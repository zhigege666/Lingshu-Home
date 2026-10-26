import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, Compass, LayoutGrid, List, LoaderCircle, Moon, Pencil, RefreshCw, Settings2, Sun, X } from 'lucide-react';
import { HomeGrid, type GridPosition } from './HomeGrid';
import { CategoryPanel, EMPTY_FILTER, NavigationPanel, SearchPanel, readNavigation, type NavigationCollection, type NavigationFilter, type NavigationLink } from './NavigationPanels';
import { ApiError, request as apiRequest } from '../core/api';
import { readCategoryNavigationSettings } from '../core/presentation';
import { readPageChrome } from '../core/chrome';
import { getPageTheme, readLinkAppearance } from '../core/themes';
import { useDraftDashboard } from '../core/useDraftDashboard';
import { useUnsavedChanges } from '../core/useUnsavedChanges';
import { createDraftHistory, inputHistoryGroup, recordDraft, redoDraft, undoDraft, type DraftHistory } from '../core/draft-history';
import { useHistoryShortcuts } from '../core/useHistoryShortcuts';
import { requestNavigation } from '../core/navigation';
import { sessionVerifiedEvent } from '../core/session-requests';
import { validatePageChrome } from '../core/chrome-validation';
import { panelLocked, panelTitle, type ComposerSource, type HomeSelection } from './composition';
import { getLocale, t } from '../core/i18n';
import { ProjectLogo } from '../components/ProjectLogo';
import AccountMenu from '../components/AccountMenu';
import { HomeEnvironment } from './HomeEnvironment';
import { DocumentActivityProvider } from './DocumentActivityProvider';
import { useHomeEndpointRouting } from './useEndpointRouting';
import { PageChromeArea } from './PageChrome';
import type { Bootstrap, Dashboard, Page, PageConfig, Placement, Region, View } from '../core/types';
import './homepage.css';
import './ios-theme.css';
import './link-appearance.css';
import './composer-canvas.css';
import './endpoint-routing.css';

type HomeProps = { bootstrap: Bootstrap; dashboard: Dashboard; onRefresh: () => Promise<void>; onSpaceChange: (spaceId: string) => void; onLogout?: () => Promise<void>; onProfile?: () => void; preview?: boolean; viewportWindow?: Window };
type EditDraft = { pageId: string; spaceId: string; identity: string; revision: string; history: DraftHistory<PageConfig>; original: PageConfig };
const SpaceSelect = lazy(() => import('./SpaceSelect'));
const HomeEditor = lazy(() => import('./HomeEditor'));
const DataPanel = lazy(() => import('./DataPanels'));
const DocumentActivityPanel = lazy(() => import('./DocumentActivityPanel'));
const TrafficPanel = lazy(() => import('./TrafficPanel').then(module => ({ default: module.TrafficPanel })));
const DiscardChangesDialog = lazy(() => import('../components/DiscardChangesDialog'));
const NO_SOURCES: ComposerSource[] = [];

class PanelBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="lh-panel lh-panel-empty"><strong>{t('{name} 暂时无法显示', '{name} is temporarily unavailable', { name: this.props.label })}</strong><p>{t('其他链接仍可使用。请刷新页面，或检查此积木的配置。', 'Other links are still available. Refresh the page or check this panel’s configuration.')}</p></div> : this.props.children; }
}
function useMedia(query: string, viewportWindow?: Window) {
  const [matches, setMatches] = useState(() => viewportWindow?.matchMedia(query).matches || false);
  useEffect(() => { const mq = viewportWindow?.matchMedia(query); if (!mq) return; const update = () => setMatches(mq.matches); update(); mq.addEventListener('change', update); return () => mq.removeEventListener('change', update); }, [query, viewportWindow]);
  return matches;
}
function panelName(view: View) { return panelTitle(view); }
function effectivePlacement(config: PageConfig, view: View, narrow: boolean): Placement {
  const entry = config.layout.placements[view.id];
  if (!entry) return { kind: 'hidden' };
  const position = narrow && entry.overrides?.narrow ? entry.overrides.narrow : entry.base;
  if (narrow && position.kind === 'grid') return { kind: 'flow', region: 'main', order: position.y * 24 + position.x };
  return position;
}
function orderOf(position: Placement) { return position.kind === 'hidden' ? 0 : position.kind === 'grid' ? position.y * 24 + position.x : position.order; }
function readCategoryCollapses(pageId: string): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`lh:category-panels:${pageId}`) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, collapsed]) => typeof collapsed === 'boolean')) : {};
  } catch { return {}; }
}

