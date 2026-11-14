import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import type { Bootstrap } from '../core/types'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { Button } from '../components/ui/button'
import { FieldHelp } from '../components/FieldHelp'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import './mcp-settings.css'

type Source = 'startup' | 'saved'
type Draft = { workflowEnabled: boolean; collaborationEnabled: boolean }
type McpSettings = Draft & { revision: string; workflowSource: Source; collaborationSource: Source; canManage: boolean }
type Submission = { baseline: McpSettings; draft: Draft }
type Props = { bootstrap: Bootstrap; onNotice: (message: string) => void; onBusyChange?: (busy: boolean) => void; disabled?: boolean }
const editable = (value: Draft): Draft => ({ workflowEnabled: value.workflowEnabled, collaborationEnabled: value.collaborationEnabled })
const same = (left: Draft, right: Draft) => left.workflowEnabled === right.workflowEnabled && left.collaborationEnabled === right.collaborationEnabled
const savedIntent = (value: McpSettings, draft: Draft) => same(value, draft) && value.workflowSource === 'saved' && value.collaborationSource === 'saved'
const enabledLabel = (enabled: boolean) => enabled ? t('开启', 'On') : t('关闭', 'Off')
const sourceLabel = (source: Source) => source === 'saved' ? t('页面设置', 'Saved settings') : t('启动值', 'Startup value')

