import { t } from './i18n'
import type { PageChrome } from './types'

export type ChromeValidationIssue = { area: 'header' | 'footer'; alignment: 'left' | 'center' | 'right'; itemId?: string; field?: 'text' | 'url'; message: string }
const areas = ['header', 'footer'] as const
const alignments = ['left', 'center', 'right'] as const
const areaName = (area: 'header' | 'footer') => area === 'header' ? t('页眉', 'Header') : t('页脚', 'Footer')
const alignmentName = (alignment: 'left' | 'center' | 'right') => alignment === 'left' ? t('左侧', 'Left') : alignment === 'center' ? t('居中', 'Center') : t('右侧', 'Right')

function validURL(value: string) {
  if (!value || value.length > 2048 || /[\s\\\p{Cc}]/u.test(value)) return false
  const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1]
  if (!authority || authority.includes('@')) return false
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname && !/[<>"'{}|]/.test(parsed.hostname)
      && !parsed.username && !parsed.password && (!parsed.port || Number(parsed.port) >= 1 && Number(parsed.port) <= 65535)
  } catch { return false }
}

/** Check every slot, including disabled areas and unmounted editor tabs. */
export function validatePageChrome(chrome?: PageChrome): ChromeValidationIssue | null {
  if (!chrome) return null
  const ids = new Set<string>()
  for (const area of areas) for (const alignment of alignments) {
    const items = chrome[area][alignment]
    const problem = (message: string, index = 0, field?: 'text' | 'url'): ChromeValidationIssue => ({
      area, alignment, itemId: items[index]?.id, field,
      message: t('{area} / {alignment}，第 {count} 项：{message}', '{area} / {alignment}, item {count}: {message}',
        { area: areaName(area), alignment: alignmentName(alignment), count: index + 1, message })
    })
    if (items.length > 8) return problem(t('每个位置最多 8 项。', 'Each position supports up to 8 items.'))
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!
      if (!item.id || item.id.trim() !== item.id || item.id.length > 80 || ids.has(item.id)) return problem(t('内容标识无效或重复。', 'The item identifier is invalid or duplicated.'), index)
      ids.add(item.id)
      if (item.type === 'branding') continue
      const limit = item.type === 'link' ? 160 : 500
      if (!item.text?.trim()) return problem(t('请填写文本。', 'Enter the item text.'), index, 'text')
      if (item.text.length > limit) return problem(t('文本最多 {limit} 个字符。', 'Text is limited to {limit} characters.', { limit }), index, 'text')
      if (item.type === 'link' && !validURL(item.url || '')) return problem(t('请填写完整的 HTTP 或 HTTPS 网址，不含账号、空格或反斜线。', 'Enter a complete HTTP or HTTPS URL without credentials, spaces or backslashes.'), index, 'url')
    }
  }
  return null
}
