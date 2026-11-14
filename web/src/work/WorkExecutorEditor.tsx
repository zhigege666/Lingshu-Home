import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, Save, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { workPath } from '../core/work-types'
import type { WorkExecutorDefinition, WorkExecutorResponse } from '../core/work-automation-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Field, Loading, handleFormInvalid } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import WorkToolDetail from './WorkToolDetail'

type Draft = Pick<WorkExecutorDefinition, 'name' | 'endpoint' | 'resourceKey' | 'allowPrivateNetwork' | 'pollIntervalSeconds' | 'timeoutSeconds' | 'enabled'>
const draftOf = (value?: WorkExecutorDefinition): Draft => ({ name: value?.name || '', endpoint: value?.endpoint || '', resourceKey: value?.resourceKey || '', allowPrivateNetwork: value?.allowPrivateNetwork || false, pollIntervalSeconds: value?.pollIntervalSeconds || 5, timeoutSeconds: value?.timeoutSeconds || 3600, enabled: value?.enabled || false })
const normalized = (value: Draft): Draft => ({ ...value, name: value.name.trim(), endpoint: value.endpoint.trim().replace(/\/+$/, ''), resourceKey: value.resourceKey.trim() })
const changes = (base: Draft, draft: Draft) => Object.fromEntries(Object.entries(normalized(draft)).filter(([key, value]) => normalized(base)[key as keyof Draft] !== value))
export default function WorkExecutorEditor({ spaceId, selection, enabled, canEdit, onClose, onSaved }: { spaceId: string; selection: { id: string; create?: boolean }; enabled: boolean; canEdit: boolean; onClose: () => void; onSaved: (value: WorkExecutorDefinition) => void }) {
  const [response, setResponse] = useState<WorkExecutorResponse | null>(null), [creating, setCreating] = useState(!!selection.create), [draft, setDraft] = useState<Draft>(() => draftOf()), [token, setToken] = useState(''), [clearToken, setClearToken] = useState(false)
  const [loading, setLoading] = useState(!selection.create), [busy, setBusy] = useState(false), [error, setError] = useState(''), [latest, setLatest] = useState<WorkExecutorResponse | null>(null), [uncertain, setUncertain] = useState(false)
  const alive = useRef(true), loaded = useRef(false), pending = useRef(false), intent = useRef<Record<string, unknown> | null>(null)
  const base = response?.executor, editable = enabled && (response?.canEdit ?? canEdit), active = response?.activeExecutions || 0
  const dirty = Object.keys(changes(draftOf(base), draft)).length > 0 || !!token || clearToken, guard = useUnsavedChanges(dirty, busy), path = `${workPath(spaceId)}/executors/${selection.id}`
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function adopt(data: WorkExecutorResponse) { loaded.current = true; setResponse(data); setDraft(draftOf(data.executor)); setCreating(false); setToken(''); setClearToken(false); setLatest(null); setUncertain(false); setError(''); intent.current = null }
  useEffect(() => {
    if (!enabled || selection.create || loaded.current) return
    const abort = new AbortController(); setLoading(true)
    request<WorkExecutorResponse>(path, { signal: abort.signal }).then(data => { if (!abort.signal.aborted) adopt(data) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [path, enabled])
  async function readLatest() {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try {
      const data = await request<WorkExecutorResponse>(path)
      if (!alive.current) return
      const intended = intent.current, matches = intended && !('secret' in intended) && Object.entries(intended).every(([key, value]) => JSON.stringify(data.executor[key as keyof WorkExecutorDefinition]) === JSON.stringify(value))
      if (uncertain && matches) { adopt(data); onSaved(data.executor) }
      else { setLatest(data); setError(token || clearToken ? t('凭据不回传，无法核验本次凭据写入。输入已保留，请选择使用当前配置或再次明确保存。', 'Credentials are never returned, so this credential write cannot be verified. Your input is retained; use the current configuration or explicitly save it again.') : t('配置已有更新，草稿保留。', 'Configuration changed; your draft is retained.')) }
    } catch (cause) { if (alive.current) { if (creating && cause instanceof ApiError && cause.status === 404) setUncertain(false); setError(messageOf(cause)) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function save(event?: FormEvent, archived?: boolean) {
    event?.preventDefault()
    if (!editable || pending.current || uncertain || latest) return
    const patch: Record<string, unknown> = archived === undefined ? creating ? normalized(draft) : changes(draftOf(base), draft) : { archived }
    if (archived === undefined) { if (token) patch.secret = { bearerToken: token }; else if (clearToken) patch.secret = { clearBearerToken: true } }
    if (!Object.keys(patch).length) return
    intent.current = { ...patch }; pending.current = true; setBusy(true); setError('')
    try {
      const data = await request<WorkExecutorResponse>(creating ? `${workPath(spaceId)}/executors` : path, { method: creating ? 'POST' : 'PATCH', body: creating ? { id: selection.id, ...patch } : { expectedRevision: base?.revision, ...patch } })
      if (alive.current) { adopt(data); onSaved(data.executor) }
    } catch (cause) { if (alive.current) { setError(messageOf(cause)); if (!(cause instanceof ApiError) || cause.status >= 500 || cause.status === 409) setUncertain(true) } }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  function mergeLatest() {
    if (!latest) return
    const patch = changes(draftOf(base), draft)
    setResponse(latest); setDraft({ ...draftOf(latest.executor), ...patch }); setCreating(false); setLatest(null); setUncertain(false); setError('')
  }
  const close = () => guard.requestLeave(onClose)
  return <><WorkToolDetail title={creating ? t('新建执行器', 'New executor') : t('执行器设置', 'Executor settings')} busy={busy} onClose={close}><header className="work-detail-heading"><h2>{creating ? t('新建执行器', 'New executor') : t('执行器设置', 'Executor settings')}</h2><Button type="button" size="icon" variant="ghost" disabled={busy} aria-label={t('关闭执行器', 'Close executor')} onClick={close}><X size={18}/></Button></header>{loading ? <Loading/> : !creating && !base ? <div className="work-detail-body"><ErrorMessage error={error}/></div> : <form className="work-detail-form" onSubmit={event => void save(event)} onInvalidCapture={event => handleFormInvalid(event, setError)}><div className="work-detail-body"><ErrorMessage error={error}/>{(uncertain || latest) && <section className="work-conflict"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void readLatest()}>{t('读取当前配置', 'Read current configuration')}</Button>{latest && <><dl><dt>{t('名称', 'Name')}</dt><dd>{latest.executor.name}</dd><dt>{t('端点', 'Endpoint')}</dt><dd>{latest.executor.endpoint}</dd><dt>{t('资源', 'Resource')}</dt><dd>{latest.executor.resourceKey}</dd><dt>{t('凭据', 'Credential')}</dt><dd>{latest.executor.credentialConfigured ? t('已配置', 'Configured') : t('未配置', 'Not configured')}</dd></dl><div className="work-conflict-actions"><Button type="button" variant="outline" size="sm" onClick={() => adopt(latest)}>{t('使用当前配置', 'Use current configuration')}</Button><Button type="button" size="sm" onClick={mergeLatest}>{t('保留我的改动', 'Keep my changes')}</Button></div></>}</section>}
    <fieldset className="admin-plain-fieldset" disabled={!editable || busy}><Field label={t('名称', 'Name')}><Input data-executor-name autoFocus={creating} required maxLength={160} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/></Field><label className="work-feature-switch"><input data-executor-enabled type="checkbox" checked={draft.enabled} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))}/>{t('启用执行器', 'Enable executor')}</label>{active > 0 && <p className="work-inline-note">{t('有 {count} 次执行待结束，连接、凭据与资源暂不可改。', '{count} executions are pending. Connection, credential and resource settings are locked.', { count: active })}</p>}
      <fieldset className="admin-plain-fieldset" disabled={active > 0 || !editable || busy}><Field label={t('HTTP 服务端点', 'HTTP service endpoint')}><Input data-executor-endpoint type="url" required maxLength={2000} placeholder="https://runner.example.com" value={draft.endpoint} onChange={event => setDraft(current => ({ ...current, endpoint: event.target.value }))}/></Field><label className="work-feature-switch"><input data-executor-private type="checkbox" checked={draft.allowPrivateNetwork} onChange={event => setDraft(current => ({ ...current, allowPrivateNetwork: event.target.checked }))}/>{t('允许私网端点', 'Allow private network endpoints')}</label><Field label={t('资源键', 'Resource key')} hint={t('相同资源串行执行', 'Executions sharing a resource run sequentially')}><Input data-executor-resource required maxLength={160} pattern="[A-Za-z0-9][A-Za-z0-9_.:\/\-]{0,159}" value={draft.resourceKey} onChange={event => setDraft(current => ({ ...current, resourceKey: event.target.value }))}/></Field><div className="work-fields-row"><Field label={t('核验间隔（秒）', 'Receipt interval (seconds)')}><Input type="number" required min={2} max={60} value={draft.pollIntervalSeconds} onChange={event => setDraft(current => ({ ...current, pollIntervalSeconds: Number(event.target.value) }))}/></Field><Field label={t('执行时限（秒）', 'Execution timeout (seconds)')}><Input type="number" required min={30} max={86400} value={draft.timeoutSeconds} onChange={event => setDraft(current => ({ ...current, timeoutSeconds: Number(event.target.value) }))}/></Field></div><Field label="Bearer Token" hint={base?.credentialConfigured ? t('已配置；留空保留', 'Configured; leave blank to keep') : t('启用前需配置', 'Required before enabling')}><Input data-executor-token type="password" autoComplete="new-password" maxLength={2048} disabled={clearToken || busy || !editable || active > 0} value={token} onChange={event => setToken(event.target.value)}/></Field>{base?.credentialConfigured && <label className="work-feature-switch"><input data-executor-clear-token type="checkbox" checked={clearToken} onChange={event => { setClearToken(event.target.checked); if (event.target.checked) setToken('') }}/>{t('移除凭据', 'Remove credential')}</label>}</fieldset>
    </fieldset></div><footer className="work-detail-footer">{base && editable && <Button type="button" variant="ghost" size="sm" disabled={busy || !!active || dirty || uncertain || !!latest} onClick={() => void save(undefined, !base.archived)}>{base.archived ? <ArchiveRestore size={14}/> : <Archive size={14}/>}<span>{base.archived ? t('恢复', 'Restore') : t('归档', 'Archive')}</span></Button>}<span className="grow"/><Button type="button" variant="outline" size="sm" disabled={busy} onClick={close}>{t('关闭', 'Close')}</Button><Button type="submit" disabled={!editable || busy || !draft.name.trim() || !draft.endpoint.trim() || !draft.resourceKey.trim() || (!creating && !dirty) || uncertain || !!latest || (draft.enabled && !token && (!base?.credentialConfigured || clearToken))}><Save size={14}/>{t('保存执行器', 'Save executor')}</Button></footer></form>}</WorkToolDetail>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
