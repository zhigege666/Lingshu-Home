import { getLocale, t } from './i18n'
import { defaultPageChrome } from './chrome'
import manifest from '../../../assets/icons/manifest.json'
import type { Category, Dataset, LinkInput, NavigationData, NavLink, PageConfig, Placement, Slot } from './types'
export const icons = manifest.icons
const iconIds = new Set(icons.map(icon => icon.id))
export function iconPath(id: string = 'lucide:link') { return `/icons/lucide/${(iconIds.has(id) ? id : 'lucide:link').split(':')[1]}.svg` }
export function viewId() { return 'view-' + (globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`) }
export const panelTypes = [{ id: 'builtin/category-navigation', get name() { return t('分类导航', 'Categories') } }, { id: 'builtin/search', get name() { return t('搜索框', 'Search') } }, { id: 'builtin/favorites', get name() { return t('常用收藏', 'Favorites') } }, { id: 'builtin/navigation', get name() { return t('导航链接', 'Navigation') } }, { id: 'builtin/github-traffic', name: 'GitHub Traffic' }, { id: 'builtin/calendar', get name() { return t('日程', 'Calendar') } }, { id: 'builtin/weather', get name() { return t('天气', 'Weather') } }, { id: 'builtin/metrics', get name() { return t('统计指标', 'Metrics') } }, { id: 'builtin/status', get name() { return t('服务状态', 'Service status') } }]
export type CategoryNavigationSettings = { displayMode: 'icon-text' | 'icons' | 'text'; collapsible: boolean; defaultCollapsed: boolean; hierarchyMode: 'tree' | 'flat'; showCounts: boolean }
export const defaultCategoryNavigationSettings: CategoryNavigationSettings = { displayMode: 'icon-text', collapsible: true, defaultCollapsed: false, hierarchyMode: 'tree', showCounts: true }
export function readCategoryNavigationSettings(settings: Record<string, unknown> = {}): CategoryNavigationSettings {
  return {
    displayMode: settings.displayMode === 'icons' || settings.displayMode === 'text' ? settings.displayMode : 'icon-text',
    collapsible: typeof settings.collapsible === 'boolean' ? settings.collapsible : true,
    defaultCollapsed: typeof settings.defaultCollapsed === 'boolean' ? settings.defaultCollapsed : false,
    hierarchyMode: settings.hierarchyMode === 'flat' ? 'flat' : 'tree',
    showCounts: typeof settings.showCounts === 'boolean' ? settings.showCounts : true
  }
}
export const authModes = [
  { id: 'open_edit', get title() { return t('完全开放', 'Open editing') }, get detail() { return t('前台与后台均免登录，可维护公开共享导航。', 'Browse and edit shared navigation without signing in.') }, icon: 'lucide:globe' },
  { id: 'public_read', get title() { return t('公开浏览', 'Public browsing') }, get detail() { return t('前台免登录，后台由管理员登录维护。', 'Browse publicly; administrators sign in to edit.') }, icon: 'lucide:house' },
  { id: 'private_single', get title() { return t('私人导航', 'Private navigation') }, get detail() { return t('登录后使用，仅管理员一个账号可访问。', 'Sign in to use a private navigation with one administrator account.') }, icon: 'lucide:shield' },
  { id: 'private_multi', get title() { return t('多人空间', 'Multiple users') }, get detail() { return t('登录后使用，每位成员有独立的个人空间。', 'Sign in with separate personal spaces for each member.') }, icon: 'lucide:folder' }
] as const
export function placementFor(config: PageConfig, id: string, narrow = false): Placement { const p = config.layout.placements[id]; return (narrow && p?.overrides?.narrow ? p.overrides.narrow : p?.base) || { kind: 'hidden' } }
export function navigationData(dataset?: Dataset<unknown>): NavigationData | null { if (!dataset || dataset.schemaId !== 'navigation.collection' || !dataset.data || typeof dataset.data !== 'object') return null; const value = dataset.data as NavigationData; return Array.isArray(value.categories) && Array.isArray(value.links) ? value : null }
export function categoryPosition(config: PageConfig): Slot { const view = config.views.find(v => v.panel.id === 'builtin/category-navigation'); const p = view ? placementFor(config, view.id) : { kind: 'hidden' }; return p.kind === 'hidden' ? 'hidden' : (p as Exclude<Placement, { kind: 'hidden' }>).region }
export function setCategoryPosition(config: PageConfig, position: Slot): PageConfig { const next = structuredClone(config); for (const view of next.views.filter(v => v.panel.id === 'builtin/category-navigation')) { const p = next.layout.placements[view.id]?.base; if (p && p.kind !== 'hidden' && p.locked) continue; next.layout.placements[view.id] = position === 'hidden' ? { base: { kind: 'hidden' } } : { base: { kind: 'region', region: position, order: 1 }, overrides: { narrow: { kind: 'region', region: position === 'left' || position === 'right' ? 'top' : position, order: 1 } } } } return next }
export function presetConfig(preset: 'grouped-cards' | 'dense-directory'): PageConfig {
  const [categories, search, favorites, navigation] = Array.from({ length: 4 }, viewId) as [string,string,string,string]
  const dense = preset === 'dense-directory'
  const view = (id: string, name: string, settings = {}): PageConfig['views'][number] => ({ id, panel: { id: 'builtin/' + name }, inputs: name === 'search' ? {} : { collection: 'navigation' }, interactionScope: 'primary-navigation', settings })
  const grid = (y: number, h: number, order: number) => ({ base: { kind: 'grid' as const, region: 'main' as const, x: 0, y, w: 24, h, heightMode: 'content' as const, locked: false }, overrides: { narrow: { kind: 'flow' as const, region: 'main' as const, order } } })
  return { schemaVersion: 2, pageTheme: { id: 'builtin/dashboard' }, chrome: defaultPageChrome(), appearance: { colorMode: dense ? 'dark' : 'light', density: dense ? 'compact' : 'comfortable' }, bindings: { navigation: { datasetId: 'local-navigation', space: 'current-page-space', query: {} } }, views: [view(categories, 'category-navigation', { ...defaultCategoryNavigationSettings }), view(search, 'search'), view(favorites, 'favorites', { variant: dense ? 'directory' : 'cards' }), view(navigation, 'navigation', { variant: dense ? 'directory' : 'cards', groupBy: 'category' })], layout: { mode: 'regions-grid', gap: dense ? 12 : 16, grid: { columns: 24 }, placements: { [categories]: { base: { kind: 'region', region: dense ? 'top' : 'left', order: 1 }, overrides: { narrow: { kind: 'region', region: 'top', order: 1 } } }, [search]: { base: { kind: 'region', region: 'top', order: 0, size: { widthPx: 340, maxWidthPx: 360 } } }, [favorites]: grid(0,4,0), [navigation]: grid(4,12,1) } } }
}
export function linkInput(link: NavLink): LinkInput { return { title: link.title, url: link.url, description: link.description, contextMarkdown: link.contextMarkdown || '', categoryId: link.categoryId, icon: link.icon, iconMode: link.iconMode === 'auto' ? 'auto' : 'manual', tags: link.tags || [], isFavorite: link.isFavorite, sortOrder: link.sortOrder, endpoints: link.endpoints || [] } }
export function categoryLabel(category: Category, categories: Category[]): string { const names = [category.name]; const seen = new Set([category.id]); let parentId = category.parentId; while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = categories.find(item => item.id === parentId); if (!parent) break; names.unshift(parent.name); parentId = parent.parentId } return names.join(' / ') }
export function safeHref(value: string): string | undefined { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined } catch { return undefined } }
export function displayHost(value: string) { try { return new URL(value).host } catch { return value } }
export function formatUpdated(value?: string | null) { return value ? new Date(value).toLocaleString(getLocale(), { hour12: false }) : t('尚未同步', 'Not synced yet') }
