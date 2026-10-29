import { navigationFolderPage, navigationGroupPreview } from '../core/navigation-folder'
import './navigation-folder.css'
import { ArrowUpRight, Bookmark, ChevronDown, ChevronLeft, ChevronRight, Folder, GripVertical, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Search, Star, X } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactElement } from 'react';
import { Dialog as DialogPrimitive, Tooltip } from 'radix-ui';
import type { Category, NavLink, NavigationData } from '../core/types';
import type { LinkAppearance } from '../core/themes';
import { IconAsset } from '../components/IconAsset';
import { defaultCategoryNavigationSettings, type CategoryNavigationSettings } from '../core/presentation';
import { getLocale, t } from '../core/i18n';
import { useHomeEnvironment } from './HomeEnvironment';
import { useBookmarkEndpointRouting } from './useEndpointRouting';
import { recordLinkClick } from './recordLinkClick';
import { readNavigationAppearanceSettings, type NavigationAppearanceSettings } from '../core/navigation-appearance';
import './navigation-appearance.css';
import './navigation-edit.css';
import type { NavigationEditor } from './navigation-editor-types';

export type NavigationCategory = Category;
export type NavigationLink = NavLink;
export type NavigationCollection = NavigationData;
export type NavigationFilter = { search: string; categoryId: string | null; favoritesOnly: boolean };
export const EMPTY_FILTER: NavigationFilter = { search: '', categoryId: null, favoritesOnly: false };

type NavigationDrag = { kind: 'link' | 'category'; id: string; spaceId: string; ownerDocument: Document };
// Only an active handle in this document can initiate a navigation move. Do not
// interpret arbitrary dropped text/URLs, external snapshots or other spaces.
let navigationDrag: NavigationDrag | null = null;
const navigationDragResets = new Set<() => void>();
function clearNavigationDrag() { navigationDrag = null; navigationDragResets.forEach(reset => reset()); }
function useNavigationDragReset(enabled: boolean, reset: () => void) {
  const latest = useRef(reset); latest.current = reset;
  useEffect(() => {
    if (!enabled) return;
    const clear = () => latest.current(); navigationDragResets.add(clear);
    return () => { navigationDragResets.delete(clear); };
  }, [enabled]);
}
function activeDrag(editor: NavigationEditor | undefined, element: HTMLElement) {
  return editor && !editor.busy && navigationDrag?.spaceId === editor.spaceId && navigationDrag.ownerDocument === element.ownerDocument ? navigationDrag : null;
}
function dragScroll(element: HTMLElement, clientY: number) {
  const win = element.ownerDocument.defaultView;
  if (!win) return;
  const selectors = '.lh-folder-body,.lh-category-list,.lh-side-content,.lh-grid-scroll,.lh-home-scroll';
  const viewport = element.closest<HTMLElement>('.lh-home-scroll,.lh-folder-body')?.getBoundingClientRect();
  let scrollable = element.closest<HTMLElement>(selectors);
  while (scrollable) {
    if (scrollable.scrollHeight > scrollable.clientHeight && ['auto', 'scroll'].includes(win.getComputedStyle(scrollable).overflowY)) {
      const box = scrollable.getBoundingClientRect();
      const top = Math.max(box.top, viewport?.top || 0), bottom = Math.min(box.bottom, viewport?.bottom || win.innerHeight);
      const delta = clientY < top + 32 ? -18 : clientY > bottom - 32 ? 18 : 0;
      if (delta && (delta < 0 ? scrollable.scrollTop > 0 : scrollable.scrollTop + scrollable.clientHeight < scrollable.scrollHeight - 1)) {
        scrollable.scrollBy({ top: delta }); return;
      }
    }
    scrollable = scrollable.parentElement?.closest<HTMLElement>(selectors) || null;
  }
}
function NavigationDragHandle({ kind, id, name, editor }: { kind: 'link' | 'category'; id: string; name: string; editor: NavigationEditor }) {
  const [dragging, setDragging] = useState(false);
  useNavigationDragReset(true, () => setDragging(false));
  const label = kind === 'link' ? t('拖动链接 {name}', 'Drag link {name}', { name }) : t('拖动分类 {name}', 'Drag category {name}', { name });
  useEffect(() => () => { if (navigationDrag?.id === id && navigationDrag.spaceId === editor.spaceId) clearNavigationDrag(); }, [id, editor.spaceId]);
  return <button type="button" className={`lh-nav-drag-handle${dragging ? ' is-dragging' : ''}`} draggable={!editor.busy} disabled={editor.busy} aria-label={label} title={label}
    onClick={event => event.stopPropagation()}
    onDragStart={event => {
      if (editor.busy) { event.preventDefault(); return; }
      event.stopPropagation();
      clearNavigationDrag();
      navigationDrag = { kind, id, spaceId: editor.spaceId, ownerDocument: event.currentTarget.ownerDocument };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-lingshu-navigation', JSON.stringify({ kind, id, spaceId: editor.spaceId }));
      const visual = event.currentTarget.closest<HTMLElement>(kind === 'link' ? '.lh-bookmark' : '.lh-group-heading,.lh-category-row');
      if (visual) event.dataTransfer.setDragImage(visual, 16, 16);
      setDragging(true);
    }}
    onDragEnd={event => { event.stopPropagation(); clearNavigationDrag(); }}><GripVertical size={15} aria-hidden="true" /></button>;
}
function canonicalAfterLink(editor: NavigationEditor, target: NavigationLink, movingId: string) {
  const links = navigationIndex(editor.navigation).links.filter(link => (link.categoryId || null) === (target.categoryId || null) && link.id !== movingId);
  const at = links.findIndex(link => link.id === target.id);
  return at < 0 ? undefined : links[at + 1]?.id || null;
}
function categoryDrop(editor: NavigationEditor, category: NavigationCategory, drag: NavigationDrag, after: boolean) {
  const index = navigationIndex(editor.navigation), source = index.byId.get(drag.id);
  if (drag.kind !== 'category' || !source || source.id === category.id || (source.parentId || null) !== (category.parentId || null)) return undefined;
  if (!after) return category.id;
  const siblings = index.categories.filter(item => (item.parentId || null) === (category.parentId || null) && item.id !== source.id);
  return siblings[siblings.findIndex(item => item.id === category.id) + 1]?.id || null;
}
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

