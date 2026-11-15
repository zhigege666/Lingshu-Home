import { useRef, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { useWorkTheme } from './work-theme'

export default function WorkToolDetail({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const theme = useWorkTheme(), returningTo = useRef<HTMLElement | null>(document.activeElement as HTMLElement)
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose() }}><DialogContent aria-modal="true" className={`admin-ui work-theme work-theme-${theme} work-dialog`} data-theme={theme} showCloseButton={false} aria-describedby={undefined} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); if (returningTo.current?.isConnected) returningTo.current.focus({ preventScroll: true }) }}><DialogTitle className="sr-only">{title}</DialogTitle><div data-work-auto-detail className="work-auto-detail">{children}</div></DialogContent></Dialog>
}
