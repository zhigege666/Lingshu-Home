import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionReadGuard, createSessionRequestQueue } from '../web/src/core/session-requests.ts'
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
test('password and logout wait for renewal response completion; data reads stay independent',async()=>{
 const run=createSessionRequestQueue(),gate=deferred(),events=[]
 const renew=run('/auth/renew','POST',async()=>{events.push('renew-start');await gate.promise;events.push('renew-cookie');return 1})
 const password=run('/account/password','POST',async()=>{events.push('password-cookie');return 2})
 const logout=run('/auth/logout','POST',async()=>{events.push('logout-cookie');return 3})
 await run('/spaces/s/navigation','GET',async()=>{events.push('read');return 4})
 assert(!events.includes('password-cookie'));assert(events.includes('read'))
 gate.resolve();assert.deepEqual(await Promise.all([renew,password,logout]),[1,2,3])
 assert(events.indexOf('renew-cookie')<events.indexOf('password-cookie'));assert(events.indexOf('password-cookie')<events.indexOf('logout-cookie'))
})
test('a rejected renewal does not block login, and queued renewals use the new cookie',async()=>{
 const run=createSessionRequestQueue();let cookie='old'
 const failed=run('/auth/renew','POST',async()=>{throw Error('network')})
 const login=run('/auth/login','POST',async()=>{cookie='new';return cookie})
 const renewed=run('/auth/renew','POST',async()=>cookie)
 await assert.rejects(failed,/network/);assert.equal(await login,'new');assert.equal(await renewed,'new')
})
test('a delayed bootstrap cannot restore CSRF from before a session change',async()=>{
 const guard=createSessionReadGuard(),gate=deferred();let csrf='original'
 const old=guard.capture(),pending=gate.promise.then(()=>{if(old())csrf='old-account'})
 guard.invalidate()
 const current=guard.capture();assert(current());csrf='new-account'
 gate.resolve();await pending;assert.equal(csrf,'new-account')
})
test('a bootstrap started during a cookie-changing response cannot commit afterwards',()=>{
 const guard=createSessionReadGuard();guard.invalidate()
 const during=guard.capture();guard.invalidate()
 assert.equal(during(),false)
 const first=guard.capture(),latest=guard.capture()
 assert.equal(first(),false);assert.equal(latest(),true)
})