export function CategoryPanel({ data, filter, onChange, orientation = 'vertical', settings = defaultCategoryNavigationSettings, collapsed = false, onCollapsedChange, stateKey = '', theme = 'light', persistState = true, editor }: {
  data: NavigationCollection; filter: NavigationFilter; onChange: (filter: NavigationFilter) => void; orientation?: 'vertical' | 'horizontal';
  settings?: CategoryNavigationSettings; collapsed?: boolean; onCollapsedChange?: (collapsed: boolean) => void; stateKey?: string; theme?: 'light' | 'dark'; persistState?: boolean; editor?: NavigationEditor;
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
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' | 'inside' } | null>(null);
  useNavigationDragReset(!!editor, () => setDropTarget(null));
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
  const acceptCategoryDrop = (event: DragEvent<HTMLDivElement>, category: NavigationCategory, commit = false) => {
    const drag = activeDrag(editor, event.currentTarget);
    if (!editor || !drag) return;
    const box = event.currentTarget.getBoundingClientRect(), after = horizontal ? event.clientX > box.left + box.width / 2 : event.clientY > box.top + box.height / 2;
    const beforeId = drag.kind === 'category' ? categoryDrop(editor, category, drag, after) : null;
    if (beforeId === undefined) { event.dataTransfer.dropEffect = 'none'; return; }
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    if (commit) {
      setDropTarget(null);
      if (drag.kind === 'link') editor.onMoveLink(drag.id, category.id, null);
      else editor.onMoveCategory(drag.id, beforeId);
      clearNavigationDrag();
    } else {
      const side = drag.kind === 'link' ? 'inside' : after ? 'after' : 'before';
      setDropTarget(previous => previous?.id === category.id && previous.side === side ? previous : { id: category.id, side });
      dragScroll(event.currentTarget, event.clientY);
    }
  };
  const categoryItem = (category: NavigationCategory, depth = 0): ReactElement | null => {
    if (visited.has(category.id)) return null; visited.add(category.id);
    const children = tree ? index.children.get(category.id) || [] : [];
    const path = index.paths.get(category.id) || category.name;
    const isActiveAncestor = activeAncestors.has(category.id);
    const expanded = isActiveAncestor || branches[category.id] !== false;
    const groupId = `${idPrefix}-${encodeURIComponent(category.id)}`;
    const count = index.counts.get(category.id) || 0;
    return <li key={category.id} className="lh-category-node" data-category-id={category.id} style={{ '--lh-category-depth': Math.min(depth, 5) } as CSSProperties}>
      <div className={`lh-category-row${editor ? ' is-content-editable' : ''}`} data-drop-side={dropTarget?.id === category.id ? dropTarget.side : undefined}
        onDragOver={editor ? event => acceptCategoryDrop(event, category) : undefined} onDrop={editor ? event => acceptCategoryDrop(event, category, true) : undefined}
        onDragLeave={editor ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(previous => previous?.id === category.id ? null : previous); } : undefined}>
        {editor && !iconsOnly && <NavigationDragHandle kind="category" id={category.id} name={category.name} editor={editor} />}
        {hint(countLabel(path, count), <button className="lh-category-select" type="button" aria-label={path} aria-pressed={filter.categoryId === category.id} title={iconsOnly ? undefined : path}
          onClick={() => onChange({ ...filter, categoryId: filter.categoryId === category.id ? null : category.id, favoritesOnly: false })}>
          {mode !== 'text' && <NavigationIcon name={category.icon} size={17} />}<span className="lh-category-name">{tree ? category.name : path}</span>{settings.showCounts && <b aria-hidden="true">{count.toLocaleString(locale)}</b>}
        </button>)}
        {editor && !iconsOnly && <button type="button" className="lh-nav-edit-button" disabled={editor.busy} aria-label={t('编辑分类 {name}', 'Edit category {name}', { name: path })} title={t('编辑分类', 'Edit category')} onClick={() => editor.onEditCategory(category.id)}><Pencil size={13} aria-hidden="true" /></button>}
        {!!children.length && <button className="lh-category-disclosure" type="button" aria-label={expanded ? t('收起 {name} 的子分类', 'Collapse subcategories of {name}', { name: path }) : t('展开 {name} 的子分类', 'Expand subcategories of {name}', { name: path })} aria-expanded={expanded} aria-controls={groupId} aria-disabled={isActiveAncestor || undefined}
          title={isActiveAncestor ? t('当前选中分类位于此目录中；选择其他分类后可收起。', 'The selected category is in this branch. Select another category to collapse it.') : expanded ? t('收起子分类', 'Collapse subcategories') : t('展开子分类', 'Expand subcategories')} onClick={() => { if (!isActiveAncestor) changeBranch(category.id, !expanded); }}><ChevronDown size={13} /></button>}
      </div>
      {!!children.length && <ul id={groupId} className="lh-category-children" hidden={!expanded}>{expanded && children.map(child => categoryItem(child, depth + 1))}</ul>}
    </li>;
  };
  const categoryItems = (tree ? index.roots : index.categories).map(category => categoryItem(category));
  const collapseLabel = collapsed ? t('展开分类导航', 'Expand category navigation') : t('收起分类导航', 'Collapse category navigation');
  return <Tooltip.Provider delayDuration={220} skipDelayDuration={100}><nav className={`lh-categories is-${orientation} is-${mode}${collapsed && canCollapse ? ' is-collapsed' : ''}`} aria-label={t('导航分类', 'Navigation categories')} data-state-key={stateKey} data-content-editing={!!editor || undefined}>
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

const BookmarkItem = memo(function BookmarkItem({ link, directory, presentation, canEdit, onFavorite, pending, editor, sortable = true, clickSpaceId }: {
  link: NavigationLink; directory: boolean; presentation: NavigationAppearanceSettings; canEdit: boolean;
  onFavorite: (link: NavigationLink) => void; pending?: string; editor?: NavigationEditor; sortable?: boolean; clickSpaceId?: string;
}) {
  const { preview } = useHomeEnvironment();
  const routing = useBookmarkEndpointRouting(link);
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null);
  useNavigationDragReset(!!editor, () => setDropSide(null));
  const href = routing.href, inert = preview || !!editor;
  const routes = link.endpoints.filter(endpoint => endpoint.route === 'internal' || endpoint.route === 'external');
  const additional = link.endpoints.filter(endpoint => endpoint.route !== 'internal' && endpoint.route !== 'external');
  const endpointLink = (endpoint: NavigationLink['endpoints'][number], i: number) => {
    const url = safeLink(endpoint.url); if (!url) return null;
    const role = endpoint.route === 'internal' ? t('内网', 'Internal') : t('外网', 'External');
    const manualLabel = endpoint.route === 'internal' ? t('手动打开内网入口 {name}', 'Open internal route {name} manually', { name: endpoint.label }) : endpoint.route === 'external' ? t('手动打开外网入口 {name}', 'Open external route {name} manually', { name: endpoint.label }) : undefined;
    if (editor) return <span className="lh-edit-endpoint" key={endpoint.label+i}>{endpoint.route && <span className="lh-endpoint-role">{role}</span>}<span className="lh-endpoint-name">{endpoint.label}</span></span>;
    return <a href={inert ? undefined : url} role={inert ? 'link' : undefined} aria-disabled={inert || undefined} aria-label={manualLabel} title={manualLabel || endpoint.label}
      data-route={endpoint.route} tabIndex={inert ? 0 : undefined} key={endpoint.label+i} target={inert ? undefined : '_blank'} rel={inert ? undefined : 'noopener noreferrer'}
      onClick={event => { recordLinkClick(clickSpaceId, link.id, endpoint.route === 'internal' || endpoint.route === 'external' ? endpoint.route : 'additional', event, inert); routing.cancel(); }}
      onAuxClick={event => { recordLinkClick(clickSpaceId, link.id, endpoint.route === 'internal' || endpoint.route === 'external' ? endpoint.route : 'additional', event, inert); if (event.button === 1) routing.cancel(); }}>
      {endpoint.route && <span className="lh-endpoint-role">{role}</span>}<span className="lh-endpoint-name">{endpoint.label}</span><ArrowUpRight size={10} />
    </a>;
  };
  const acceptDrop = (event: DragEvent<HTMLElement>, commit = false) => {
    const drag = activeDrag(editor, event.currentTarget);
    if (!editor || !sortable || drag?.kind !== 'link') return;
    if (drag.id === link.id) { event.stopPropagation(); event.dataTransfer.dropEffect = 'none'; return; }
    const box = event.currentTarget.getBoundingClientRect();
    const after = directory ? event.clientY > box.top + box.height / 2 : event.clientX > box.left + box.width / 2;
    const beforeId = after ? canonicalAfterLink(editor, link, drag.id) : link.id;
    if (beforeId === undefined) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    if (commit) {
      setDropSide(null); editor.onMoveLink(drag.id, link.categoryId || null, beforeId); clearNavigationDrag();
    } else {
      setDropSide(after ? 'after' : 'before'); dragScroll(event.currentTarget, event.clientY);
    }
  };
  let host = ''; try { host = new URL(link.url).host.replace(/^www\./, ''); } catch { host = link.url; }
  const description = presentation.descriptionLines > 0 && !!link.description;
  const showURL = presentation.urlDisplay === 'always' || presentation.urlDisplay === 'fallback' && !description;
  // Keep a manual recovery route available when the browser blocked opening a tab.
  const showEndpoints = presentation.showEndpoints || routing.state !== 'idle' && routing.state !== 'pending';
  return <article className={`lh-bookmark ${directory ? 'is-directory' : ''}${editor ? ' is-content-editable' : ''}${editor?.selectedLinkId === link.id ? ' is-content-selected' : ''}`} data-link-id={link.id} data-routing={routing.state}
    data-drop-side={dropSide || undefined} data-drop-axis={directory ? 'y' : 'x'}
    onDragOver={editor && sortable ? event => acceptDrop(event) : undefined} onDrop={editor && sortable ? event => acceptDrop(event, true) : undefined}
    onDragLeave={editor ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSide(null); } : undefined}>
    {editor && sortable && <NavigationDragHandle kind="link" id={link.id} name={link.title} editor={editor} />}
    <div className="lh-bookmark-icon"><NavigationIcon name={link.icon} size={directory ? 18 : 21} /></div>
    <div className="lh-bookmark-body">
      {editor ? <button type="button" className="lh-bookmark-title lh-bookmark-edit-title" disabled={editor.busy} aria-label={t('编辑链接 {name}', 'Edit link {name}', { name: link.title })} aria-pressed={editor.selectedLinkId === link.id} title={link.title} onClick={event => { event.stopPropagation(); editor.onEditLink(link.id); }}><span>{link.title}</span><Pencil size={13} aria-hidden="true" /></button>
        : href ? <a className="lh-bookmark-title" href={inert ? undefined : href} role={inert ? 'link' : undefined} aria-disabled={inert || undefined} aria-busy={routing.state === 'pending' || undefined} tabIndex={inert ? 0 : undefined} target={inert ? undefined : '_blank'} rel={inert ? undefined : 'noopener noreferrer'} title={link.title}
          onClick={event => { recordLinkClick(clickSpaceId, link.id, 'primary', event, inert); routing.onClick(event); }} onPointerDown={routing.refreshNativeHref} onKeyDown={routing.refreshNativeHref}
          onAuxClick={event => { routing.refreshNativeHref(event); recordLinkClick(clickSpaceId, link.id, 'primary', event, inert); }}><span>{link.title}</span><ArrowUpRight size={13} /></a> : <span className="lh-bookmark-title" title={t('链接地址不可用', 'Link URL unavailable')}>{link.title}</span>}
      {description && <p className="lh-bookmark-description" title={link.description}>{link.description}</p>}
      {showURL && <p className="lh-bookmark-url" title={link.url}>{host}</p>}
      {showEndpoints && !!routes.length && <div className="lh-endpoints lh-network-endpoints" aria-label={t('手动选择网络入口', 'Choose a network route manually')}>{routes.map(endpointLink)}</div>}
      {showEndpoints && !!additional.length && <div className="lh-endpoints lh-additional-endpoints">{additional.map(endpointLink)}</div>}
      {!editor && routing.state !== 'idle' && <p className="lh-routing-status" role="status">{routing.state === 'pending' ? t('正在选择入口…', 'Choosing a route…') : t('未能打开新页面，请直接选择入口重试。', 'The new page could not be opened. Choose a route directly to retry.')}</p>}
      {(presentation.showTags === true || presentation.showTags === null && !directory) && !!link.tags.length && <div className="lh-bookmark-tags">{link.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div>}
    </div>
    {canEdit && !inert ? <button className={`lh-favorite-button ${link.isFavorite ? 'is-active' : ''}`} title={link.isFavorite ? t('取消收藏', 'Remove favorite') : t('收藏链接', 'Favorite link')} aria-label={link.isFavorite ? t('取消收藏 {name}', 'Remove {name} from favorites', { name: link.title }) : t('收藏 {name}', 'Favorite {name}', { name: link.title })} aria-pressed={link.isFavorite} disabled={pending === link.id} onClick={() => onFavorite(link)}><Star size={14} /></button>
      : link.isFavorite && <Star className="lh-favorite-indicator" size={13} aria-label={t('已收藏', 'Favorited')} />}
  </article>;
});


