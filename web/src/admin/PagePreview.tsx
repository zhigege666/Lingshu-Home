import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle, Maximize2, Monitor, RefreshCw, X } from 'lucide-react'
import { t } from '../core/i18n'
import type { Bootstrap, Dashboard, PageConfig } from '../core/types'
import { useDraftDashboard } from '../core/useDraftDashboard'
import { HomeView } from '../home/HomeView'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { StyledSelect } from '../components/ui/select'

type Source = { id: string; datasetId: string }
type Props = {
  bootstrap: Bootstrap; dashboard: Dashboard; name: string; config: PageConfig; sources: Source[];
  dirty: boolean; busy: boolean; canSave: boolean; onSave: () => void; onCancel: () => void; onClose: () => void
}
type Resolution = { id: string; width: number; height: number }
const resolutions: Resolution[] = [
  { id: '2560x1440', width: 2560, height: 1440 },
  { id: '1920x1080', width: 1920, height: 1080 },
  { id: '1600x900', width: 1600, height: 900 },
  { id: '2560x1080', width: 2560, height: 1080 }
]
const noRefresh = async () => {}
const noSpaceChange = () => {}


function PreviewFrame({ bootstrap, dashboard, resolution, onEscape }: { bootstrap: Bootstrap; dashboard: Dashboard; resolution: Resolution; onEscape?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const prepared = useRef<Document | null>(null)
  const [documentState, setDocumentState] = useState<Document | null>(null)
  const [stylesReady, setStylesReady] = useState(false)
  const [styleError, setStyleError] = useState(false)
  const [scale, setScale] = useState(.25)

  const prepare = useCallback(() => {
    const target = frame.current?.contentDocument
    if (!target?.body || prepared.current === target) return
    prepared.current = target
    setStylesReady(false); setStyleError(false)
    target.documentElement.lang = bootstrap.language
    target.head.replaceChildren()
    const base = target.createElement('base'); base.href = window.location.origin + '/'; target.head.append(base)
    const styles: Promise<boolean>[] = []
    for (const node of document.head.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]')) {
      if (node instanceof HTMLLinkElement) {
        const url = new URL(node.href, document.baseURI)
        if (url.origin !== window.location.origin) continue
        const copied = target.createElement('link'); copied.rel = 'stylesheet'; copied.href = url.href; copied.media = node.media
        styles.push(new Promise(resolve => {
          copied.addEventListener('load', () => resolve(true), { once: true })
          copied.addEventListener('error', () => resolve(false), { once: true })
        }))
        target.head.append(copied)
      } else {
        const copied = target.createElement('style'); copied.textContent = node.textContent; target.head.append(copied)
      }
    }
    const reset = target.createElement('style')
    reset.textContent = 'html,body{margin:0;min-width:0;min-height:100%;}body{background:#f4f7f5;}'
    target.head.append(reset)
    target.body.replaceChildren()
    setDocumentState(target)
    void Promise.all(styles).then(results => {
      if (frame.current?.contentDocument !== target) return
      const loaded = results.every(Boolean)
      setStyleError(!loaded); setStylesReady(loaded)
    })
  }, [bootstrap.language])

  useLayoutEffect(() => { prepare() }, [prepare])
  useLayoutEffect(() => {
    const target = stage.current
    if (!target) return
    const update = () => setScale(Math.max(.04, Math.min(1, Math.max(1, target.clientWidth - 24) / resolution.width, Math.max(1, target.clientHeight - 24) / resolution.height)))
    update()
    const observer = new ResizeObserver(update); observer.observe(target)
    return () => observer.disconnect()
  }, [resolution.width, resolution.height])
  useEffect(() => {
    if (!documentState) return
    const stopNavigation = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest?.('a')) event.preventDefault()
    }
    const stopSubmit = (event: Event) => event.preventDefault()
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !onEscape || event.defaultPrevented) return
      // An iframe menu owns its first Escape. Check the live layer as well as
      // defaultPrevented so this does not depend on native listener order.
      if (documentState.querySelector('[data-state="open"]:is([role="menu"],[role="listbox"],[role="dialog"])')) return
      event.preventDefault(); event.stopPropagation(); onEscape()
    }
    documentState.addEventListener('click', stopNavigation, true)
    documentState.addEventListener('auxclick', stopNavigation, true)
    documentState.addEventListener('submit', stopSubmit, true)
    documentState.addEventListener('keydown', escape)
    return () => {
      documentState.removeEventListener('click', stopNavigation, true)
      documentState.removeEventListener('auxclick', stopNavigation, true)
      documentState.removeEventListener('submit', stopSubmit, true)
      documentState.removeEventListener('keydown', escape)
    }
  }, [documentState, onEscape])

  return <div ref={stage} className="admin-preview-stage" aria-busy={!stylesReady && !styleError}>
    <div className="admin-preview-scaled-frame" style={{ width: resolution.width * scale, height: resolution.height * scale }}>
      <iframe ref={frame} src="about:blank" sandbox="allow-same-origin" onLoad={prepare}
        title={t('首页预览，{width} × {height}', 'Homepage preview, {width} × {height}', { width: resolution.width, height: resolution.height })}
        width={resolution.width} height={resolution.height}
        style={{ width: resolution.width, height: resolution.height, transform: 'scale(' + scale + ')', visibility: stylesReady ? 'visible' : 'hidden' }} />
    </div>
    {!stylesReady && <div className="admin-preview-frame-status" role="status">
      {!styleError && <LoaderCircle size={18} className="admin-spin" aria-hidden="true" />}
      <span>{styleError ? t('预览样式暂时无法载入，请关闭后重新打开。', 'Preview styles could not load. Close and reopen the preview.')
        : t('正在准备预览…', 'Preparing preview…')}</span>
    </div>}
    {documentState && stylesReady && createPortal(<HomeView bootstrap={bootstrap} dashboard={dashboard} onRefresh={noRefresh} onSpaceChange={noSpaceChange}
      preview viewportWindow={frame.current?.contentWindow || undefined} />, documentState.body)}
  </div>
}

