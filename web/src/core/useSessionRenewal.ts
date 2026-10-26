import { useEffect, useRef } from 'react'
import { ApiError, request } from './api'
import type { Bootstrap, SessionStatus } from './types'
const RENEW_INTERVAL = 15 * 60 * 1000
const RETRY_DELAY = 60 * 1000
/** Background polling, visibility changes and synthetic events never count as activity. */
export function useSessionRenewal(boot: Bootstrap | null, onSession: (session: SessionStatus) => void, onExpired: () => void) {
  const identity = boot?.user ? boot.user.id + ':' + boot.csrfToken : ''
  const callbacks = useRef({onSession,onExpired}); callbacks.current = {onSession,onExpired}
  const latest = useRef({identity,session:boot?.session}); latest.current = {identity,session:boot?.session}
  const tracking = useRef({identity:'',dueAt:Infinity,retryAt:0,lastSuccessAt:0,busy:false,expired:false,controller:null as AbortController|null})
  useEffect(()=>{
    let state=tracking.current
    if(state.identity !== identity){state.controller?.abort();state={identity,dueAt:Infinity,retryAt:0,lastSuccessAt:0,busy:false,expired:false,controller:null};tracking.current=state}
    const session=boot?.session
    if(!identity || !session || session.mode === 'temporary'){state.dueAt=Infinity;return}
    state.expired=false
    const remaining=Number.isFinite(session.renewAfterSeconds)?Math.max(0,Math.min(900,session.renewAfterSeconds))*1000:RENEW_INTERVAL
    state.dueAt=Math.max(Date.now()+remaining,state.lastSuccessAt+RENEW_INTERVAL)
  },[identity,boot?.session])
  useEffect(()=>{
    const activity=(event:Event)=>{
      if(!event.isTrusted || document.visibilityState !== 'visible')return
      const snapshot=latest.current,state=tracking.current,now=Date.now()
      if(!snapshot.identity || snapshot.identity !== state.identity || !snapshot.session || snapshot.session.mode === 'temporary' || state.busy || state.expired || now<state.dueAt || now<state.retryAt)return
      const controller=new AbortController();state.busy=true;state.controller=controller
      const timeout=setTimeout(()=>{if(tracking.current===state)state.retryAt=Date.now()+RETRY_DELAY;controller.abort()},15000)
      void(async()=>{
        try{
          const result=await request<{session:SessionStatus}>('/auth/renew',{method:'POST',body:{},signal:controller.signal})
          if(controller.signal.aborted || tracking.current !== state || latest.current.identity !== snapshot.identity)return
          const completed=Date.now();state.lastSuccessAt=completed
          state.dueAt=completed+Math.max(RENEW_INTERVAL,Math.max(0,Number(result.session.renewAfterSeconds)||0)*1000);state.retryAt=0
          callbacks.current.onSession(result.session)
        }catch(cause){
          if(controller.signal.aborted || tracking.current !== state)return
          if(cause instanceof ApiError && [401,403].includes(cause.status)){state.expired=true;state.retryAt=Date.now()+RETRY_DELAY;void Promise.resolve(callbacks.current.onExpired()).catch(()=>{})}
          else state.retryAt=Date.now()+RETRY_DELAY
        }finally{clearTimeout(timeout);if(tracking.current === state){state.busy=false;state.controller=null}}
      })()
    }
    const events=['pointerdown','keydown','wheel','touchstart'] as const
    for(const name of events)window.addEventListener(name,activity,{capture:true,passive:true})
    return()=>{tracking.current.controller?.abort();for(const name of events)window.removeEventListener(name,activity,true)}
  },[])
}
