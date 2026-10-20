import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react'
import { createEndpointRouter, shouldInterceptEndpointClick, type EndpointRouter, type EndpointRoutingInput } from '../core/endpoint-routing'
import { t } from '../core/i18n'
import type { Bootstrap, NavLink } from '../core/types'
import { useHomeEnvironment, type HomeEndpointRouting } from './HomeEnvironment'

export function useHomeEndpointRouting(bootstrap: Bootstrap, spaceId: string, inactive: boolean, ownerWindow?: Window): HomeEndpointRouting {
  // One engine serves all navigation and favorite panels. Recreating an engine
  // after effect cleanup also keeps development StrictMode replays usable.
  const router = useMemo<EndpointRouter>(() => {
    let engine: EndpointRouter | undefined
    const current = () => engine ||= createEndpointRouter(ownerWindow ? { fetch: ownerWindow.fetch.bind(ownerWindow) } : undefined)
    return {
      peek: input => current().peek(input),
      resolve: (input, options) => current().resolve(input, options),
      clear: () => engine?.clear(),
      dispose: () => { engine?.dispose(); engine = undefined }
    }
  }, [ownerWindow])
  const enabled = bootstrap.autoSelectEndpoint !== false && !inactive
  const contextKey = [spaceId, bootstrap.user?.id || 'anonymous', bootstrap.user?.role || '', bootstrap.mode].join(':')
  useLayoutEffect(() => { router.clear() }, [router, bootstrap, spaceId, enabled])
  useEffect(() => {
    const clear = () => router.clear()
    ownerWindow?.addEventListener('online', clear); ownerWindow?.addEventListener('offline', clear)
    return () => { ownerWindow?.removeEventListener('online', clear); ownerWindow?.removeEventListener('offline', clear) }
  }, [router, ownerWindow])
  useEffect(() => () => router.dispose(), [router])
  return useMemo(() => ({ router, enabled, contextKey }), [router, enabled, contextKey])
}

function safeDestination(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
type PendingNavigation = { controller: AbortController; tab: Window; key: string }
function closePending(job: PendingNavigation | null) {
  if (!job) return
  job.controller.abort()
  try { if (!job.tab.closed) job.tab.close() } catch { /* A tab already closed by the visitor needs no cleanup. */ }
}

export function useBookmarkEndpointRouting(link: NavLink) {
  const { preview, viewportWindow, endpointRouting } = useHomeEnvironment()
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle')
  const pending = useRef<PendingNavigation | null>(null)
  const input: EndpointRoutingInput = {
    mainURL: link.url, endpoints: link.endpoints,
    enabled: !preview && endpointRouting?.enabled === true,
    contextKey: endpointRouting?.contextKey || ''
  }
  const identity = JSON.stringify([input.contextKey, input.enabled, link.id, link.url, link.endpoints])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  useEffect(() => {
    setState('idle')
    return () => { const job = pending.current; pending.current = null; closePending(job) }
  }, [identity, endpointRouting?.router])
  const href = safeDestination(endpointRouting?.router.peek(input).url || link.url)
  const cancel = () => { const job = pending.current; pending.current = null; closePending(job); setState('idle') }
  const refreshNativeHref = (event: SyntheticEvent<HTMLAnchorElement>) => {
    if (preview) return
    // Native modified/middle clicks must not reuse a render-time href after its
    // cache expires. Peeking only reads memory and never starts a probe.
    const current = safeDestination(endpointRouting?.router.peek(input).url || link.url)
    if (current) event.currentTarget.href = current
  }
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    refreshNativeHref(event)
    if (!input.enabled || !endpointRouting || !shouldInterceptEndpointClick(event) || !link.endpoints.some(endpoint => endpoint.route === 'internal' || endpoint.route === 'external')) return
    const ownerWindow = viewportWindow || event.currentTarget.ownerDocument.defaultView
    if (!ownerWindow) return
    let tab: Window | null = null
    try {
      // Open during the gesture, before waiting for the bounded route probe.
      // Drop the opener while the page is still blank, before any destination.
      tab = ownerWindow.open('about:blank', '_blank')
      if (tab) {
        tab.opener = null
        tab.document.title = t('正在选择入口…', 'Choosing a route…')
        const meta = tab.document.createElement('meta'); meta.name = 'referrer'; meta.content = 'no-referrer'; tab.document.head.append(meta)
        const status = tab.document.createElement('p'); status.textContent = t('正在选择入口，稍后自动打开。', 'Choosing a route. Your link will open shortly.')
        status.style.cssText = 'font:14px/1.6 system-ui,sans-serif;margin:32px;color:#545c65'
        tab.document.body.append(status)
      }
    } catch { try { tab?.close() } catch { /* Fall back to the ordinary anchor. */ }; return }
    // Popup blocking must still allow the anchor's native, safe fallback.
    if (!tab) return
    event.preventDefault()
    const old = pending.current; pending.current = null; closePending(old)
    const job: PendingNavigation = { controller: new AbortController(), tab, key: identity }
    pending.current = job; setState('pending')
    void endpointRouting.router.resolve(input, { signal: job.controller.signal }).then(decision => {
      if (pending.current !== job) return
      pending.current = null
      if (decision.reason === 'cancelled' || job.controller.signal.aborted || currentIdentity.current !== job.key) { closePending(job); setState('idle'); return }
      const destination = safeDestination(decision.url)
      if (!destination) { closePending(job); setState('failed'); return }
      try {
        if (!job.tab.closed) { job.tab.opener = null; job.tab.location.replace(destination) }
        setState('idle')
      } catch { closePending(job); setState('failed') }
    }).catch(() => {
      if (pending.current !== job) return
      pending.current = null; closePending(job)
      setState(currentIdentity.current === job.key ? 'failed' : 'idle')
    })
  }
  return { href, onClick, refreshNativeHref, cancel, state }
}
