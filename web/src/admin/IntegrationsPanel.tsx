import { t, getLocale } from '../core/i18n'
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { Copy, KeyRound, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import type { Bootstrap, Dashboard, Dataset } from '../core/types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { Checkbox } from '../components/ui/checkbox'
import { Table,TableHeader,TableBody,TableHead,TableRow,TableCell } from '../components/ui/table'
import { Tabs,TabsContent,TabsList,TabsTrigger } from '../components/ui/tabs'
import { Empty,ErrorMessage,Field,handleFormInvalid,Loading,Modal } from '../components/Shared'
import { ConfirmPopover } from '../components/ConfirmPopover'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import SourceDialog, { sourceKindLabel } from './SourceDialog'
import { sourceExample } from './source-examples'
import './integration-tokens.css'
const CalendarImportDialog = lazy(() => import('./CalendarImportDialog'))
export type SourceInfo={id:string;spaceId:string;name:string;kind:string;schemaId:string;schemaVersion:number;datasetId:string;connection:Record<string,string>;sync:Record<string,unknown>;revision:string;enabled:boolean;configRevision:string;nextSyncAt:string|null;credentialConfigured:boolean;createdAt:string;updatedAt:string;lastSuccessAt:string|null;lastError:{code:string;message:string;at?:string}|null}
type Credential={id:string;revision:string;name:string;spaceId:string;sourceId:string|null;permissionMode:'selected'|'all';actions:string[];expiresAt:string|null;createdAt:string;revokedAt:string|null;status:'active'|'expired'|'revoked'|'invalidated'}
type TokenAction={id:string;label:string;requires:string[];sourceScoped:boolean;write:boolean}
type TokenActionCatalog={items:TokenAction[];defaultActions:string[]}
type TokenForm={name:string;sourceId:string;days:string;permissionMode:'selected'|'all';actions:string[]}
type TokenPatch={expectedRevision?:string;name?:string;actions?:string[];permissionMode?:'selected'|'all';expiresAt?:string|null}
const sameActions=(left:string[],right:string[])=>JSON.stringify([...left].sort())===JSON.stringify([...right].sort())
const editableToken=(value:Credential)=>value.status==='active'||value.status==='expired'
function tokenStatusLabel(status:Credential['status']){return {active:t('有效','Valid'),expired:t('已到期','Expired'),revoked:t('已撤销','Revoked'),invalidated:t('权限已失效','Permissions invalidated')}[status]}
function tokenExpiry(value:string|null){return value===null?t('永久有效','Never expires'):time(value)}
function availableTokenActions(catalog:TokenActionCatalog,sourceId:string,canEdit:boolean){
  let items=catalog.items.filter(action=>(!sourceId||action.sourceScoped)&&(canEdit||!action.write))
  for(;;){const ids=new Set(items.map(action=>action.id)),next=items.filter(action=>action.requires.every(id=>ids.has(id)));if(next.length===items.length)return next;items=next}
}
function toggleTokenAction(selected:string[],id:string,checked:boolean,available:TokenAction[]){
  const next=new Set(selected),byId=new Map(available.map(action=>[action.id,action]))
  if(checked){const add=(key:string)=>{if(next.has(key))return;const action=byId.get(key);if(!action)return;next.add(key);action.requires.forEach(add)};add(id)}
  else{next.delete(id);for(;;){const missing=available.filter(action=>next.has(action.id)&&action.requires.some(key=>!next.has(key)));if(!missing.length)break;missing.forEach(action=>next.delete(action.id))}}
  return [...next]
}
function defaultTokenActions(catalog:TokenActionCatalog,sourceId:string,canEdit:boolean){
  const available=availableTokenActions(catalog,sourceId,canEdit),ids=new Set(available.map(action=>action.id))
  const defaults=catalog.defaultActions.filter(id=>ids.has(id))
  return (defaults.length?defaults:sourceId?available.filter(action=>!action.write).map(action=>action.id):[]).reduce((selected,id)=>toggleTokenAction(selected,id,true,available),[] as string[])
}
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
function TokenEditor({credential,catalog,bootstrap,dashboard,sources,onClose,onCreated,onSaved,onListRead,onBusyChange}:{credential:Credential|null;catalog:TokenActionCatalog;bootstrap:Bootstrap;dashboard:Dashboard;sources:SourceInfo[];onClose:()=>void;onCreated:(value:{token:string;credential:Credential})=>void;onSaved:(value:Credential)=>void;onListRead:(value:Credential[])=>void;onBusyChange:(busy:boolean)=>void}){
  const spaceId=credential?.spaceId||dashboard.space.id,boundSpace=bootstrap.spaces.find(space=>space.id===spaceId)||(dashboard.space.id===spaceId?dashboard.space:null)
  const canEditSpace=!!boundSpace?.canEdit
  const draftFor=(value:Credential|null):TokenForm=>value?{name:value.name,sourceId:value.sourceId||'',days:'keep',permissionMode:value.permissionMode,actions:[...value.actions]}:{name:'',sourceId:'',days:'30',permissionMode:'selected',actions:defaultTokenActions(catalog,'',canEditSpace)}
  const [baseline,setBaseline]=useState(credential),[form,setForm]=useState<TokenForm>(()=>draftFor(credential)),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [conflict,setConflict]=useState(false),[uncertain,setUncertain]=useState(false),[remote,setRemote]=useState<Credential|null>(null)
  const initial=useRef(draftFor(credential)),running=useRef(false),alive=useRef(true),submitted=useRef<TokenPatch|null>(null),busyChange=useRef(onBusyChange)
  busyChange.current=onBusyChange
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;busyChange.current(false)}},[])
  const allowed=availableTokenActions(catalog,form.sourceId,canEditSpace),allowedIds=new Set(allowed.map(action=>action.id))
  const editable=!!boundSpace&&(!baseline||editableToken(baseline))
  const original=baseline?draftFor(baseline):initial.current
  const dirty=form.name.trim()!==original.name||form.sourceId!==original.sourceId||form.days!==original.days||form.permissionMode!==original.permissionMode||(form.permissionMode==='selected'&&!sameActions(form.actions,original.actions))
  const guard=useUnsavedChanges(dirty||busy,busy,()=>setForm(baseline?draftFor(baseline):initial.current))
  const expired=!!baseline&&(baseline.status==='expired'||!!baseline.expiresAt&&Date.parse(baseline.expiresAt)<=Date.now())
  const sourceName=sources.find(source=>source.id===form.sourceId&&source.spaceId===spaceId)?.name||form.sourceId
  const actionNames=(values:string[])=>values.map(id=>catalog.items.find(action=>action.id===id)?.label||id).join('、')
  function working(value:boolean){running.current=value;if(alive.current)setBusy(value);busyChange.current(value)}
  function close(){guard.requestLeave(onClose)}
  function adopt(value:Credential){setBaseline(value);setForm(draftFor(value));setRemote(null);setConflict(false);setUncertain(false);submitted.current=null;setError(editableToken(value)?'':t('该令牌已撤销或权限已失效，无法继续编辑。','This token is revoked or invalidated and can no longer be edited.'))}
  function keepDraft(){
    if(!baseline||!remote)return
    if(!editableToken(remote)){setError(t('该令牌已撤销或权限已失效，草稿已保留，无法继续保存。','This token is revoked or invalidated. Your draft is retained, but cannot be saved.'));return}
    const permissionsChanged=form.permissionMode!==baseline.permissionMode||(form.permissionMode==='selected'&&!sameActions(form.actions,baseline.actions))
    setForm({...form,name:form.name.trim()===baseline.name?remote.name:form.name,sourceId:remote.sourceId||'',permissionMode:permissionsChanged?form.permissionMode:remote.permissionMode,actions:permissionsChanged?form.actions:[...remote.actions]})
    setBaseline(remote);setRemote(null);setConflict(false);setUncertain(false);submitted.current=null;setError('')
  }
  async function readLatest(){
    if(running.current)return
    working(true)
    try{
      const list=await request<Credential[]>('/integrations/tokens')
      if(!alive.current)return
      onListRead(list)
      if(!baseline){setError(t('列表已刷新。请关闭此窗口检查创建结果；完整令牌无法再次读取。','The list is refreshed. Close this window to check the creation result; the complete token cannot be read again.'));return}
      const current=list.find(value=>value.id===baseline.id)
      if(!current){setRemote(null);setConflict(true);setError(t('该令牌记录已不存在，当前草稿已保留。','This token record no longer exists. Your draft is retained.'));return}
      const sent=submitted.current
      const matches=sent&&Object.entries(sent).filter(([key])=>key!=='expectedRevision').every(([key,value])=>key==='actions'?sameActions(current.actions,value as string[]):current[key as keyof Credential]===value)
      if(uncertain&&matches&&editableToken(current)){onSaved(current);return}
      setRemote(current);setConflict(true);setError(t('最新版本已读取，草稿已保留。请比较后选择。','The latest version is available. Your draft is retained; compare before continuing.'))
    }catch(cause){if(alive.current)setError(messageOf(cause))}finally{working(false)}
  }
  async function save(event:FormEvent){
    event.preventDefault()
    if(running.current||!editable||conflict||uncertain)return
    const name=form.name.trim()
    if(!name||[...name].length>80){setError(t('请填写不超过 80 个字符的令牌名称。','Enter a token name of at most 80 characters.'));return}
    if(form.permissionMode==='selected'&&(!form.actions.length||form.actions.some(id=>!allowedIds.has(id))||allowed.some(action=>form.actions.includes(action.id)&&action.requires.some(id=>!form.actions.includes(id))))){setError(t('请选择当前授权范围内的操作，并包含所需的关联权限。','Select actions available within this scope, including their required permissions.'));return}
    if(expired&&form.days==='keep'){setError(t('该令牌已到期，请明确选择新的有效期。','This token has expired. Choose a new validity period.'));return}
    const change:TokenPatch={}
    if(!baseline||name!==baseline.name)change.name=name
    if(!baseline||form.permissionMode!==baseline.permissionMode)change.permissionMode=form.permissionMode
    if(form.permissionMode==='selected'&&(!baseline||baseline.permissionMode!=='selected'||!sameActions(form.actions,baseline.actions)))change.actions=[...form.actions]
    if(form.days!=='keep')change.expiresAt=form.days==='never'?null:new Date(Date.now()+Number(form.days)*86400000).toISOString()
    if(baseline&&!Object.keys(change).length)return
    if(baseline)change.expectedRevision=baseline.revision
    submitted.current=change;working(true);setError('')
    try{
      if(baseline){const value=await request<Credential>(`/integrations/tokens/${encodeURIComponent(baseline.id)}`,{method:'PATCH',body:change});if(alive.current)onSaved(value)}
      else{const value=await request<{token:string;credential:Credential}>('/integrations/tokens',{method:'POST',body:{...change,spaceId,sourceId:form.sourceId||null}});if(alive.current)onCreated(value)}
    }catch(cause){
      if(!alive.current)return
      if(cause instanceof ApiError&&cause.status===409){setConflict(true);setError(t('令牌已在其他地方更新，草稿已保留。请读取最新版本后比较。','The token changed elsewhere. Your draft is retained; read the latest version to compare.'))}
      else if(!(cause instanceof ApiError)||cause.status>=500){setUncertain(true);setError(baseline?t('保存结果尚未确认，草稿已保留。请读取最新版本核对。','The save result is unconfirmed. Your draft is retained; read the latest version to check.'):t('创建结果尚未确认。请读取最新列表核对，避免重复创建。','The creation result is unconfirmed. Read the latest list before creating another token.'))}
      else setError(cause instanceof ApiError&&cause.code==='integration_token_expiry_required'?t('该令牌已到期，请明确选择新的有效期。','This token has expired. Choose a new validity period.'):messageOf(cause))
    }finally{working(false)}
  }
  const expiryOptions=[...(baseline?[{value:'keep',label:t('保持原有效期','Keep current validity')}]:[]),...[7,30,90,365].map(days=>({value:String(days),label:t('{count} 天','{count} days',{count:days})})),{value:'never',label:t('永久有效','Never expires')}]
  return <><Modal className="admin-token-dialog" title={baseline?t('编辑访问令牌','Edit access token'):t('创建访问令牌','Create access token')} description={t('授权空间：{name}','Authorized space: {name}',{name:boundSpace?.name||spaceId})} busy={busy} onClose={close}>
    <form onSubmit={event=>void save(event)} onInvalidCapture={event=>handleFormInvalid(event,setError)}>
      <ErrorMessage error={error}/>
      {(conflict||uncertain)&&<section className="admin-token-conflict"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void readLatest()}>{t('读取最新版本','Read latest version')}</Button>{remote&&<><dl><div><dt>{t('名称','Name')}</dt><dd><span>{t('最新','Latest')}</span>{remote.name}</dd><dd><span>{t('草稿','Draft')}</span>{form.name}</dd></div><div><dt>{t('权限','Permissions')}</dt><dd><span>{t('最新','Latest')}</span>{remote.permissionMode==='all'?t('全部权限','All permissions'):actionNames(remote.actions)}</dd><dd><span>{t('草稿','Draft')}</span>{form.permissionMode==='all'?t('全部权限','All permissions'):actionNames(form.actions)}</dd></div><div><dt>{t('有效期','Validity period')}</dt><dd><span>{t('最新','Latest')}</span>{tokenExpiry(remote.expiresAt)}</dd><dd><span>{t('草稿','Draft')}</span>{form.days==='keep'?tokenExpiry(baseline?.expiresAt??null):expiryOptions.find(option=>option.value===form.days)?.label}</dd></div><div><dt>{t('状态','Status')}</dt><dd>{tokenStatusLabel(remote.status)}</dd></div></dl><div className="admin-button-row"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>adopt(remote)}>{t('使用最新版本','Use latest version')}</Button><Button type="button" size="sm" disabled={busy||!editableToken(remote)} onClick={keepDraft}>{t('保留草稿改动','Keep my draft changes')}</Button></div></>}</section>}
      <fieldset className="admin-plain-fieldset" disabled={busy||!editable}>
        <Field label={t('令牌名称','Token name')}><Input name="tokenName" required autoFocus maxLength={80} value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></Field>
        <div className="admin-form-row equal"><Field label={t('授权范围','Scope')}>{baseline?<Input readOnly value={form.sourceId?t('仅 {name}','{name} only',{name:sourceName}):boundSpace?.name||spaceId}/>:<StyledSelect name="sourceId" value={form.sourceId} disabled={busy||!editable} onValueChange={sourceId=>setForm({...form,sourceId,actions:defaultTokenActions(catalog,sourceId,canEditSpace)})} options={[{value:'',label:t('当前空间','Current space')},...sources.filter(source=>source.kind==='external-push').map(source=>({value:source.id,label:t('仅 {name}','{name} only',{name:source.name})}))]}/>}</Field><Field label={t('有效期','Validity period')} hint={baseline?t('当前：{value}','Current: {value}',{value:tokenExpiry(baseline.expiresAt)}):undefined}><StyledSelect name="days" value={form.days} disabled={busy||!editable} onValueChange={days=>setForm({...form,days})} options={expiryOptions}/></Field></div>
        {expired&&<p className="admin-hint">{t('已到期，请选择新的有效期后保存。','Expired; choose a new validity period before saving.')}</p>}
        <Field label={t('权限范围','Permission scope')}><StyledSelect name="permissionMode" value={form.permissionMode} disabled={busy||!editable} onValueChange={permissionMode=>setForm({...form,permissionMode:permissionMode as TokenForm['permissionMode']})} options={[{value:'selected',label:t('自定义权限','Selected permissions')},{value:'all',label:t('全部权限','All permissions')}]}/></Field>
        {form.permissionMode==='all'?<p className="admin-token-all-note">{t('包含后续新增功能，限当前授权范围。','Includes future features, limited to the current authorized scope.')}</p>:<fieldset className="admin-permission-options"><legend>{t('允许的操作','Allowed actions')}</legend>{allowed.map(action=><label className="admin-check-line" key={action.id}><Checkbox checked={form.actions.includes(action.id)} disabled={busy||!editable} onCheckedChange={checked=>setForm(previous=>({...previous,actions:toggleTokenAction(previous.actions,action.id,!!checked,allowed)}))}/>{action.label}</label>)}{form.actions.filter(id=>!allowedIds.has(id)).map(id=><label className="admin-check-line admin-token-unavailable" key={id}><Checkbox checked disabled={busy||!editable} onCheckedChange={()=>setForm(previous=>({...previous,actions:toggleTokenAction(previous.actions,id,false,allowed)}))}/>{t('{name}（已不可用）','{name} (unavailable)',{name:catalog.items.find(action=>action.id===id)?.label||id})}</label>)}</fieldset>}
      </fieldset>
      <div className="admin-form-footer"><Button type="button" variant="outline" disabled={busy} onClick={close}>{t('取消','Cancel')}</Button><Button type="submit" disabled={busy||!editable||conflict||uncertain||!form.name.trim()||(baseline?!dirty:false)||(form.permissionMode==='selected'&&!form.actions.length)}>{busy?t('正在保存…','Saving…'):baseline?t('保存令牌','Save token'):t('创建令牌','Create token')}</Button></div>
    </form>
  </Modal>{guard.blocked&&<DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard}/>}</>
}
export default function IntegrationsPanel({bootstrap,dashboard,onNotice,onLogin,onOpenAccounts,onRefresh,onMutationBusyChange}:{bootstrap:Bootstrap;dashboard:Dashboard;onNotice:(message:string)=>void;onLogin:()=>void;onOpenAccounts:()=>void;onRefresh:()=>Promise<void>;onMutationBusyChange?:(busy:boolean)=>void}){
  const [actionCatalog,setActionCatalog]=useState<TokenActionCatalog|null>(null)
  const actions=actionCatalog?.items||[]
  const [sources,setSources]=useState<SourceInfo[]>([]),[credentials,setCredentials]=useState<Credential[]>([])
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[formError,setFormError]=useState(''),[busy,setBusy]=useState(false)
  const [sourceOpen,setSourceOpen]=useState(false),[editingSource,setEditingSource]=useState<SourceInfo|null>(null),[calendarImport,setCalendarImport]=useState<SourceInfo|null>(null)
  const [tokenOpen,setTokenOpen]=useState(false),[editingToken,setEditingToken]=useState<Credential|null>(null),[tokenValue,setTokenValue]=useState('')
  const [selectedSource,setSelectedSource]=useState<SourceInfo|null>(null),[snapshot,setSnapshot]=useState<Dataset<unknown>|null>(null),[revoke,setRevoke]=useState<(Credential & {anchor:HTMLButtonElement})|null>(null),[template,setTemplate]=useState('')
  const [queued,setQueued]=useState<Record<string,{revision:string;lastSuccessAt:string|null;lastErrorAt?:string;startedAt:number}>>({})
  const [deletingSource,setDeletingSource]=useState<(SourceInfo & {anchor:HTMLButtonElement})|null>(null), [sourceNeedsReload,setSourceNeedsReload]=useState(false)
  const [deletingToken,setDeletingToken]=useState<(Credential & {anchor:HTMLButtonElement})|null>(null),[tokenNeedsReload,setTokenNeedsReload]=useState(false)
  const confirmationRunning=useRef(false), sourceAction=useRef<HTMLButtonElement>(null), tokenAction=useRef<HTMLButtonElement>(null)
  const [pendingActionFocus,setPendingActionFocus]=useState<'source'|'token'|null>(null)
  const authenticated=!!bootstrap.user,canManage=authenticated&&dashboard.space.canEdit
  const signInGuidance = <div className="admin-info"><p>{bootstrap.mode === 'open_edit'
    ? t('配置数据源、MCP 和推送令牌需要登录账号。已有管理员可直接登录；尚未创建管理员时，可在「站点设置」中按需创建，继续保留免账号编辑模式。', 'Sign in to configure sources, MCP and push tokens. Existing administrators can sign in directly. If no administrator exists, optionally create one in Site settings while keeping account-free editing enabled.')
    : t('登录账号后可配置所属空间的数据源、MCP 和推送访问令牌。', 'Sign in to configure sources, MCP and push access tokens for your spaces.')}</p><div className="admin-button-row"><Button type="button" variant="outline" onClick={onLogin}>{t('登录账号', 'Sign in')}</Button>{bootstrap.mode === 'open_edit' && <Button type="button" variant="ghost" onClick={onOpenAccounts}>{t('站点设置', 'Site settings')}</Button>}</div></div>

  async function load(){
    setLoading(true);setError('')
    const results=await Promise.allSettled([request<SourceInfo[]>(`/spaces/${dashboard.space.id}/sources`),authenticated?request<Credential[]>('/integrations/tokens'):Promise.resolve([] as Credential[]),authenticated?request<TokenActionCatalog>('/integrations/token-actions'):Promise.resolve(null)])
    if(results[0].status==='fulfilled')setSources(results[0].value);else setError(messageOf(results[0].reason))
    if(results[1].status==='fulfilled')setCredentials(results[1].value);else setError(messageOf(results[1].reason))
    if(results[2].status==='fulfilled')setActionCatalog(results[2].value);else{setActionCatalog(null);setError(messageOf(results[2].reason))}
    setLoading(false);return results.every(result=>result.status==='fulfilled')
  }
  useEffect(()=>{void load()},[dashboard.space.id,authenticated])
  useEffect(()=>{if(!canManage)setDeletingSource(null);if(!authenticated){setRevoke(null);setDeletingToken(null);setTokenOpen(false)}},[canManage,authenticated])
  useEffect(()=>()=>{onMutationBusyChange?.(false)},[onMutationBusyChange])
  function focusAction(kind:'source'|'token'){setPendingActionFocus(kind)}
  useEffect(()=>{
    if(!pendingActionFocus||busy||loading)return
    // Wait for the commit that releases the parent shell's inert state.
    const frame=requestAnimationFrame(()=>{
      const target=(pendingActionFocus==='source'?sourceAction.current:tokenAction.current)||document.getElementById('main-content')
      if(target?.isConnected){if(target.id==='main-content')target.tabIndex=-1;target.focus({preventScroll:true})}
      setPendingActionFocus(null)
    })
    return()=>cancelAnimationFrame(frame)
  },[pendingActionFocus,busy,loading])
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
  function openToken(value:Credential|null){if(busy||!actionCatalog)return;setEditingToken(value);setTokenOpen(true);setRevoke(null);setDeletingToken(null);setDeletingSource(null)}
  async function readTokenRecord(){
    if(!deletingToken||confirmationRunning.current)return
    const target=deletingToken
    confirmationRunning.current=true;setBusy(true);onMutationBusyChange?.(true);setFormError('')
    try{
      const list=await request<Credential[]>('/integrations/tokens');setCredentials(list)
      const latest=list.find(value=>value.id===target.id)
      if(!latest){setDeletingToken(null);onNotice(t('令牌记录已删除','Token record deleted'));focusAction('token')}
      else{setDeletingToken({...latest,anchor:target.anchor});setTokenNeedsReload(latest.status!=='revoked');setFormError(latest.status==='revoked'?t('已读取最新记录，请确认后再删除。','The latest record is loaded. Confirm again to delete it.'):t('只有已撤销的令牌可以删除记录。','Only revoked token records can be deleted.'))}
    }catch(cause){setFormError(messageOf(cause))}finally{confirmationRunning.current=false;setBusy(false);onMutationBusyChange?.(false)}
  }
  async function deleteTokenRecord(){
    if(!deletingToken||deletingToken.status!=='revoked'||!authenticated||confirmationRunning.current||busy||tokenNeedsReload)return
    const target=deletingToken
    confirmationRunning.current=true;setBusy(true);onMutationBusyChange?.(true);setFormError('')
    try{
      await request(`/integrations/tokens/${encodeURIComponent(target.id)}/record`,{method:'DELETE',body:{expectedRevision:target.revision}})
      setCredentials(current=>current.filter(value=>value.id!==target.id));setDeletingToken(null);onNotice(t('令牌记录已删除','Token record deleted'));focusAction('token')
    }catch(cause){setTokenNeedsReload(true);setFormError(cause instanceof ApiError&&cause.status===409?t('记录已变化，请读取最新列表后确认。','The record changed. Read the latest list before confirming.'):t('删除结果尚未确认，请读取最新列表核对。','The deletion result is unconfirmed. Read the latest list to check.'))}
    finally{confirmationRunning.current=false;setBusy(false);onMutationBusyChange?.(false)}
  }
  async function revokeToken(){
    if(!revoke||!authenticated||confirmationRunning.current||busy)return
    const target=revoke
    confirmationRunning.current=true;setBusy(true);onMutationBusyChange?.(true);setFormError('')
    try{await request(`/integrations/tokens/${encodeURIComponent(target.id)}`,{method:'DELETE'})}
    catch(cause){setFormError(messageOf(cause));confirmationRunning.current=false;setBusy(false);onMutationBusyChange?.(false);return}
    setRevoke(null)
    setCredentials(current=>current.map(credential=>credential.id===target.id?{...credential,status:'revoked' as const,revokedAt:new Date().toISOString()}:credential))
    onNotice(t('访问令牌已撤销','Access token revoked'))
    try{if(!await load())setError(t('令牌已撤销，但列表刷新失败。请稍后刷新列表。','The token was revoked, but refreshing failed. Reload the list later.'))}
    finally{confirmationRunning.current=false;setBusy(false);onMutationBusyChange?.(false);focusAction('token')}
  }
  async function sync(source:SourceInfo){setError('');setQueued(previous=>({...previous,[source.id]:{revision:source.revision,lastSuccessAt:source.lastSuccessAt,lastErrorAt:source.lastError?.at,startedAt:Date.now()}}));try{await request(`/sources/${source.id}/sync`,{method:'POST',body:{}});onNotice(t("已提交后台采集任务", "Collection task queued"))}catch(cause){setQueued(previous=>{const next={...previous};delete next[source.id];return next});setError(messageOf(cause))}}
  async function deleteSource() {
    if (!deletingSource || !canManage || busy || confirmationRunning.current || sourceNeedsReload) return
    const target = deletingSource
    confirmationRunning.current = true; setBusy(true); onMutationBusyChange?.(true); setFormError('')
    try {
      await request(`/sources/${encodeURIComponent(target.id)}`, { method: 'DELETE', body: { expectedConfigRevision: target.configRevision, detachUnusedBindings: true } })
    } catch (cause) {
      setSourceNeedsReload(cause instanceof ApiError && (cause.status === 404 || cause.status === 409))
      setFormError(cause instanceof ApiError && cause.code === 'source_in_use'
        ? t('数据源仍被已保存的组件使用。请先移除相关组件（包括隐藏组件）或更换来源，并保存页面后再删除。', 'A saved component still uses this source. Remove those components, including hidden ones, or change their source, then save the page before deleting.')
        : cause instanceof ApiError && cause.code === 'source_config_conflict'
          ? t('配置已在其他窗口修改。请刷新数据源，再重新查看并删除。', 'This configuration changed in another window. Refresh sources, then review it before deleting.')
          : messageOf(cause))
      confirmationRunning.current = false; setBusy(false); onMutationBusyChange?.(false); return
    }
    // Once the mutation succeeds, refreshing only reads. Never reopen a
    // destructive confirmation because a subsequent read failed.
    setQueued(current => { const next = { ...current }; delete next[target.id]; return next })
    setSources(current => current.filter(source => source.id !== target.id)); setDeletingSource(null)
    onNotice(t('数据源已删除', 'Source deleted'))
    try {
      const results = await Promise.allSettled([load(), onRefresh()])
      if (results.some(result => result.status === 'rejected') || results[0]?.status === 'fulfilled' && results[0].value === false)
        setError(t('数据源已删除，但页面刷新失败。请刷新列表查看结果。', 'The source was deleted, but refreshing failed. Reload the list to see the result.'))
    } finally { confirmationRunning.current = false; setBusy(false); onMutationBusyChange?.(false); focusAction('source') }
  }
  async function inspect(source:SourceInfo){setSelectedSource(source);setSnapshot(null);setFormError('');setBusy(true);try{setSnapshot(await request<Dataset<unknown>>(`/sources/${source.id}/snapshot`))}catch(cause){setFormError(messageOf(cause))}finally{setBusy(false)}}
  function pushTemplate(source:SourceInfo){const body={requestId:'replace-with-unique-request-id',expectedRevision:source.revision||'0',schemaId:source.schemaId,schemaVersion:source.schemaVersion,sourceUpdatedAt:null,data:sourceExample(source.schemaId)};setTemplate(`PUT ${window.location.origin}/api/v1/sources/${source.id}/snapshot\nAuthorization: Bearer <YOUR_SCOPED_TOKEN>\nContent-Type: application/json\n\n${JSON.stringify(body,null,2)}`)}
  return <><Tabs defaultValue="sources"><TabsList variant="line"><TabsTrigger value="sources">{t("数据源", "Sources")}</TabsTrigger><TabsTrigger value="mcp">{t("MCP 与访问令牌", "MCP and access tokens")}</TabsTrigger></TabsList><TabsContent value="sources"><div className="admin-content-toolbar"><p className="admin-hint">{t("外部数据先保存为独立数据集，再在「布局与主题」中绑定积木。", "External data is saved as a separate dataset. Bind it to a component in Layout and theme.")}</p><div className="admin-button-row"><Button ref={sourceAction} variant="outline" size="icon" aria-label={t("刷新数据源", "Refresh sources")} onClick={load}><RefreshCw size={16}/></Button>{canManage&&<Button onClick={()=>openSource(null)}><Plus size={16}/>{t("添加数据源", "Add source")}</Button>}</div></div>{!authenticated&&signInGuidance}<ErrorMessage error={error}/>{loading?<Loading text={t("正在读取数据源…", "Loading sources…")}/>:sources.length?<Table><TableHeader><TableRow><TableHead>{t("数据源", "Sources")}</TableHead><TableHead>{t("数据格式", "Data format")}</TableHead><TableHead>{t("最近成功", "Last success")}</TableHead><TableHead>{t("状态", "Status")}</TableHead><TableHead>{t("操作", "Actions")}</TableHead></TableRow></TableHeader><TableBody>{sources.map(source=><TableRow key={source.id}><TableCell><strong>{source.name}</strong><small>{source.kind==='github-traffic'?`${source.connection.owner}/${source.connection.repo}`:sourceKindLabel(source.kind)}</small></TableCell><TableCell><code>{source.schemaId}@{source.schemaVersion}</code></TableCell><TableCell>{time(source.lastSuccessAt)}</TableCell><TableCell><span className={`admin-badge ${source.lastError?'danger':!source.lastSuccessAt?'muted':''}`}>{!source.enabled?t("已停用", "Disabled"):queued[source.id]?t("正在采集", "Collecting"):source.lastError?t("采集异常", "Collection failed"):source.lastSuccessAt?t("已有快照", "Snapshot available"):source.kind==='external-push'?t("等待推送", "Awaiting push"):t("等待采集", "Awaiting collection")}</span>{source.lastError&&<small className="admin-inline-error">{source.lastError.message}</small>}</TableCell><TableCell><div className="admin-button-row"><Button variant="ghost" size="sm" onClick={()=>inspect(source)}>{t("快照", "Snapshot")}</Button>{canManage&&<Button variant="ghost" size="sm" onClick={()=>openSource(source)}>{t("配置", "Configure")}</Button>}{source.kind!=='external-push'&&canManage?<Button variant="outline" size="sm" disabled={!!queued[source.id]||!source.enabled} onClick={()=>sync(source)}>{source.lastSuccessAt?t("重新采集", "Collect again"):source.kind==='github-traffic'?t("采集基线", "Collect baseline"):t("立即采集", "Collect now")}</Button>:source.kind==='external-push'&&<Button variant="outline" size="sm" onClick={()=>pushTemplate(source)}>{t("推送模板", "Push template")}</Button>}{source.kind==='external-push'&&source.schemaId==='calendar.events'&&canManage&&<Button variant="outline" size="sm" disabled={!source.enabled} onClick={()=>setCalendarImport(source)}>{t("导入 ICS", "Import ICS")}</Button>}{canManage&&<Button variant="ghost" size="sm" disabled={busy} aria-label={t('删除数据源 {name}','Delete source {name}',{name:source.name})} aria-haspopup="dialog" aria-expanded={deletingSource?.id===source.id} aria-controls={deletingSource?.id===source.id?'admin-confirm-source':undefined} onClick={event=>{if(confirmationRunning.current)return;setRevoke(null);setDeletingToken(null);setDeletingSource(deletingSource?.id===source.id?null:{...source,anchor:event.currentTarget});setSourceNeedsReload(false);setFormError('')}}><Trash2 size={14}/>{t('删除','Delete')}</Button>}</div></TableCell></TableRow>)}</TableBody></Table>:<Empty title={t("暂无外部数据源", "No external sources")}/>}</TabsContent><TabsContent value="mcp">
    <section className="admin-mcp-intro"><span className="admin-feature-icon"><Server size={23}/></span><div><h3>{t('通过 MCP 使用 Home','Use Home through MCP')}</h3><p>{t('每个客户端使用有范围、可撤销的访问令牌。','Give each client its own scoped, revocable access token.')}</p><div className="admin-copy-line"><code>{window.location.origin}/mcp</code><Button variant="outline" size="icon-sm" aria-label={t('复制 MCP 地址','Copy MCP address')} onClick={()=>copied(`${window.location.origin}/mcp`)}><Copy size={15}/></Button></div></div></section>
    {!authenticated?signInGuidance:<>
      <div className="admin-content-toolbar"><h3>{t('我的访问令牌','My access tokens')}</h3><div className="admin-button-row"><Button type="button" variant="outline" size="icon" disabled={busy||loading} aria-label={t('刷新令牌','Refresh tokens')} onClick={()=>void load()}><RefreshCw size={16}/></Button><Button ref={tokenAction} disabled={busy||loading||!actionCatalog} onClick={()=>openToken(null)}><KeyRound size={16}/>{t('创建令牌','Create token')}</Button></div></div>
      <ErrorMessage error={error}/>{loading?<Loading/>:credentials.length?<Table className="admin-token-table"><TableHeader><TableRow><TableHead>{t('名称','Name')}</TableHead><TableHead>{t('权限','Permissions')}</TableHead><TableHead>{t('到期','Expires')}</TableHead><TableHead>{t('状态','Status')}</TableHead><TableHead>{t('操作','Actions')}</TableHead></TableRow></TableHeader><TableBody>{credentials.map(credential=><TableRow key={credential.id} data-token-id={credential.id}>
        <TableCell><strong>{credential.name}</strong><small>{bootstrap.spaces.find(space=>space.id===credential.spaceId)?.name||credential.spaceId}{credential.sourceId?t(' · 数据源：{name}',' · Source: {name}',{name:sources.find(source=>source.id===credential.sourceId&&source.spaceId===credential.spaceId)?.name||credential.sourceId}):''}</small></TableCell>
        <TableCell><div className="admin-tags">{credential.permissionMode==='all'?<span>{t('全部权限','All permissions')}</span>:credential.actions.map(action=><span key={action}>{actions.find(value=>value.id===action)?.label||action}</span>)}</div></TableCell>
        <TableCell>{tokenExpiry(credential.expiresAt)}</TableCell><TableCell><span className={`admin-badge ${credential.status!=='active'?'muted':''}`}>{tokenStatusLabel(credential.status)}</span></TableCell>
        <TableCell><div className="admin-button-row">{editableToken(credential)&&<Button type="button" variant="ghost" size="sm" disabled={busy||!actionCatalog} aria-label={t('编辑令牌 {name}','Edit token {name}',{name:credential.name})} onClick={()=>openToken(credential)}><Pencil size={14}/>{t('编辑','Edit')}</Button>}
          {credential.status!=='revoked'?<Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t('撤销令牌 {name}','Revoke token {name}',{name:credential.name})} aria-haspopup="dialog" aria-expanded={revoke?.id===credential.id} aria-controls={revoke?.id===credential.id?'admin-confirm-token':undefined} onClick={event=>{if(confirmationRunning.current)return;setDeletingSource(null);setDeletingToken(null);setRevoke(revoke?.id===credential.id?null:{...credential,anchor:event.currentTarget});setFormError('')}}><Trash2 size={14}/>{t('撤销','Revoke')}</Button>:<Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t('删除令牌记录 {name}','Delete token record {name}',{name:credential.name})} aria-haspopup="dialog" aria-expanded={deletingToken?.id===credential.id} aria-controls={deletingToken?.id===credential.id?'admin-confirm-token-record':undefined} onClick={event=>{if(confirmationRunning.current)return;setRevoke(null);setDeletingSource(null);setDeletingToken(deletingToken?.id===credential.id?null:{...credential,anchor:event.currentTarget});setTokenNeedsReload(false);setFormError('')}}><Trash2 size={14}/>{t('删除记录','Delete record')}</Button>}
        </div></TableCell>
      </TableRow>)}</TableBody></Table>:<Empty title={t('暂无访问令牌','No access tokens')}/>}</>}
  </TabsContent></Tabs>
  {deletingSource&&<ConfirmPopover id="admin-confirm-source" kind="source" anchor={deletingSource.anchor} title={t('删除数据源？','Delete this source?')} busy={busy} onClose={()=>setDeletingSource(null)} getReturnFocus={()=>deletingSource.anchor.isConnected&&!deletingSource.anchor.closest('[inert]')?deletingSource.anchor:sourceAction.current}><p>{t('将删除「{name}」的配置、密钥和已保存快照，并清理未被任何组件使用的页面数据绑定。', 'This deletes the configuration, credentials and saved snapshot for “{name}”, and removes page data bindings that no component uses.', {name:deletingSource.name})}</p><p className="admin-hint">{t('仍被组件使用的数据源（包括隐藏组件）不能删除。请先移除相关组件或更换来源，并保存页面。', 'Sources used by a component, including a hidden component, cannot be deleted. Remove those components or change their source, then save the page.')}</p><ErrorMessage error={formError}/><div className="admin-form-footer"><Button type="button" variant="outline" data-confirm-cancel disabled={busy} onClick={()=>setDeletingSource(null)}>{t('保留','Keep')}</Button>{sourceNeedsReload?<Button type="button" disabled={busy} onClick={()=>{setDeletingSource(null);void load().finally(()=>focusAction('source'))}}>{t('刷新数据源','Refresh sources')}</Button>:<Button type="button" variant="destructive" disabled={busy} onClick={deleteSource}>{busy?t('正在删除…','Deleting…'):t('确认删除','Delete source')}</Button>}</div></ConfirmPopover>}
  {sourceOpen&&<SourceDialog space={dashboard.space} source={editingSource} onClose={closeSource} onSaved={async()=>{onNotice(editingSource?t('数据源配置已更新','Source configuration updated'):t('数据源已创建','Source created'));await load()}}/>}
  {calendarImport&&<Suspense fallback={<Loading/>}><CalendarImportDialog source={calendarImport} space={dashboard.space} onClose={()=>setCalendarImport(null)} onImported={async()=>{onNotice(t('日程快照已导入','Calendar snapshot imported'));await load()}}/></Suspense>}
  {tokenOpen&&actionCatalog&&<TokenEditor credential={editingToken} catalog={actionCatalog} bootstrap={bootstrap} dashboard={dashboard} sources={sources} onClose={()=>setTokenOpen(false)} onBusyChange={value=>{setBusy(value);onMutationBusyChange?.(value)}} onListRead={setCredentials} onCreated={result=>{setCredentials(current=>[result.credential,...current.filter(value=>value.id!==result.credential.id)]);setTokenValue(result.token);setTokenOpen(false)}} onSaved={value=>{setCredentials(current=>current.map(item=>item.id===value.id?value:item));setTokenOpen(false);onNotice(t('访问令牌已更新','Access token updated'))}}/>}
  {tokenValue&&<Modal title={t("保存你的访问令牌", "Save your access token")} description={t("完整令牌只在这次创建后显示，关闭后无法再次查看。", "The complete token is shown only once. You cannot view it again after closing this dialog.")} onClose={()=>setTokenValue('')}><Input readOnly value={tokenValue} aria-label={t("新访问令牌", "New access token")} onFocus={e=>e.target.select()}/><div className="admin-form-footer"><Button variant="outline" onClick={()=>copied(tokenValue)}><Copy size={16}/>{t("复制令牌", "Copy token")}</Button><Button onClick={()=>setTokenValue('')}>{t("已保存，关闭", "Saved; close")}</Button></div></Modal>}
  {revoke&&<ConfirmPopover id="admin-confirm-token" kind="token" anchor={revoke.anchor} title={t("撤销访问令牌？", "Revoke this access token?")} busy={busy} onClose={()=>setRevoke(null)} getReturnFocus={()=>revoke.anchor.isConnected&&!revoke.anchor.closest('[inert]')?revoke.anchor:tokenAction.current}><p>{t("「{name}」对应的客户端会立即失去权限。", "Clients using “{name}” will immediately lose access.", { name: revoke.name })}</p><ErrorMessage error={formError}/><div className="admin-form-footer"><Button type="button" variant="outline" data-confirm-cancel onClick={()=>setRevoke(null)} disabled={busy}>{t("保留", "Keep")}</Button><Button type="button" variant="destructive" onClick={revokeToken} disabled={busy}>{busy?t('正在撤销…','Revoking…'):t("确认撤销", "Confirm revocation")}</Button></div></ConfirmPopover>}
  {deletingToken&&<ConfirmPopover id="admin-confirm-token-record" kind="token" anchor={deletingToken.anchor} title={t('删除令牌记录？','Delete this token record?')} busy={busy} onClose={()=>setDeletingToken(null)} getReturnFocus={()=>deletingToken.anchor.isConnected&&!deletingToken.anchor.closest('[inert]')?deletingToken.anchor:tokenAction.current}><p>{t('删除已撤销的“{name}”记录。原令牌仍不可使用。','Delete the revoked record “{name}”. The original token remains unusable.',{name:deletingToken.name})}</p><ErrorMessage error={formError}/><div className="admin-form-footer"><Button type="button" variant="outline" data-confirm-cancel disabled={busy} onClick={()=>setDeletingToken(null)}>{t('保留','Keep')}</Button>{tokenNeedsReload?<Button type="button" disabled={busy} onClick={()=>void readTokenRecord()}>{t('读取最新列表','Read latest list')}</Button>:<Button type="button" variant="destructive" disabled={busy||deletingToken.status!=='revoked'} onClick={()=>void deleteTokenRecord()}>{busy?t('正在删除…','Deleting…'):t('确认删除','Confirm deletion')}</Button>}</div></ConfirmPopover>}
  {selectedSource&&<Modal title={t("{name} · 已保存快照", "{name} · Saved snapshot", { name: selectedSource.name })} wide busy={busy} onClose={()=>setSelectedSource(null)}>{busy?<Loading/>:<><ErrorMessage error={formError}/>{snapshot&&<pre className="admin-code-block">{JSON.stringify(snapshot,null,2)}</pre>}</>}</Modal>}
  {template&&<Modal title={t("外部推送模板", "External push template")} description={t("将占位令牌替换为限定此数据源的 Home 访问令牌。", "Replace the token placeholder with a Home access token scoped to this source.")} wide onClose={()=>setTemplate('')}><pre className="admin-code-block">{template}</pre><div className="admin-form-footer"><Button variant="outline" onClick={()=>copied(template)}><Copy size={16}/>{t("复制模板", "Copy template")}</Button><Button onClick={()=>setTemplate('')}>{t("关闭", "Close")}</Button></div></Modal>}
  </>
}
