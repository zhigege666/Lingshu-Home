import { useEffect, useRef } from 'react'

type Options = { enabled: boolean; undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean; ownerWindow?: Window }
export function useHistoryShortcuts(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const ownerWindow = options.ownerWindow || window
  useEffect(() => {
    if (!options.enabled) return
    const keydown = (event: KeyboardEvent) => {
      const current = latest.current
      if (!current.enabled || event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      const redo = key === 'z' && event.shiftKey || key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey
      if (key !== 'z' && !redo) return
      const target = event.target as Element | null
      if (target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="spinbutton"]')) return
      if ([...ownerWindow.document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(dialog => dialog.getClientRects().length)) return
      event.preventDefault()
      if (redo ? current.canRedo : current.canUndo) (redo ? current.redo : current.undo)()
    }
    ownerWindow.addEventListener('keydown', keydown)
    return () => ownerWindow.removeEventListener('keydown', keydown)
  }, [options.enabled, ownerWindow])
}
