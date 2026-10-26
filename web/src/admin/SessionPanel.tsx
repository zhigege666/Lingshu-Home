import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, LogOut, RefreshCw } from 'lucide-react'
import { ApiError, request } from '../core/api'
import { t } from '../core/i18n'
import type { AccountSession, Bootstrap } from '../core/types'
import { FieldHelp } from '../components/FieldHelp'
import { sessionModeLabel } from '../components/SessionChoice'
import { Button } from '../components/ui/button'
import '../components/session-controls.css'
function dateLabel(value?:string){
  if(!value)return t('未记录','Not recorded')
  const date=new Date(value)
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat(t('zh-CN','en'),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date):t('未记录','Not recorded')
}
const errorText=(cause:unknown)=>cause instanceof Error?cause.message:t('无法读取登录记录。','Login records could not be read.')
export function SessionPanel({bootstrap,onSessionChanged,onNotice,disabled=false,onCurrentSessionRevoked}:{bootstrap:Bootstrap;onSessionChanged:()=>Promise<void>;onNotice:(message:string)=>void;disabled?:boolean;onCurrentSessionRevoked?:()=>Promise<void>}){
  const [sessions,setSessions]=useState<AccountSession[]>([]),[loaded,setLoaded]=useState(false),[reading,setReading]=useState(false),[busy,setBusy]=useState(false),[needsRead,setNeedsRead]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState<string|null>(null)
  const mounted=useRef(false),inFlight=useRef(false),controller=useRef<AbortController|null>(null)
  async function load(){
    controller.current?.abort();const pending=new AbortController();controller.current=pending;setReading(true);setError('')
    try{
      const result=await request<{sessions:AccountSession[]}>('/account/sessions',{signal:pending.signal})
      if(!mounted.current || pending.signal.aborted)return
      setSessions(result.sessions.slice().sort((a,b)=>Number(b.current)-Number(a.current)));setLoaded(true);setNeedsRead(false);setConfirm(null)
    }catch(cause){
      if(!mounted.current || pending.signal.aborted)return
      setError(errorText(cause));if(cause instanceof ApiError && cause.status===401)void onSessionChanged().catch(()=>{})
    }finally{if(mounted.current && controller.current===pending)setReading(false)}
  }
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;controller.current?.abort()}},[bootstrap.user?.id,bootstrap.csrfToken,bootstrap.session?.mode,bootstrap.session?.expiresAt])
  async function revoke(target:string){
    if(disabled || inFlight.current || reading || needsRead)return
    const current=target!=='others' && sessions.find(session=>session.id===target)?.current
    inFlight.current=true;setBusy(true);setError('')
    try{
      if(target==='others'){
        const result=await request<{revoked:number}>('/account/sessions/revoke-others',{method:'POST',body:{}})
        onNotice(t('已退出其他 {count} 个登录。','Signed out {count} other sessions.',{count:result.revoked}));if(mounted.current)await load()
      }else{
        const result=await request<{revoked:boolean;current:boolean}>('/account/sessions/revoke',{method:'POST',body:{id:target}})
        onNotice(result.current?t('已退出此登录。','This session is signed out.'):t('已撤销该登录。','The session is revoked.'))
        if(result.current)await(onCurrentSessionRevoked || onSessionChanged)();else if(mounted.current)await load()
      }
    }catch(cause){
      if(!mounted.current)return
      const rejected=cause instanceof ApiError && cause.status>=400 && cause.status<500 && cause.status!==408
      setNeedsRead(true);setError(rejected?errorText(cause):t('操作结果尚未确认。请重新读取登录记录后核对。','The result is not confirmed. Reload the login records to check it.'))
      if(current || cause instanceof ApiError && cause.status===401)await onSessionChanged().catch(()=>{})
    }finally{inFlight.current=false;if(mounted.current){setBusy(false);setConfirm(null)}}
  }
  const blocked=disabled || reading || busy || needsRead,others=sessions.filter(session=>!session.current).length
  const liveSessions=sessions.map(session=>session.current && bootstrap.session?{...session,...bootstrap.session}:session)
  return <section className="profile-card account-sessions" aria-label={t('登录设备','Signed-in sessions')}>
    <div className="session-section-heading"><h2>{t('登录设备','Signed-in sessions')}</h2><FieldHelp label={t('登录设备','Signed-in sessions')}><p>{t('这里列出此账号的浏览器登录。退出其他登录不影响当前浏览器，也不撤销单独签发的 API / MCP 令牌。','These are browser sessions for this account. Signing out other sessions keeps this browser signed in and does not revoke separately issued API / MCP tokens.')}</p><p>{t('设备描述来自浏览器提供的信息。记住模式按闲置时间到期；“直到退出”仍受账号安全策略和浏览器数据清理影响。','Device descriptions come from browser-provided information. Remembered sessions expire after inactivity; “until sign out” still respects account security policy and browser-data removal.')}</p></FieldHelp><Button type="button" className="session-refresh" variant="ghost" size="icon-sm" aria-label={t('刷新登录记录','Refresh login records')} disabled={reading || busy} onClick={()=>void load()}>{reading?<LoaderCircle size={16} className="admin-spin"/>:<RefreshCw size={16}/>}</Button></div>
    {error && <div className="admin-error" role="alert">{error}</div>}
    {!loaded && reading && <p className="session-muted" role="status">{t('正在读取登录记录…','Loading login records…')}</p>}
    {loaded && <ul className="session-list">{liveSessions.map(session=><li className="session-row" key={session.id} data-current={session.current}>
      <div className="session-row-copy"><div className="session-row-title"><strong>{session.current?t('此浏览器','This browser'):t('其他登录','Another session')}</strong>{session.current && <span className="session-current-badge">{t('当前','Current')}</span>}</div>
        <p className="session-device" title={session.userAgent || undefined}>{session.userAgent || t('未提供设备描述','No device description supplied')}</p><p className="session-mode">{sessionModeLabel(session)}</p>
        <dl className="session-dates"><div><dt>{t('最后使用','Last used')}</dt><dd>{dateLabel(session.lastInteractiveAt || session.createdAt)}</dd></div>{session.mode!=='until_logout' && <div><dt>{t('有效至','Expires')}</dt><dd>{dateLabel(session.expiresAt)}</dd></div>}</dl>
      </div>
      <div className="session-row-actions">{confirm===session.id?<div className="session-inline-confirm" role="group" aria-label={t('确认退出此登录','Confirm session sign-out')}><span>{session.current?t('退出当前浏览器？','Sign out this browser?'):t('撤销此登录？','Revoke this session?')}</span><div><Button type="button" size="sm" disabled={blocked} onClick={()=>void revoke(session.id)}>{busy && <LoaderCircle size={14} className="admin-spin"/>}{t('确认退出','Confirm sign-out')}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>setConfirm(null)}>{t('取消','Cancel')}</Button></div></div>:<Button type="button" variant="outline" size="sm" disabled={blocked} onClick={()=>setConfirm(session.id)}><LogOut size={14}/>{session.current?t('退出此登录','Sign out here'):t('撤销登录','Revoke session')}</Button>}</div>
    </li>)}</ul>}
    {loaded && sessions.length===0 && <p className="session-muted">{t('没有可用的登录记录，请重新读取账号状态。','No login records are available. Reload the account status.')}</p>}
    <div className="session-footer">{confirm==='others'?<div className="session-inline-confirm" role="group" aria-label={t('确认退出其他登录','Confirm other-session sign-out')}><span>{t('退出其他所有登录，保留此浏览器？','Sign out all other sessions and keep this browser?')}</span><div><Button type="button" size="sm" disabled={blocked} onClick={()=>void revoke('others')}>{t('确认退出其他登录','Confirm other sign-outs')}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>setConfirm(null)}>{t('取消','Cancel')}</Button></div></div>:<Button type="button" variant="outline" size="sm" disabled={blocked || others===0} onClick={()=>setConfirm('others')}>{t('退出其他登录','Sign out other sessions')}</Button>}
      {needsRead && <Button type="button" variant="outline" size="sm" disabled={reading || busy} onClick={()=>void load()}><RefreshCw size={14}/>{t('重新读取登录记录','Reload login records')}</Button>}
      {disabled && <p className="session-muted">{t('请先保存或取消资料中的修改，再退出登录。','Save or cancel the profile changes before signing out.')}</p>}
    </div>
  </section>
}
