import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Plus, Save, Trash2, Undo2, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { newWorkId, workPath, workStatusTypes, type WorkStatusBatch, type WorkStatusCatalog, type WorkStatusDefinition } from '../core/work-types'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { ErrorMessage, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import { useWorkTheme } from './work-theme'
import { editableStatusFields, mergeStatusDraft, statusValues } from './status-merge'

const builtin = new Set(['todo', 'doing', 'waiting', 'done'])
export const statusTypeLabel = (type: WorkStatusDefinition['type']) => ({ todo: t('未开始', 'Not started'), doing: t('进行中', 'In progress'), waiting: t('等待', 'Waiting'), done: t('已完成', 'Completed'), canceled: t('已取消', 'Canceled') })[type]
function shape(items: WorkStatusDefinition[], defaultStatus: string) {
  return JSON.stringify({ defaultStatus, items: items.map(item => ({ id: item.id, ...statusValues(item) })) })
}

export default function StatusManager({ spaceId, focusId, onClose, onSaved }: { spaceId: string; focusId?: string; onClose: () => void; onSaved: (catalog: WorkStatusCatalog) => void }) {
  const theme = useWorkTheme()
  const [baseline, setBaseline] = useState<WorkStatusCatalog | null>(null), [rows, setRows] = useState<WorkStatusDefinition[]>([]), [defaultStatus, setDefaultStatus] = useState('')
  const [deletions, setDeletions] = useState<Record<string, string>>({}), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false), [latest, setLatest] = useState<WorkStatusCatalog | null>(null), [dropId, setDropId] = useState('')
  const alive = useRef(true), running = useRef(false), dragId = useRef(''), focusNext = useRef(focusId), body = useRef<HTMLDivElement>(null)
  const activeRows = rows.filter(row => !(row.id in deletions))
  const dirty = !!baseline && shape(activeRows, defaultStatus) !== shape(baseline.items, baseline.defaultStatus)
  const guard = useUnsavedChanges(dirty, busy)
  const path = `${workPath(spaceId)}/statuses`
  function adopt(value: WorkStatusCatalog) {
    setBaseline(value); setRows(value.items); setDefaultStatus(value.defaultStatus); setDeletions({}); setLatest(null); setConflict(false); setUncertain(false); setError('')
  }
  useEffect(() => {
    alive.current = true
    const abort = new AbortController()
    request<WorkStatusCatalog>(path, { signal: abort.signal }).then(value => { if (alive.current) adopt(value) })
      .catch(cause => { if (!abort.signal.aborted && alive.current) setError(messageOf(cause)) })
      .finally(() => { if (alive.current && !abort.signal.aborted) setLoading(false) })
    return () => { alive.current = false; abort.abort() }
  }, [path])
  useEffect(() => {
    if (!focusNext.current || loading) return
    const target = body.current?.querySelector<HTMLInputElement>(`[data-status-name="${focusNext.current}"]`)
    if (target) { target.focus(); target.select(); focusNext.current = undefined }
  }, [rows, loading])
  function close() { guard.requestLeave(onClose) }
  function patch(id: string, change: Partial<WorkStatusDefinition>) { setRows(current => current.map(row => row.id === id ? { ...row, ...change } : row)) }
  function add() {
    const id = newWorkId()
    focusNext.current = id
    setRows(current => [...current, { id, name: '', type: 'todo', color: '#7c8f84', description: '', position: current.length, isDefault: false, total: 0, archivedTotal: 0 }])
  }
  function remove(id: string) {
    if (!baseline?.items.some(row => row.id === id)) setRows(current => current.filter(row => row.id !== id))
    else setDeletions(current => ({ ...current, [id]: '' }))
    if (defaultStatus === id) setDefaultStatus('')
    setDeletions(current => Object.fromEntries(Object.entries(current).map(([key, target]) => [key, target === id ? '' : target])))
  }
  function shift(id: string, destination: number) {
    setRows(current => {
      const active = current.filter(row => !(row.id in deletions)), from = active.findIndex(row => row.id === id)
      if (from < 0 || destination < 0 || destination >= active.length) return current
      const next = [...active], [row] = next.splice(from, 1); next.splice(destination, 0, row)
      return [...next, ...current.filter(row => row.id in deletions)]
    })
  }
  function drop(event: DragEvent, target: string) {
    event.preventDefault(); setDropId('')
    if (!dragId.current || dragId.current === target) return
    shift(dragId.current, activeRows.findIndex(row => row.id === target)); dragId.current = ''
  }
  async function readLatest() {
    if (running.current) return
    running.current = true; setBusy(true)
    try {
      const value = await request<WorkStatusCatalog>(path)
      if (!alive.current) return
      if (!baseline) { adopt(value); return }
      if (uncertain && shape(value.items, value.defaultStatus) === shape(activeRows, defaultStatus)) { onSaved(value); return }
      setLatest(value); setConflict(true); setError(t('最新配置已读取，草稿仍保留。请对照后选择。', 'The latest configuration is available. Your draft is retained; compare before continuing.'))
    } catch (cause) { if (alive.current) setError(messageOf(cause)) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  function keepDraft() {
    if (!baseline || !latest) return
    const merged = mergeStatusDraft(baseline, rows, deletions, defaultStatus, latest)
    if ('error' in merged) {
      const messages = {
        removed: t('“{name}”已被其他人删除，相关草稿无法合并。请撤回该状态的改动，或使用最新配置。', '“{name}” was removed elsewhere, so its draft changes cannot be merged. Revert those changes or use the latest configuration.', { name: merged.name }),
        'id-conflict': t('新增状态“{name}”的标识已存在。草稿已保留，请移除此新增状态后再合并。', 'The ID for the new status “{name}” already exists. Your draft is retained; remove that new status before merging.', { name: merged.name }),
        'target-removed': t('迁移目标“{name}”已不可用，请更换迁移目标后再合并。', 'The destination “{name}” is unavailable. Choose another destination before merging.', { name: merged.name }),
        'too-many': t('合并后将超过 64 个状态，请减少新增状态后再合并。', 'The merged catalog would exceed 64 statuses. Remove some new statuses before merging.'),
      }
      setError(messages[merged.error]); return
    }
    setBaseline(latest); setRows(merged.rows); setDefaultStatus(merged.defaultStatus); setDeletions(merged.deletions); setLatest(null); setConflict(false); setUncertain(false); setError('')
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!baseline || running.current || !baseline.canEdit || conflict || uncertain || !dirty) return
    if (!activeRows.length) { setError(t('请至少保留一个状态。', 'Keep at least one status.')); return }
    if (!activeRows.some(row => row.id === defaultStatus)) { setError(t('请选择默认状态。', 'Choose the default status.')); return }
    const names = new Set<string>()
    for (const row of activeRows) {
      const key = row.name.trim().toLowerCase()
      if (!key || [...row.name.trim()].length > 80) { setError(t('状态名称必填，最多 80 个字符。', 'Status names are required and allow at most 80 characters.')); return }
      if (names.has(key)) { setError(t('状态名称不能重复。', 'Status names must be unique.')); return }
      names.add(key)
    }
    for (const [id, target] of Object.entries(deletions)) {
      const row = rows.find(value => value.id === id)!
      if (((row.total || 0) + (row.archivedTotal || 0) > 0 || target) && !activeRows.some(value => value.id === target)) {
        setError(t('请为要删除的状态选择有效的迁移目标。', 'Choose a valid destination for the statuses being removed.')); return
      }
    }
    const create: NonNullable<WorkStatusBatch['create']> = [], patches: NonNullable<WorkStatusBatch['patches']> = []
    for (const row of activeRows) {
      const old = baseline.items.find(value => value.id === row.id)
      const fields = statusValues(row)
      if (!old) create.push({ id: row.id, ...fields })
      else {
        const changes = Object.fromEntries(editableStatusFields.filter(key => old[key] !== fields[key]).map(key => [key, fields[key]]))
        if (Object.keys(changes).length) patches.push({ id: row.id, ...changes })
      }
    }
    const input: WorkStatusBatch = { expectedRevision: baseline.revision, create, patches, order: activeRows.map(row => row.id), deletions: Object.entries(deletions).map(([id, moveToStatus]) => ({ id, ...(moveToStatus ? { moveToStatus } : {}) })), defaultStatus }
    running.current = true; setBusy(true); setError('')
    try {
      const value = await request<WorkStatusCatalog>(`${path}/batch-edit`, { method: 'POST', body: input })
      if (alive.current) onSaved(value)
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError(t('状态或事项已在其他地方更新，草稿已保留。请读取最新配置后比较。', 'Statuses or items changed elsewhere. Your draft is retained. Read the latest configuration to compare.')) }
      else if (!(cause instanceof ApiError) || cause.status >= 500) { setUncertain(true); setError(t('保存结果尚未确认，草稿已保留。请读取最新配置核对。', 'The save result is unconfirmed. Your draft is retained; read the current configuration to check.')) }
      else setError(messageOf(cause))
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <><Dialog open onOpenChange={value => { if (!value) close() }}><DialogContent className={`admin-ui work-theme work-theme-${theme} work-drawer work-status-manager`} data-theme={theme} showCloseButton={false} aria-describedby={undefined} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
    <header className="work-detail-heading"><DialogTitle>{t('管理状态', 'Manage statuses')}</DialogTitle><Button type="button" variant="ghost" size="icon" disabled={busy} onClick={close} aria-label={t('关闭状态管理', 'Close status manager')}><X size={19}/></Button></header>
    {loading ? <Loading/> : <form className="work-detail-form" onSubmit={event => void save(event)} onInvalidCapture={event => handleFormInvalid(event, setError)}>
      <div className="work-detail-body" ref={body}>
        <ErrorMessage error={error}/>
        {(conflict || uncertain || !baseline) && <section className="work-conflict"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void readLatest()}>{t('读取最新配置', 'Read latest configuration')}</Button>{latest && <><div className="work-status-comparison">{latest.items.map(row => <div key={row.id}><span className="work-status-dot" style={{ backgroundColor: row.color }}/><strong>{row.name}</strong><span>{statusTypeLabel(row.type)}</span>{row.id === latest.defaultStatus && <span>{t('默认', 'Default')}</span>}</div>)}</div><div className="work-conflict-actions"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => adopt(latest)}>{t('使用最新配置', 'Use latest configuration')}</Button><Button type="button" size="sm" disabled={busy || !latest.canEdit} onClick={keepDraft}>{t('保留草稿改动', 'Keep my draft changes')}</Button></div></>}</section>}
        {baseline && <fieldset className="admin-plain-fieldset" disabled={busy || !baseline.canEdit}>
          <div className="work-status-rows">{rows.map(row => {
            const deleted = row.id in deletions, index = activeRows.findIndex(item => item.id === row.id), isNew = !baseline.items.some(item => item.id === row.id)
            const count = (row.total || 0) + (row.archivedTotal || 0)
            return <section className={`work-status-row ${deleted ? 'is-deleted' : ''} ${dropId === row.id ? 'drop-before' : ''}`} key={row.id} data-status-id={row.id} onDragOver={event => { if (!dragId.current || deleted) return; event.preventDefault(); setDropId(row.id) }} onDrop={event => drop(event, row.id)}>
              {deleted ? <><div className="work-status-removal-heading"><span className="work-status-dot" style={{ backgroundColor: row.color }}/><strong>{row.name}</strong><span>{t('待删除', 'To remove')}</span><Button type="button" variant="ghost" size="icon-sm" aria-label={t('撤销删除：{name}', 'Undo removal: {name}', { name: row.name })} onClick={() => setDeletions(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== row.id)))}><Undo2 size={15}/></Button></div><label className="work-status-migration"><span>{count ? t('迁移 {count} 个事项（含 {archived} 个已归档）', 'Move {count} items ({archived} archived)', { count, archived: row.archivedTotal || 0 }) : t('有新增事项时迁移至', 'If items are added, move them to')}</span><StyledSelect value={deletions[row.id]} tone="home" theme={theme} aria-label={t('{name}的迁移目标', 'Destination for {name}', { name: row.name })} onValueChange={value => setDeletions(current => ({ ...current, [row.id]: value }))} options={[{ value: '', label: count ? t('选择目标状态', 'Choose destination') : t('无事项时直接删除', 'Remove if empty') }, ...activeRows.map(item => ({ value: item.id, label: item.name || t('未命名状态', 'Unnamed status') }))]}/></label></> : <>
                <div className="work-status-row-main"><button type="button" className="work-status-drag" draggable={!busy && baseline.canEdit} onDragStart={event => { dragId.current = row.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-lingshu-status', row.id) }} onDragEnd={() => { dragId.current = ''; setDropId('') }} aria-label={t('拖动排序：{name}', 'Reorder: {name}', { name: row.name })}><GripVertical size={17}/></button><input type="color" className="work-status-color" value={row.color} aria-label={t('状态颜色：{name}', 'Status color: {name}', { name: row.name })} onChange={event => patch(row.id, { color: event.target.value })}/><Input data-status-name={row.id} aria-label={t('状态名称', 'Status name')} value={row.name} required maxLength={80} placeholder={t('状态名称', 'Status name')} onChange={event => patch(row.id, { name: event.target.value })}/><StyledSelect tone="home" theme={theme} aria-label={t('状态类型：{name}', 'Status type: {name}', { name: row.name })} value={row.type} disabled={busy || !baseline.canEdit || (!isNew && builtin.has(row.id))} title={!isNew && builtin.has(row.id) ? t('内置状态保留原有类型', 'Built-in statuses retain their original type') : undefined} onValueChange={value => patch(row.id, { type: value as WorkStatusDefinition['type'] })} options={workStatusTypes.map(type => ({ value: type, label: statusTypeLabel(type) }))}/></div>
                <div className="work-status-row-options"><label className="work-status-default"><input type="radio" name="work-default-status" checked={defaultStatus === row.id} onChange={() => setDefaultStatus(row.id)}/>{t('默认', 'Default')}</label>{count > 0 && <span className="work-status-count">{t('{count} 个事项', '{count} items', { count })}</span>}<span className="grow"/><Button type="button" variant="ghost" size="icon-sm" disabled={index === 0 || busy} aria-label={t('上移：{name}', 'Move up: {name}', { name: row.name })} onClick={() => shift(row.id, index - 1)}><ArrowUp size={14}/></Button><Button type="button" variant="ghost" size="icon-sm" disabled={index === activeRows.length - 1 || busy} aria-label={t('下移：{name}', 'Move down: {name}', { name: row.name })} onClick={() => shift(row.id, index + 1)}><ArrowDown size={14}/></Button><Button type="button" variant="ghost" size="icon-sm" disabled={activeRows.length === 1 || busy} aria-label={t('删除状态：{name}', 'Remove status: {name}', { name: row.name })} onClick={() => remove(row.id)}><Trash2 size={14}/></Button></div>
                <Input className="work-status-description" aria-label={t('用途说明：{name}', 'Usage description: {name}', { name: row.name })} placeholder={t('用途说明（可选）', 'Usage description (optional)')} value={row.description} maxLength={1000} onChange={event => patch(row.id, { description: event.target.value })}/>
              </>}
            </section>
          })}</div>
          <Button type="button" className="work-add-status" variant="outline" disabled={busy || !baseline.canEdit || activeRows.length >= 64} onClick={add}><Plus size={16}/>{t('新增状态', 'Add status')}</Button>
        </fieldset>}
      </div>
      <footer className="work-detail-footer"><Button type="button" variant="outline" disabled={busy} onClick={close}>{t('取消', 'Cancel')}</Button><span className="grow"/><Button type="submit" disabled={busy || loading || !baseline?.canEdit || !dirty || conflict || uncertain}><Save size={15}/>{busy ? t('正在保存…', 'Saving…') : t('保存状态', 'Save statuses')}</Button></footer>
    </form>}
  </DialogContent></Dialog>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