export function HomeView({ bootstrap, dashboard, onRefresh, onSpaceChange, onLogout, onProfile, preview = false, viewportWindow }: HomeProps) {
  const ownerWindow = viewportWindow || (typeof window === 'undefined' ? undefined : window);
  const viewportNarrow = useMedia('(max-width: 900px)', ownerWindow);
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [selection, setSelection] = useState<HomeSelection>({ kind: 'page' });
  const [editorPreview, setEditorPreview] = useState(false);
  const [previewCollapses, setPreviewCollapses] = useState<Record<string, boolean>>({});
  const [sourceState, setSourceState] = useState<{ spaceId: string; items: ComposerSource[] }>({ spaceId: dashboard.space.id, items: [] });
  const systemDark = useMedia('(prefers-color-scheme: dark)', ownerWindow);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [gridInteracting, setGridInteracting] = useState(false);
  const identity = `${bootstrap.user?.id || 'visitor'}:${bootstrap.mode}`;
  const canEdit = dashboard.space.canEdit && bootstrap.spaces.some(space => space.id === dashboard.space.id && space.canEdit);
  const editContext = `${identity}:${dashboard.space.id}:${dashboard.page.id}`;
  const currentContext = useRef(editContext); currentContext.current = editContext;
  const [filters, setFilters] = useState<Record<string, NavigationFilter>>({});
  const [temporaryVariant, setTemporaryVariant] = useState<'cards' | 'directory' | null>(null);
  const [temporaryColor, setTemporaryColor] = useState<'light' | 'dark' | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingData, setRefreshingData] = useState(false);
  const dataRefreshRunning = useRef(false), lastDataRead = useRef(Date.now());
  const saving = useRef(false);
  const favoriting = useRef(false);
  const [pendingFavorite, setPendingFavorite] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [categoryCollapseState, setCategoryCollapseState] = useState(() => ({ pageId: dashboard.page.id, preview, config: dashboard.page.config, values: preview ? {} : readCategoryCollapses(dashboard.page.id) }));
  const categoryCollapses = categoryCollapseState.pageId === dashboard.page.id && categoryCollapseState.preview === preview && (!preview || categoryCollapseState.config === dashboard.page.config) ? categoryCollapseState.values : preview ? {} : readCategoryCollapses(dashboard.page.id);
  const activeDraft = !preview && canEdit && draft?.identity === identity && draft.pageId === dashboard.page.id && draft.spaceId === dashboard.space.id ? draft : null;
  const config = activeDraft?.history.present || dashboard.page.config;
  const editing = activeDraft !== null;
  const inspecting = editing && !editorPreview;
  const narrow = canvasWidth > 0 ? canvasWidth <= 900 : viewportNarrow;
  const endpointRouting = useHomeEndpointRouting(bootstrap, dashboard.space.id, preview || editing, ownerWindow);
  const environment = useMemo(() => ({ preview: preview || editing, viewportWindow: ownerWindow, endpointRouting }), [preview, editing, ownerWindow, endpointRouting]);
  const sources = sourceState.spaceId === dashboard.space.id ? sourceState.items : NO_SOURCES;
  const updateSources = useCallback((items: ComposerSource[]) => setSourceState({ spaceId: dashboard.space.id, items }), [dashboard.space.id]);
  const { preview: resolvedDashboard, loading: loadingData, incomplete: incompleteData, failed: failedData, retry: retryData } = useDraftDashboard(dashboard, dashboard.page.name, config, sources);
  const datasets = resolvedDashboard.datasets;
  useLayoutEffect(() => {
    if (!canvasElement) return;
    const measure = () => setCanvasWidth(previous => { const width = canvasElement.getBoundingClientRect().width; return Math.abs(previous - width) < .5 ? previous : width; });
    measure(); const observer = new ResizeObserver(measure); observer.observe(canvasElement);
    return () => observer.disconnect();
  }, [canvasElement]);
  useEffect(() => { if (selection.kind === 'view' && !config.views.some(view => view.id === selection.id)) setSelection({ kind: 'page' }); }, [config.views, selection]);
  const dirty = useMemo(() => !!activeDraft && JSON.stringify(activeDraft.history.present) !== JSON.stringify(activeDraft.original), [activeDraft]);
  const leaveGuard = useUnsavedChanges(dirty && !preview, busy, () => {
    setDraft(current => current ? { ...current, history: createDraftHistory(current.original) } : current);
  });
  const chrome = useMemo(() => readPageChrome(config.chrome), [config.chrome]);
  const color = temporaryColor || (config.appearance.colorMode === 'system' ? (systemDark ? 'dark' : 'light') : config.appearance.colorMode);
  useEffect(() => { setDraft(null); setSelection({ kind: 'page' }); setEditorPreview(false); setFilters({}); setTemporaryVariant(null); setTemporaryColor(null); setNotice(null); }, [dashboard.space.id, dashboard.page.id, identity, canEdit, preview]);
  // Refreshing an admin draft must display its exact appearance, even after a
  // visitor tested a temporary viewing control inside the preview.
  useEffect(() => { if (preview) { setTemporaryVariant(null); setTemporaryColor(null); } }, [dashboard.page.config, preview]);

  const request = useCallback(async <T,>(path: string, body: unknown): Promise<T> => {
    try { return await apiRequest<T>(path, { method: 'PUT', body }); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409 && ['page_version_conflict', 'conflict'].includes(error.code)) throw new Error(t('页面已在其他窗口修改。你的草稿仍然保留；取消编辑以加载最新布局，再重新调整。', 'The page changed in another window. Your draft is still here. Cancel editing to load the latest layout before making your changes again.'));
      throw error;
    }
  }, []);

  const save = async () => {
    if (preview || !canEdit || !activeDraft || !dirty || saving.current || gridInteracting) return;
    const chromeIssue = validatePageChrome(activeDraft.history.present.chrome);
    if (chromeIssue) { setSelection({ kind: 'chrome', area: chromeIssue.area, alignment: chromeIssue.alignment }); setNotice({ kind: 'error', text: chromeIssue.message }); return; }
    saving.current = true; setBusy(true); setNotice(null);
    try {
      const saved = await request<Page>(`/spaces/${encodeURIComponent(activeDraft.spaceId)}/page`, { name: dashboard.page.name, expectedRevision: activeDraft.revision, config: activeDraft.history.present });
      if (currentContext.current !== editContext) return;
      const changedCategoryDefaults = saved.config.views.filter(view => {
        if (view.panel.id !== 'builtin/category-navigation') return false;
        const before = readCategoryNavigationSettings(activeDraft.original.views.find(item => item.id === view.id)?.settings);
        const after = readCategoryNavigationSettings(view.settings);
        return before.defaultCollapsed !== after.defaultCollapsed || before.displayMode !== after.displayMode || before.collapsible !== after.collapsible;
      }).map(view => view.id);
      if (changedCategoryDefaults.length) {
        // A just-saved category style should remain visible in this tab. Drop
        // only preferences that would override these explicitly changed defaults.
        const values = { ...categoryCollapses };
        for (const id of changedCategoryDefaults) delete values[id];
        setCategoryCollapseState({ pageId: activeDraft.pageId, preview: false, config: saved.config, values });
        try { sessionStorage.setItem(`lh:category-panels:${activeDraft.pageId}`, JSON.stringify(values)); } catch { /* Saving the page does not require browser storage. */ }
      }
      // If the read-after-save fails, retain the saved preview with its new
      // revision and a clean baseline. Retrying must not send the same draft twice.
      setDraft(current => current === activeDraft ? { ...current, revision: saved.revision, original: structuredClone(saved.config), history: createDraftHistory(saved.config) } : current);
      try { await onRefresh(); if (currentContext.current !== editContext) return; setDraft(null); setNotice({ kind: 'success', text: t('页面布局已保存。', 'Page layout saved.') }); }
      catch { if (currentContext.current !== editContext) return; setNotice({ kind: 'error', text: t('布局已经保存，但重新加载失败。当前画面保留了已保存内容；可稍后取消编辑并重试加载。', 'The layout was saved, but reloading failed. The saved layout remains visible. Cancel editing later to try reloading again.') }); }
    } catch (error) { if (currentContext.current !== editContext) return; setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('保存失败，草稿仍然保留。', 'Saving failed. Your draft is still here.') }); }
    finally { saving.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (preview || saving.current) return;
    saving.current = true; setBusy(true); setDraft(null); setNotice(null);
    try { await onRefresh(); }
    catch { if (currentContext.current === editContext) setNotice({ kind: 'error', text: t('重新加载失败，请稍后刷新页面。', 'Reloading failed. Please refresh the page later.') }); }
    finally { saving.current = false; setBusy(false); }
  };
  const changeDraft = (next: PageConfig) => {
    if (preview || !canEdit || saving.current || gridInteracting || currentContext.current !== editContext) return;
    const group = inputHistoryGroup(ownerWindow?.document);
    setDraft(current => current ? { ...current, history: recordDraft(current.history, next, group) } : current);
  };
  const restore = () => { if (!preview && canEdit && !saving.current && !gridInteracting) { setDraft(current => current ? { ...current, history: createDraftHistory(current.original) } : current); setNotice(null); } };
  const historyAction = (redo: boolean) => {
    if (!inspecting || !canEdit || saving.current || gridInteracting) return;
    setDraft(current => current ? { ...current, history: (redo ? redoDraft : undoDraft)(current.history) } : current);
    setNotice(null);
  };
  const canUndo = !!activeDraft?.history.past.length, canRedo = !!activeDraft?.history.future.length;
  useHistoryShortcuts({ enabled: inspecting && !busy && !gridInteracting, undo: () => historyAction(false), redo: () => historyAction(true), canUndo, canRedo, ownerWindow });
  const startEditing = () => {
    if (preview || !canEdit || busy || saving.current) return;
    const original = structuredClone(dashboard.page.config);
    setTemporaryVariant(null); setTemporaryColor(null); setNotice(null); setFilters({}); setSelection({ kind: 'page' }); setEditorPreview(false);
    setDraft({ pageId: dashboard.page.id, spaceId: dashboard.space.id, identity, revision: dashboard.page.revision, original, history: createDraftHistory(original) });
  };
  const favorite = useCallback(async (link: NavigationLink) => {
    if (preview || editing || !dashboard.space.canEdit || favoriting.current) return;
    favoriting.current = true; setPendingFavorite(link.id); setNotice(null);
    try {
      await request(`/spaces/${encodeURIComponent(dashboard.space.id)}/links/${encodeURIComponent(link.id)}`, { title: link.title, url: link.url, categoryId: link.categoryId, description: link.description,
        icon: link.icon, tags: link.tags, isFavorite: !link.isFavorite, sortOrder: link.sortOrder, endpoints: link.endpoints });
      await onRefresh();
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : t('收藏修改失败。', 'Updating the favorite failed.') }); }
    finally { favoriting.current = false; setPendingFavorite(undefined); }
  }, [preview, editing, request, onRefresh, dashboard.space.id, dashboard.space.canEdit]);

  const scopeData = useMemo(() => {
    const scopes = new Map<string, { categories: Map<string, NavigationCollection['categories'][number]>; links: Map<string, NavigationLink> }>();
    for (const view of config.views) {
      const data = readNavigation(datasets[view.inputs.collection]?.data); if (!data) continue;
      const scope = view.interactionScope || view.id;
      if (!scopes.has(scope)) scopes.set(scope, { categories: new Map(), links: new Map() });
      const group = scopes.get(scope)!; data.categories.forEach(c => group.categories.set(c.id, c)); data.links.forEach(l => group.links.set(l.id, l));
    }
    return new Map(Array.from(scopes, ([key,value]) => [key, { categories: [...value.categories.values()], links: [...value.links.values()] }]));
  }, [config.views, datasets]);
  const totals = useMemo(() => {
    const links = new Set<string>(), categories = new Set<string>();
    for (const data of scopeData.values()) { data.links.forEach(link => links.add(link.id)); data.categories.forEach(category => categories.add(category.id)); }
    return { links: links.size, categories: categories.size };
  }, [scopeData]);
  const positions = config.views.map(view => ({ view, placement: effectivePlacement(config, view, narrow) })).filter(item => item.placement.kind !== 'hidden');
  const hasExternalPanels = positions.some(({ view }) => Object.values(view.inputs).some(alias => config.bindings[alias]?.datasetId.startsWith('source:')));
  useEffect(() => { lastDataRead.current = Date.now(); }, [dashboard]);
  const readSavedData = useCallback(async () => {
    if (preview || editing || dataRefreshRunning.current) return;
    dataRefreshRunning.current = true; lastDataRead.current = Date.now(); setRefreshingData(true);
    try { await onRefresh(); } catch { setNotice({ kind: 'error', text: t('读取已保存内容失败，请稍后重试。', 'Could not read saved content. Try again later.') }); }
    finally { dataRefreshRunning.current = false; setRefreshingData(false); }
  }, [preview, editing, onRefresh]);
  useEffect(() => {
    if (preview || editing || !hasExternalPanels || !ownerWindow) return;
    const resumed = () => { if (ownerWindow.document.visibilityState === 'visible' && Date.now() - lastDataRead.current > 60000) void readSavedData(); };
    ownerWindow.addEventListener(sessionVerifiedEvent, resumed);
    return () => { ownerWindow.removeEventListener(sessionVerifiedEvent, resumed); };
  }, [preview, editing, hasExternalPanels, ownerWindow, readSavedData]);
  const region = (name: Region) => positions.filter(item => item.placement.kind !== 'hidden' && item.placement.region === name).sort((a,b) => orderOf(a.placement) - orderOf(b.placement));
  const top = region('top'), left = region('left'), right = region('right'), bottom = region('bottom'), main = region('main');
  const topSearch = top.filter(item => item.view.panel.id === 'builtin/search');
  const topOther = top.filter(item => item.view.panel.id !== 'builtin/search');
  const mainVariant = temporaryVariant || (config.views.find(view => view.panel.id === 'builtin/navigation')?.settings.variant === 'directory' ? 'directory' : 'cards');
  const categoryCollapsed = (view: View) => {
    const settings = readCategoryNavigationSettings(view.settings);
    const saved = editing && editorPreview ? previewCollapses[view.id] : !editing && Object.hasOwn(categoryCollapses, view.id) ? categoryCollapses[view.id] : undefined;
    return settings.displayMode !== 'icons' && settings.collapsible && (typeof saved === 'boolean' ? saved : settings.defaultCollapsed);
  };
  const changeCategoryCollapse = (viewId: string, collapsed: boolean) => {
    if (editing) {
      if (editorPreview) { setPreviewCollapses(previous => ({ ...previous, [viewId]: collapsed })); return; }
      if (!saving.current) setDraft(current => current ? { ...current, history: recordDraft(current.history, { ...current.history.present, views: current.history.present.views.map(view => view.id === viewId ? { ...view, settings: { ...view.settings, defaultCollapsed: collapsed } } : view) }) } : current);
      return;
    }
    const values = { ...categoryCollapses, [viewId]: collapsed }; setCategoryCollapseState({ pageId: dashboard.page.id, preview, config: dashboard.page.config, values });
    if (!preview) try { sessionStorage.setItem(`lh:category-panels:${dashboard.page.id}`, JSON.stringify(values)); } catch { /* This is an optional, tab-local preference. */ }
  };
  const compactSide = (items: ReturnType<typeof region>) => !!items.length && items.every(({ view }) => view.panel.id === 'builtin/category-navigation' && (readCategoryNavigationSettings(view.settings).displayMode === 'icons' || categoryCollapsed(view)));
  const openLocalNavigation = (action: 'add-link' | 'import-bookmarks') => {
    if (preview || editing || !dashboard.space.canEdit || !bootstrap.spaces.some(space => space.id === dashboard.space.id && space.canEdit)) return;
    const params = new URLSearchParams({ tab: action === 'add-link' ? 'links' : 'bookmarks', action, spaceId: dashboard.space.id });
    requestNavigation(() => { window.location.hash = `/admin?${params}`; });
  };

  const render = (view: View, placement: Placement) => {
    const alias = view.inputs.collection || view.inputs.traffic || view.inputs.metrics || Object.values(view.inputs)[0];
    const dataset = datasets[alias];
    const binding = config.bindings[alias];
    const localNavigation = dataset?.datasetId === 'local-navigation' && binding?.datasetId === 'local-navigation';
    const canMaintainNavigation = !preview && !editing && dashboard.space.canEdit && bootstrap.spaces.some(space => space.id === dashboard.space.id && space.canEdit) && localNavigation;
    const collection = readNavigation(dataset?.data);
    const scope = view.interactionScope || view.id;
    const filter = Object.hasOwn(filters, scope) ? filters[scope] : EMPTY_FILTER;
    const update = (next: NavigationFilter) => setFilters(previous => ({ ...previous, [scope]: next }));
    const heading = typeof view.settings.title === 'string' ? view.settings.title : undefined;
    let content: ReactNode;
    if (view.panel.id === 'builtin/search') content = <SearchPanel filter={filter} onChange={update} />;
    else if (view.panel.id === 'builtin/category-navigation') content = <CategoryPanel data={collection || scopeData.get(scope) || { categories: [], links: [] }} filter={filter} onChange={update}
      orientation={narrow || (placement.kind !== 'hidden' && ['top', 'bottom'].includes(placement.region)) ? 'horizontal' : 'vertical'} settings={readCategoryNavigationSettings(view.settings)}
      collapsed={categoryCollapsed(view)} onCollapsedChange={collapsed => changeCategoryCollapse(view.id, collapsed)} stateKey={`${dashboard.page.id}:${view.id}${editing ? ':draft' : ''}`} persistState={!preview && !editing} theme={color} />;
    else if (view.panel.id === 'builtin/document-activity') content = <Suspense fallback={<section className="lh-panel lh-panel-empty" role="status">{t('正在读取…', 'Loading…')}</section>}><DocumentActivityPanel view={view}/></Suspense>;
    else if (view.panel.id === 'builtin/github-traffic') content = <Suspense fallback={<section className="lh-panel lh-panel-empty" role="status">{t('正在加载流量组件…', 'Loading traffic component…')}</section>}><TrafficPanel dataset={dataset} title={heading} /></Suspense>;
    else if (['builtin/calendar', 'builtin/weather', 'builtin/metrics', 'builtin/status'].includes(view.panel.id)) content = <Suspense fallback={<section className="lh-panel lh-panel-empty" role="status">{t('正在加载组件…', 'Loading component…')}</section>}><DataPanel view={view} dataset={dataset} loading={!dataset && loadingData} failed={!dataset && failedData} /></Suspense>;
    else if (['builtin/navigation', 'builtin/favorites'].includes(view.panel.id)) content = collection ? <NavigationPanel data={collection} filter={filter} title={heading} settings={view.settings}
      variant={temporaryVariant || (view.settings.variant === 'directory' ? 'directory' : 'cards')} linkAppearance={readLinkAppearance(view.settings, config.pageTheme.id)} favorites={view.panel.id === 'builtin/favorites'}
      canEdit={canMaintainNavigation} onFavorite={favorite} pending={pendingFavorite} onClear={() => update(EMPTY_FILTER)}
      emptyActions={canMaintainNavigation && binding && !Object.keys(binding.query).length ? {
        scope: dashboard.space.kind === 'personal'
          ? t('添加或导入到个人空间「{name}」，仅自己可见。', 'Add or import into your personal space “{name}”, visible only to you.', { name: dashboard.space.name })
          : t('添加或导入到共享空间「{name}」，有权访问此空间的人可见。', 'Add or import into the shared space “{name}”, visible to people who can access it.', { name: dashboard.space.name }),
        onAdd: () => openLocalNavigation('add-link'), onImport: () => openLocalNavigation('import-bookmarks'),
      } : undefined} />
      : <section className="lh-panel lh-panel-empty"><strong>{panelName(view)}</strong><p>{dataset ? t('此积木需要兼容的导航数据。', 'This panel needs compatible navigation data.') : t('数据尚未就绪，请检查数据源绑定或同步状态。', 'Data is not ready. Check the source binding or synchronization status.')}</p></section>;
    else content = <section className="lh-panel lh-panel-empty"><strong>{t('此积木暂不可用', 'This panel is unavailable')}</strong><p>{t('{name} 的配置已保留，可在管理中心更换展示组件。', 'The configuration for {name} is preserved. Choose a different panel in the admin.', { name: panelName(view) })}</p></section>;
    return <PanelBoundary key={`${view.id}:${dataset?.revision || 0}:${view.panel.id}`} label={panelName(view)}>{content}</PanelBoundary>;
  };
  const renderRegion = (items: ReturnType<typeof region>) => items.map(({ view, placement }) => {
    const sizing = placement.kind === 'region' ? placement.size : undefined;
    return <div key={view.id} className={`lh-region-item lh-type-${view.panel.id.split('/')[1] || 'unknown'}${inspecting ? ' is-editable' : ''}${inspecting && selection.kind === 'view' && selection.id === view.id ? ' is-selected' : ''}`} data-view-id={view.id}
      onClickCapture={inspecting ? () => setSelection({ kind: 'view', id: view.id }) : undefined}
      style={sizing ? { width: sizing.widthPx, maxWidth: sizing.maxWidthPx || '100%' } : undefined}>
      {inspecting && <button type="button" className="lh-region-edit-label" aria-label={t('编辑{name}组件', 'Edit {name} component', { name: panelName(view) })} aria-pressed={selection.kind === 'view' && selection.id === view.id} onClick={() => setSelection({ kind: 'view', id: view.id })}><Pencil size={12} /><span>{panelName(view)}</span></button>}
      {render(view, placement)}</div>;
  });
  const updateGrid = useCallback((updates: Record<string, GridPosition>) => setDraft(previous => {
    if (preview || !canEdit || !previous || saving.current || currentContext.current !== editContext) return previous;
    const config = structuredClone(previous.history.present);
    for (const [id, position] of Object.entries(updates)) if (config.layout.placements[id] && !panelLocked(config, id)) config.layout.placements[id].base = position;
    return { ...previous, history: recordDraft(previous.history, config) };
  }), [preview, canEdit, editContext]);
  const compactLeft = compactSide(left), compactRight = compactSide(right);
  const widthRevision = `${left.length}:${right.length}:${compactLeft}:${compactRight}:${narrow}:${config.appearance.density}:${config.layout.gap}:${mainVariant}:${config.pageTheme.id}:${editing}:${editorPreview}`;
  const number = useMemo(() => new Intl.NumberFormat(getLocale()), [bootstrap.language]);
  const managementLabel = dashboard.space.canEdit || bootstrap.user ? t('管理中心', 'Admin') : t('登录管理', 'Admin sign in');
  const noticeElement = notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`lh-notice is-${notice.kind}`}><span>{notice.text}</span><button type="button" aria-label={t('关闭提示', 'Dismiss message')} onClick={() => setNotice(null)}><X size={15} /></button></div>;
  const canvas = <div ref={setCanvasElement} className="lh-home" data-preview={preview || editing || undefined} data-page-theme={config.pageTheme.id} data-composing={inspecting || undefined} data-canvas-narrow={narrow || undefined} data-canvas-compact={canvasWidth > 0 && canvasWidth <= 1280 || undefined} data-theme={color} data-density={config.appearance.density} style={{ '--lh-gap': `${config.layout.gap}px` } as CSSProperties}>
    <a className="lh-skip" href="#home-links" onClick={event => { event.preventDefault(); const target = event.currentTarget.ownerDocument.getElementById('home-links'); target?.focus(); target?.scrollIntoView({ block: 'start' }); }}>{t('跳到链接区域', 'Skip to links')}</a>
    {(!editing || editorPreview) && <header className="lh-header"><div className="lh-header-identity"><a className="lh-brand" href={preview || editing ? undefined : '#/'} aria-label={t('{name} 首页', '{name} home', { name: bootstrap.siteName || 'Lingshu-Home' })}><span><ProjectLogo /></span><strong>{bootstrap.siteName || 'Lingshu-Home'}</strong></a>
        <div className="lh-home-heading"><h1>{dashboard.page.name || t('我的导航', 'My bookmarks')}</h1><p className="lh-home-summary">{t('{count} 个链接', '{count} links', { count: number.format(totals.links) })}<span>·</span>{t('{count} 个分类', '{count} categories', { count: number.format(totals.categories) })}{dashboard.space.kind === 'personal' && <><span>·</span>{t('仅自己可见', 'Private')}</>}</p></div></div>
      <div className="lh-header-search">{renderRegion(topSearch)}</div>
      <div className="lh-header-actions">
        {!editing && <><div className="lh-segmented" aria-label={t('链接展示方式', 'Link presentation')}><button aria-label={t('卡片模式', 'Card view')} title={t('卡片模式', 'Card view')} aria-pressed={mainVariant === 'cards'} onClick={() => setTemporaryVariant('cards')}><LayoutGrid size={16} /></button><button aria-label={t('目录模式', 'Directory view')} title={t('目录模式', 'Directory view')} aria-pressed={mainVariant === 'directory'} onClick={() => setTemporaryVariant('directory')}><List size={17} /></button></div>
        <button className="lh-icon-button" onClick={() => setTemporaryColor(color === 'dark' ? 'light' : 'dark')} title={t('切换深浅色', 'Toggle light or dark')} aria-label={t('切换深浅色', 'Toggle light or dark')}>{color === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></>}
        {!preview && !editing && <button type="button" className="lh-quiet-button" disabled={refreshingData} aria-label={hasExternalPanels ? t('读取最新组件快照', 'Read latest component snapshots') : t('刷新内容', 'Refresh content')} title={t('读取已保存内容，不触发外部获取', 'Read saved content without starting external requests')} onClick={() => { void readSavedData(); }}><RefreshCw size={14} className={refreshingData ? 'lh-spin' : undefined} /><span>{hasExternalPanels ? t('更新数据', 'Refresh data') : t('刷新内容', 'Refresh content')}</span></button>}
        {!preview && dashboard.space.canEdit && !editing && <button className="lh-quiet-button lh-edit-trigger" title={t('编辑页面', 'Edit page')} aria-label={t('编辑页面', 'Edit page')} disabled={busy} onClick={startEditing}><Pencil size={14} /><span>{t('编辑页面', 'Edit page')}</span></button>}
        {!preview && !editing && <a className="lh-admin-link" href="#/library"><BookOpen size={16}/><span>{t('资料库', 'Library')}</span></a>}
        {!preview && !editing && <a className="lh-admin-link" href="#/admin" aria-label={managementLabel} title={managementLabel}><Settings2 size={16} /><span>{managementLabel}</span></a>}
        {!preview && bootstrap.spaces.length > 1 && <div className={`lh-space-holder${bootstrap.user ? ' has-preference' : ''}`}><Suspense fallback={<button className="lh-space-placeholder" disabled aria-label={t('正在加载空间选择', 'Loading space selector')} aria-busy="true"><span>{dashboard.space.name}{dashboard.space.kind === 'personal' ? t(' · 私人', ' · Personal') : ''}</span><ChevronDown size={15}/></button>}><SpaceSelect spaces={bootstrap.spaces} value={dashboard.space.id} disabled={editing} theme={color} onChange={onSpaceChange} bootstrap={bootstrap}/></Suspense></div>}
        {!preview && !editing && bootstrap.user && onLogout && <AccountMenu user={bootstrap.user} onProfile={() => onProfile?.()} onLogout={() => { void onLogout(); }}/>}
      </div>
    </header>}
    <PageChromeArea area={chrome.header} placement="header" version={bootstrap.version} editing={inspecting} selectedSlot={selection.kind === 'chrome' && selection.area === 'header' ? selection.alignment || 'left' : undefined} onSelect={alignment => setSelection({ kind: 'chrome', area: 'header', alignment })} />
    {inspecting && !!topSearch.length && <div className="lh-top-region lh-editor-search-region">{renderRegion(topSearch)}</div>}
    {!!topOther.length && <div className="lh-top-region">{renderRegion(topOther)}</div>}
    <div className={`lh-workspace ${left.length ? 'has-left' : ''} ${right.length ? 'has-right' : ''}${compactLeft ? ' has-compact-left' : ''}${compactRight ? ' has-compact-right' : ''}`}>
      {!!left.length && <aside className="lh-side-region lh-left-region"><div className="lh-side-content">{renderRegion(left)}</div></aside>}
      <main id="home-links" className="lh-main" tabIndex={-1}>
        {!editing && noticeElement}
        {!config.views.length && <section className="lh-panel lh-panel-empty"><Compass size={30} /><strong>{t('为这个页面添加积木', 'Add panels to this page')}</strong><p>{t('链接和分类仍保存在你的空间中，可以在管理中心选择首页预设或添加展示组件。', 'Your links and categories are still in this space. Choose a homepage preset or add panels in the admin.')}</p>{!preview && !editing && dashboard.space.canEdit && <a className="lh-primary-button" href="#/admin?tab=appearance">{t('配置首页', 'Configure homepage')}<ArrowUpRight size={14} /></a>}</section>}
        {config.schemaVersion !== 2 || !getPageTheme(config.pageTheme.id) ? <section className="lh-panel lh-panel-empty"><strong>{t('此页面需要兼容的主题', 'This page needs a compatible theme')}</strong><p>{t('现有页面配置已保留。请在管理中心查看主题与页面版本。', 'The existing page configuration is preserved. Check its theme and schema version in the admin.')}</p></section>
          : <><div className="lh-main-flow">{renderRegion(main.filter(item => item.placement.kind !== 'grid'))}</div>
            {!!main.some(item => item.placement.kind === 'grid') && <HomeGrid gap={config.layout.gap} editing={inspecting && !narrow} disabled={busy} selectedId={selection.kind === 'view' ? selection.id : undefined} onSelect={id => setSelection({ kind: 'view', id })} widthRevision={widthRevision} onChange={updateGrid} onInteractionChange={setGridInteracting} panels={main.filter(item => item.placement.kind === 'grid').map(({view,placement}) => ({ id: view.id, label: panelName(view), placement: { ...(placement as GridPosition), locked: panelLocked(config, view.id) }, content: render(view, placement) }))} />}</>}
      </main>
      {!!right.length && <aside className="lh-side-region lh-right-region"><div className="lh-side-content">{renderRegion(right)}</div></aside>}
    </div>
    {!!bottom.length && <div className="lh-bottom-region">{renderRegion(bottom)}</div>}
    <PageChromeArea area={chrome.footer} placement="footer" version={bootstrap.version} editing={inspecting} selectedSlot={selection.kind === 'chrome' && selection.area === 'footer' ? selection.alignment || 'right' : undefined} onSelect={alignment => setSelection({ kind: 'chrome', area: 'footer', alignment })} />
  </div>;
  return <HomeEnvironment.Provider value={environment}><DocumentActivityProvider key={`${identity}:${dashboard.space.id}:${bootstrap.mode}:${bootstrap.user?.role || 'visitor'}:${canEdit}:${preview || editing}`} spaceId={dashboard.space.id} userKey={bootstrap.user?.id || 'visitor'} enabled={!!bootstrap.user && canEdit}>{editing ? <Suspense fallback={<div className="lh-home lh-composer-loading"><LoaderCircle className="lh-spin" size={20} /><span>{t('正在加载页面编辑器', 'Loading the page editor')}</span><button className="lh-quiet-button" onClick={() => { void cancel(); }}><X size={14}/>{t('取消', 'Cancel')}</button></div>}>
    <HomeEditor config={config} theme={color} pageName={dashboard.page.name} busy={busy} dirty={dirty} narrow={narrow} historyBusy={gridInteracting} canUndo={canUndo} canRedo={canRedo} onUndo={() => historyAction(false)} onRedo={() => historyAction(true)}
      selection={selection} onSelect={setSelection} previewing={editorPreview} onPreviewChange={value => { setPreviewCollapses({}); setEditorPreview(value); }}
      datasets={datasets} spaceId={dashboard.space.id} space={dashboard.space} canManageSources={!!bootstrap.user && dashboard.space.canEdit} onSourcesChange={updateSources}
      onChange={changeDraft} onSave={() => { void save(); }} onCancel={() => leaveGuard.requestLeave(() => { void cancel(); })} onRestore={() => leaveGuard.requestLeave(restore)}
      notice={notice || loadingData || incompleteData ? <>{noticeElement}{loadingData ? <p className="lh-composer-data-status" role="status">{t('正在读取组件数据…', 'Loading component data…')}</p> : incompleteData ? <p className="lh-composer-data-status" role="status">{t('部分组件的数据尚未就绪。', 'Some component data is unavailable.')}{failedData && <button type="button" onClick={retryData}>{t('重试', 'Retry')}</button>}</p> : null}</> : null}>{canvas}</HomeEditor>
  </Suspense> : canvas}{leaveGuard.blocked && <Suspense fallback={null}><DiscardChangesDialog onKeep={leaveGuard.keep} onDiscard={leaveGuard.discard} /></Suspense>}</DocumentActivityProvider></HomeEnvironment.Provider>;
}
