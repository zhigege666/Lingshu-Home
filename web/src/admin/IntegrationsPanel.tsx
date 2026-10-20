import { t, getLocale } from '../core/i18n'
import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import { Copy, KeyRound, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import type { Bootstrap, Dashboard, Dataset } from '../core/types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { Checkbox } from '../components/ui/checkbox'
import { Table,TableHeader,TableBody,TableHead,TableRow,TableCell } from '../components/ui/table'
import { Tabs,TabsContent,TabsList,TabsTrigger } from '../components/ui/tabs'
import { Empty,ErrorMessage,Field,handleFormInvalid,Loading,Modal } from '../components/Shared'
import SourceDialog, { sourceKindLabel } from './SourceDialog'
import { sourceExample } from './source-examples'
const CalendarImportDialog = lazy(() => import('./CalendarImportDialog'))
export type SourceInfo={id:string;spaceId:string;name:string;kind:string;schemaId:string;schemaVersion:number;datasetId:string;connection:Record<string,string>;sync:Record<string,unknown>;revision:string;enabled:boolean;configRevision:string;nextSyncAt:string|null;credentialConfigured:boolean;createdAt:string;updatedAt:string;lastSuccessAt:string|null;lastError:{code:string;message:string;at?:string}|null}
type Credential={id:string;name:string;spaceId:string;sourceId:string|null;actions:string[];expiresAt:string;createdAt:string;revokedAt:string|null;status:'active'|'expired'|'revoked'|'invalidated'}
const actionOptions=()=>[['navigation:read',t("读取导航", "Read bookmarks")],['navigation:write',t("维护导航", "Manage bookmarks")],['sources:read',t("读取数据源", "Read sources")],['sources:write',t("维护数据源", "Manage sources")],['datasets:write',t("推送快照", "Push snapshots")],['pages:read',t("读取页面", "Read pages")],['pages:write',t("维护页面", "Manage pages")]]
function time(value:string|null){return value?new Date(value).toLocaleString(getLocale(),{hour12:false}):t("尚未采集", "Not collected yet")}
async function copy(value: string) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); return }
  const previousFocus = document.activeElement
  const input = document.createElement('textarea')
  input.value = value; input.readOnly = true; input.tabIndex = -1
  input.setAttribute('aria-hidden', 'true')
  Object.assign(input.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' })
  document.body.append(input)
  try {
    input.select()
    if (!document.execCommand('copy')) throw new Error(t('无法自动复制，请选中文字后手动复制。', 'Unable to copy automatically. Select the text and copy it manually.'))
  } finally {
    input.remove()
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
  }
}
export default function IntegrationsPanel({bootstrap,dashboard,onNotice,onLogin,onOpenAccounts,onRefresh}:{bootstrap:Bootstrap;dashboard:Dashboard;onNotice:(message:string)=>void;onLogin:()=>void;onOpenAccounts:()=>void;onRefresh:()=>Promise<void>}){
  const actions = actionOptions()
  const [sources,setSources]=useState<SourceInfo[]>([]),[credentials,setCredentials]=useState<Credential[]>([])
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[formError,setFormError]=useState(''),[busy,setBusy]=useState(false)
  const [sourceOpen,setSourceOpen]=useState(false),[editingSource,setEditingSource]=useState<SourceInfo|null>(null),[calendarImport,setCalendarImport]=useState<SourceInfo|null>(null)
  const [tokenOpen,setTokenOpen]=useState(false),[tokenForm,setTokenForm]=useState({name:'',sourceId:'',days:30,actions:['navigation:read','pages:read']}),[tokenValue,setTokenValue]=useState('')
  const [selectedSource,setSelectedSource]=useState<SourceInfo|null>(null),[snapshot,setSnapshot]=useState<Dataset<unknown>|null>(null),[revoke,setRevoke]=useState<Credential|null>(null),[template,setTemplate]=useState('')
  const [queued,setQueued]=useState<Record<string,{revision:string;lastSuccessAt:string|null;lastErrorAt?:string;startedAt:number}>>({})
  const [deletingSource,setDeletingSource]=useState<SourceInfo|null>(null)
  const authenticated=!!bootstrap.user,canManage=authenticated&&dashboard.space.canEdit
  const allowedActions=actions.filter(([action])=>dashboard.space.canEdit||!action!.endsWith(':write'))
  const signInGuidance = <div className="admin-info"><p>{bootstrap.mode === 'open_edit'
    ? t('配置数据源、MCP 和推送令牌需要登录账号。已有管理员可直接登录；尚未创建管理员时，可在「访问与账号」中按需创建，继续保留免账号编辑模式。', 'Sign in to configure sources, MCP and push tokens. Existing administrators can sign in directly. If no administrator exists, optionally create one in Access and accounts while keeping account-free editing enabled.')
    : t('登录账号后可配置所属空间的数据源、MCP 和推送访问令牌。', 'Sign in to configure sources, MCP and push access tokens for your spaces.')}</p><div className="admin-button-row"><Button type="button" variant="outline" onClick={onLogin}>{t('登录账号', 'Sign in')}</Button>{bootstrap.mode === 'open_edit' && <Button type="button" variant="ghost" onClick={onOpenAccounts}>{t('访问与账号', 'Access and accounts')}</Button>}</div></div>

  async function load(){setLoading(true);setError('');const results=await Promise.allSettled([request<SourceInfo[]>(`/spaces/${dashboard.space.id}/sources`),authenticated?request<Credential[]>('/integrations/tokens'):Promise.resolve([] as Credential[])]);if(results[0].status==='fulfilled')setSources(results[0].value);else setError(messageOf(results[0].reason));if(results[1].status==='fulfilled')setCredentials(results[1].value);else setError(messageOf(results[1].reason));setLoading(false)}
  useEffect(()=>{void load()},[dashboard.space.id,authenticated])
  useEffect(() => {
    const entries = Object.entries(queued)
    if (!entries.length) return
    let active = true, limitReached = false
    let pending: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let requestLimit: ReturnType<typeof setTimeout> | undefined
    const clearWaiting = (ids: string[]) => setQueued(current => {
      const next = { ...current }
      for (const id of ids) if (next[id]?.startedAt === queued[id]?.startedAt) delete next[id]
      return next
    })
    // This short-lived wait follows an explicit collection request. It only
    // reads Home's cached status, never queues another upstream collection.
    const poll = async () => {
      if (!active || limitReached) return
      pending = new AbortController()
      let requestExpired = false, succeeded = false
      requestLimit = setTimeout(() => { requestExpired = true; pending?.abort() }, 10000)
      try {
        const value = await request<SourceInfo[]>(`/spaces/${dashboard.space.id}/sources`, { signal: pending.signal })
        if (!active || limitReached) return
        succeeded = true
        setSources(value)
        setQueued(current => {
          const next = { ...current }
          for (const [id, previous] of Object.entries(current)) {
            const source = value.find(item => item.id === id)
            if (!source || !source.enabled || source.revision !== previous.revision || source.lastSuccessAt !== previous.lastSuccessAt || source.lastError?.at !== previous.lastErrorAt) delete next[id]
          }
          return next
        })
      } catch (cause) {
        if (active && !limitReached) {
          clearWaiting(entries.map(([id]) => id))
          setError(requestExpired ? t('读取采集状态超时。可稍后刷新数据源；后台采集仍会继续。', 'Reading collection status timed out. Refresh sources later; the background task can still complete.') : messageOf(cause))
        }
      } finally {
        clearTimeout(requestLimit)
        pending = null
        if (active && !limitReached && succeeded) timer = setTimeout(poll, 4000)
      }
    }
    timer = setTimeout(poll, 4000)
    const waitLimit = setTimeout(() => {
      if (!active) return
      limitReached = true
      clearTimeout(timer)
      pending?.abort()
      clearWaiting(entries.filter(([, state]) => Date.now() - state.startedAt >= 120000).map(([id]) => id))
      setError(t('采集尚未返回结果，已停止等待。可稍后刷新数据源；后台采集仍会继续。', 'Collection has not returned a result. Waiting has stopped. Refresh sources later; the background task can still complete.'))
    }, Math.max(0, Math.min(...entries.map(([, state]) => state.startedAt)) + 120000 - Date.now()))
    return () => { active = false; clearTimeout(timer); clearTimeout(waitLimit); clearTimeout(requestLimit); pending?.abort() }
  }, [Object.keys(queued).join(','), dashboard.space.id])
  async function copied(value:string){try{await copy(value);onNotice(t("已复制", "Copied"))}catch(cause){setError(messageOf(cause))}}
  function openSource(source:SourceInfo|null){setEditingSource(source);setSourceOpen(true)}
  function closeSource(){setSourceOpen(false)}
  async function createToken(e:FormEvent){e.preventDefault();setBusy(true);setFormError('');try{const result=await request<{token:string;credential:Credential}>('/integrations/tokens',{method:'POST',body:{name:tokenForm.name.trim(),spaceId:dashboard.space.id,sourceId:tokenForm.sourceId||null,actions:tokenForm.sourceId?['sources:read','datasets:write']:tokenForm.actions,expiresAt:new Date(Date.now()+tokenForm.days*86400000).toISOString()}});setTokenValue(result.token);setTokenOpen(false);await load()}catch(cause){setFormError(messageOf(cause))}finally{setBusy(false)}}
  async function revokeToken(){if(!revoke)return;setBusy(true);setFormError('');try{await request(`/integrations/tokens/${revoke.id}`,{method:'DELETE'});setRevoke(null);onNotice(t("访问令牌已撤销", "Access token revoked"));await load()}catch(cause){setFormError(messageOf(cause))}finally{setBusy(false)}}
  async function sync(source:SourceInfo){setError('');setQueued(previous=>({...previous,[source.id]:{revision:source.revision,lastSuccessAt:source.lastSuccessAt,lastErrorAt:source.lastError?.at,startedAt:Date.now()}}));try{await request(`/sources/${source.id}/sync`,{method:'POST',body:{}});onNotice(t("已提交后台采集任务", "Collection task queued"))}catch(cause){setQueued(previous=>{const next={...previous};delete next[source.id];return next});setError(messageOf(cause))}}
  async function deleteSource() {
    if (!deletingSource || busy) return
    setBusy(true); setFormError('')
    try {
      await request(`/sources/${deletingSource.id}`, { method: 'DELETE', body: { expectedConfigRevision: deletingSource.configRevision, detachUnusedBindings: true } })
      setQueued(current => { const next = { ...current }; delete next[deletingSource.id]; return next })
      setDeletingSource(null)
      onNotice(t('数据源已删除', 'Source deleted'))
      await Promise.all([load(), onRefresh()])
    } catch (cause) {
      setFormError(cause instanceof ApiError && cause.code === 'source_in_use'
        ? t('数据源仍被已保存的组件使用。请先移除相关组件（包括隐藏组件）或更换来源，并保存页面后再删除。', 'A saved component still uses this source. Remove those components, including hidden ones, or change their source, then save the page before deleting.')
        : cause instanceof ApiError && cause.code === 'source_config_conflict'
          ? t('配置已在其他窗口修改。请关闭此对话框、刷新数据源，再重新查看并删除。', 'This configuration changed in another window. Close this dialog, refresh sources, then review it before deleting.')
          : messageOf(cause))
    } finally { setBusy(false) }
  }
  async function inspect(source:SourceInfo){setSelectedSource(source);setSnapshot(null);setFormError('');setBusy(true);try{setSnapshot(await request<Dataset<unknown>>(`/sources/${source.id}/snapshot`))}catch(cause){setFormError(messageOf(cause))}finally{setBusy(false)}}
  function pushTemplate(source:SourceInfo){const body={requestId:'replace-with-unique-request-id',expectedRevision:source.revision||'0',schemaId:source.schemaId,schemaVersion:source.schemaVersion,sourceUpdatedAt:null,data:sourceExample(source.schemaId)};setTemplate(`PUT ${window.location.origin}/api/v1/sources/${source.id}/snapshot\nAuthorization: Bearer <YOUR_SCOPED_TOKEN>\nContent-Type: application/json\n\n${JSON.stringify(body,null,2)}`)}
  return <><Tabs defaultValue="sources"><TabsList variant="line"><TabsTrigger value="sources">{t("数据源", "Sources")}</TabsTrigger><TabsTrigger value="mcp">{t("MCP 与访问令牌", "MCP and access tokens")}</TabsTrigger></TabsList><TabsContent value="sources"><div className="admin-content-toolbar"><p className="admin-hint">{t("外部数据先保存为独立数据集，再在「布局与主题」中绑定积木。", "External data is saved as a separate dataset. Bind it to a component in Layout and theme.")}</p><div className="admin-button-row"><Button variant="outline" size="icon" aria-label={t("刷新数据源", "Refresh sources")} onClick={load}><RefreshCw size={16}/></Button>{canManage&&<Button onClick={()=>openSource(null)}><Plus size={16}/>{t("添加数据源", "Add source")}</Button>}</div></div>{!authenticated&&signInGuidance}<ErrorMessage error={error}/>{loading?<Loading text={t("正在读取数据源…", "Loading sources…")}/>:sources.length?<Table><TableHeader><TableRow><TableHead>{t("数据源", "Sources")}</TableHead><TableHead>{t("数据格式", "Data format")}</TableHead><TableHead>{t("最近成功", "Last success")}</TableHead><TableHead>{t("状态", "Status")}</TableHead><TableHead>{t("操作", "Actions")}</TableHead></TableRow></TableHeader><TableBody>{sources.map(source=><TableRow key={source.id}><TableCell><strong>{source.name}</strong><small>{source.kind==='github-traffic'?`${source.connection.owner}/${source.connection.repo}`:sourceKindLabel(source.kind)}</small></TableCell><TableCell><code>{source.schemaId}@{source.schemaVersion}</code></TableCell><TableCell>{time(source.lastSuccessAt)}</TableCell><TableCell><span className={`admin-badge ${source.lastError?'danger':!source.lastSuccessAt?'muted':''}`}>{!source.enabled?t("已停用", "Disabled"):queued[source.id]?t("正在采集", "Collecting"):source.lastError?t("采集异常", "Collection failed"):source.lastSuccessAt?t("已有快照", "Snapshot available"):source.kind==='external-push'?t("等待推送", "Awaiting push"):t("等待采集", "Awaiting collection")}</span>{source.lastError&&<small className="admin-inline-error">{source.lastError.message}</small>}</TableCell><TableCell><div className="admin-button-row"><Button variant="ghost" size="sm" onClick={()=>inspect(source)}>{t("快照", "Snapshot")}</Button>{canManage&&<Button variant="ghost" size="sm" onClick={()=>openSource(source)}>{t("配置", "Configure")}</Button>}{source.kind!=='external-push'&&canManage?<Button variant="outline" size="sm" disabled={!!queued[source.id]||!source.enabled} onClick={()=>sync(source)}>{source.lastSuccessAt?t("重新采集", "Collect again"):source.kind==='github-traffic'?t("采集基线", "Collect baseline"):t("立即采集", "Collect now")}</Button>:source.kind==='external-push'&&<Button variant="outline" size="sm" onClick={()=>pushTemplate(source)}>{t("推送模板", "Push template")}</Button>}{source.kind==='external-push'&&source.schemaId==='calendar.events'&&canManage&&<Button variant="outline" size="sm" disabled={!source.enabled} onClick={()=>setCalendarImport(source)}>{t("导入 ICS", "Import ICS")}</Button>}{canManage&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>{setDeletingSource(source);setFormError('')}}><Trash2 size={14}/>{t('删除','Delete')}</Button>}</div></TableCell></TableRow>)}</TableBody></Table>:<Empty title={t("暂无外部数据源", "No external sources")}/>}</TabsContent><TabsContent value="mcp"><section className="admin-mcp-intro"><span className="admin-feature-icon"><Server size={23}/></span><div><h3>{t("通过 MCP 使用 Home", "Use Home through MCP")}</h3><p>{t("每个客户端使用有范围、可撤销的访问令牌。", "Give each client its own scoped, revocable access token.")}</p><div className="admin-copy-line"><code>{window.location.origin}/mcp</code><Button variant="outline" size="icon-sm" aria-label={t("复制 MCP 地址", "Copy MCP address")} onClick={()=>copied(`${window.location.origin}/mcp`)}><Copy size={15}/></Button></div></div></section>{!authenticated?signInGuidance:<><div className="admin-content-toolbar"><h3>{t("我的访问令牌", "My access tokens")}</h3><Button onClick={()=>{setTokenForm({name:'',sourceId:'',days:30,actions:['navigation:read','pages:read']});setFormError('');setTokenOpen(true)}}><KeyRound size={16}/>{t("创建令牌", "Create token")}</Button></div><ErrorMessage error={error}/>{credentials.length?<Table><TableHeader><TableRow><TableHead>{t("名称", "Name")}</TableHead><TableHead>{t("权限", "Permissions")}</TableHead><TableHead>{t("到期", "Expires")}</TableHead><TableHead>{t("状态", "Status")}</TableHead><TableHead>{t("操作", "Actions")}</TableHead></TableRow></TableHeader><TableBody>{credentials.map(credential=><TableRow key={credential.id}><TableCell><strong>{credential.name}</strong><small>{bootstrap.spaces.find(s=>s.id===credential.spaceId)?.name||t("所属空间", "Assigned space")}{credential.sourceId?t(" · 限定数据源", " · Source-scoped"):''}</small></TableCell><TableCell><div className="admin-tags">{credential.actions.map(action=><span key={action}>{actions.find(a=>a[0]===action)?.[1]||action}</span>)}</div></TableCell><TableCell>{time(credential.expiresAt)}</TableCell><TableCell><span className={`admin-badge ${credential.status!=='active'?'muted':''}`}>{{active:t("有效", "Valid"),expired:t("已到期", "Expired"),revoked:t("已撤销", "Revoked"),invalidated:t("权限已失效", "Permissions invalidated")}[credential.status]}</span></TableCell><TableCell>{!credential.revokedAt&&<Button variant="ghost" size="sm" onClick={()=>{setRevoke(credential);setFormError('')}}><Trash2 size={14}/>{t("撤销", "Revoke")}</Button>}</TableCell></TableRow>)}</TableBody></Table>:<Empty title={t("暂无访问令牌", "No access tokens")}/>}</>}</TabsContent></Tabs>
  {deletingSource&&<Modal title={t('删除数据源？','Delete this source?')} busy={busy} onClose={()=>setDeletingSource(null)}><p>{t('将删除「{name}」的配置、密钥和已保存快照，并清理未被任何组件使用的页面数据绑定。', 'This deletes the configuration, credentials and saved snapshot for “{name}”, and removes page data bindings that no component uses.', {name:deletingSource.name})}</p><p className="admin-hint">{t('仍被组件使用的数据源（包括隐藏组件）不能删除。请先移除相关组件或更换来源，并保存页面。', 'Sources used by a component, including a hidden component, cannot be deleted. Remove those components or change their source, then save the page.')}</p><ErrorMessage error={formError}/><div className="admin-form-footer"><Button variant="outline" autoFocus disabled={busy} onClick={()=>setDeletingSource(null)}>{t('保留','Keep')}</Button><Button variant="destructive" disabled={busy} onClick={deleteSource}>{busy?t('正在删除…','Deleting…'):t('确认删除','Delete source')}</Button></div></Modal>}
  {sourceOpen&&<SourceDialog space={dashboard.space} source={editingSource} onClose={closeSource} onSaved={async()=>{onNotice(editingSource?t('数据源配置已更新','Source configuration updated'):t('数据源已创建','Source created'));await load()}}/>}
  {calendarImport&&<Suspense fallback={<Loading/>}><CalendarImportDialog source={calendarImport} space={dashboard.space} onClose={()=>setCalendarImport(null)} onImported={async()=>{onNotice(t('日程快照已导入','Calendar snapshot imported'));await load()}}/></Suspense>}
  {tokenOpen&&<Modal title={t("创建访问令牌", "Create access token")} description={t("授权空间：{name}", "Authorized space: {name}", { name: dashboard.space.name })} busy={busy} onClose={()=>setTokenOpen(false)}><form onSubmit={createToken} onInvalidCapture={event=>handleFormInvalid(event,setFormError)}><fieldset disabled={busy} className="admin-plain-fieldset"><Field label={t("令牌名称", "Token name")}><Input required autoFocus maxLength={80} value={tokenForm.name} onChange={e=>setTokenForm({...tokenForm,name:e.target.value})}/></Field><div className="admin-form-row equal"><Field label={t("授权范围", "Scope")}><StyledSelect name="sourceId" value={tokenForm.sourceId} disabled={busy} onValueChange={value=>setTokenForm({...tokenForm,sourceId:value})} options={[{value:'',label:t("当前空间", "Current space")},...sources.filter(s=>s.kind==='external-push'&&dashboard.space.canEdit).map(s=>({value:s.id,label:t("仅 {name}", "{name} only", { name: s.name })}))]}/></Field><Field label={t("有效期", "Validity period")}><StyledSelect name="days" value={String(tokenForm.days)} disabled={busy} onValueChange={value=>setTokenForm({...tokenForm,days:Number(value)})} options={[7,30,90].map(d=>({value:String(d),label:t("{count} 天", "{count} days", { count: d })}))}/></Field></div>{tokenForm.sourceId?<p className="admin-info">{t("只允许读取选定数据源和提交其快照。", "Allows reading the selected source and submitting its snapshots only.")}</p>:<fieldset className="admin-permission-options"><legend>{t("允许的操作", "Allowed actions")}</legend>{allowedActions.map(([action,label])=><label className="admin-check-line" key={action}><Checkbox checked={tokenForm.actions.includes(action!)} disabled={busy} onCheckedChange={checked=>setTokenForm({...tokenForm,actions:checked?[...tokenForm.actions,action!]:tokenForm.actions.filter(v=>v!==action)})}/>{label}</label>)}</fieldset>}<ErrorMessage error={formError}/><div className="admin-form-footer"><Button type="button" variant="outline" onClick={()=>setTokenOpen(false)}>{t("取消", "Cancel")}</Button><Button type="submit" disabled={!tokenForm.sourceId&&!tokenForm.actions.length}>{busy?t("正在创建…", "Creating…"):t("创建令牌", "Create token")}</Button></div></fieldset></form></Modal>}
  {tokenValue&&<Modal title={t("保存你的访问令牌", "Save your access token")} description={t("完整令牌只在这次创建后显示，关闭后无法再次查看。", "The complete token is shown only once. You cannot view it again after closing this dialog.")} onClose={()=>setTokenValue('')}><Input readOnly value={tokenValue} aria-label={t("新访问令牌", "New access token")} onFocus={e=>e.target.select()}/><div className="admin-form-footer"><Button variant="outline" onClick={()=>copied(tokenValue)}><Copy size={16}/>{t("复制令牌", "Copy token")}</Button><Button onClick={()=>setTokenValue('')}>{t("已保存，关闭", "Saved; close")}</Button></div></Modal>}
  {revoke&&<Modal title={t("撤销访问令牌？", "Revoke this access token?")} busy={busy} onClose={()=>setRevoke(null)}><p>{t("「{name}」对应的客户端会立即失去权限。", "Clients using “{name}” will immediately lose access.", { name: revoke.name })}</p><ErrorMessage error={formError}/><div className="admin-form-footer"><Button variant="outline" onClick={()=>setRevoke(null)} disabled={busy}>{t("保留", "Keep")}</Button><Button variant="destructive" onClick={revokeToken} disabled={busy}>{t("确认撤销", "Confirm revocation")}</Button></div></Modal>}
  {selectedSource&&<Modal title={t("{name} · 已保存快照", "{name} · Saved snapshot", { name: selectedSource.name })} wide busy={busy} onClose={()=>setSelectedSource(null)}>{busy?<Loading/>:<><ErrorMessage error={formError}/>{snapshot&&<pre className="admin-code-block">{JSON.stringify(snapshot,null,2)}</pre>}</>}</Modal>}
  {template&&<Modal title={t("外部推送模板", "External push template")} description={t("将占位令牌替换为限定此数据源的 Home 访问令牌。", "Replace the token placeholder with a Home access token scoped to this source.")} wide onClose={()=>setTemplate('')}><pre className="admin-code-block">{template}</pre><div className="admin-form-footer"><Button variant="outline" onClick={()=>copied(template)}><Copy size={16}/>{t("复制模板", "Copy template")}</Button><Button onClick={()=>setTemplate('')}>{t("关闭", "Close")}</Button></div></Modal>}
  </>
}
