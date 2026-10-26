import { useEffect, useId, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { ApiError, request } from '../core/api'
import { t } from '../core/i18n'
import { beforeNavigationEvent } from '../core/navigation'
import type { SessionOptions, SessionPolicy } from '../core/types'
import { Field, Modal } from '../components/Shared'
import { FieldHelp } from '../components/FieldHelp'
import { SessionChoice } from '../components/SessionChoice'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { StyledSelect } from '../components/ui/select'
import '../components/session-controls.css'
type Draft = Omit<SessionPolicy,'policyVersion'>
type Props = {onSessionChanged:()=>Promise<void>;disabled?:boolean;onDirtyChange?:(dirty:boolean)=>void;navigationManaged?:boolean}
const editable=(p:SessionPolicy):Draft=>({defaultMode:p.defaultMode,defaultIdleDays:p.defaultIdleDays,maxIdleDays:p.maxIdleDays,allowUntilLogout:p.allowUntilLogout})
const same=(a:Draft,b:Draft)=>a.defaultMode===b.defaultMode && a.defaultIdleDays===b.defaultIdleDays && a.maxIdleDays===b.maxIdleDays && a.allowUntilLogout===b.allowUntilLogout
const errorText=(cause:unknown)=>cause instanceof Error ? cause.message : t('无法完成操作，请重试。','The operation could not be completed. Try again.')
export function SessionPolicyPanel({onSessionChanged,disabled=false,onDirtyChange,navigationManaged=false}:Props){
  const [baseline,setBaseline]=useState<SessionPolicy|null>(null),[draft,setDraft]=useState<Draft|null>(null)
  const [reading,setReading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState(''),[needsRead,setNeedsRead]=useState(false),[leaveOpen,setLeaveOpen]=useState(false)
  const allowId=useId(),mounted=useRef(false),readController=useRef<AbortController|null>(null),pending=useRef<(()=>void)|null>(null),allowNavigation=useRef(false)
  const dirty=!!baseline && !!draft && !same(editable(baseline),draft)
  const dirtyRef=useRef(dirty),savingRef=useRef(false),dirtyCallback=useRef(onDirtyChange),draftRef=useRef(draft)
  dirtyRef.current=dirty;dirtyCallback.current=onDirtyChange;draftRef.current=draft
  const blocked=disabled || reading || saving
  async function recheckIdentity(){allowNavigation.current=true;try{await onSessionChanged()}catch{}finally{allowNavigation.current=false}}
  async function readPolicy(keepDraft:boolean):Promise<boolean>{
    readController.current?.abort();const controller=new AbortController();readController.current=controller
    setReading(true);setError('')
    try{
      const value=await request<SessionPolicy>('/settings/session-policy',{signal:controller.signal})
      if(!mounted.current || controller.signal.aborted)return false
      const retained=keepDraft ? draftRef.current : null,matches=retained && same(editable(value),retained)
      setBaseline(value);setDraft(retained || editable(value));setNeedsRead(false)
      setStatus(matches ? t('已按服务端最新状态确认，无需再次保存。','Confirmed against the latest server state; no additional save is needed.') : retained ? t('已读取最新策略。你的修改仍保留，请核对后保存。','The latest policy is loaded. Your edits are retained; review them before saving.') : needsRead ? t('已按服务端状态重新读取登录策略。','The current login policy has been reloaded from the server.') : '')
      return true
    }catch(cause){if(mounted.current && !controller.signal.aborted){setError(errorText(cause));if(cause instanceof ApiError && [401,403].includes(cause.status))await recheckIdentity()}return false}
    finally{if(mounted.current && readController.current===controller)setReading(false)}
  }
  useEffect(()=>{mounted.current=true;void readPolicy(false);return()=>{mounted.current=false;readController.current?.abort();dirtyCallback.current?.(false)}},[])
  useEffect(()=>{onDirtyChange?.(dirty)},[dirty,onDirtyChange])
  useEffect(()=>{
    if(navigationManaged)return
    const before=(event:Event)=>{
      if(event.defaultPrevented || allowNavigation.current || (!dirtyRef.current && !savingRef.current))return
      event.preventDefault();if(savingRef.current)return
      const proceed=(event as CustomEvent<{proceed:()=>void}>).detail?.proceed
      if(proceed){pending.current=proceed;setLeaveOpen(true)}
    }
    const unload=(event:BeforeUnloadEvent)=>{if(!allowNavigation.current && (dirtyRef.current || savingRef.current)){event.preventDefault();event.returnValue=''}}
    window.addEventListener(beforeNavigationEvent,before);window.addEventListener('beforeunload',unload)
    return()=>{window.removeEventListener(beforeNavigationEvent,before);window.removeEventListener('beforeunload',unload)}
  },[navigationManaged])
  async function discard(leave=false){
    if(!baseline || savingRef.current || reading)return
    if(needsRead){if(!await readPolicy(false))return}else{setDraft(editable(baseline));setError('');setStatus('')}
    dirtyRef.current=false;dirtyCallback.current?.(false)
    if(leave && mounted.current){const proceed=pending.current;pending.current=null;setLeaveOpen(false);proceed?.()}
  }
  async function save(leave=false){
    if(!baseline || !draft || blocked || savingRef.current || !dirty || needsRead)return
    savingRef.current=true;setSaving(true);setError('');setStatus('')
    let value:SessionPolicy
    try{value=await request<SessionPolicy>('/settings/session-policy',{method:'PUT',body:{...draft,expectedVersion:baseline.policyVersion}})}
    catch(cause){
      savingRef.current=false
      if(!mounted.current)return
      const rejected=cause instanceof ApiError && cause.status>=400 && cause.status<500 && cause.status!==408
      setNeedsRead(!rejected || cause instanceof ApiError && cause.status===409)
      setError(rejected ? errorText(cause) : t('保存结果尚未确认。请读取最新策略后核对，不要重复提交。','The save result is not confirmed. Read the latest policy and review it before submitting again.'))
      setSaving(false);if(cause instanceof ApiError && [401,403].includes(cause.status))await recheckIdentity();return
    }
    if(!mounted.current){savingRef.current=false;return}
    setBaseline(value);setDraft(editable(value));setNeedsRead(false);dirtyRef.current=false;dirtyCallback.current?.(false)
    setStatus(t('登录保持策略已保存。','The login retention policy is saved.'));allowNavigation.current=true
    try{await onSessionChanged();if(leave && mounted.current){const proceed=pending.current;pending.current=null;setLeaveOpen(false);proceed?.()}}
    catch{if(mounted.current)setStatus(t('策略已保存，当前登录状态未能刷新。请重新读取。','The policy is saved, but the current login status could not be refreshed. Reload it to continue.'))}
    finally{allowNavigation.current=false;savingRef.current=false;if(mounted.current)setSaving(false)}
  }
  const options:SessionOptions|undefined=draft?{...draft,rememberDays:[7,30,90].filter(days=>days<=draft.maxIdleDays)}:undefined
  return <section className="session-policy-panel" aria-labelledby={allowId+'-title'}>
    <div className="session-section-heading"><h2 id={allowId+'-title'}>{t('登录保持','Login retention')}</h2><FieldHelp label={t('登录保持策略','Login retention policy')}><p>{t('决定新登录默认保持多久，以及用户可以选择的最长闲置期限。旧客户端未选择保持方式时，仍使用固定 12 小时。','Choose the default for new sign-ins and the longest idle period users may select. Clients that omit a retention choice still receive a fixed 12-hour session.')}</p><p>{t('收紧上限会限制已有登录；关闭“直到退出”会使采用该方式的登录失效，包括当前浏览器。','Lower limits also restrict existing sessions. Disabling “until sign out” revokes sessions using that mode, including this browser when applicable.')}</p></FieldHelp></div>
    {draft && options ? <form className="session-policy-form" onSubmit={event=>{event.preventDefault();void save()}}>
      <Field className="admin-field-inline" label={t('最长闲置期限','Maximum idle period')}><StyledSelect tone="admin" aria-label={t('最长闲置期限','Maximum idle period')} disabled={blocked} value={String(draft.maxIdleDays)} options={[7,30,90].map(days=>({value:String(days),label:t('{days} 天','{days} days',{days})}))} onValueChange={value=>{const days=Number(value);setDraft(previous=>previous?{...previous,maxIdleDays:days,defaultIdleDays:Math.min(previous.defaultIdleDays,days)}:previous);setStatus('')}}/></Field>
      <SessionChoice label={t('默认登录方式','Default sign-in')} options={options} value={{sessionMode:draft.defaultMode,rememberDays:draft.defaultIdleDays}} disabled={blocked} onChange={value=>{setDraft(previous=>previous?{...previous,defaultMode:value.sessionMode,defaultIdleDays:value.rememberDays || previous.defaultIdleDays}:previous);setStatus('')}}/>
      <div className="session-policy-allow"><Checkbox id={allowId} checked={draft.allowUntilLogout} disabled={blocked} onCheckedChange={checked=>{const allowed=checked===true;setDraft(previous=>previous?{...previous,allowUntilLogout:allowed,defaultMode:!allowed && previous.defaultMode==='until_logout'?'remember':previous.defaultMode}:previous);setStatus('')}}/><label htmlFor={allowId}>{t('允许保持登录直到退出','Allow staying signed in until sign-out')}</label></div>
      {error && <div className="admin-error" role="alert">{error}</div>}{status && <p className="session-status" role="status">{status}</p>}
      {needsRead && <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={()=>void readPolicy(true)}><RefreshCw size={14}/>{t('读取最新策略','Read latest policy')}</Button>}
      <div className="session-form-actions"><Button type="submit" disabled={blocked || !dirty || needsRead}>{saving && <LoaderCircle size={15} className="admin-spin"/>}{t('保存登录策略','Save login policy')}</Button><Button type="button" variant="outline" disabled={blocked || !dirty} onClick={()=>void discard()}>{t('取消修改','Cancel changes')}</Button></div>
      {disabled && <p className="session-muted">{t('请先保存或取消上方访问设置的修改。','Save or cancel the access-setting edits above before changing this policy.')}</p>}
    </form> : <>{error ? <><div className="admin-error" role="alert">{error}</div><Button type="button" variant="outline" disabled={reading} onClick={()=>void readPolicy(false)}>{t('重新读取','Reload')}</Button></> : <p className="session-muted" role="status">{t('正在读取登录策略…','Loading login policy…')}</p>}</>}
    {leaveOpen && <Modal title={t('登录策略尚未保存','Login policy has unsaved changes')} busy={saving || reading} onClose={()=>{pending.current=null;setLeaveOpen(false)}}><p>{t('保存这次修改后离开，或放弃修改。','Save these changes before leaving, or discard them.')}</p><div className="session-form-actions"><Button type="button" disabled={blocked || needsRead} onClick={()=>void save(true)}>{t('保存并离开','Save and leave')}</Button><Button type="button" variant="outline" disabled={saving || reading} onClick={()=>void discard(true)}>{t('放弃并离开','Discard and leave')}</Button><Button type="button" variant="ghost" disabled={saving || reading} onClick={()=>{pending.current=null;setLeaveOpen(false)}}>{t('继续编辑','Keep editing')}</Button></div></Modal>}
  </section>
}
