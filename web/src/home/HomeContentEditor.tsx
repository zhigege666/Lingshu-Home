import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronsDown, ChevronsUp, LoaderCircle, Redo2, RefreshCw, Undo2, X } from 'lucide-react'
import { t } from '../core/i18n'
import { readDraft, type InlineConflict } from '../core/navigation-inline'
import { categoryLabel } from '../core/presentation'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { StyledSelect } from '../components/ui/select'
import { Checkbox } from '../components/ui/checkbox'
import { IconPicker } from '../components/IconPicker'
import { Modal } from '../components/Shared'
import { Button } from '../components/ui/button'
import LinkEndpointsEditor from '../admin/LinkEndpointsEditor'
import type { HomeContentController } from './useHomeContentEditor'
import './home-content-editor.css'
const LinkClickSummary = lazy(() => import('./LinkClickStats').then(module => ({ default: module.LinkClickSummary })))

const fieldNames = () => ({ name: t('名称', 'Name'), title: t('名称', 'Name'), url: t('网址', 'URL'), parentId: t('上级分类', 'Parent category'), categoryId: t('分类', 'Category'), icon: t('图标', 'Icon'), tags: t('标签', 'Tags'), description: t('描述', 'Description'), endpoints: t('其他入口', 'Additional URLs'), isFavorite: t('收藏', 'Favorite'), iconMode: t('图标模式', 'Icon mode'), sortOrder: t('排序', 'Order'), $deleted: t('已删除', 'Deleted') })
function conflictValue(value: unknown) { return value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
function Field({ name, label, children, error }: { name: string; label: string; children: ReactNode; error?: boolean }) {
  return <div className={'lh-content-field' + (error ? ' has-error' : '')} data-content-field={name}><label htmlFor={'home-content-' + name}>{label}</label><div>{children}{error && <small role="alert">{t('请检查此项。', 'Check this field.')}</small>}</div></div>
}
export default function HomeContentEditor({ controller: c, spaceName, spaceId, autoFetchIcons = true, autoSelectEndpoint = true, showClickStats = false }: {
  controller: HomeContentController; spaceName: string; spaceId: string; autoFetchIcons?: boolean; autoSelectEndpoint?: boolean; showClickStats?: boolean
}) {
  const details = useRef<HTMLElement>(null), [iconOpen, setIconOpen] = useState(false)
  const selection = c.selection, navigation = c.navigation, draft = c.draft
  useEffect(() => {
    setIconOpen(false)
    if (!selection) return
    const frame = requestAnimationFrame(() => details.current?.querySelector<HTMLInputElement>('.lh-content-main-input')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [selection?.kind, selection?.id])
  useEffect(() => {
    const first = c.errors.find(error => error.id === selection?.id && error.kind === selection?.kind)
    if (!first) return
    const frame = requestAnimationFrame(() => { const field = details.current?.querySelector<HTMLElement>(`[data-content-field="${first.field}"] input,[data-content-field="${first.field}"] button`); field?.focus(); field?.scrollIntoView({ block: 'nearest' }) })
    return () => cancelAnimationFrame(frame)
  }, [c.errors, selection?.kind, selection?.id])
  function keydown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && !c.busy) { event.preventDefault(); c.closeDetails(); return }
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || !(event.target instanceof HTMLInputElement) || ['checkbox', 'radio', 'button', 'submit'].includes(event.target.type)) return
    const inputs = [...(details.current?.querySelectorAll<HTMLElement>('input:not([type="hidden"]),textarea,button[role="combobox"],button[role="checkbox"]') || [])].filter(node => !node.hasAttribute('disabled') && !!node.getClientRects().length)
    const index = inputs.indexOf(event.target); event.preventDefault(); inputs[index + (event.shiftKey ? -1 : 1)]?.focus()
  }
  const hasError = (field: string) => c.errors.some(error => error.id === selection?.id && error.kind === selection?.kind && error.field === field)
  const exists = selection && navigation?.[selection.kind].some(row => row.id === selection.id)
  const link = exists && selection?.kind === 'links' && draft ? readDraft(draft.fields, 'links', selection.id) : null
  const category = exists && selection?.kind === 'categories' && draft ? readDraft(draft.fields, 'categories', selection.id) : null
  const categoryOptions = navigation?.categories.map(row => ({ value: row.id, label: categoryLabel(row, navigation.categories) })) || []
  const forbidden = new Set<string>(selection?.kind === 'categories' ? [selection.id] : [])
  if (navigation) for (let loop = 0; loop < navigation.categories.length; loop++) { const before = forbidden.size; for (const row of navigation.categories) if (row.parentId && forbidden.has(row.parentId)) forbidden.add(row.id); if (before === forbidden.size) break }
  function move(direction: 'first' | 'up' | 'down' | 'last') {
    if (!selection || !draft || !navigation) return
    const group = selection.kind === 'links' ? link?.categoryId : category?.parentId
    const ids = draft.orders[selection.kind][group || ''] || [], index = ids.indexOf(selection.id)
    const beforeId = direction === 'first' ? ids[0] || null : direction === 'up' ? ids[index - 1] || null : direction === 'down' ? ids[index + 2] || null : null
    if (selection.kind === 'links') c.moveLink(selection.id, group || null, beforeId)
    else c.moveCategory(selection.id, beforeId)
  }
  const siblings = draft && selection ? draft.orders[selection.kind][(link ? link.categoryId : category?.parentId) || ''] || [] : []
  const position = selection ? siblings.indexOf(selection.id) : -1
  const names = fieldNames()
  function conflictName(conflict: InlineConflict) {
    const row = draft?.fields.base.data[conflict.kind].find(item => item.id === conflict.id)
    return `${row ? 'name' in row ? row.name : row.title : conflict.id} · ${names[conflict.field as keyof typeof names] || conflict.field}`
  }
  return <>
    <div className="lh-content-toolbar" aria-label={t('首页内容编辑', 'Homepage content editor')}>
      <div className="lh-content-toolbar-title"><strong>{t('编辑内容', 'Edit content')}</strong><span title={spaceName}>{spaceName}</span>{c.dirty && <span className="lh-content-unsaved" aria-label={t('未保存', 'Unsaved')}>{c.changeCount || '·'}</span>}</div>
      <div className="lh-content-toolbar-actions">
        <button type="button" className="lh-icon-button" aria-label={t('撤销内容修改', 'Undo content edit')} title={t('撤销', 'Undo')} disabled={c.blocked || !c.canUndo} onClick={c.undo}><Undo2 size={17}/></button>
        <button type="button" className="lh-icon-button" aria-label={t('重做内容修改', 'Redo content edit')} title={t('重做', 'Redo')} disabled={c.blocked || !c.canRedo} onClick={c.redo}><Redo2 size={17}/></button>
        <button type="button" className="lh-quiet-button" disabled={c.busy} onClick={c.exit}>{t('取消', 'Cancel')}</button>
        <button type="button" className="lh-primary-button" disabled={c.blocked || !c.changeCount} onClick={() => { void c.save() }}>{c.busy ? <LoaderCircle className="lh-spin" size={16}/> : <Check size={16}/>}<span>{c.busy ? t('保存中', 'Saving') : t('保存', 'Save')}</span></button>
      </div>
    </div>
    {(c.error || c.status || c.needsRead || c.conflicts.length > 0 || c.orderConflicts.length > 0) && <section className="lh-content-feedback" aria-label={t('内容编辑状态', 'Content edit status')}>
      {c.error && <p role="alert">{c.error}</p>}{c.status && <p role="status">{c.status}</p>}
      {(c.needsRead || c.refreshNeeded) && <button type="button" className="lh-quiet-button" disabled={c.busy} onClick={() => { void c.readLatest() }}><RefreshCw size={14}/>{t('读取最新内容并比较', 'Read latest and compare')}</button>}
      {c.conflicts.map((conflict, index) => <div className="lh-content-conflict" key={`${conflict.kind}:${conflict.id}:${conflict.field}`}><strong>{conflictName(conflict)}</strong>
        {conflict.field !== '$deleted' && <div className="lh-content-conflict-values"><span>{t('我的修改', 'My edit')}<b>{conflictValue(conflict.mine)}</b></span><span>{t('当前内容', 'Current content')}<b>{conflictValue(conflict.server)}</b></span></div>}
        <div>{conflict.field !== '$deleted' && <button className="lh-quiet-button" disabled={c.busy} aria-label={t('冲突 {index}：保留我的修改', 'Conflict {index}: keep my edit', { index: index + 1 })} onClick={() => c.resolve(conflict, 'mine')}>{t('保留我的修改', 'Keep my edit')}</button>}<button className="lh-quiet-button" disabled={c.busy} onClick={() => c.resolve(conflict, 'server')}>{conflict.field === '$deleted' ? t('移除已删除项的草稿', 'Remove deleted draft') : t('使用当前内容', 'Use current content')}</button></div>
      </div>)}
      {c.orderConflicts.map(conflict => <div className="lh-content-conflict" key={conflict.kind}><strong>{conflict.kind === 'categories' ? t('分类顺序也被修改', 'Category order also changed') : t('链接顺序也被修改', 'Link order also changed')}</strong><div><button className="lh-quiet-button" disabled={c.busy} onClick={() => c.resolveOrder(conflict, 'mine')}>{t('保留我的移动', 'Keep my moves')}</button><button className="lh-quiet-button" disabled={c.busy} onClick={() => c.resolveOrder(conflict, 'server')}>{t('使用当前顺序', 'Use current order')}</button></div></div>)}
    </section>}
    {selection && navigation && draft && (link || category) && <aside ref={details} className="admin-ui lh-content-inspector" role="dialog" aria-modal="false" aria-label={link ? t('编辑链接', 'Edit link') : t('编辑分类', 'Edit category')} onKeyDown={keydown}>
      <header><h2>{link ? t('编辑链接', 'Edit link') : t('编辑分类', 'Edit category')}</h2><button type="button" className="lh-icon-button" aria-label={t('关闭编辑面板', 'Close edit panel')} disabled={c.busy} onClick={c.closeDetails}><X size={19}/></button></header>
      {link && showClickStats && <Suspense fallback={null}><LinkClickSummary key={selection.id} spaceId={spaceId} linkId={selection.id}/></Suspense>}
      <div className="lh-content-inspector-body"><fieldset disabled={c.blocked}>
        <Field name={link ? 'title' : 'name'} label={t('名称', 'Name')} error={hasError(link ? 'title' : 'name')}><Input id={'home-content-' + (link ? 'title' : 'name')} className="lh-content-main-input" maxLength={link ? 160 : 80} value={link?.title ?? category?.name ?? ''} aria-invalid={hasError(link ? 'title' : 'name') || undefined} onChange={event => c.change(selection.kind, selection.id, link ? { title: event.target.value } : { name: event.target.value })}/></Field>
        {link && <Field name="url" label={t('网址', 'URL')} error={hasError('url')}><Input id="home-content-url" type="url" maxLength={2048} value={link.url} aria-invalid={hasError('url') || undefined} onChange={event => c.change('links', selection.id, { url: event.target.value })}/></Field>}
        <Field name={link ? 'categoryId' : 'parentId'} label={link ? t('分类', 'Category') : t('上级分类', 'Parent category')} error={hasError(link ? 'categoryId' : 'parentId')}><StyledSelect id={'home-content-' + (link ? 'categoryId' : 'parentId')} disabled={c.blocked} value={(link ? link.categoryId : category?.parentId) || ''} options={[{ value: '', label: link ? t('未分类', 'Uncategorized') : t('顶层分类', 'Top level') }, ...categoryOptions.filter(option => link || !forbidden.has(option.value))]} onValueChange={value => c.change(selection.kind, selection.id, link ? { categoryId: value || null } : { parentId: value || null })}/></Field>
        {link && <><Field name="tags" label={t('标签', 'Tags')} error={hasError('tags')}><Input id="home-content-tags" value={link.tags} placeholder={t('逗号分隔', 'Comma separated')} maxLength={1400} onChange={event => c.change('links', selection.id, { tags: event.target.value })}/></Field><Field name="isFavorite" label={t('收藏', 'Favorite')}><Checkbox id="home-content-isFavorite" checked={link.isFavorite} onCheckedChange={value => c.change('links', selection.id, { isFavorite: value })}/></Field></>}
        <div className="lh-content-position" aria-label={t('调整顺序', 'Change order')}>
          <button type="button" title={t('移到开头', 'Move to start')} aria-label={t('移到开头', 'Move to start')} disabled={c.blocked || position <= 0} onClick={() => move('first')}><ChevronsUp size={17}/></button>
          <button type="button" title={t('上移', 'Move up')} aria-label={t('上移', 'Move up')} disabled={c.blocked || position <= 0} onClick={() => move('up')}><ArrowUp size={17}/></button>
          <span>{position + 1} / {siblings.length}</span>
          <button type="button" title={t('下移', 'Move down')} aria-label={t('下移', 'Move down')} disabled={c.blocked || position < 0 || position >= siblings.length - 1} onClick={() => move('down')}><ArrowDown size={17}/></button>
          <button type="button" title={t('移到末尾', 'Move to end')} aria-label={t('移到末尾', 'Move to end')} disabled={c.blocked || position < 0 || position >= siblings.length - 1} onClick={() => move('last')}><ChevronsDown size={17}/></button>
        </div>
        <details open={iconOpen} onToggle={event => setIconOpen(event.currentTarget.open)}><summary>{t('图标', 'Icon')}</summary>{iconOpen && <IconPicker spaceId={spaceId} canEdit allowLibraryChanges={false} disabled={c.blocked} value={link?.icon || category?.icon || ''} onChange={icon => c.change(selection.kind, selection.id, link ? { icon, iconMode: 'manual' } : { icon })} iconMode={link?.iconMode} onModeChange={link ? mode => c.change('links', selection.id, { iconMode: mode }) : undefined} autoFetchIcons={autoFetchIcons} fallback={category ? 'lucide:folder' : 'lucide:link'}/>}</details>
        {link && <details key={selection.id}><summary>{t('更多设置', 'More settings')}</summary><Field name="description" label={t('描述', 'Description')} error={hasError('description')}><Textarea id="home-content-description" rows={4} maxLength={2000} value={link.description} onChange={event => c.change('links', selection.id, { description: event.target.value })}/></Field><div data-content-field="endpoints"><LinkEndpointsEditor value={link.endpoints} onChange={endpoints => c.change('links', selection.id, { endpoints })} disabled={c.blocked} autoSelectEndpoint={autoSelectEndpoint}/></div></details>}
      </fieldset></div>
    </aside>}
    {c.leaveOpen && <Modal title={t('保存内容修改？', 'Save content changes?')} busy={c.busy} onClose={c.keep}><div className="admin-form-footer lh-content-leave-actions"><Button variant="outline" onClick={c.keep}>{t('继续编辑', 'Keep editing')}</Button><Button variant="ghost" onClick={c.discard}>{t('放弃修改', 'Discard changes')}</Button><Button disabled={c.blocked} onClick={() => { void c.save(true) }}>{t('保存并离开', 'Save and leave')}</Button></div></Modal>}
  </>
}
