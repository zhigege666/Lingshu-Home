export const navigationGroupPreviewCounts = [0, 4, 6, 8, 12, 24] as const
export const navigationFolderPageSize = 24
export function normalizeNavigationGroupPreviewCount(value: unknown): number {
  return typeof value === 'number' && navigationGroupPreviewCounts.some(count => count === value) ? value : 6
}
export function navigationGroupPreview<T>(items: readonly T[], setting: unknown) {
  const limit = normalizeNavigationGroupPreviewCount(setting), visible = limit === 0 ? items.slice() : items.slice(0, limit)
  return { visible, totalCount: items.length, hiddenCount: items.length - visible.length }
}
type FolderSearchable = { title: string; url: string; description?: string; tags?: readonly string[] }
const searchText = (value: string, locale: string) => value.normalize('NFKC').toLocaleLowerCase(locale)
export function navigationFolderPage<T extends FolderSearchable>(items: readonly T[], query: string, requestedPage: number, locale = 'en') {
  const terms = searchText(query.trim(), locale).split(/\s+/).filter(Boolean)
  const matching = terms.length ? items.filter(item => {
    const text = searchText([item.title, item.url, item.description || '', ...(item.tags || [])].join(' '), locale)
    return terms.every(term => text.includes(term))
  }) : items
  const count = matching.length, pageCount = Math.max(1, Math.ceil(count / navigationFolderPageSize))
  const page = Number.isFinite(requestedPage) ? Math.min(pageCount, Math.max(1, Math.trunc(requestedPage))) : 1
  const offset = (page - 1) * navigationFolderPageSize, visible = matching.slice(offset, offset + navigationFolderPageSize)
  return { items: visible, count, page, pageCount, start: count ? offset + 1 : 0, end: offset + visible.length }
}
