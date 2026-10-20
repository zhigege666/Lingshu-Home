import { ArrowUpRight, Bookmark, ChevronDown, ChevronLeft, ChevronRight, Folder, PanelLeftClose, PanelLeftOpen, Search, Star, X } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Tooltip } from 'radix-ui';
import type { Category, NavLink, NavigationData } from '../core/types';
import type { LinkAppearance } from '../core/themes';
import { IconAsset } from '../components/IconAsset';
import { defaultCategoryNavigationSettings, type CategoryNavigationSettings } from '../core/presentation';
import { getLocale, t } from '../core/i18n';
import { useHomeEnvironment } from './HomeEnvironment';
import { useBookmarkEndpointRouting } from './useEndpointRouting';

export type NavigationCategory = Category;
export type NavigationLink = NavLink;
export type NavigationCollection = NavigationData;
export type NavigationFilter = { search: string; categoryId: string | null; favoritesOnly: boolean };
export const EMPTY_FILTER: NavigationFilter = { search: '', categoryId: null, favoritesOnly: false };
export function NavigationIcon({ name, size = 20 }: { name?: string; size?: number }) {
  return <IconAsset name={name} size={size} fallback="lucide:globe" />;
}
export function safeLink(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function readNavigation(data: unknown): NavigationCollection | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<NavigationCollection>;
  return Array.isArray(d.categories) && Array.isArray(d.links) ? d as NavigationCollection : null;
}
type NavigationIndex = {
  locale: string;
  categories: NavigationCategory[]; byId: Map<string, NavigationCategory>; children: Map<string, NavigationCategory[]>;
  roots: NavigationCategory[]; counts: Map<string, number>; paths: Map<string, string>;
  links: NavigationLink[]; searchText: Map<string, string>; favorites: number;
};
// API snapshots are immutable. Reuse one index across panels bound to the same snapshot.
const navigationIndexes = new WeakMap<NavigationCollection, NavigationIndex>();
function navigationIndex(collection: NavigationCollection): NavigationIndex {
  const locale = getLocale();
  const cached = navigationIndexes.get(collection); if (cached?.locale === locale) return cached;
  const categories = collection.categories.slice().sort((a,b) => a.sortOrder-b.sortOrder || a.name.localeCompare(b.name, locale));
  const byId = new Map(categories.map(category => [category.id, category]));
  const children = new Map<string, NavigationCategory[]>(), paths = new Map<string, string>(), counts = new Map<string, number>();
  const roots: NavigationCategory[] = [];
  for (const category of categories) {
    if (category.parentId && category.parentId !== category.id && byId.has(category.parentId)) {
      const siblings = children.get(category.parentId) || []; siblings.push(category); children.set(category.parentId, siblings);
    } else roots.push(category);
    const names = [category.name], seen = new Set([category.id]); let parentId = category.parentId;
    while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = byId.get(parentId); if (!parent) break; names.unshift(parent.name); parentId = parent.parentId; }
    paths.set(category.id, names.join(' / ')); counts.set(category.id, 0);
  }
  const reachable = new Set<string>();
  const markReachable = (root: NavigationCategory) => {
    const pending = [root];
    while (pending.length) { const category = pending.pop()!; if (reachable.has(category.id)) continue; reachable.add(category.id); pending.push(...(children.get(category.id) || [])); }
  };
  roots.forEach(markReachable);
  // Defensive handling for external snapshots: keep disconnected/cyclic nodes reachable.
  for (const category of categories) if (!reachable.has(category.id)) { roots.push(category); markReachable(category); }
  const links = collection.links.slice().sort((a,b) => a.sortOrder-b.sortOrder || a.title.localeCompare(b.title, locale));
  const searchText = new Map<string, string>(); let favorites = 0;
  for (const link of links) {
    searchText.set(link.id, [link.title, link.url, link.description, ...link.tags, ...link.endpoints.map(endpoint => endpoint.label + ' ' + endpoint.url)].join(' ').toLocaleLowerCase(locale));
    if (link.isFavorite) favorites++;
    const seen = new Set<string>(); let categoryId = link.categoryId;
    while (categoryId && byId.has(categoryId) && !seen.has(categoryId)) { seen.add(categoryId); counts.set(categoryId, (counts.get(categoryId) || 0) + 1); categoryId = byId.get(categoryId)!.parentId; }
  }
  const index = { locale, categories, byId, children, roots, counts, paths, links, searchText, favorites };
  navigationIndexes.set(collection, index); return index;
}
function descendants(index: NavigationIndex, selected: string) {
  const ids = new Set<string>(), pending = [selected];
  while (pending.length) { const id = pending.pop()!; if (ids.has(id)) continue; ids.add(id); for (const child of index.children.get(id) || []) pending.push(child.id); }
  return ids;
}
export function filteredLinks(collection: NavigationCollection, filter: NavigationFilter, onlyFavorites = false) {
  const index = navigationIndex(collection);
  const selected = filter.categoryId ? descendants(index, filter.categoryId) : null;
  const query = filter.search.trim().toLocaleLowerCase(getLocale());
  return index.links.filter(link => (!selected || selected.has(link.categoryId || ''))
    && (!(onlyFavorites || filter.favoritesOnly) || link.isFavorite)
    && (!query || index.searchText.get(link.id)!.includes(query)));
}
function storedBranches(key: string): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`lh:category-branches:${key}`) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, open]) => typeof open === 'boolean')) : {};
  } catch { return {}; }
}
function CategoryHint({ label, enabled, theme, side, children, container }: { label: string; enabled: boolean; theme: 'light' | 'dark'; side: 'right' | 'top'; children: ReactElement; container?: HTMLElement }) {
  return enabled ? <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal container={container}><Tooltip.Content className="lh-category-tooltip" data-theme={theme} side={side} sideOffset={8} collisionPadding={12}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root> : children;
}

