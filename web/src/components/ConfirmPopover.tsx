import { useId, useMemo, useRef, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import './confirm-popover.css'

type Props = {
  id?: string
  kind: 'link' | 'category' | 'bulk-links' | 'source' | 'token'
  anchor: HTMLElement
  title: string
  busy?: boolean
  onClose: () => void
  getReturnFocus?: () => HTMLElement | null
  children: ReactNode
}

/** A keyboard-accessible confirmation next to an existing action button. */
export function ConfirmPopover({ id, kind, anchor, title, busy = false, onClose, getReturnFocus, children }: Props) {
  const generatedId = useId(), titleId = `${id || generatedId}-title`
  const content = useRef<HTMLDivElement>(null), restoreFocus = useRef(true)
  const virtualAnchor = useMemo(() => ({ current: anchor }), [anchor])
  return <Popover.Root open modal={false} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Popover.Anchor virtualRef={virtualAnchor}/>
    <Popover.Portal>
      <Popover.Content ref={content} id={id} role="dialog" aria-labelledby={titleId} aria-describedby={undefined} aria-busy={busy || undefined}
        className="admin-ui lh-confirm-popover" data-confirm-kind={kind} side="bottom" align="end" sideOffset={8} collisionPadding={12} sticky="always" hideWhenDetached
        onOpenAutoFocus={event => {
          event.preventDefault()
          content.current?.querySelector<HTMLButtonElement>('[data-confirm-cancel]')?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (!restoreFocus.current) return
          requestAnimationFrame(() => {
            const target = getReturnFocus?.() || (anchor.isConnected ? anchor : document.getElementById('main-content'))
            if (!target?.isConnected) return
            if (target.id === 'main-content') target.tabIndex = -1
            target.focus({ preventScroll: true })
          })
        }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault(); else restoreFocus.current = true }}
        onInteractOutside={event => {
          // Keep the trigger's own click handler in charge of toggling it.
          if (busy || event.target instanceof Node && anchor.contains(event.target)) event.preventDefault()
          else restoreFocus.current = false
        }}>
        <h2 className="lh-confirm-popover-title" id={titleId}>{title}</h2>
        <div className="lh-confirm-popover-body">{children}</div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
