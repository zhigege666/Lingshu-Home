import { useRef, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { newWorkId, workPath, type WorkProject } from '../core/work-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Field, Modal, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import { useWorkTheme } from './work-theme'

export default function ProjectDialog({ spaceId, project, onClose, onSaved }: { spaceId: string; project: WorkProject | null; onClose: () => void; onSaved: (value: WorkProject, created: boolean) => void }) {
  const theme = useWorkTheme()
  const [id] = useState(() => project?.id || newWorkId()), [baseline, setBaseline] = useState(project)
  const [name, setName] = useState(project?.name || ''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false)
  const [latest, setLatest] = useState<WorkProject | null>(null), running = useRef(false)
  const submittedIntent = useRef<{ name?: string; archived?: boolean } | null>(null)
  const guard = useUnsavedChanges(name.trim() !== (baseline?.name || ''), busy, () => setName(baseline?.name || ''))
  async function readLatest() {
    if (running.current) return
    running.current = true; setBusy(true)
    try {
      const data = await request<{ items: WorkProject[] }>(`${workPath(spaceId)}/projects`), value = data.items.find(item => item.id === id)
      if (!value) { setUncertain(false); setError(t('尚未读到该项目，可保留原标识重新提交。', 'The project was not found. You can submit again with the same ID.')); return }
      const intent = submittedIntent.current
      if (uncertain && intent && Object.entries(intent).every(([key, expected]) => value[key as 'name' | 'archived'] === expected)) { onSaved(value, !baseline); return }
      setLatest(value); setConflict(true); setError(t('项目已更新。当前名称仍保留，请比较后选择。', 'This project changed. Your draft name is retained; compare before continuing.'))
    } catch (cause) { setError(messageOf(cause)) }
    finally { running.current = false; setBusy(false) }
  }
  async function save(event?: FormEvent, archived?: boolean, expectedRevision?: string) {
    event?.preventDefault()
    if (running.current || !name.trim() || (uncertain && !expectedRevision)) return
    if ([...name.trim()].length > 80) { setError(t('项目名称最多允许 80 个字符。', 'Project names allow at most 80 characters.')); return }
    running.current = true; setBusy(true); setError('')
    submittedIntent.current = baseline && archived !== undefined ? { archived } : { name: name.trim() }
    try {
      const value = await request<WorkProject>(`${workPath(spaceId)}/projects${baseline ? '/' + id : ''}`, { method: baseline ? 'PATCH' : 'POST', body: baseline ? { expectedRevision: expectedRevision || baseline.revision, ...(archived === undefined ? { name: name.trim() } : { archived }) } : { id, name: name.trim() } })
      onSaved(value, !baseline)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError(t('项目已更新，名称草稿已保留。请读取最新版本。', 'The project changed. Your draft name is retained. Read the latest version.')) }
      else if (!(cause instanceof ApiError) || cause.status >= 500) { setUncertain(true); setError(t('操作结果尚未确认，请读取最新版本后再决定。', 'The result is unconfirmed. Read the latest version before continuing.')) }
      else setError(messageOf(cause))
    } finally { running.current = false; setBusy(false) }
  }
  return <><Modal className={`work-theme work-theme-${theme}`} title={baseline ? t('编辑项目', 'Edit project') : t('新建项目', 'New project')} busy={busy} onClose={() => guard.requestLeave(onClose)}><form onSubmit={event => void save(event)} onInvalidCapture={event => handleFormInvalid(event, setError)} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }}>
    <Field label={t('项目名称', 'Project name')}><Input required autoFocus maxLength={160} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></Field>
    <ErrorMessage error={error}/>{(conflict || uncertain) && <div className="work-project-conflict"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void readLatest()}>{t('读取最新版本', 'Read latest version')}</Button>{latest && <><p>{t('最新名称：{name}', 'Latest name: {name}', { name: latest.name })}</p>{submittedIntent.current?.archived !== undefined && <p>{t('当前状态：{state}；待确认操作：{action}', 'Current state: {state}; unconfirmed action: {action}', { state: latest.archived ? t('已归档', 'Archived') : t('未归档', 'Active'), action: submittedIntent.current.archived ? t('归档项目', 'Archive project') : t('恢复项目', 'Restore project') })}</p>}<div className="admin-button-row"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setBaseline(latest); setName(latest.name); setConflict(false); setUncertain(false); setLatest(null); submittedIntent.current = null; setError('') }}>{t('使用最新版本', 'Use latest version')}</Button>{baseline && submittedIntent.current?.archived === undefined && <Button type="button" size="sm" disabled={busy} onClick={() => void save(undefined, undefined, latest.revision)}>{t('保存当前名称', 'Save my name')}</Button>}</div></>}</div>}
    <footer className="admin-form-footer">{baseline && <Button type="button" variant="ghost" disabled={busy || uncertain || conflict} onClick={() => guard.requestLeave(() => void save(undefined, !baseline.archived))}>{baseline.archived ? <ArchiveRestore size={15}/> : <Archive size={15}/>}<span>{baseline.archived ? t('恢复项目', 'Restore project') : t('归档项目', 'Archive project')}</span></Button>}<span className="grow"/><Button type="button" variant="outline" disabled={busy} onClick={() => guard.requestLeave(onClose)}>{t('取消', 'Cancel')}</Button><Button type="submit" disabled={busy || !name.trim() || uncertain || conflict || (!!baseline && name.trim() === baseline.name)}>{busy ? t('正在保存…', 'Saving…') : baseline ? t('保存项目', 'Save project') : t('创建项目', 'Create project')}</Button></footer>
  </form></Modal>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