export function CategoryPanel({ data, filter, onChange, orientation = 'vertical', settings = defaultCategoryNavigationSettings, collapsed = false, onCollapsedChange, stateKey = '', theme = 'light', persistState = true }: {
  data: NavigationCollection; filter: NavigationFilter; onChange: (filter: NavigationFilter) => void; orientation?: 'vertical' | 'horizontal';
  settings?: CategoryNavigationSettings; collapsed?: boolean; onCollapsedChange?: (collapsed: boolean) => void; stateKey?: string; theme?: 'light' | 'dark'; persistState?: boolean;
}) {
  const { preview, viewportWindow } = useHomeEnvironment();
  const allowPersistence = persistState && !preview;
  const locale = getLocale();
  const index = useMemo(() => navigationIndex(data), [data, locale]);
  const idPrefix = useId();
  const [branchState, setBranchState] = useState(() => ({ key: stateKey, persist: allowPersistence, values: allowPersistence ? storedBranches(stateKey) : {} }));
  const branches = branchState.key === stateKey && branchState.persist === allowPersistence ? branchState.values : allowPersistence ? storedBranches(stateKey) : {};
  const viewport = useRef<HTMLUListElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, start: true, end: true });
  const canCollapse = settings.collapsible && settings.displayMode !== 'icons';
  const mode = collapsed && canCollapse ? 'icons' : settings.displayMode;
  const iconsOnly = mode === 'icons', horizontal = orientation === 'horizontal';
  const tree = settings.hierarchyMode === 'tree';
  const activeAncestors = useMemo(() => {
    const ids = new Set<string>(); let id = filter.categoryId ? index.byId.get(filter.categoryId)?.parentId : null;
    while (id && !ids.has(id)) { ids.add(id); id = index.byId.get(id)?.parentId; }
    return ids;
  }, [filter.categoryId, index]);
  const changeBranch = (id: string, open: boolean) => {
    const values = { ...branches, [id]: open }; setBranchState({ key: stateKey, persist: allowPersistence, values });
    if (allowPersistence) try { sessionStorage.setItem(`lh:category-branches:${stateKey}`, JSON.stringify(values)); } catch { /* Browsing remains usable when storage is unavailable. */ }
  };
  useEffect(() => {
    const element = viewport.current; if (!element || !horizontal) return;
    const ownerWindow = element.ownerDocument.defaultView; if (!ownerWindow) return;
    let frame = 0;
    const measure = () => {
      ownerWindow.cancelAnimationFrame(frame); frame = ownerWindow.requestAnimationFrame(() => {
        const next = { overflow: element.scrollWidth > element.clientWidth + 2, start: element.scrollLeft < 2, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 };
        setScroll(previous => previous.overflow === next.overflow && previous.start === next.start && previous.end === next.end ? previous : next);
      });
    };
    const observer = new ResizeObserver(measure); observer.observe(element); measure(); element.addEventListener('scroll', measure, { passive: true });
    return () => { ownerWindow.cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('scroll', measure); };
  }, [data, horizontal, mode, tree, branchState, settings.showCounts, stateKey, filter.categoryId]);
  const scrollBy = (direction: number) => {
    const element = viewport.current; if (!element) return;
    element.scrollBy({ left: direction * Math.max(160, element.clientWidth * .7), behavior: element.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const hint = (label: string, button: ReactElement) => <CategoryHint label={label} enabled={iconsOnly} theme={theme} side={horizontal ? 'top' : 'right'} container={viewportWindow?.document.body}>{button}</CategoryHint>;
  const countLabel = (name: string, count: number) => settings.showCounts ? t('{name} · {count} 个链接', '{name} · {count} links', { name, count: count.toLocaleString(locale) }) : name;
  const row = (id: string, name: string, icon: ReactElement, count: number, selected: boolean, onClick: () => void) => <li key={id} className="lh-category-node lh-category-shortcut"><div className="lh-category-row">{hint(countLabel(name, count), <button className="lh-category-select" type="button" aria-label={name} aria-pressed={selected} onClick={onClick}>{mode !== 'text' && icon}<span className="lh-category-name">{name}</span>{settings.showCounts && <b aria-hidden="true">{count.toLocaleString(locale)}</b>}</button>)}</div></li>;
  const visited = new Set<string>();
  const categoryItem = (category: NavigationCategory, depth = 0): ReactElement | null => {
    if (visited.has(category.id)) return null; visited.add(category.id);
    const children = tree ? index.children.get(category.id) || [] : [];
    const path = index.paths.get(category.id) || category.name;
    const isActiveAncestor = activeAncestors.has(category.id);
    const expanded = isActiveAncestor || branches[category.id] !== false;
    const groupId = `${idPrefix}-${encodeURIComponent(category.id)}`;
    const count = index.counts.get(category.id) || 0;
    return <li key={category.id} className="lh-category-node" data-category-id={category.id} style={{ '--lh-category-depth': Math.min(depth, 5) } as CSSProperties}>
      <div className="lh-category-row">
        {hint(countLabel(path, count), <button className="lh-category-select" type="button" aria-label={path} aria-pressed={filter.categoryId === category.id} title={iconsOnly ? undefined : path}
          onClick={() => onChange({ ...filter, categoryId: filter.categoryId === category.id ? null : category.id, favoritesOnly: false })}>
          {mode !== 'text' && <NavigationIcon name={category.icon} size={17} />}<span className="lh-category-name">{tree ? category.name : path}</span>{settings.showCounts && <b aria-hidden="true">{count.toLocaleString(locale)}</b>}
        </button>)}
        {!!children.length && <button className="lh-category-disclosure" type="button" aria-label={expanded ? t('收起 {name} 的子分类', 'Collapse subcategories of {name}', { name: path }) : t('展开 {name} 的子分类', 'Expand subcategories of {name}', { name: path })} aria-expanded={expanded} aria-controls={groupId} aria-disabled={isActiveAncestor || undefined}
          title={isActiveAncestor ? t('当前选中分类位于此目录中；选择其他分类后可收起。', 'The selected category is in this branch. Select another category to collapse it.') : expanded ? t('收起子分类', 'Collapse subcategories') : t('展开子分类', 'Expand subcategories')} onClick={() => { if (!isActiveAncestor) changeBranch(category.id, !expanded); }}><ChevronDown size={13} /></button>}
      </div>
      {!!children.length && <ul id={groupId} className="lh-category-children" hidden={!expanded}>{expanded && children.map(child => categoryItem(child, depth + 1))}</ul>}
    </li>;
  };
  const categoryItems = (tree ? index.roots : index.categories).map(category => categoryItem(category));
  const collapseLabel = collapsed ? t('展开分类导航', 'Expand category navigation') : t('收起分类导航', 'Collapse category navigation');
  return <Tooltip.Provider delayDuration={220} skipDelayDuration={100}><nav className={`lh-categories is-${orientation} is-${mode}${collapsed && canCollapse ? ' is-collapsed' : ''}`} aria-label={t('导航分类', 'Navigation categories')} data-state-key={stateKey}>
    <div className="lh-category-toolbar">{!horizontal && !iconsOnly && <span>{t('分类', 'Categories')}</span>}{canCollapse && onCollapsedChange && <button className="lh-category-collapse" type="button" aria-label={collapseLabel} aria-expanded={!collapsed} onClick={() => onCollapsedChange(!collapsed)} title={collapseLabel}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>}</div>
    {horizontal && <button className={`lh-category-scroll${scroll.overflow ? '' : ' is-unneeded'}`} type="button" aria-label={t('向前滚动分类', 'Scroll categories backward')} disabled={!scroll.overflow || scroll.start} onClick={() => scrollBy(-1)}><ChevronLeft size={16} /></button>}
    <ul className="lh-category-list" ref={viewport}>
      {row('all', t('全部链接', 'All links'), <Bookmark size={17} />, data.links.length, !filter.categoryId && !filter.favoritesOnly, () => onChange({ ...filter, categoryId: null, favoritesOnly: false }))}
      {row('favorites', t('我的收藏', 'My favorites'), <Star size={17} />, index.favorites, filter.favoritesOnly, () => onChange({ ...filter, categoryId: null, favoritesOnly: !filter.favoritesOnly }))}
      {categoryItems}
    </ul>
    {horizontal && <button className={`lh-category-scroll${scroll.overflow ? '' : ' is-unneeded'}`} type="button" aria-label={t('向后滚动分类', 'Scroll categories forward')} disabled={!scroll.overflow || scroll.end} onClick={() => scrollBy(1)}><ChevronRight size={16} /></button>}
  </nav></Tooltip.Provider>;
}

export function SearchPanel({ filter, onChange, title = t('搜索链接、描述或标签', 'Search links, descriptions or tags') }: { filter: NavigationFilter; onChange: (filter: NavigationFilter) => void; title?: string }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const ownerDocument = input.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView; if (!ownerDocument || !ownerWindow) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === '/' && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !target?.closest('input,textarea,select,[contenteditable="true"],[role="combobox"],[role="listbox"],[role="option"],[role="menu"]')) {
        const first = ownerDocument.querySelector('.lh-search input');
        if (first === input.current) { event.preventDefault(); input.current?.focus(); }
      }
    };
    ownerWindow.addEventListener('keydown', handler); return () => ownerWindow.removeEventListener('keydown', handler);
  }, []);
  return <label className="lh-search"><Search size={17} /><span className="lh-sr-only">{title}</span><input ref={input} type="search" placeholder={title} value={filter.search} onChange={e => onChange({ ...filter, search: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') { onChange({ ...filter, search: '' }); input.current?.blur(); } }} />
    {filter.search ? <button aria-label={t('清除搜索', 'Clear search')} onClick={() => onChange({ ...filter, search: '' })} type="button"><X size={14} /></button> : <kbd>/</kbd>}</label>;
}

const BookmarkItem = memo(function BookmarkItem({ link, directory, canEdit, onFavorite, pending }: { link: NavigationLink; directory: boolean; canEdit: boolean; onFavorite: (link: NavigationLink) => void; pending?: string }) {
  const { preview } = useHomeEnvironment();
  const routing = useBookmarkEndpointRouting(link);
  const href = routing.href;
  const routes = link.endpoints.filter(endpoint => endpoint.route === 'internal' || endpoint.route === 'external');
  const additional = link.endpoints.filter(endpoint => endpoint.route !== 'internal' && endpoint.route !== 'external');
  const endpointLink = (endpoint: NavigationLink['endpoints'][number], i: number) => {
    const url = safeLink(endpoint.url); if (!url) return null;
    const role = endpoint.route === 'internal' ? t('内网', 'Internal') : t('外网', 'External');
    const manualLabel = endpoint.route === 'internal' ? t('手动打开内网入口 {name}', 'Open internal route {name} manually', { name: endpoint.label }) : endpoint.route === 'external' ? t('手动打开外网入口 {name}', 'Open external route {name} manually', { name: endpoint.label }) : undefined;
    return <a href={preview ? undefined : url} role={preview ? 'link' : undefined} aria-disabled={preview || undefined} aria-label={manualLabel} title={manualLabel || endpoint.label}
      data-route={endpoint.route} tabIndex={preview ? 0 : undefined} key={endpoint.label+i} target={preview ? undefined : '_blank'} rel={preview ? undefined : 'noopener noreferrer'} onClick={routing.cancel}>
      {endpoint.route && <span className="lh-endpoint-role">{role}</span>}<span className="lh-endpoint-name">{endpoint.label}</span><ArrowUpRight size={10} />
    </a>;
  };
  let host = ''; try { host = new URL(link.url).hostname.replace(/^www\./, ''); } catch { host = link.url; }
  return <article className={`lh-bookmark ${directory ? 'is-directory' : ''}`} data-link-id={link.id} data-routing={routing.state}>
    <div className="lh-bookmark-icon"><NavigationIcon name={link.icon} size={directory ? 18 : 21} /></div>
    <div className="lh-bookmark-body">
      {href ? <a className="lh-bookmark-title" href={preview ? undefined : href} role={preview ? 'link' : undefined} aria-disabled={preview || undefined} aria-busy={routing.state === 'pending' || undefined} tabIndex={preview ? 0 : undefined} target={preview ? undefined : '_blank'} rel={preview ? undefined : 'noopener noreferrer'} title={link.title} onClick={routing.onClick} onPointerDown={routing.refreshNativeHref} onKeyDown={routing.refreshNativeHref} onAuxClick={routing.refreshNativeHref}><span>{link.title}</span><ArrowUpRight size={13} /></a> : <span className="lh-bookmark-title" title={t('链接地址不可用', 'Link URL unavailable')}>{link.title}</span>}
      <p title={link.description || link.url}>{link.description || host}</p>
      {!!routes.length && <div className="lh-endpoints lh-network-endpoints" aria-label={t('手动选择网络入口', 'Choose a network route manually')}>{routes.map(endpointLink)}</div>}
      {!!additional.length && <div className="lh-endpoints lh-additional-endpoints">{additional.map(endpointLink)}</div>}
      {routing.state !== 'idle' && <p className="lh-routing-status" role="status">{routing.state === 'pending' ? t('正在选择入口…', 'Choosing a route…') : t('未能打开新页面，请直接选择入口重试。', 'The new page could not be opened. Choose a route directly to retry.')}</p>}
      {!directory && !!link.tags.length && <div className="lh-bookmark-tags">{link.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div>}
    </div>
    {canEdit && !preview ? <button className={`lh-favorite-button ${link.isFavorite ? 'is-active' : ''}`} title={link.isFavorite ? t('取消收藏', 'Remove favorite') : t('收藏链接', 'Favorite link')} aria-label={link.isFavorite ? t('取消收藏 {name}', 'Remove {name} from favorites', { name: link.title }) : t('收藏 {name}', 'Favorite {name}', { name: link.title })} aria-pressed={link.isFavorite} disabled={pending === link.id} onClick={() => onFavorite(link)}><Star size={14} /></button>
      : link.isFavorite && <Star className="lh-favorite-indicator" size={13} aria-label={t('已收藏', 'Favorited')} />}
  </article>;
});

export function NavigationPanel({ data, filter, title, variant = 'cards', linkAppearance = 'icon-text', favorites = false, canEdit = false, onFavorite, pending, onClear, emptyActions }: {
  data: NavigationCollection; filter: NavigationFilter; title?: string; variant?: 'cards' | 'directory'; linkAppearance?: LinkAppearance; favorites?: boolean;
  canEdit?: boolean; onFavorite: (link: NavigationLink) => void; pending?: string; onClear?: () => void;
  emptyActions?: { scope: string; onAdd: () => void; onImport: () => void };
}) {
  const locale = getLocale();
  const links = useMemo(() => filteredLinks(data, filter, favorites), [data, filter, favorites, locale]);
  const groups = useMemo(() => {
    if (favorites) return [{ id: 'favorites', name: title || t('常用收藏', 'Favorites'), icon: 'star', links }];
    const index = navigationIndex(data), byCategory = new Map<string, NavigationLink[]>();
    for (const link of links) { const key = link.categoryId && index.byId.has(link.categoryId) ? link.categoryId : ''; const items = byCategory.get(key) || []; items.push(link); byCategory.set(key, items); }
    const groups: { id: string; name: string; icon: string; links: NavigationLink[] }[] = [];
    for (const category of index.categories) { const items = byCategory.get(category.id); if (items?.length) groups.push({ id: category.id, name: index.paths.get(category.id) || category.name, icon: category.icon, links: items }); }
    const others = byCategory.get(''); if (others?.length) groups.push({ id: 'uncategorized', name: t('未分类', 'Uncategorized'), icon: 'folder', links: others });
    return groups;
  }, [data, links, favorites, title, locale]);
  if (!links.length && favorites) return <section className="lh-favorites-empty" aria-label={title || t('常用收藏', 'Favorites')}><Star size={16} /><h2>{title || t('常用收藏', 'Favorites')}</h2><span>{filter.search || filter.categoryId || filter.favoritesOnly ? t('当前筛选下无收藏', 'No favorites match these filters') : t('暂无收藏', 'No favorites yet')}</span></section>;
  if (!links.length) {
    const filtered = !!(filter.search || filter.categoryId || filter.favoritesOnly);
    const actions = !filtered && !data.links.length ? emptyActions : undefined;
    return <section className="lh-panel lh-panel-empty"><Folder size={28} /><strong>{filtered ? t('没有匹配的链接', 'No matching links') : t('暂无链接', 'No links yet')}</strong>
      <p>{filtered ? t('调整关键词或分类。', 'Try a different search or category.') : actions ? actions.scope : t('当前数据范围内没有可显示的链接。', 'There are no links to display in this collection.')}</p>
      {actions && <><button className="lh-primary-button" type="button" onClick={actions.onAdd}>{t('添加第一个链接', 'Add your first link')}<ChevronRight size={14} /></button><button className="lh-text-button" type="button" onClick={actions.onImport}>{t('导入浏览器书签', 'Import browser bookmarks')}<ChevronRight size={14} /></button></>}
      {onClear && filtered && <button className="lh-text-button" type="button" onClick={onClear}>{t('清除筛选', 'Clear filters')}<ChevronRight size={14} /></button>}
    </section>;
  }
  return <div className={`lh-navigation-panel ${variant === 'directory' ? 'lh-directory-groups' : 'lh-card-groups'}`} data-link-appearance={linkAppearance}>
    {title && !favorites && <div className="lh-panel-heading lh-custom-panel-title"><h2>{title}</h2><span>{t('{count} 个链接', '{count} links', { count: links.length.toLocaleString(locale) })}</span></div>}
    {groups.map(group => <section className={`lh-link-group ${favorites ? 'lh-favorites-group' : ''}${group.links.length <= 3 && variant !== 'directory' ? ' is-sparse' : ''}`} key={group.id} aria-label={group.name}
      style={{ '--lh-link-count': group.links.length } as CSSProperties}>
      <div className="lh-group-heading"><span className="lh-group-icon"><NavigationIcon name={group.icon} size={17} /></span><h2>{group.name}</h2><span className="lh-count">{group.links.length.toLocaleString(locale)}</span></div>
      <div className={`lh-links ${variant === 'directory' ? 'is-directory' : ''}`}>{group.links.map(link => <BookmarkItem key={link.id} link={link} directory={variant === 'directory'} canEdit={canEdit} onFavorite={onFavorite} pending={pending} />)}</div>
    </section>)}
  </div>;
}
