import manifest from '../../../assets/icons/manifest.json'
import { t } from './i18n'

export type IconAssetRecord = { ref: string; url: string; sha256: string; mediaType: string; width: number; height: number }
export type IconPackEntry = IconAssetRecord & { key: string; label: string; sourceSha256: string }
export type IconPack = { id: string; spaceId: string; name: string; sourceUrl: string; license: string; createdAt: string; icons: IconPackEntry[] }
export type IconPackDraft = { schemaVersion: 1; name: string; sourceUrl: string; license: string; icons: { key: string; label: string; mediaType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; dataBase64: string }[] }
export type WebsiteIcon = IconAssetRecord & { cached: boolean; stale?: boolean; sourceUrl: string }

const assetPattern = /^asset:([0-9a-f]{32}):([0-9a-f]{64})$/
const builtinIds = new Set(manifest.icons.map(icon => icon.id))
const iconMediaTypes = new Set(['image/png', 'image/jpeg', 'image/svg+xml'])
export function builtinIconChoices() {
  return manifest.icons.map(icon => ({ id: icon.id, group: icon.group, label: t(icon.label, icon.labelEn), keywords: [icon.label, icon.labelEn, icon.id, ...icon.keywords] }))
}

export function builtinIconGroups() {
  return manifest.groups.map(group => ({ id: group.id, label: t(group.label, group.labelEn), count: manifest.icons.filter(icon => icon.group === group.id).length }))
}

/** Match either language and technical IDs regardless of case or word separators. */
export function matchesIconSearch(text: string, query: string): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s:_-]+/gu, '')
  const normalized = text.normalize('NFKC').toLowerCase()
  const words: string[] = normalized.match(/[a-z0-9]+/g) || []
  const keys = normalized.split(/\s+/u).flatMap(word => [normalize(word), normalize(word.replace(/^lucide[:/]/, ''))])
  const haystack = normalize(text)
  return query.normalize('NFKC').trim().split(/\s+/u).every(word => {
    const term = normalize(word)
    // English prefixes match words/IDs: “art” must not match “cart” or “heart”.
    // Short abbreviations such as AI require a whole word, avoiding “mail”.
    if (/^[a-z0-9]+$/.test(term)) return term.length <= 2 ? words.includes(term) : [...words, ...keys].some(key => key.startsWith(term))
    return haystack.includes(term)
  })
}

export function parseIconAssetReference(value: string | undefined): { spaceId: string; sha256: string; src: string } | null {
  const match = assetPattern.exec(value || '')
  return match ? { spaceId: match[1]!, sha256: match[2]!, src: `/api/v1/spaces/${match[1]}/icons/${match[2]}` } : null
}

/** Only a bundled path or a strictly parsed same-origin asset may become img.src. */
export function iconAssetSource(value?: string, fallback = 'lucide:link'): { src: string; imported: boolean } {
  const asset = parseIconAssetReference(value)
  if (asset) return { src: asset.src, imported: true }
  const candidate = `lucide:${(value || '').replace(/^lucide[:/]/, '')}`
  const safeFallback = builtinIds.has(fallback) ? fallback : 'lucide:link'
  const id = builtinIds.has(candidate) ? candidate : safeFallback
  return { src: `/icons/lucide/${id.slice(7)}.svg`, imported: false }
}

export function websiteIconURL(value: string | undefined): string | null {
  if (!value || value.length > 2048) return null
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function iconDraftError(): never { throw new Error(t('请选择 Schema 1 图标库 JSON，或 PNG、JPEG、静态 SVG 图片。', 'Choose a Schema 1 icon pack JSON, or a PNG, JPEG or static SVG image.')) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)) }

/** Validate bounded data before posting it; only the server decodes/sanitizes images. */
export function validateIconPackDraft(value: unknown): IconPackDraft {
  if (!record(value) || !onlyKeys(value, ['schemaVersion', 'name', 'sourceUrl', 'license', 'icons']) || value.schemaVersion !== 1
    || typeof value.name !== 'string' || !value.name.trim() || [...value.name].length > 80
    || typeof value.license !== 'string' || !value.license.trim() || [...value.license].length > 2048
    || (value.sourceUrl !== undefined && (typeof value.sourceUrl !== 'string' || !!value.sourceUrl && !websiteIconURL(value.sourceUrl)))
    || !Array.isArray(value.icons) || value.icons.length < 1 || value.icons.length > 64) {
    throw new Error(t('请填写图标库名称和真实许可说明；来源须为 HTTP/HTTPS，图标库需包含 1–64 个图标。', 'Enter a library name and its actual license or ownership notice. Source must be HTTP/HTTPS, with 1–64 icons in the library.'))
  }
  const keys = new Set<string>(); let total = 0
  for (const icon of value.icons) {
    if (!record(icon) || !onlyKeys(icon, ['key', 'label', 'mediaType', 'dataBase64']) || typeof icon.key !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(icon.key) || keys.has(icon.key)
      || typeof icon.label !== 'string' || !icon.label.trim() || [...icon.label].length > 80
      || typeof icon.mediaType !== 'string' || !iconMediaTypes.has(icon.mediaType)
      || typeof icon.dataBase64 !== 'string' || !icon.dataBase64 || icon.dataBase64.length > 349528 || icon.dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(icon.dataBase64)) iconDraftError()
    const bytes = icon.dataBase64.length / 4 * 3 - (icon.dataBase64.endsWith('==') ? 2 : icon.dataBase64.endsWith('=') ? 1 : 0)
    if (bytes > 256 * 1024) throw new Error(t('每张图标最多 256 KiB。', 'Each icon may be at most 256 KiB.'))
    total += bytes; keys.add(icon.key)
  }
  if (total > 4 * 1024 * 1024) throw new Error(t('一个图标库的图片总计最多 4 MiB。', 'Images in one library may total at most 4 MiB.'))
  return { schemaVersion: 1, name: value.name.trim(), sourceUrl: (value.sourceUrl as string | undefined)?.trim() || '', license: value.license.trim(), icons: value.icons as IconPackDraft['icons'] }
}

export async function readIconImportFile(file: File): Promise<IconPackDraft> {
  if (file.size > 6 * 1024 * 1024) throw new Error(t('图标库文件最多 6 MiB。', 'The icon library file may be at most 6 MiB.'))
  if (/\.json$/i.test(file.name) || file.type === 'application/json') {
    let value: unknown
    try { value = JSON.parse(await file.text()) } catch { throw new Error(t('图标库不是有效的 JSON 文件。', 'The icon library is not a valid JSON file.')) }
    return validateIconPackDraft(value)
  }
  if (file.size < 1 || file.size > 256 * 1024) throw new Error(t('单张图标须为 1–256 KiB，图片尺寸最多 512 × 512。', 'A single icon must be 1–256 KiB, with dimensions up to 512 × 512.'))
  const mediaType = /\.svg$/i.test(file.name) ? 'image/svg+xml' : /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : file.type
  if (!iconMediaTypes.has(mediaType)) iconDraftError()
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  const name = [...file.name.replace(/\.[^.]+$/, '')].slice(0, 80).join('') || t('图标', 'Icon')
  return { schemaVersion: 1, name, sourceUrl: '', license: '', icons: [{ key: 'icon', label: name, mediaType: mediaType as IconPackDraft['icons'][number]['mediaType'], dataBase64: btoa(binary) }] }
}
