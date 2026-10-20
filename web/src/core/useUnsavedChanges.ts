import { useEffect, useRef, useState } from 'react'
import { beforeNavigationEvent } from './navigation'

/** Only active while a page has actual unsaved changes. No storage or timer is added. */
export function useUnsavedChanges(dirty: boolean, busy = false, onDiscard?: () => void) {
  const [pending, setPending] = useState<{ run: () => void } | null>(null)
  const released = useRef(false)
  const discardDraft = useRef(onDiscard)
  discardDraft.current = onDiscard
  useEffect(() => {
    if (!dirty) { released.current = false; setPending(null); return }
    const unload = (event: BeforeUnloadEvent) => { if (!released.current) { event.preventDefault(); event.returnValue = '' } }
    const navigate = (event: Event) => {
      if (released.current) return
      const change = event as CustomEvent<{ proceed: () => void }>
      event.preventDefault()
      if (!busy) setPending({ run: change.detail.proceed })
    }
    window.addEventListener('beforeunload', unload)
    window.addEventListener(beforeNavigationEvent, navigate)
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener(beforeNavigationEvent, navigate) }
  }, [dirty, busy])
  return {
    blocked: pending !== null,
    requestLeave: (run: () => void) => { if (busy) return; if (dirty && !released.current) setPending({ run }); else run() },
    keep: () => setPending(null),
    discard: () => {
      if (busy || !pending) return
      // Clear the actual draft before starting an async action such as sign-out.
      // A subsequent route change from that action must not ask a second time.
      released.current = true
      const action = pending
      setPending(null)
      discardDraft.current?.()
      action.run()
    }
  }
}