type NavigationFolderTheme = { style: CSSProperties; theme?: string; pageTheme?: string; density?: string }
function navigationFolderTheme(element: HTMLElement | null): NavigationFolderTheme {
  const home = element?.closest<HTMLElement>('.lh-home'), hostWindow = element?.ownerDocument.defaultView
  const values: Record<string, string> = {}
  if (element && hostWindow) {
    const computed = hostWindow.getComputedStyle(element)
    for (let index = 0; index < computed.length; index++) { const name = computed.item(index); if (name.startsWith('--lh-')) values[name] = computed.getPropertyValue(name) }
  }
  return { style: values as CSSProperties, theme: home?.dataset.theme, pageTheme: home?.dataset.pageTheme, density: home?.dataset.density }
}
function EditableCategoryTitle({ category, path, editor }: { category: NavigationCategory; path: string; editor: NavigationEditor }) {
  const [renaming, setRenaming] = useState(false), original = useRef(category.name), input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) { input.current?.focus(); input.current?.select(); } }, [renaming]);
  return renaming ? <input ref={input} className="lh-category-name-input" aria-label={t('分类名称', 'Category name')} maxLength={80} disabled={editor.busy} value={category.name}
    onChange={event => editor.onRenameCategory(category.id, event.target.value)} onBlur={() => setRenaming(false)}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); setRenaming(false); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editor.onRenameCategory(category.id, original.current); setRenaming(false); }
    }} /> : <button type="button" className="lh-category-rename" disabled={editor.busy} aria-label={t('重命名分类 {name}', 'Rename category {name}', { name: category.name })} title={t('重命名分类', 'Rename category')}
      onClick={() => { original.current = category.name; setRenaming(true); }}>{path || t('未命名分类', 'Unnamed category')}<Pencil size={12} aria-hidden="true" /></button>;
}
type NavigationGroupData = { id: string; name: string; icon: string; links: NavigationLink[]; category?: NavigationCategory };
function NavigationGroup({ group, presentation, variant, linkAppearance, favorites, matching, canEdit, onFavorite, pending, editor, scopeKey, clickSpaceId }: {
  group: NavigationGroupData; presentation: NavigationAppearanceSettings;
  variant: 'cards' | 'directory'; linkAppearance: LinkAppearance; favorites: boolean; matching: boolean;
  canEdit: boolean; onFavorite: (link: NavigationLink) => void; pending?: string; editor?: NavigationEditor; scopeKey: string; clickSpaceId?: string;
}) {
  const locale = getLocale(), { preview, viewportWindow } = useHomeEnvironment();
  const groupElement = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), scrollBody = useRef<HTMLDivElement>(null), openingLinkEditor = useRef(false);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const [dropSide, setDropSide] = useState<'before' | 'after' | 'inside' | null>(null);
  useNavigationDragReset(!!editor, () => setDropSide(null));
  const [folderTheme, setFolderTheme] = useState<NavigationFolderTheme>({ style: {} });
  const editable = !!editor && !favorites;
  const visible = useMemo(() => navigationGroupPreview(group.links, favorites ? 0 : presentation.groupPreviewCount), [group.links, favorites, presentation.groupPreviewCount]);
  const folder = useMemo(() => navigationFolderPage(group.links, query, page, locale), [group.links, query, page, locale]);
  // A content draft can reorder or update records without losing the folder's
  // search/page/focus. A real filter or category change still closes that view.
  const context = useMemo(() => editor ? JSON.stringify([editor.spaceId, group.id, scopeKey]) : JSON.stringify([group.id, ...group.links.map(link => link.id)]), [editor?.spaceId, !!editor, group.id, scopeKey, group.links]);
  useEffect(() => { setOpen(false); setQuery(''); setPage(1); }, [context]);
  useEffect(() => { if (scrollBody.current) scrollBody.current.scrollTop = 0; }, [folder.page, query]);
  const count = (value: number) => value.toLocaleString(locale);
  function changeOpen(value: boolean) {
    if (value) { setFolderTheme(navigationFolderTheme(groupElement.current)); if (!editor) { setQuery(''); setPage(1); } }
    setOpen(value);
  }
  const folderEditor = editor ? { ...editor, onEditLink: (id: string) => { openingLinkEditor.current = true; setOpen(false); editor.onEditLink(id); } } : undefined;
  const renderLink = (link: NavigationLink, inFolder = false) => <BookmarkItem key={link.id} link={link} directory={variant === 'directory'} presentation={presentation} canEdit={canEdit} onFavorite={onFavorite} pending={pending} editor={inFolder ? folderEditor : editor} sortable={!favorites} clickSpaceId={clickSpaceId}/>;
  const acceptDrop = (event: DragEvent<HTMLElement>, commit = false) => {
    const drag = activeDrag(editor, event.currentTarget);
    if (!editor || !editable || !drag) return;
    let beforeId: string | null | undefined = null, after = false;
    if (drag.kind === 'category') {
      if (!group.category) return;
      const box = event.currentTarget.getBoundingClientRect(); after = event.clientY > box.top + box.height / 2;
      beforeId = categoryDrop(editor, group.category, drag, after);
      if (beforeId === undefined) { event.dataTransfer.dropEffect = 'none'; return; }
    }
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    if (commit) {
      setDropSide(null);
      if (drag.kind === 'link') editor.onMoveLink(drag.id, group.category?.id || null, null);
      else editor.onMoveCategory(drag.id, beforeId);
      clearNavigationDrag();
    } else {
      setDropSide(drag.kind === 'link' ? 'inside' : after ? 'after' : 'before');
      dragScroll(event.currentTarget, event.clientY);
    }
  };
  return <DialogPrimitive.Root open={open} onOpenChange={changeOpen} modal={!preview && !editor}>
    <section ref={groupElement} className={'lh-link-group ' + (favorites ? 'lh-favorites-group' : '') + (group.links.length <= 3 && variant !== 'directory' ? ' is-sparse' : '') + (editable ? ' is-content-editable' : '')}
      aria-label={group.name} data-category-id={group.category?.id || (favorites ? undefined : 'uncategorized')} data-drop-side={dropSide || undefined} style={{ '--lh-link-count': Math.max(1, visible.visible.length) } as CSSProperties}
      onDragOver={editable ? event => acceptDrop(event) : undefined} onDrop={editable ? event => acceptDrop(event, true) : undefined}
      onDragLeave={editable ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSide(null); } : undefined}>
      {(presentation.showGroupTitles || editable) && <div className="lh-group-heading">
        {editor && group.category && <NavigationDragHandle kind="category" id={group.category.id} name={group.category.name} editor={editor} />}
        {editor && group.category ? <button type="button" className="lh-nav-edit-button lh-group-icon" disabled={editor.busy} aria-label={t('编辑分类图标 {name}', 'Edit category icon {name}', { name: group.category.name })} onClick={() => editor.onEditCategory(group.category!.id)}><NavigationIcon name={group.icon} size={17}/></button> : <span className="lh-group-icon"><NavigationIcon name={group.icon} size={17}/></span>}
        <h2>{editor && group.category ? <EditableCategoryTitle category={group.category} path={group.name} editor={editor}/> : group.name}</h2>
        {presentation.showCounts && <span className="lh-count">{count(group.links.length)}</span>}
        {editor && group.category && <button type="button" className="lh-nav-edit-button lh-category-more" disabled={editor.busy} aria-label={t('编辑分类 {name}', 'Edit category {name}', { name: group.category.name })} title={t('分类设置', 'Category settings')} onClick={() => editor.onEditCategory(group.category!.id)}><MoreHorizontal size={16} aria-hidden="true" /></button>}
      </div>}
      <div className={'lh-links ' + (variant === 'directory' ? 'is-directory' : '')}>
        {visible.visible.map(link => renderLink(link))}
        {editable && !group.links.length && <div className="lh-empty-category-target" aria-label={t('移入分类 {name}', 'Move into category {name}', { name: group.name })}><Folder size={18} aria-hidden="true"/><span>{t('暂无链接', 'No links yet')}</span></div>}
        {visible.hiddenCount > 0 && <DialogPrimitive.Trigger asChild><button ref={trigger} type="button" className="lh-folder-more"
          aria-label={t('打开“{name}”，查看全部 {count} 个书签', 'Open {name}, view all {count} bookmarks', { name: group.name, count: count(group.links.length) })}
          onClick={event => event.stopPropagation()}>
          <Folder size={22} aria-hidden="true"/><span className="lh-folder-more-copy"><strong>{t('查看全部', 'View all')}</strong><small>{matching ? t('还有 {count} 个匹配项', '{count} more matches', { count: count(visible.hiddenCount) }) : t('还有 {count} 个书签', '{count} more bookmarks', { count: count(visible.hiddenCount) })}</small></span><ChevronRight size={17} aria-hidden="true"/>
        </button></DialogPrimitive.Trigger>}
      </div>
    </section>
    {open && <DialogPrimitive.Portal container={viewportWindow?.document.body || trigger.current?.ownerDocument.body}>
      <div className="lh-home lh-folder-portal" data-theme={folderTheme.theme} data-page-theme={folderTheme.pageTheme} data-density={folderTheme.density} style={folderTheme.style}>
        <DialogPrimitive.Overlay className="lh-folder-overlay"/>
        <DialogPrimitive.Content className="lh-folder-dialog lh-navigation-panel" aria-describedby={undefined}
          data-link-appearance={linkAppearance} data-content-density={presentation.density}
          data-drop-side={dropSide === 'inside' ? 'inside' : undefined}
          data-show-tags={presentation.showTags === null ? undefined : String(presentation.showTags)} data-description-lines={presentation.descriptionLines}
          onDragOver={editable ? event => { if (activeDrag(editor, event.currentTarget)?.kind === 'link') acceptDrop(event); } : undefined}
          onDrop={editable ? event => { if (activeDrag(editor, event.currentTarget)?.kind === 'link') acceptDrop(event, true); } : undefined}
          onDragLeave={editable ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSide(null); } : undefined}
          onOpenAutoFocus={event => { if (search.current) { event.preventDefault(); search.current.focus({ preventScroll: true }); } }}
          onCloseAutoFocus={event => { if (openingLinkEditor.current) { openingLinkEditor.current = false; event.preventDefault(); return; } if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus({ preventScroll: true }); } }}>
          <header className="lh-folder-header"><div className="lh-folder-heading"><span className="lh-folder-heading-icon"><Folder size={24} aria-hidden="true"/></span><div><DialogPrimitive.Title>{group.name}</DialogPrimitive.Title><p>{matching ? t('{count} 个匹配的书签', '{count} matching bookmarks', { count: count(group.links.length) }) : t('{count} 个书签', '{count} bookmarks', { count: count(group.links.length) })}</p></div></div><DialogPrimitive.Close asChild><button type="button" className="lh-folder-icon-button" aria-label={t('关闭书签文件夹', 'Close bookmark folder')}><X size={20} aria-hidden="true"/></button></DialogPrimitive.Close></header>
          <div className="lh-folder-search"><Search size={17} aria-hidden="true"/><input ref={search} type="search" value={query} aria-label={matching ? t('搜索当前匹配结果', 'Search current matches') : t('搜索此分类的书签', 'Search bookmarks in this category')} placeholder={t('搜索名称、网址或标签', 'Search name, URL or tags')} onChange={event => { setQuery(event.target.value); setPage(1); }}/>
            {query && <button type="button" className="lh-folder-icon-button" aria-label={t('清空分类搜索', 'Clear folder search')} onClick={() => { setQuery(''); setPage(1); search.current?.focus(); }}><X size={16} aria-hidden="true"/></button>}
          </div>
          <div className="lh-folder-body" ref={scrollBody}>{folder.count ? <div className="lh-folder-grid">{folder.items.map(link => renderLink(link, true))}</div> : <div className="lh-folder-empty"><Search size={26} aria-hidden="true"/><p>{t('没有匹配的书签', 'No matching bookmarks')}</p><button type="button" onClick={() => { setQuery(''); setPage(1); search.current?.focus(); }}>{t('清空搜索', 'Clear search')}</button></div>}</div>
          <nav className="lh-folder-pagination" aria-label={t('分类书签分页', 'Category bookmark pagination')}><span aria-live="polite">{t('{start}–{end} / {count}', '{start}–{end} / {count}', { start: count(folder.start), end: count(folder.end), count: count(folder.count) })}</span><div><button type="button" className="lh-folder-icon-button" disabled={folder.page <= 1} aria-label={t('上一页书签', 'Previous bookmark page')} onClick={() => setPage(folder.page - 1)}><ChevronLeft size={18} aria-hidden="true"/></button><span>{t('第 {page} / {pages} 页', 'Page {page} / {pages}', { page: count(folder.page), pages: count(folder.pageCount) })}</span><button type="button" className="lh-folder-icon-button" disabled={folder.page >= folder.pageCount} aria-label={t('下一页书签', 'Next bookmark page')} onClick={() => setPage(folder.page + 1)}><ChevronRight size={18} aria-hidden="true"/></button></div></nav>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>}
  </DialogPrimitive.Root>;
}