export function PagePreview({ bootstrap, dashboard, name, config, sources, dirty, busy, canSave, onSave, onCancel, onClose }: Props) {
  const [resolutionId, setResolutionId] = useState(resolutions[0]!.id)
  const [expanded, setExpanded] = useState(false)
  const resolution = resolutions.find(item => item.id === resolutionId) || resolutions[0]!
  const { preview, loading, incomplete, failed, retry } = useDraftDashboard(dashboard, name, config, sources)
  const restoreFocus = useRef<HTMLButtonElement>(null)
  const status = dirty ? t('未保存草稿', 'Unsaved draft') : t('已保存配置', 'Saved configuration')
  const controls = <div className="admin-preview-controls">
    <StyledSelect aria-label={t('预览分辨率', 'Preview resolution')} value={resolutionId} onValueChange={setResolutionId}
      options={resolutions.map(item => ({ value: item.id, label: item.width + ' × ' + item.height }))} />
    <span className={'admin-preview-status' + (dirty ? ' is-dirty' : '')} role="status">{status}</span>
  </div>
  const dataStatus = loading ? <p className="admin-preview-data-status" role="status"><LoaderCircle size={14} className="admin-spin" />{t('正在读取预览数据…', 'Loading preview data…')}</p>
    : incomplete ? <div className="admin-preview-data-status"><p>{t('部分积木的数据尚未就绪，已读取的内容继续显示。', 'Some panel data is unavailable. Loaded content remains visible.')}</p>
      {failed && <Button type="button" variant="ghost" size="sm" onClick={retry}><RefreshCw size={13} />{t('重试', 'Retry')}</Button>}</div> : null

  return <aside className="admin-page-preview" aria-label={t('首页预览', 'Homepage preview')}>
    <header><h3><Monitor size={16} />{t('首页预览', 'Homepage preview')}</h3><span className="grow" />
      <Button ref={restoreFocus} type="button" variant="ghost" size="icon-sm" aria-label={t('放大预览', 'Enlarge preview')} onClick={() => setExpanded(true)}><Maximize2 size={16} /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('关闭预览', 'Close preview')} onClick={onClose}><X size={16} /></Button>
    </header>
    {!expanded ? <>{controls}{dataStatus}<PreviewFrame bootstrap={bootstrap} dashboard={preview} resolution={resolution} />
      <p className="admin-preview-caption">{t('按所选屏幕尺寸实时渲染当前草稿。', 'Renders the current draft at the selected screen size.')}</p></>
      : <div className="admin-preview-expanded-placeholder"><Monitor size={30} /><p>{t('预览已放大', 'Preview is enlarged')}</p><Button type="button" variant="outline" onClick={() => setExpanded(false)}>{t('返回此处', 'Return here')}</Button></div>}
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogContent className="admin-ui admin-preview-dialog" showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus.current?.focus() }}>
        <DialogHeader><DialogTitle>{t('首页预览', 'Homepage preview')}</DialogTitle><DialogDescription>{t('预览随当前草稿变化，保存后才会更新首页。', 'The preview follows the current draft. Save to update the homepage.')}</DialogDescription></DialogHeader>
        <Button type="button" className="admin-preview-dialog-close" variant="ghost" size="icon-sm" aria-label={t('返回编辑', 'Return to editing')} onClick={() => setExpanded(false)}><X size={18} /></Button>
        {controls}{dataStatus}
        <PreviewFrame bootstrap={bootstrap} dashboard={preview} resolution={resolution} onEscape={() => setExpanded(false)} />
        <footer className="admin-preview-dialog-footer"><span className={'admin-preview-status' + (dirty ? ' is-dirty' : '')}>{status}</span><span className="grow" />
          <Button type="button" variant="outline" onClick={() => setExpanded(false)}>{t('返回编辑', 'Return to editing')}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t('取消更改', 'Cancel changes')}</Button>
          <Button type="button" disabled={busy || !canSave} onClick={() => { setExpanded(false); requestAnimationFrame(onSave) }}>{busy ? t('正在保存…', 'Saving…') : t('保存页面', 'Save page')}</Button>
        </footer>
      </DialogContent>
    </Dialog>
  </aside>
}
