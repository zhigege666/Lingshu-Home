import { FieldHelp } from './FieldHelp'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, LoaderCircle, Search, Trash2, Upload, X } from 'lucide-react'
import { request } from '../core/api'
import { t } from '../core/i18n'
import { builtinIconChoices, builtinIconGroups, matchesIconSearch, parseIconAssetReference, readIconImportFile, validateIconPackDraft, websiteIconURL, type IconPack, type IconPackDraft, type WebsiteIcon } from '../core/icon-assets'
import { iconErrorMessage } from '../core/icon-errors'
import type { IconMode } from '../core/types'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { StyledSelect } from './ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { ErrorMessage, Field, FilePicker } from './Shared'
import { IconAsset } from './IconAsset'
import './icon-picker.css'

type Props = { value: string; onChange: (ref: string) => void; spaceId: string; canEdit: boolean; disabled?: boolean; url?: string; fallback?: string; onBusyChange?: (busy: boolean) => void; iconMode?: IconMode; onModeChange?: (mode: IconMode) => void; autoFetchIcons?: boolean; allowLibraryChanges?: boolean }
const PAGE_SIZE = 32
const BUILTIN_PAGE_SIZE = 24
const PICKER_ICON_SIZE = 24

export function IconPicker({ value, onChange, spaceId, canEdit, disabled = false, url, fallback = 'lucide:link', onBusyChange, iconMode, onModeChange, autoFetchIcons = true, allowLibraryChanges = true }: Props) {
  const headingId = useId(), queryId = useId()
  const [tab, setTab] = useState('builtin'), [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const [group, setGroup] = useState('all')
  const [focusedLabel, setFocusedLabel] = useState(''), [hoveredLabel, setHoveredLabel] = useState('')
  const builtinGrid = useRef<HTMLDivElement>(null)
  const [library, setLibrary] = useState<{ spaceId: string; packs: IconPack[] } | null>(null), [loading, setLoading] = useState(false)
  const [selectedPack, setSelectedPack] = useState(''), [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [operation, setOperation] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<IconPackDraft | null>(null), [filename, setFilename] = useState('')
  const pending = useRef(false), mounted = useRef(true), readRequest = useRef<AbortController | null>(null), writeRequest = useRef<AbortController | null>(null)
  const current = useRef({ spaceId, value, url, iconMode, onBusyChange }); current.current = { spaceId, value, url, iconMode, onBusyChange }
  const packs = library?.spaceId === spaceId ? library.packs : []
  const blocked = disabled || !!operation || !canEdit
  const website = websiteIconURL(url)
  const builtin = builtinIconChoices()
  const groups = builtinIconGroups()
  const selected = packs.find(pack => pack.id === selectedPack) || packs[0]
  const entries = tab === 'builtin' ? builtin.filter(icon => group === 'all' || icon.group === group).map(icon => ({ ref: icon.id, label: icon.label, keywords: icon.keywords.join(' ') }))
    : (selected?.icons || []).map(icon => ({ ref: icon.ref, label: icon.label, keywords: icon.key }))
  const results = entries.filter(icon => matchesIconSearch(`${icon.label} ${icon.keywords}`, query))
  const pageSize = tab === 'builtin' ? BUILTIN_PAGE_SIZE : PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize)), currentPage = Math.min(page, pageCount)
  const visible = results.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const currentLabel = builtin.find(icon => icon.id === value)?.label || packs.flatMap(pack => pack.icons).find(icon => icon.ref === value)?.label
    || (parseIconAssetReference(value) ? t('已保存的图片图标', 'Saved image icon') : t('默认图标', 'Default icon'))
  const mountedSpace = (expected: string) => mounted.current && current.current.spaceId === expected

  useEffect(() => {
    if (builtinGrid.current) builtinGrid.current.scrollTop = 0
    setFocusedLabel(''); setHoveredLabel('')
  }, [currentPage, group, query, tab])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; readRequest.current?.abort(); writeRequest.current?.abort(); current.current.onBusyChange?.(false) }
  }, [])
  useEffect(() => {
    readRequest.current?.abort(); writeRequest.current?.abort(); writeRequest.current = null
    pending.current = false; setLoading(false); setOperation(''); current.current.onBusyChange?.(false)
    setSelectedPack(''); setConfirmDelete(null); setPage(1); setGroup('all'); setQuery(''); setError(''); setNotice(''); setDraft(null); setFilename('')
  }, [spaceId])

  async function loadPacks() {
    const scope = spaceId
    readRequest.current?.abort()
    const controller = new AbortController(); readRequest.current = controller; setLoading(true); setError('')
    try {
      const data = await request<{ packs: IconPack[] }>(`/spaces/${encodeURIComponent(scope)}/icon-packs`, { signal: controller.signal })
      if (controller.signal.aborted || !mountedSpace(scope)) return
      setLibrary({ spaceId: scope, packs: data.packs })
    } catch (cause) { if (!controller.signal.aborted && mountedSpace(scope)) setError(iconErrorMessage(cause)) }
    finally { if (!controller.signal.aborted && mountedSpace(scope)) setLoading(false) }
  }
  useEffect(() => { if (tab === 'imported' && library?.spaceId !== spaceId && !loading && !error) void loadPacks() }, [tab, spaceId, library?.spaceId, loading, error])

  function begin(label: string): AbortController | null {
    if (pending.current || disabled || !canEdit || !allowLibraryChanges) return null
    readRequest.current?.abort(); setLoading(false)
    pending.current = true; setOperation(label); setError(''); setNotice(''); onBusyChange?.(true)
    const controller = new AbortController(); writeRequest.current = controller
    return controller
  }
  function finish(controller: AbortController) {
    if (writeRequest.current !== controller) return
    writeRequest.current = null; pending.current = false; if (mounted.current) setOperation(''); current.current.onBusyChange?.(false)
  }
  function select(ref: string) { if (blocked) return; onChange(ref); setNotice(t('图标已选入当前草稿，保存表单后生效。', 'Icon selected for this draft. Save the form to apply it.')) }
  function changeMode(mode: IconMode) { if (blocked || !onModeChange) return; onModeChange(mode); setNotice(''); setError('') }
  function changeTab(next: string) { setTab(next); setQuery(''); setGroup('all'); setPage(1); setConfirmDelete(null); setError('') }
  function changeGroup(next: string) { setGroup(next); setQuery(''); setPage(1) }
  function changeQuery(next: string) { setQuery(next); setGroup('all'); setPage(1) }
  async function readFile(file?: File) {
    if (!file || blocked) return
    const controller = begin(t('正在读取文件…', 'Reading file…')); if (!controller) return
    const scope = spaceId
    try { const value = await readIconImportFile(file); if (mountedSpace(scope) && !controller.signal.aborted) { setDraft(value); setFilename(file.name) } }
    catch (cause) { if (mountedSpace(scope)) { setDraft(null); setFilename(file.name); setError(iconErrorMessage(cause)) } }
    finally { finish(controller) }
  }
  async function fetchWebsite() {
    if (!website) return
    const controller = begin(t('正在获取网站图标…', 'Fetching website icon…')); if (!controller) return
    const scope = spaceId, initialValue = value, initialURL = url, initialMode = iconMode
    try {
      const asset = await request<WebsiteIcon>(`/spaces/${encodeURIComponent(scope)}/icons/fetch`, { method: 'POST', body: { url: website }, signal: controller.signal })
      if (!mountedSpace(scope) || controller.signal.aborted) return
      if (parseIconAssetReference(asset.ref)?.spaceId !== scope) throw new Error(t('图标响应不属于当前空间。', 'The icon response does not belong to this space.'))
      const selectForDraft = current.current.value === initialValue && current.current.url === initialURL && current.current.iconMode === initialMode
      if (selectForDraft) onChange(asset.ref)
      setNotice(!selectForDraft ? t('网站图标已缓存；当前表单内容已变化，请按需重新获取并选用。', 'The website icon was cached. This form has changed; fetch it again to select it if needed.')
        : asset.stale ? t('网站图标暂时无法更新，已选用上次缓存图标；保存表单后生效。', 'The website icon could not be refreshed. Its last cached icon is selected for this draft; save the form to apply it.')
        : asset.cached ? t('缓存的网站图标已选入草稿；保存表单后生效。', 'The cached website icon is selected for this draft. Save the form to apply it.')
        : t('网站图标已缓存到当前空间并选入草稿；保存表单后生效。', 'Website icon cached in this space and selected for the draft. Save the form to apply it.'))
    } catch (cause) { if (!controller.signal.aborted && mountedSpace(scope)) setError(iconErrorMessage(cause)) }
    finally { finish(controller) }
  }
  async function importPack() {
    if (!draft) return
    let payload: IconPackDraft
    try { payload = validateIconPackDraft(draft) } catch (cause) { setError(iconErrorMessage(cause)); return }
    const controller = begin(t('正在导入图标库…', 'Importing icon library…')); if (!controller) return
    const scope = spaceId
    try {
      const pack = await request<IconPack>(`/spaces/${encodeURIComponent(scope)}/icon-packs`, { method: 'POST', body: payload, signal: controller.signal })
      if (!mountedSpace(scope) || controller.signal.aborted) return
      if (pack.spaceId !== scope || !pack.icons.length || pack.icons.some(icon => parseIconAssetReference(icon.ref)?.spaceId !== scope)) throw new Error(t('导入结果不属于当前空间，请刷新图标库。', 'The import response does not belong to this space. Refresh the library.'))
      const listed = await request<{ packs: IconPack[] }>(`/spaces/${encodeURIComponent(scope)}/icon-packs`, { signal: controller.signal }).catch(() => null)
      if (!mountedSpace(scope) || controller.signal.aborted) return
      setLibrary({ spaceId: scope, packs: listed?.packs || [...packs.filter(item => item.id !== pack.id), pack] }); setSelectedPack(pack.id); setTab('imported'); setQuery(''); setPage(1); setDraft(null); setFilename('')
      if (pack.icons.length === 1) onChange(pack.icons[0]!.ref)
      setNotice(pack.icons.length === 1 ? t('图标库已保存，图标已选入草稿；保存表单后应用。', 'Library saved and icon selected for this draft. Save the form to apply it.') : t('图标库已保存，请选择要使用的图标。', 'Library saved. Select the icon you want to use.'))
    } catch (cause) { if (!controller.signal.aborted && mountedSpace(scope)) setError(iconErrorMessage(cause)) }
    finally { finish(controller) }
  }
  async function removePack(pack: IconPack) {
    const controller = begin(t('正在删除图标库…', 'Deleting icon library…')); if (!controller) return
    const scope = spaceId
    try {
      await request(`/spaces/${encodeURIComponent(scope)}/icon-packs/${encodeURIComponent(pack.id)}`, { method: 'DELETE', signal: controller.signal })
      if (!mountedSpace(scope) || controller.signal.aborted) return
      const remaining = packs.filter(item => item.id !== pack.id)
      setLibrary({ spaceId: scope, packs: remaining }); setSelectedPack(remaining[0]?.id || ''); setConfirmDelete(null); setPage(1)
      const removedSelection = pack.icons.some(icon => icon.ref === current.current.value) && !remaining.some(item => item.icons.some(icon => icon.ref === current.current.value))
      if (removedSelection) onChange(fallback)
      setNotice(removedSelection ? t('图标库已删除，当前草稿已恢复默认图标。', 'Library deleted. This draft now uses the default icon.') : t('图标库已删除。', 'Icon library deleted.'))
    } catch (cause) {
      if (!controller.signal.aborted && mountedSpace(scope)) setError(iconErrorMessage(cause))
    } finally { finish(controller) }
  }
  const selectedSource = websiteIconURL(selected?.sourceUrl)
  return <fieldset className="lh-icon-picker" aria-labelledby={headingId} disabled={disabled || !canEdit} onKeyDown={event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
  }}>
    <legend id={headingId}>{t('图标', 'Icon')}<FieldHelp label={t('图标保存方式', 'How icons are saved')}>{allowLibraryChanges ? t('导入、删除和网站图标缓存会立即保存到当前空间。取消表单只放弃本次图标选择。', 'Imports, deletions and website icon caching are saved to the current space immediately. Canceling the form only discards the current icon selection.') : t('在列表草稿中可选择现有图标或自动模式。图标库的导入、删除和立即获取请在结束列表编辑后操作。', 'Choose existing icons or automatic mode in a list draft. Finish list editing before importing, deleting or fetching icon assets.')}</FieldHelp></legend>
    {url !== undefined && onModeChange && <div className="lh-icon-picker-mode">
      <div className="lh-icon-picker-mode-options" role="group" aria-label={t('图标模式', 'Icon mode')}>
        <Button type="button" variant={iconMode === 'auto' ? 'secondary' : 'outline'} size="sm" disabled={blocked} aria-pressed={iconMode === 'auto'} onClick={() => changeMode('auto')}>{t('自动获取', 'Automatic')}</Button>
        <Button type="button" variant={iconMode !== 'auto' ? 'secondary' : 'outline'} size="sm" disabled={blocked} aria-pressed={iconMode !== 'auto'} onClick={() => changeMode('manual')}>{t('手动选择', 'Manual selection')}</Button>
      </div>
      <p className="lh-icon-picker-note">{!autoFetchIcons
        ? t('自动获取已由站点设置暂停。已保存图标继续显示，你仍可手动选择或获取。', 'Automatic fetching is paused in site settings. Saved icons stay visible; you can still select or fetch an icon manually.')
        : iconMode === 'auto' ? t('保存后由服务器获取，已有图标会保留，刷新内容后显示结果。选择下方图标将切换为手动。', 'The server fetches the icon after saving. The current icon is kept until then; refresh content to see the result. Selecting an icon below switches to manual mode.')
        : t('手选图标会保留。切换为自动获取并保存后，服务器可在后台更新此链接的图标。', 'Manually selected icons are kept. Switch to automatic mode and save to let the server update this link’s icon in the background.')}</p>
    </div>}
    <div className="lh-icon-picker-current"><div className="lh-icon-picker-preview"><IconAsset name={value} size={PICKER_ICON_SIZE} fallback={fallback}/></div><span>{currentLabel}</span>
      <Button type="button" variant="ghost" size="sm" disabled={blocked || ((!value || value === fallback) && iconMode !== 'auto')} onClick={() => select(fallback)}>{t('使用默认图标', 'Use default')}</Button>
      {url !== undefined && <Button type="button" variant="outline" size="sm" disabled={blocked || !website || !allowLibraryChanges} onClick={() => void fetchWebsite()}><Download size={14}/>{t('获取网站图标', 'Fetch website icon')}</Button>}
    </div>
    <Tabs value={tab} onValueChange={changeTab} className="lh-icon-picker-tabs"><TabsList aria-label={t('图标来源', 'Icon source')}>
      <TabsTrigger type="button" value="builtin" disabled={blocked}>{t('内置', 'Built-in')} <small>{builtin.length}</small></TabsTrigger>
      <TabsTrigger type="button" value="imported" disabled={blocked}>{t('图标库', 'Libraries')}</TabsTrigger>
      <TabsTrigger type="button" value="import" disabled={blocked || !allowLibraryChanges}><Upload size={13}/>{t('导入', 'Import')}</TabsTrigger>
    </TabsList>
    {tab !== 'import' && <div className="lh-icon-picker-filters">
      {tab === 'builtin' && <StyledSelect aria-label={t('图标分组', 'Icon group')} value={group} disabled={blocked} onValueChange={changeGroup} options={[{ value: 'all', label: t('全部图标（{count}）', 'All icons ({count})', { count: builtin.length }) }, ...groups.map(item => ({ value: item.id, label: `${item.label} (${item.count})` }))]}/>}
      <div className="lh-icon-picker-search"><Search size={15}/><Input id={queryId} type="search" value={query} disabled={blocked || loading} onChange={event => changeQuery(event.target.value)} placeholder={tab === 'builtin' ? t('搜索全部图标，如 NAS、AI', 'Search all icons, e.g. NAS, AI') : t('搜索图标', 'Search icons')} aria-label={t('搜索图标', 'Search icons')}/>
        {query && <Button type="button" variant="ghost" size="icon-sm" disabled={blocked || loading} aria-label={t('清空图标搜索', 'Clear icon search')} onClick={() => { changeQuery(''); document.getElementById(queryId)?.focus() }}><X size={13}/></Button>}
      </div>
    </div>}
    <TabsContent value="builtin">
      <div className="lh-icon-picker-results" role="status"><span>{t('{count} 个图标', '{count} icons', { count: results.length })}</span><span className="lh-icon-picker-full-label" aria-hidden="true">{focusedLabel || hoveredLabel}</span></div>
      <div ref={builtinGrid} className="lh-icon-picker-grid is-labelled">{visible.map(icon => <Button key={icon.ref} type="button" variant={value === icon.ref ? 'secondary' : 'ghost'} disabled={blocked} aria-label={icon.label} title={icon.label} aria-pressed={value === icon.ref} onFocus={() => setFocusedLabel(icon.label)} onBlur={() => setFocusedLabel('')} onMouseEnter={() => setHoveredLabel(icon.label)} onMouseLeave={() => setHoveredLabel('')} onClick={() => select(icon.ref)}><IconAsset name={icon.ref} size={PICKER_ICON_SIZE}/><span>{icon.label}</span></Button>)}</div>
      {!visible.length && <p className="lh-icon-picker-note">{t('没有匹配的图标，试试其他关键词或清空搜索。', 'No matching icons. Try another keyword or clear the search.')}</p>}
    </TabsContent>
    <TabsContent value="imported">
      {loading ? <p role="status" className="lh-icon-picker-note"><LoaderCircle className="admin-spin" size={14}/>{t('正在读取图标库…', 'Loading icon libraries…')}</p> : selected ? <>
        <div className="lh-icon-picker-library"><StyledSelect aria-label={t('选择图标库', 'Choose icon library')} value={selected.id} disabled={blocked} options={packs.map(pack => ({ value: pack.id, label: `${pack.name} (${pack.icons.length})` }))} onValueChange={id => { setSelectedPack(id); setPage(1); setConfirmDelete(null) }}/><Button type="button" variant="ghost" size="icon-sm" disabled={blocked || !allowLibraryChanges} aria-label={t('删除图标库 {name}', 'Delete library {name}', { name: selected.name })} onClick={() => { setConfirmDelete(selected.id); setError('') }}><Trash2 size={15}/></Button></div>
        <div className="lh-icon-picker-grid">{visible.map(icon => <Button key={icon.ref + icon.label} type="button" variant={value === icon.ref ? 'secondary' : 'ghost'} disabled={blocked} aria-label={icon.label} title={icon.label} aria-pressed={value === icon.ref} onClick={() => select(icon.ref)}><IconAsset name={icon.ref} size={PICKER_ICON_SIZE}/></Button>)}</div>
        {!visible.length && <p className="lh-icon-picker-note">{t('没有匹配的图标。', 'No matching icons.')}</p>}
        <details className="lh-icon-picker-provenance"><summary>{t('来源与许可', 'Source and license')}</summary>{selectedSource && <a href={selectedSource} target="_blank" rel="noopener noreferrer">{selected.sourceUrl}</a>}<p>{selected.license}</p></details>
        {confirmDelete === selected.id && <div className="lh-icon-picker-delete"><p>{t('删除“{name}”及其中未使用的图标？此操作立即保存。', 'Delete “{name}” and its unused icons? This change is saved immediately.', { name: selected.name })}</p><div><Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => setConfirmDelete(null)}>{t('取消', 'Cancel')}</Button><Button type="button" variant="destructive" size="sm" disabled={blocked} onClick={() => void removePack(selected)}>{t('删除图标库', 'Delete library')}</Button></div></div>}
      </> : <p className="lh-icon-picker-note">{t('当前空间还没有导入图标库。', 'No icon libraries have been imported into this space.')}</p>}
      {!loading && <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => void loadPacks()}>{t('刷新图标库', 'Refresh libraries')}</Button>}
    </TabsContent>
    <TabsContent value="import"><Field label={t('图标库或图片文件', 'Icon library or image')}><FilePicker accept=".json,.png,.jpg,.jpeg,.svg,application/json,image/png,image/jpeg,image/svg+xml" filename={filename} disabled={blocked} onFileChange={file => void readFile(file)}/></Field>
      <p className="lh-icon-picker-note">{t('支持 Schema 1 JSON、PNG、JPEG 或静态 SVG；单张最多 256 KiB、512 × 512。', 'Accepts Schema 1 JSON, PNG, JPEG or static SVG; each icon up to 256 KiB and 512 × 512.')}</p>
      {draft && <div className="lh-icon-picker-import"><Field label={t('图标库名称', 'Library name')}><Input value={draft.name} maxLength={80} disabled={blocked} onChange={event => setDraft({ ...draft, name: event.target.value })}/></Field><Field label={t('来源网址', 'Source URL')} hint={t('选填', 'Optional')}><Input type="text" inputMode="url" value={draft.sourceUrl} maxLength={2048} placeholder="https://" disabled={blocked} onChange={event => setDraft({ ...draft, sourceUrl: event.target.value })}/></Field><Field label={t('许可或权属说明', 'License or ownership notice')}><Textarea value={draft.license} maxLength={2048} disabled={blocked} placeholder={t('填写原始许可证或你拥有使用权的说明', 'Enter the original license or describe your right to use these assets')} onChange={event => setDraft({ ...draft, license: event.target.value })}/></Field><div className="lh-icon-picker-import-actions"><span>{t('{count} 个图标', '{count} icons', { count: draft.icons.length })}</span><Button type="button" size="sm" disabled={blocked || !draft.name.trim() || !draft.license.trim()} onClick={() => void importPack()}><Upload size={14}/>{draft.icons.length === 1 ? t('导入并选用', 'Import and select') : t('导入图标库', 'Import library')}</Button></div></div>}
    </TabsContent></Tabs>
    {tab !== 'import' && results.length > pageSize && <nav className="lh-icon-picker-pagination" aria-label={t('图标分页', 'Icon pagination')}><Button type="button" variant="ghost" size="icon-sm" disabled={blocked || currentPage === 1} aria-label={t('上一页图标', 'Previous icon page')} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15}/></Button><span>{currentPage} / {pageCount}</span><Button type="button" variant="ghost" size="icon-sm" disabled={blocked || currentPage === pageCount} aria-label={t('下一页图标', 'Next icon page')} onClick={() => setPage(currentPage + 1)}><ChevronRight size={15}/></Button></nav>}
    {operation && <p className="lh-icon-picker-note" role="status"><LoaderCircle className="admin-spin" size={14}/>{operation}</p>}
    {notice && <p className="lh-icon-picker-notice" role="status">{notice}</p>}<ErrorMessage error={error}/>
  </fieldset>
}