export default function McpSettingsPanel({ bootstrap, onNotice, onBusyChange, disabled = false }: Props) {
  const [baseline, setBaseline] = useState<McpSettings | null>(null), [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [readingConfig, setReadingConfig] = useState(false), [error, setError] = useState('')
  const [remote, setRemote] = useState<McpSettings | null>(null), [needsRead, setNeedsRead] = useState(false), [accessDenied, setAccessDenied] = useState(false)
  const alive = useRef(false), running = useRef(false), reading = useRef<AbortController | null>(null), submitted = useRef<Submission | null>(null)
  const busyChange = useRef(onBusyChange), prefix = useId()
  busyChange.current = onBusyChange
  const owner = bootstrap.user?.role === 'Owner'
  const canManage = owner && !!baseline?.canManage && !accessDenied
  const dirty = !!baseline && !!draft && !same(baseline, draft)
  const needsPersistence = !!baseline && (baseline.workflowSource !== 'saved' || baseline.collaborationSource !== 'saved')
  const blocked = busy || loading || disabled
  const fieldsBlocked = blocked || !canManage || needsRead || !!remote

  function working(value: boolean) { running.current = value; if (alive.current) setBusy(value); busyChange.current?.(value) }
  function adopt(value: McpSettings) {
    setBaseline(value); setDraft(editable(value)); setRemote(null); setNeedsRead(false); setError(''); setAccessDenied(!value.canManage)
    submitted.current = null
  }
  function resetDraft() {
    if (baseline) setDraft(editable(baseline))
    setRemote(null); setNeedsRead(false); setError(''); submitted.current = null
  }
  const guard = useUnsavedChanges(dirty || needsRead || !!remote || busy, busy, resetDraft)

  useEffect(() => {
    alive.current = true
    setBaseline(null); setDraft(null); setRemote(null); setNeedsRead(false); setAccessDenied(false); setError(''); setLoading(true)
    submitted.current = null
    const controller = new AbortController(); reading.current = controller
    request<McpSettings>('/settings/mcp', { signal: controller.signal }).then(value => {
      if (alive.current && !controller.signal.aborted) adopt(value)
    }).catch(cause => {
      if (alive.current && !controller.signal.aborted) setError(messageOf(cause))
    }).finally(() => { if (alive.current && !controller.signal.aborted) setLoading(false) })
    return () => { alive.current = false; controller.abort(); reading.current?.abort(); busyChange.current?.(false) }
  }, [bootstrap.user?.id])

  function compare(value: McpSettings, attempt: Submission) {
    setAccessDenied(!value.canManage)
    if (savedIntent(value, attempt.draft)) {
      adopt(value)
      onNotice(t('已核对，MCP 设置已保存并生效。', 'Verified: MCP settings are saved and effective.'))
      return
    }
    setNeedsRead(false)
    if (value.revision === attempt.baseline.revision && same(value, attempt.baseline)
      && value.workflowSource === attempt.baseline.workflowSource && value.collaborationSource === attempt.baseline.collaborationSource) {
      setRemote(null); submitted.current = null
      setError(t('当前仍是保存前的配置，修改已保留。可以重新保存。', 'The current settings still match the previous state. Your edits are retained; you can save again.'))
      return
    }
    setRemote(value)
    setError(t('配置已变化，修改已保留。请核对当前值后选择。', 'The settings changed. Your edits are retained; compare the current values before continuing.'))
  }

  async function readLatest(discard = false) {
    if (running.current) return
    setReadingConfig(true); working(true); setError('')
    const controller = new AbortController(); reading.current?.abort(); reading.current = controller
    try {
      const value = await request<McpSettings>('/settings/mcp', { signal: controller.signal })
      if (!alive.current || controller.signal.aborted) return
      const attempt = submitted.current || (baseline && draft ? { baseline, draft } : null)
      if (discard || !attempt) adopt(value)
      else compare(value, attempt)
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) {
        setError(messageOf(cause))
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) setAccessDenied(true)
      }
    } finally { if (alive.current && !controller.signal.aborted) { setLoading(false); setReadingConfig(false); working(false) } }
  }

  function keepChanges() {
    if (!baseline || !draft || !remote || !remote.canManage || !owner || running.current) return
    const next = editable(remote)
    if (draft.workflowEnabled !== baseline.workflowEnabled) next.workflowEnabled = draft.workflowEnabled
    if (draft.collaborationEnabled !== baseline.collaborationEnabled) next.collaborationEnabled = draft.collaborationEnabled
    setBaseline(remote); setDraft(next); setRemote(null); setNeedsRead(false); setAccessDenied(false); setError(''); submitted.current = null
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!baseline || !draft || running.current || fieldsBlocked || (!dirty && !needsPersistence)) return
    const attempt: Submission = { baseline, draft: editable(draft) }
    submitted.current = attempt; setReadingConfig(false); working(true); setError('')
    try {
      const value = await request<McpSettings>('/settings/mcp', { method: 'PUT', body: { expectedRevision: baseline.revision, ...attempt.draft } })
      if (!alive.current) return
      adopt(value)
      onNotice(t('MCP 设置已保存并生效。', 'MCP settings saved and effective.'))
    } catch (cause) {
      if (!alive.current) return
      const rejected = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408
      if (rejected && (cause as ApiError).status !== 409) {
        submitted.current = null; setError(messageOf(cause))
        if ([401, 403].includes((cause as ApiError).status)) setAccessDenied(true)
        return
      }
      setNeedsRead(true); setReadingConfig(true)
      setError(rejected ? t('配置已变化，正在读取当前值。', 'Settings changed; reading the current values.') : t('保存结果尚未确认，正在核对。', 'The save result is unconfirmed; checking the current settings.'))
      try {
        const value = await request<McpSettings>('/settings/mcp')
        if (alive.current) compare(value, attempt)
      } catch (readError) {
        if (!alive.current) return
        setNeedsRead(true)
        setError(t('保存结果尚未确认，修改已保留。请重新读取配置后核对。', 'The save result is still unconfirmed. Your edits are retained; read the settings again to verify.'))
        if (readError instanceof ApiError && [401, 403].includes(readError.status)) setAccessDenied(true)
      }
    } finally { if (alive.current) { setReadingConfig(false); working(false) } }
  }

  const rows: { key: keyof Draft; title: string; description: string; source: Source | undefined }[] = [
    { key: 'workflowEnabled', title: t('MCP 工作流指导', 'MCP workflow guidance'), description: t('引导 Agent 维护事项、进展和交付记录。', 'Guide agents to maintain work items, progress and delivery records.'), source: baseline?.workflowSource },
    { key: 'collaborationEnabled', title: t('多 Agent 协作', 'Multi-agent collaboration'), description: t('登记会话、认领事项并记录交接。', 'Register sessions, claim work items and record handoffs.'), source: baseline?.collaborationSource },
  ]
  return <section className="admin-mcp-settings" data-mcp-settings aria-labelledby={prefix + '-heading'}>
    <header className="admin-mcp-settings-heading"><div><h3 id={prefix + '-heading'}>{t('MCP 设置', 'MCP settings')}</h3><p>{t('对所有空间生效', 'Applies to all spaces')}</p></div>{baseline && <FieldHelp label={t('MCP 配置来源', 'MCP configuration sources')}>
      <p>{t('页面保存后立即生效，重启后保留，并优先于启动参数。首次保存前沿用启动值。', 'Saved settings take effect immediately, survive restarts and take priority over startup parameters. Startup values apply until the first save.')}</p>
      {rows.map(row => <p key={row.key}>{row.title}{t('：', ': ')}{sourceLabel(row.source!)}</p>)}
    </FieldHelp>}</header>
    {loading ? <p className="admin-hint" role="status">{t('正在读取 MCP 设置…', 'Loading MCP settings…')}</p> : !baseline || !draft ? <><p className="admin-inline-error" role="alert">{error}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void readLatest(true)}><RefreshCw size={14}/>{t('重新读取配置', 'Read settings again')}</Button></> : <form onSubmit={event => void save(event)}>
      <div className="admin-mcp-setting-rows">{rows.map(row => <div className="admin-mcp-setting-row" key={row.key}>
        <div><label id={prefix + '-' + row.key + '-label'} htmlFor={prefix + '-' + row.key}>{row.title}</label><p id={prefix + '-' + row.key + '-description'}>{row.description}</p></div>
        <SwitchPrimitive.Root id={prefix + '-' + row.key} className="admin-mcp-switch" checked={draft[row.key]} disabled={fieldsBlocked}
          aria-labelledby={prefix + '-' + row.key + '-label'} aria-describedby={prefix + '-' + row.key + '-description'}
          onCheckedChange={checked => { setDraft(previous => previous ? { ...previous, [row.key]: checked } : previous); setError('') }}><SwitchPrimitive.Thumb className="admin-mcp-switch-thumb"/></SwitchPrimitive.Root>
      </div>)}</div>
      {!canManage && <p className="admin-hint">{t('只有管理员可以修改全站 MCP 设置。', 'Only the owner can change site-wide MCP settings.')}</p>}
      {canManage && draft.collaborationEnabled !== baseline.collaborationEnabled && <p className="admin-mcp-setting-impact" role="status">{draft.collaborationEnabled
        ? t('开启后，Agent 修改事项前需要登记会话并认领事项。', 'When enabled, agents must register a session and claim an item before changing it.')
        : t('关闭后不再接受新会话和认领，已有认领仍可续租、交接和解除。', 'Disabling stops new sessions and claims. Existing claims can still be renewed, handed off and resolved.')}</p>}
      {bootstrap.modules?.work === false && draft.collaborationEnabled && <p className="admin-hint">{t('事项模块已关闭；协作设置会保留，启用事项后可用。', 'The Work module is disabled. Collaboration settings are retained and become available when Work is enabled.')}</p>}
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {remote && <section className="admin-mcp-settings-conflict" aria-label={t('比较 MCP 配置', 'Compare MCP settings')}>
        <table><thead><tr><th scope="col">{t('配置', 'Setting')}</th><th scope="col">{t('当前值', 'Current value')}</th><th scope="col">{t('我的修改', 'My edits')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><th scope="row">{row.title}</th><td>{enabledLabel(remote[row.key])}<small>{sourceLabel(row.key === 'workflowEnabled' ? remote.workflowSource : remote.collaborationSource)}</small></td><td>{enabledLabel(draft[row.key])}</td></tr>)}</tbody></table>
        <div className="admin-mcp-settings-actions"><Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => adopt(remote)}>{t('使用当前配置', 'Use current settings')}</Button><Button type="button" size="sm" disabled={blocked || !remote.canManage || !owner} onClick={keepChanges}>{t('保留我的修改', 'Keep my changes')}</Button></div>
      </section>}
      {needsRead && <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => void readLatest()}><RefreshCw size={14}/>{t('重新读取配置', 'Read settings again')}</Button>}
      {(owner || dirty || needsRead || remote) && <div className="admin-mcp-settings-actions">
        <Button type="button" variant="outline" disabled={blocked || (!dirty && !needsRead && !remote)} onClick={() => needsRead ? void readLatest(true) : remote ? adopt(remote) : resetDraft()}>{t('取消修改', 'Cancel changes')}</Button>
        <Button type="submit" disabled={fieldsBlocked || (!dirty && !needsPersistence)}>{busy && <LoaderCircle size={15} className="admin-spin"/>}{busy ? readingConfig ? t('正在读取…', 'Reading…') : t('正在保存…', 'Saving…') : t('保存 MCP 设置', 'Save MCP settings')}</Button>
      </div>}
    </form>}
    {guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard} description={needsRead ? t('保存结果尚未确认。离开会放弃本地草稿，但不会撤销可能已生效的配置。', 'The save result is unconfirmed. Leaving discards the local draft but does not undo settings that may already be effective.') : t('MCP 设置的修改尚未保存。离开会放弃本地草稿。', 'MCP setting changes have not been saved. Leaving discards the local draft.')}/>}
  </section>
}
