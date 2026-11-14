import { useEffect, useState, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { useWorkTheme } from './work-theme'

export default function WorkToolDetail({ title, busy, onClose, children, forceDrawer = false }: { title: string; busy: boolean; forceDrawer?: boolean; onClose: () => void; children: ReactNode }) {
  const theme = useWorkTheme(), [wide, setWide] = useState(() => matchMedia('(min-width:2200px)').matches)
  useEffect(() => { const media = matchMedia('(min-width:2200px)'), changed = () => setWide(media.matches); media.addEventListener('change', changed); return () => media.removeEventListener('change', changed) }, [])
  return wide && !forceDrawer ? <aside data-work-auto-detail className="work-auto-detail" aria-label={title}>{children}</aside> : <Dialog open onOpenChange={value => { if (!value && !busy) onClose() }}><DialogContent className={`admin-ui work-theme work-theme-${theme} work-drawer`} data-theme={theme} showCloseButton={false} aria-describedby={undefined} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}><DialogTitle className="sr-only">{title}</DialogTitle><div data-work-auto-detail className="work-auto-detail">{children}</div></DialogContent></Dialog>
}