export function NavigationPanel({ data, filter, title, variant = 'cards', linkAppearance = 'icon-text', settings, favorites = false, canEdit = false, onFavorite, pending, onClear, emptyActions, editor, clickSpaceId }: {
  data: NavigationCollection; filter: NavigationFilter; title?: string; variant?: 'cards' | 'directory'; linkAppearance?: LinkAppearance; favorites?: boolean;
  settings?: Record<string, unknown>; canEdit?: boolean; onFavorite: (link: NavigationLink) => void; pending?: string; onClear?: () => void; editor?: NavigationEditor; clickSpaceId?: string;
  emptyActions?: { scope: string; onAdd: () => void; onImport: () => void };
}) {
  const locale = getLocale();
  const presentation = useMemo(() => readNavigationAppearanceSettings(settings), [settings]);
  const links = useMemo(() => filteredLinks(data, filter, favorites), [data, filter, favorites, locale]);
  const scopeKey = JSON.stringify([filter.search, filter.categoryId, filter.favoritesOnly, favorites]);
  const groups = useMemo<NavigationGroupData[]>(() => {
    if (favorites) return [{ id: 'favorites', name: title || t('常用收藏', 'Favorites'), icon: 'star', links }];
    const index = navigationIndex(data), byCategory = new Map<string, NavigationLink[]>();
    for (const link of links) { const key = link.categoryId && index.byId.has(link.categoryId) ? link.categoryId : ''; const items = byCategory.get(key) || []; items.push(link); byCategory.set(key, items); }
    const groups: NavigationGroupData[] = [], visited = new Set<string>(), ordered: NavigationCategory[] = [], stack = [...index.roots].reverse();
    // Category order belongs to siblings. Traverse the hierarchy so moving a
    // parent also moves its descendant groups instead of interleaving levels.
    while (stack.length) { const category = stack.pop()!; if (visited.has(category.id)) continue; visited.add(category.id); ordered.push(category); stack.push(...(index.children.get(category.id) || []).slice().reverse()); }
    const showEmpty = !!editor && !filter.search.trim() && !filter.favoritesOnly;
    const selected = filter.categoryId ? descendants(index, filter.categoryId) : null;
    for (const category of ordered) {
      const items = byCategory.get(category.id) || [];
      if (items.length || showEmpty && (!selected || selected.has(category.id))) groups.push({ id: category.id, name: index.paths.get(category.id) || category.name, icon: category.icon, links: items, category });
    }
    const others = byCategory.get('') || []; if (others.length || showEmpty && !selected) groups.push({ id: 'uncategorized', name: t('未分类', 'Uncategorized'), icon: 'folder', links: others });
    return groups;
  }, [data, links, favorites, title, locale, !!editor, scopeKey]);
  if (!links.length && favorites) return <section className="lh-favorites-empty" aria-label={title || t('常用收藏', 'Favorites')}><Star size={16} /><h2>{title || t('常用收藏', 'Favorites')}</h2><span>{filter.search || filter.categoryId || filter.favoritesOnly ? t('当前筛选下无收藏', 'No favorites match these filters') : t('暂无收藏', 'No favorites yet')}</span></section>;
  if (!links.length && !(editor && groups.length)) {
    const filtered = !!(filter.search || filter.categoryId || filter.favoritesOnly);
    const actions = !filtered && !data.links.length ? emptyActions : undefined;
    return <section className="lh-panel lh-panel-empty"><Folder size={28} /><strong>{filtered ? t('没有匹配的链接', 'No matching links') : t('暂无链接', 'No links yet')}</strong>
      <p>{filtered ? t('调整关键词或分类。', 'Try a different search or category.') : actions ? actions.scope : t('当前数据范围内没有可显示的链接。', 'There are no links to display in this collection.')}</p>
      {actions && <><button className="lh-primary-button" type="button" onClick={actions.onAdd}>{t('添加第一个链接', 'Add your first link')}<ChevronRight size={14} /></button><button className="lh-text-button" type="button" onClick={actions.onImport}>{t('导入浏览器书签', 'Import browser bookmarks')}<ChevronRight size={14} /></button></>}
      {onClear && filtered && <button className="lh-text-button" type="button" onClick={onClear}>{t('清除筛选', 'Clear filters')}<ChevronRight size={14} /></button>}
    </section>;
  }
  return <div className={`lh-navigation-panel ${variant === 'directory' ? 'lh-directory-groups' : 'lh-card-groups'}`} data-link-appearance={linkAppearance} data-content-editing={!!editor || undefined}
    data-max-columns={presentation.maxColumns || undefined} data-content-density={presentation.density}
    data-show-tags={presentation.showTags === null ? undefined : String(presentation.showTags)}
    data-description-lines={presentation.descriptionLines}
    style={{ '--lh-max-columns': presentation.maxColumns || undefined, '--lh-description-lines': presentation.descriptionLines || 1 } as CSSProperties}>
    {title && !favorites && <div className="lh-panel-heading lh-custom-panel-title"><h2>{title}</h2>{presentation.showCounts && <span>{t('{count} 个链接', '{count} links', { count: links.length.toLocaleString(locale) })}</span>}</div>}
    {groups.map(group => <NavigationGroup key={group.id} group={group} presentation={presentation} variant={variant} linkAppearance={linkAppearance} favorites={favorites} matching={!favorites && links.length !== data.links.length} canEdit={canEdit} onFavorite={onFavorite} pending={pending} editor={editor} scopeKey={scopeKey} clickSpaceId={clickSpaceId}/>)}
  </div>;
}
