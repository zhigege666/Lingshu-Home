import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { ApiError, bootstrap, messageOf, request } from './core/api'
import type { Bootstrap, Dashboard } from './core/types'
import { HomeView } from './home/HomeView'
import { configureLanguage, t } from './core/i18n'
import { accessibleLibrarySpace, readLibraryTarget } from './core/library-navigation'
import { requestNavigation, routeCommittedEvent } from './core/navigation'
import { browserSpaceStorage, clearRememberedSpace, forgetSpacePreference, readRememberedSpace, readSpacePreferences, rememberSpace, rememberSuccessfulSpace, selectAccessibleSpace, spaceSelectionKey } from './core/space-selection'
import { Button } from './components/ui/button'
import { ProjectLogo } from './components/ProjectLogo'
const AdminView = lazy(() => import('./admin/AdminView'))
const LibraryView = lazy(() => import('./library/LibraryView'))
const AuthScreen = lazy(() => import('./components/AuthScreen'))
// Route status must not import the admin form module (and its dialog dependencies).
function AppLoading({ text = t('正在读取…', 'Loading…') }: { text?: string }) { return <div className="admin-loading" role="status"><LoaderCircle className="admin-spin" size={21}/>{text}</div> }
function readRoute() { return window.location.hash.replace(/^#/, '') || (window.location.pathname.startsWith('/admin') ? '/admin' : window.location.pathname === '/login' ? '/login' : window.location.pathname === '/library' ? '/library' + window.location.search : '/') }
export default function App() {
  const [boot,setBoot] = useState<Bootstrap|null>(null); const [dashboard,setDashboard] = useState<Dashboard|null>(null)
  const [loading,setLoading] = useState(true); const [loadingSpace,setLoadingSpace] = useState(false); const [route,setRoute] = useState(readRoute)
  const [fatal,setFatal] = useState(''); const [error,setError] = useState(''); const [notice,setNotice] = useState('')
  const routeRef = useRef(route);
  const libraryRequest = useRef('')
  const libraryTarget = readLibraryTarget(route)
  const libraryRoutePending = !!libraryTarget?.spaceId && !!boot && libraryRequest.current !== `${spaceSelectionKey(boot)}:${route}`
  const inaccessibleLibrarySpace = !!libraryTarget?.spaceId && !!boot && !accessibleLibrarySpace(libraryTarget, boot.spaces)
  const identityRef = useRef<string | null>(null)
  const bootRef = useRef<Bootstrap | null>(null), dashboardRef = useRef<Dashboard | null>(null), manualSpaceRef = useRef(''), sessionRequest = useRef(0)
  const spaceRef = useRef(''); const controller = useRef<AbortController|null>(null)
  const auth = !!boot && (!boot.initialized || !boot.user && (['private_single','private_multi'].includes(boot.mode) || route.startsWith('/login')))
  function showDashboard(value: Dashboard | null) { dashboardRef.current = value; setDashboard(value) }
  function applyBootstrap(value: Bootstrap) {
    const identity = spaceSelectionKey(value)
    if (identityRef.current !== null && identityRef.current !== identity) {
      if (bootRef.current) clearRememberedSpace(bootRef.current, browserSpaceStorage('session'))
      manualSpaceRef.current = ''; spaceRef.current = ''; showDashboard(null)
    }
    identityRef.current = identity; bootRef.current = value
    configureLanguage(value.language); setBoot(value); document.title = value.siteName || 'Lingshu-Home'
  }
  function navigate(next:string) { requestNavigation(() => { routeRef.current = next; window.location.hash = next; setRoute(next); setError(''); window.scrollTo(0,0) }) }
  async function loadDashboard(id = spaceRef.current, propagateFailure = false, options: { manual?: boolean; recover?: boolean } = {}): Promise<void> {
    controller.current?.abort()
    const session = bootRef.current
    if (!id || !session?.initialized || !session.spaces.some(space => space.id === id)) { showDashboard(null); spaceRef.current = ''; setLoadingSpace(false); return }
    const identity = spaceSelectionKey(session), previous = dashboardRef.current
    const pending = new AbortController(); controller.current = pending
    const currentRequest = () => !pending.signal.aborted && controller.current === pending && identityRef.current === identity
    if (spaceRef.current !== id) showDashboard(null)
    setLoadingSpace(true); setError('')
    try {
      const value = await request<Dashboard>(`/dashboard?spaceId=${encodeURIComponent(id)}`, { signal: pending.signal })
      pending.signal.throwIfAborted()
      if (!currentRequest()) return
      if (value.space.id !== id) throw new Error(t('空间响应与请求不一致，请重新读取。', 'The space response does not match the request. Reload the page.'))
      showDashboard(value); spaceRef.current = id
      // Persist only a confirmed dashboard. A failed switch must not replace
      // the last successful space or the tab's explicit manual selection.
      if (options.manual) { manualSpaceRef.current = id; rememberSpace(session, id, browserSpaceStorage('session')) }
      rememberSuccessfulSpace(session, id, browserSpaceStorage('local'))
    } catch (cause) {
      if (currentRequest()) {
        if (cause instanceof ApiError && [401,403,404].includes(cause.status)) {
          showDashboard(null)
          if (cause.status !== 401) {
            clearRememberedSpace(session, browserSpaceStorage('session'), id)
            forgetSpacePreference(session, id, browserSpaceStorage('local'))
            if (manualSpaceRef.current === id) manualSpaceRef.current = ''
            if (spaceRef.current === id) spaceRef.current = ''
          }
          try {
            const value = await bootstrap()
            if (currentRequest()) {
              const sameIdentity = spaceSelectionKey(value) === identity
              applyBootstrap(value)
              const preferences = readSpacePreferences(value, browserSpaceStorage('local'))
              const manual = (sameIdentity ? manualSpaceRef.current : '') || readRememberedSpace(value, browserSpaceStorage('session'))
              if (!value.user && ['private_single','private_multi'].includes(value.mode)) { spaceRef.current = ''; navigate('/login') }
              else if (options.recover !== false) {
                const fallback = selectAccessibleSpace(value, { currentId: manual, fixedId: preferences.defaultSpaceId, rememberedId: preferences.lastSpaceId, excludedIds: [id] })
                if (fallback) await loadDashboard(fallback, false, { recover: false, manual: fallback === manual })
                else spaceRef.current = ''
              }
            }
          } catch {}
        } else if (previous && session.spaces.some(space => space.id === previous.space.id)) {
          showDashboard(previous)
        }
        if (currentRequest() && !propagateFailure) setError(messageOf(cause))
      }
      // A save callback must be able to distinguish a successful read from a
      // failed/aborted one. Initial navigation continues to report errors here.
      if (propagateFailure) throw cause
    } finally { if (controller.current === pending) setLoadingSpace(false) }
  }
  async function loadSession(preferShared = false, verified?: Bootstrap) {
    const generation = ++sessionRequest.current
    setFatal(''); setError(''); controller.current?.abort()
    try {
      const value = verified || await bootstrap()
      if (sessionRequest.current !== generation) return
      const identity = spaceSelectionKey(value), sameIdentity = identityRef.current === identity
      applyBootstrap(value)
      if (!value.initialized) { showDashboard(null); spaceRef.current = ''; setLoadingSpace(false); return }
      if (!value.user && ['private_single','private_multi'].includes(value.mode)) { showDashboard(null); spaceRef.current = ''; setLoadingSpace(false); if (!readLibraryTarget(routeRef.current)) navigate('/login'); return }
      const preferences = readSpacePreferences(value, browserSpaceStorage('local'))
      const rememberedTab = readRememberedSpace(value, browserSpaceStorage('session'))
      if (manualSpaceRef.current && !value.spaces.some(space => space.id === manualSpaceRef.current)) manualSpaceRef.current = ''
      const manual = sameIdentity && manualSpaceRef.current ? manualSpaceRef.current : rememberedTab
      const linkedSpace = accessibleLibrarySpace(readLibraryTarget(routeRef.current), value.spaces)
      const selected = linkedSpace || selectAccessibleSpace(value, {
        currentId: manual,
        fixedId: preferences.defaultSpaceId,
        rememberedId: preferences.lastSpaceId,
        preferShared,
      })
      // A valid legacy tab selection migrates to persistent last-successful
      // state only after the dashboard has actually opened.
      if (selected) await loadDashboard(selected, false, { manual: !!linkedSpace || preferShared || selected === manual, recover: !linkedSpace }); else { showDashboard(null); spaceRef.current = '' }
    } catch (cause) { if (sessionRequest.current === generation) setFatal(messageOf(cause)) } finally { if (sessionRequest.current === generation) setLoading(false) }
  }
  async function authComplete(preferShared = false) { const next = readLibraryTarget(routeRef.current) ? routeRef.current : '/'; showDashboard(null); spaceRef.current=''; manualSpaceRef.current=''; navigate(next); await loadSession(preferShared) }
  async function languageReady(value: Bootstrap) {
    if (value.initialized) { await loadSession(false, value); return }
    applyBootstrap(value)
  }
  async function recheckSetup(): Promise<boolean> {
    const value = await bootstrap()
    if (!value.initialized) { applyBootstrap(value); return false }
    controller.current?.abort(); showDashboard(null); spaceRef.current = ''
    // A completed setup does not prove that this browser owns the account.
    // Follow the verified session, never the credentials still in the form.
    navigate(!value.user && value.mode !== 'open_edit' ? '/login' : '/')
    await loadSession(['open_edit', 'public_read'].includes(value.mode), value)
    setNotice(value.user || value.mode === 'open_edit'
      ? t('初始化已完成，已打开 Home。', 'Setup is complete. Home is ready.')
      : t('初始化已完成。请使用已创建的账号登录。', 'Setup is complete. Sign in with the account that was created.'))
    return true
  }
  function switchSpace(id: string) {
    if (!boot?.initialized || !boot.spaces.some(space => space.id === id)) return
    sessionRequest.current++
    if (readLibraryTarget(routeRef.current)) navigate('/library')
    void loadDashboard(id, false, { manual: true })
  }
  async function logout() { try { await request('/auth/logout',{method:'POST',body:{}}); sessionRequest.current++; controller.current?.abort(); if (bootRef.current) clearRememberedSpace(bootRef.current, browserSpaceStorage('session')); showDashboard(null); spaceRef.current=''; manualSpaceRef.current=''; navigate('/'); await loadSession(); setNotice(t('已退出登录', 'Signed out')) } catch (cause) { setError(messageOf(cause)) } }
  async function sessionChanged() { controller.current?.abort(); showDashboard(null); await loadSession() }
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
    return () => { sessionRequest.current++; controller.current?.abort(); window.removeEventListener('hashchange',changed); window.removeEventListener(routeCommittedEvent,committed) }
  },[])
  useEffect(() => {
    if (loading || !boot || auth) return
    const target = readLibraryTarget(route)
    if (!target) { libraryRequest.current = ''; return }
    const requestKey = `${spaceSelectionKey(boot)}:${route}`
    if (libraryRequest.current === requestKey) return
    libraryRequest.current = requestKey
    const linkedSpace = accessibleLibrarySpace(target, boot.spaces)
    if (linkedSpace && dashboardRef.current?.space.id !== linkedSpace) void loadDashboard(linkedSpace, false, { manual: true, recover: false })
  }, [route, loading, boot, auth])
  useEffect(() => { if (!notice) return; const timer=setTimeout(()=>setNotice(''),6500); return()=>clearTimeout(timer) },[notice])
  return <><a href="#main-content" className="app-skip-link" onClick={event=>{event.preventDefault();const target=document.getElementById('main-content')||document.querySelector('main');if(target instanceof HTMLElement){target.tabIndex=-1;target.focus();target.scrollIntoView()}}}>{t('跳到主要内容', 'Skip to main content')}</a>{loading ? <div className="admin-ui app-boot"><ProjectLogo size={48}/><h1>Lingshu-Home</h1><AppLoading/></div> : fatal ? <main className="admin-ui app-boot" id="main-content"><h1>{t('暂时无法打开 Home', 'Home is temporarily unavailable')}</h1><div role="alert" className="admin-error">{fatal}</div><Button onClick={()=>loadSession()}>{t('重新连接', 'Reconnect')}</Button></main> : boot && auth ? <Suspense fallback={<main className="admin-ui app-boot" id="main-content"><AppLoading text={t('正在加载登录页面…', 'Loading sign-in page…')}/></main>}><AuthScreen bootstrap={boot} onComplete={authComplete} onRecheckSetup={recheckSetup} onLanguageReady={languageReady} onBrowse={()=>navigate('/')}/></Suspense> : boot ? <>{error&&<div className="admin-ui app-error" role="alert"><span>{error}</span><Button variant="outline" onClick={()=>loadSession()}>{t('重新读取', 'Reload')}</Button><Button variant="ghost" size="icon-sm" aria-label={t('关闭提示', 'Dismiss notice')} onClick={()=>setError('')}><X size={16}/></Button></div>}{libraryTarget && (inaccessibleLibrarySpace || !dashboard || !!libraryTarget.spaceId && dashboard.space.id !== libraryTarget.spaceId) ? <main className="admin-ui app-boot" id="main-content">{!inaccessibleLibrarySpace && (loadingSpace || libraryRoutePending) ? <AppLoading text={t('正在读取资料库…', 'Loading library…')}/> : <><h1>{t('无法打开此资料库', 'This library could not be opened')}</h1><p role="alert">{inaccessibleLibrarySpace ? t('链接中的空间不存在，或当前账号没有访问权限。', 'The linked space does not exist or is not accessible to this account.') : error || t('当前没有可访问的资料库。', 'No library is available to this account.')}</p><div className="admin-button-row"><Button onClick={()=>navigate('/')}>{t('返回首页', 'Return home')}</Button>{!inaccessibleLibrarySpace && <Button variant="outline" onClick={()=>loadSession()}>{t('重新读取', 'Reload')}</Button>}</div></>}</main> : libraryTarget && dashboard ? <Suspense fallback={<div className="admin-ui app-boot"><AppLoading/></div>}><LibraryView key={`${boot.user?.id || 'visitor'}:${boot.user?.role || 'visitor'}:${boot.mode}:${dashboard.space.id}:${dashboard.space.canEdit}`} bootstrap={boot} dashboard={dashboard} documentId={libraryTarget.documentId} onHome={()=>navigate('/')} onManage={()=>navigate('/admin?tab=documents')} onLogin={()=>navigate('/login')} onLogout={logout} onSpaceChange={switchSpace}/></Suspense> : route.startsWith('/admin') ? <Suspense fallback={<div className="admin-ui app-boot"><AppLoading/></div>}><AdminView bootstrap={boot} dashboard={dashboard} onHome={()=>navigate('/')} onLogin={()=>navigate('/login')} onLogout={logout} onRefresh={()=>loadDashboard(undefined, true)} onSwitchSpace={switchSpace} onSessionChanged={sessionChanged} onNotice={setNotice}/></Suspense> : dashboard ? <HomeView bootstrap={boot} dashboard={dashboard} onRefresh={()=>loadDashboard(undefined, true)} onSpaceChange={switchSpace} onLogout={boot.user ? logout : undefined}/> : loadingSpace ? <div className="admin-ui app-boot"><AppLoading text={t('正在读取空间内容…', 'Loading workspace…')}/></div> : <main className="admin-ui app-boot" id="main-content"><ProjectLogo size={48}/><h1>{boot.siteName}</h1><p>{t('当前没有可访问的公开导航。', 'No public navigation is available.')}</p><div className="admin-button-row">{!boot.user&&<Button onClick={()=>navigate('/login')}>{t('登录', 'Sign in')}</Button>}<Button variant="outline" onClick={()=>navigate('/admin')}>{t('管理面板', 'Admin')}</Button>{boot.user&&<Button variant="ghost" onClick={logout}>{t('退出登录', 'Sign out')}</Button>}</div></main>}</> : null}{notice&&<div className="admin-ui app-toast" role="status"><Check size={17}/><p>{notice}</p><Button variant="ghost" size="icon-sm" aria-label={t('关闭操作提示', 'Dismiss confirmation')} onClick={()=>setNotice('')}><X size={16}/></Button></div>}</>
}
