import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { ApiError, bootstrap, messageOf, request } from './core/api'
import type { Bootstrap, Dashboard } from './core/types'
import { HomeView } from './home/HomeView'
import { configureLanguage, t } from './core/i18n'
import { requestNavigation, routeCommittedEvent } from './core/navigation'
import { readRememberedSpace, rememberSpace, selectAccessibleSpace, spaceSelectionKey } from './core/space-selection'
import { Button } from './components/ui/button'
import { ProjectLogo } from './components/ProjectLogo'
const AdminView = lazy(() => import('./admin/AdminView'))
const AuthScreen = lazy(() => import('./components/AuthScreen'))
// Route status must not import the admin form module (and its dialog dependencies).
function AppLoading({ text = t('正在读取…', 'Loading…') }: { text?: string }) { return <div className="admin-loading" role="status"><LoaderCircle className="admin-spin" size={21}/>{text}</div> }
function readRoute() { return window.location.hash.replace(/^#/, '') || (window.location.pathname.startsWith('/admin') ? '/admin' : window.location.pathname === '/login' ? '/login' : '/') }
function tabStorage(): Storage | null { try { return window.sessionStorage } catch { return null } }
export default function App() {
  const [boot,setBoot] = useState<Bootstrap|null>(null); const [dashboard,setDashboard] = useState<Dashboard|null>(null)
  const [loading,setLoading] = useState(true); const [loadingSpace,setLoadingSpace] = useState(false); const [route,setRoute] = useState(readRoute)
  const [fatal,setFatal] = useState(''); const [error,setError] = useState(''); const [notice,setNotice] = useState('')
  const routeRef = useRef(route);
  const identityRef = useRef<string | null>(null)
  const spaceRef = useRef(''); const controller = useRef<AbortController|null>(null)
  const auth = !!boot && (!boot.initialized || !boot.user && (['private_single','private_multi'].includes(boot.mode) || route.startsWith('/login')))
  function applyBootstrap(value: Bootstrap) { configureLanguage(value.language); setBoot(value); document.title = value.siteName || 'Lingshu-Home' }
  function navigate(next:string) { requestNavigation(() => { routeRef.current = next; window.location.hash = next; setRoute(next); setError(''); window.scrollTo(0,0) }) }
  async function loadDashboard(id = spaceRef.current) {
    controller.current?.abort(); if (!id) { setDashboard(null); setLoadingSpace(false); return }
    const pending = new AbortController(); controller.current = pending
    if (spaceRef.current !== id) setDashboard(null)
    spaceRef.current = id; setLoadingSpace(true); setError('')
    try { const value = await request<Dashboard>(`/dashboard?spaceId=${encodeURIComponent(id)}`,{signal:pending.signal}); if (!pending.signal.aborted) setDashboard(value) } catch (cause) { if (!pending.signal.aborted) { if (cause instanceof ApiError && [401,403].includes(cause.status)) { setDashboard(null); try { applyBootstrap(await bootstrap()) } catch {} } setError(messageOf(cause)) } } finally { if (controller.current === pending) setLoadingSpace(false) }
  }
  async function loadSession(resetCurrent = false, preferShared = false, verified?: Bootstrap) {
    setFatal(''); setError(''); controller.current?.abort()
    try {
      const value = verified || await bootstrap(); applyBootstrap(value)
      const identity = spaceSelectionKey(value), sameIdentity = identityRef.current === identity
      identityRef.current = identity
      if (!value.initialized) { setDashboard(null); spaceRef.current = ''; setLoadingSpace(false); return }
      if (!value.user && ['private_single','private_multi'].includes(value.mode)) { setDashboard(null); spaceRef.current = ''; setLoadingSpace(false); navigate('/login'); return }
      const storage = tabStorage()
      const selected = selectAccessibleSpace(value, {
        currentId: !resetCurrent && sameIdentity ? spaceRef.current : '',
        rememberedId: readRememberedSpace(value, storage),
        preferShared,
      })
      // The explicit setup landing and manual selections survive a reload of
      // this tab. The API's default space and other identities stay unchanged.
      if (preferShared && selected) rememberSpace(value, selected, storage)
      if (selected) await loadDashboard(selected); else { setDashboard(null); spaceRef.current = '' }
    } catch (cause) { setFatal(messageOf(cause)) } finally { setLoading(false) }
  }
  async function authComplete(preferShared = false) { setDashboard(null); spaceRef.current=''; navigate('/'); await loadSession(true, preferShared) }
  async function recheckSetup(): Promise<boolean> {
    const value = await bootstrap()
    if (!value.initialized) return false
    controller.current?.abort(); setDashboard(null); spaceRef.current = ''
    // A completed setup does not prove that this browser owns the account.
    // Follow the verified session, never the credentials still in the form.
    navigate(!value.user && value.mode !== 'open_edit' ? '/login' : '/')
    await loadSession(true, ['open_edit', 'public_read'].includes(value.mode), value)
    setNotice(value.user || value.mode === 'open_edit'
      ? t('初始化已完成，已打开 Home。', 'Setup is complete. Home is ready.')
      : t('初始化已完成。请使用已创建的账号登录。', 'Setup is complete. Sign in with the account that was created.'))
    return true
  }
  function switchSpace(id: string) {
    if (!boot?.initialized || !boot.spaces.some(space => space.id === id)) return
    rememberSpace(boot, id, tabStorage())
    void loadDashboard(id)
  }
  async function logout() { try { await request('/auth/logout',{method:'POST',body:{}}); controller.current?.abort(); setDashboard(null); spaceRef.current=''; navigate('/'); await loadSession(true); setNotice(t('已退出登录', 'Signed out')) } catch (cause) { setError(messageOf(cause)) } }
  async function sessionChanged() { controller.current?.abort(); setDashboard(null); await loadSession() }
  useEffect(() => {
    const changed = () => {
      const next = readRoute(); if (next === routeRef.current) return;
      const previous = routeRef.current;
      if (!requestNavigation(() => { routeRef.current = next; if (readRoute() !== next) window.location.hash = next; setRoute(next) })) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + previous)
      }
    };
    const committed = () => { const next = readRoute(); routeRef.current = next; setRoute(next) };
    window.addEventListener('hashchange',changed); window.addEventListener(routeCommittedEvent,committed); void loadSession();
    return () => { controller.current?.abort(); window.removeEventListener('hashchange',changed); window.removeEventListener(routeCommittedEvent,committed) }
  },[])
  useEffect(() => { if (!notice) return; const timer=setTimeout(()=>setNotice(''),6500); return()=>clearTimeout(timer) },[notice])
  return <><a href="#main-content" className="app-skip-link" onClick={event=>{event.preventDefault();const target=document.getElementById('main-content')||document.querySelector('main');if(target instanceof HTMLElement){target.tabIndex=-1;target.focus();target.scrollIntoView()}}}>{t('跳到主要内容', 'Skip to main content')}</a>{loading ? <div className="admin-ui app-boot"><ProjectLogo size={48}/><h1>Lingshu-Home</h1><AppLoading/></div> : fatal ? <main className="admin-ui app-boot" id="main-content"><h1>{t('暂时无法打开 Home', 'Home is temporarily unavailable')}</h1><div role="alert" className="admin-error">{fatal}</div><Button onClick={()=>loadSession()}>{t('重新连接', 'Reconnect')}</Button></main> : boot && auth ? <Suspense fallback={<main className="admin-ui app-boot" id="main-content"><AppLoading text={t('正在加载登录页面…', 'Loading sign-in page…')}/></main>}><AuthScreen bootstrap={boot} onComplete={authComplete} onRecheckSetup={recheckSetup} onBrowse={()=>navigate('/')}/></Suspense> : boot ? <>{error&&<div className="admin-ui app-error" role="alert"><span>{error}</span><Button variant="outline" onClick={()=>loadSession()}>{t('重新读取', 'Reload')}</Button><Button variant="ghost" size="icon-sm" aria-label={t('关闭提示', 'Dismiss notice')} onClick={()=>setError('')}><X size={16}/></Button></div>}{route.startsWith('/admin') ? <Suspense fallback={<div className="admin-ui app-boot"><AppLoading/></div>}><AdminView bootstrap={boot} dashboard={dashboard} onHome={()=>navigate('/')} onLogin={()=>navigate('/login')} onLogout={logout} onRefresh={()=>loadDashboard()} onSwitchSpace={switchSpace} onSessionChanged={sessionChanged} onNotice={setNotice}/></Suspense> : dashboard ? <HomeView bootstrap={boot} dashboard={dashboard} onRefresh={()=>loadDashboard()} onSpaceChange={switchSpace} onLogout={boot.user ? logout : undefined}/> : loadingSpace ? <div className="admin-ui app-boot"><AppLoading text={t('正在读取空间内容…', 'Loading workspace…')}/></div> : <main className="admin-ui app-boot" id="main-content"><ProjectLogo size={48}/><h1>{boot.siteName}</h1><p>{t('当前没有可访问的公开导航。', 'No public navigation is available.')}</p><div className="admin-button-row">{!boot.user&&<Button onClick={()=>navigate('/login')}>{t('登录', 'Sign in')}</Button>}<Button variant="outline" onClick={()=>navigate('/admin')}>{t('管理面板', 'Admin')}</Button>{boot.user&&<Button variant="ghost" onClick={logout}>{t('退出登录', 'Sign out')}</Button>}</div></main>}</> : null}{notice&&<div className="admin-ui app-toast" role="status"><Check size={17}/><p>{notice}</p><Button variant="ghost" size="icon-sm" aria-label={t('关闭操作提示', 'Dismiss confirmation')} onClick={()=>setNotice('')}><X size={16}/></Button></div>}</>
}
