import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { Download, FileJson, Globe, PackageCheck, Plus, RefreshCw } from 'lucide-react'
import { ApiError, request, messageOf } from '../core/api'
import { t } from '../core/i18n'
import type { PageConfig, Space } from '../core/types'
import type { SourceInfo } from '../admin/IntegrationsPanel'
import { addPagePanel, panelContracts, resizePagePanel, type ComposerSource } from '../home/composition'
import { componentTemplateExample, templateRenderers } from './component-template-examples'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { StyledSelect } from './ui/select'
import { ErrorMessage, Field, FilePicker, Modal, handleFormInvalid } from './Shared'
import './widget-import.css'

const SourceDialog = lazy(() => import('../admin/SourceDialog'))
type TemplatePreview = {
  manifest: {
    format: 'lingshu-home-component'; manifestVersion: 1; id: string; version: string
    name: string; description?: string; license: string; homepage?: string; renderer: string
    dataSchema: { id: string; version: number }; settings: Record<string, unknown>
    layout: { width: number; height: number }
  }
  sha256: string; sourceUrl?: string
}
type Discovery = { sourceUrl: string; templates: { url: string; title?: string }[]; truncated: boolean; preview?: TemplatePreview }
type Props = {
  spaceId: string; space?: Space; canCreateSource?: boolean; config: PageConfig; sources: ComposerSource[]
  onSourcesChange?: (sources: ComposerSource[]) => void
  onApply: (config: PageConfig, id: string) => void; onClose: () => void
}
const matches = (source: ComposerSource, preview: TemplatePreview) =>
  source.schemaId === preview.manifest.dataSchema.id && (source.schemaVersion ?? 1) === preview.manifest.dataSchema.version
function templateIssue(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.status === 429) return t('服务正在读取其他资源，请稍后重试。当前地址和 JSON 已保留。', 'The server is reading another resource. Try again shortly; your URL and JSON are preserved.')
    if (cause.status === 401 || cause.status === 403) return t('当前会话无法读取此空间的模板，请检查登录状态和空间权限。输入仍然保留。', 'This session cannot review templates for this space. Check your sign-in and space permissions. Your input is preserved.')
    if (/manifestVersion/.test(cause.message)) return t('当前支持 manifestVersion 1。请更新 JSON 的模板格式，或请发布者提供兼容版本。', 'This version supports manifestVersion 1. Correct the JSON format or ask the publisher for a compatible version.')
    if (/does not advertise|No component template|discovery link/i.test(cause.message)) return t('此网页未提供可用的 Home 模板声明。请改用模板 JSON 地址、导入 JSON 文件，或参考下方网页声明示例。', 'This page does not advertise a usable Home template. Use its template JSON URL, import a JSON file, or see the page declaration example below.')
    if (/renderer|data schema/.test(cause.message)) return t('此组件类型或数据格式尚不受支持。请使用下方内置组件示例，或选择发布者提供的兼容模板。', 'This component type or data format is not supported. Use a bundled component example below or choose a compatible template from the publisher.')
    if (cause.status === 400) return t('模板格式或参数不兼容。请根据错误详情修正 JSON，再重新检查；下方提供可用示例。', 'The template format or settings are incompatible. Correct the JSON using the error details and review again; working examples are available below.')
  }
  return messageOf(cause)
}
function sourceKind(schema: string) {
  return schema === 'calendar.events' ? 'calendar-ics' : schema === 'weather.forecast' ? 'weather-open-meteo'
    : schema === 'github.traffic' ? 'github-traffic' : schema === 'navigation.collection' ? 'external-push' : 'external-json'
}

export default function WidgetImportDialog({ spaceId, space, canCreateSource = false, config, sources, onSourcesChange, onApply, onClose }: Props) {
  const [mode, setMode] = useState<'url' | 'json'>('url')
  const [url, setURL] = useState(''), [json, setJSON] = useState(''), [filename, setFilename] = useState('')
  const [preview, setPreview] = useState<TemplatePreview | null>(null), [discovery, setDiscovery] = useState<Discovery | null>(null)
  const [templateURL, setTemplateURL] = useState(''), [sourceID, setSourceID] = useState('')
  const [error, setError] = useState(''), [errorDetail, setErrorDetail] = useState(''), [busy, setBusy] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false), [sourceNotice, setSourceNotice] = useState('')
  const [updatedSources, setUpdatedSources] = useState<ComposerSource[] | null>(null)
  const [exampleRenderer, setExampleRenderer] = useState('builtin/metrics')
  const pending = useRef<AbortController | null>(null), generation = useRef(0)
  useEffect(() => () => { generation.current++; pending.current?.abort() }, [])
  const local: ComposerSource = { id: '', name: t('本地书签', 'Local bookmarks'), datasetId: 'local-navigation', schemaId: 'navigation.collection', schemaVersion: 1, enabled: true }
  const loaded = updatedSources || sources
  const available = loaded.some(source => source.datasetId === local.datasetId) ? loaded : [local, ...loaded]
  const compatible = preview ? available.filter(source => matches(source, preview)) : []
  const currentSource = compatible.find(source => source.datasetId === sourceID)
  const schemaNames: Record<string, string> = {
    'navigation.collection': t('书签', 'Bookmarks'), 'github.traffic': 'GitHub Traffic',
    'calendar.events': t('日程', 'Calendar'), 'weather.forecast': t('天气', 'Weather'),
    'metrics.summary': t('统计指标', 'Metrics'), 'status.collection': t('服务状态', 'Service status')
  }
  function stop() {
    generation.current++; pending.current?.abort(); pending.current = null; setBusy(false)
  }
  function invalidate(keepDiscovery = false) {
    stop(); setPreview(null); setSourceID(''); setError(''); setErrorDetail(''); setSourceNotice('')
    if (!keepDiscovery) { setDiscovery(null); setTemplateURL('') }
  }
  function report(cause: unknown) {
    setError(templateIssue(cause))
    setErrorDetail(cause instanceof ApiError && cause.message !== templateIssue(cause) ? cause.message : '')
  }
  function acceptPreview(value: TemplatePreview) {
    const contract = panelContracts[value.manifest.renderer]
    if (!contract || contract.schema !== value.manifest.dataSchema.id || value.manifest.dataSchema.version !== 1) throw new Error(t('此版本无法显示该组件或数据格式。请使用兼容的内置组件示例。', 'This version cannot display this component or data format. Use a compatible bundled-component example.'))
    setPreview(value)
    const matching = available.filter(source => matches(source, value))
    setSourceID(matching.length === 1 ? matching[0]!.datasetId : '')
  }
  async function readFile(file?: File) {
    invalidate(); setFilename(file?.name || ''); setJSON('')
    if (!file) return
    if (file.size > 64 * 1024) { setError(t('组件模板不能超过 64 KiB。', 'Component templates must not exceed 64 KiB.')); return }
    const current = generation.current
    try { const value = await file.text(); if (current === generation.current) setJSON(value) }
    catch (cause) { if (current === generation.current) report(cause) }
  }
  async function inspect(selectedURL?: string) {
    if (busy) return
    invalidate(!!selectedURL)
    const current = generation.current, controller = new AbortController()
    pending.current = controller; setBusy(true)
    const prefix = '/spaces/' + encodeURIComponent(spaceId) + '/component-templates/'
    try {
      if (selectedURL) {
        acceptIfCurrent(await request<TemplatePreview>(prefix + 'preview', { method: 'POST', body: { url: selectedURL }, signal: controller.signal }))
      } else if (mode === 'url') {
        const result = await request<Discovery>(prefix + 'discover', { method: 'POST', body: { url: url.trim() }, signal: controller.signal })
        if (current !== generation.current) return
        setDiscovery(result)
        if (result.preview) acceptPreview(result.preview)
        else if (!result.templates.length) throw new Error(t('网页没有可用的模板地址。请粘贴模板 JSON 地址或导入文件。', 'No usable template URL was found on the page. Paste a template JSON URL or import a file.'))
        else {
          setTemplateURL(result.templates[0]!.url)
          if (result.templates.length === 1) acceptIfCurrent(await request<TemplatePreview>(prefix + 'preview', { method: 'POST', body: { url: result.templates[0]!.url }, signal: controller.signal }))
        }
      } else {
        if (new TextEncoder().encode(json).length > 64 * 1024) throw new Error(t('组件模板不能超过 64 KiB。', 'Component templates must not exceed 64 KiB.'))
        let manifest: unknown
        try { manifest = JSON.parse(json) } catch { throw new Error(t('JSON 格式不正确。请保留双引号、检查括号与逗号，或填入下方示例后重试。', 'The JSON is invalid. Check double quotes, brackets and commas, or use an example below and try again.')) }
        acceptIfCurrent(await request<TemplatePreview>(prefix + 'preview', { method: 'POST', body: { manifest }, signal: controller.signal }))
      }
    } catch (cause) { if (current === generation.current && !controller.signal.aborted) report(cause) }
    finally { if (current === generation.current) { setBusy(false); pending.current = null } }
    function acceptIfCurrent(value: TemplatePreview) { if (current === generation.current) acceptPreview(value) }
  }
  async function refreshSources() {
    if (busy) return
    stop(); const current = generation.current, controller = new AbortController()
    pending.current = controller; setBusy(true); setError(''); setErrorDetail(''); setSourceNotice('')
    try {
      const value = await request<ComposerSource[]>('/spaces/' + encodeURIComponent(spaceId) + '/sources', { signal: controller.signal })
      if (current !== generation.current) return
      setUpdatedSources(value); onSourcesChange?.(value)
      const list = value.some(source => source.datasetId === local.datasetId) ? value : [local, ...value]
      const matching = preview ? list.filter(source => matches(source, preview)) : []
      if (!matching.some(source => source.datasetId === sourceID)) setSourceID(matching.length === 1 ? matching[0]!.datasetId : '')
      setSourceNotice(t('数据来源列表已刷新。', 'Data source list refreshed.'))
    } catch (cause) { if (current === generation.current && !controller.signal.aborted) setError(messageOf(cause)) }
    finally { if (current === generation.current) { setBusy(false); pending.current = null } }
  }
  function sourceSaved(value: SourceInfo) {
    const item: ComposerSource = { id: value.id, name: value.name, datasetId: value.datasetId, schemaId: value.schemaId, schemaVersion: value.schemaVersion, enabled: value.enabled }
    const next = [...loaded.filter(source => source.datasetId !== item.datasetId), item]
    setError(''); setErrorDetail('')
    setUpdatedSources(next); onSourcesChange?.(next); setSourceID(item.datasetId)
    setSourceNotice(t('数据来源已创建。组件仍需加入草稿并保存页面。', 'Data source created. Add the component to the draft and save the page to finish.'))
  }
  function useExample() {
    invalidate(); setMode('json'); setFilename(''); setJSON(JSON.stringify(componentTemplateExample(exampleRenderer), null, 2))
  }
  function downloadExample() {
    const content = JSON.stringify(componentTemplateExample(exampleRenderer), null, 2) + '\n'
    const href = URL.createObjectURL(new Blob([content], { type: 'application/json' })), anchor = document.createElement('a')
    anchor.href = href; anchor.download = 'lingshu-home-' + exampleRenderer.slice(8) + '.json'; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
  function apply() {
    if (!preview || busy) return
    if (!currentSource) { setError(t('请选择兼容的数据来源。', 'Choose a compatible data source.')); return }
    try {
      const manifest = preview.manifest, added = addPagePanel(config, manifest.renderer, currentSource)
      const view = added.config.views.find(value => value.id === added.id)!
      view.settings = { ...view.settings, title: manifest.name, ...manifest.settings }
      view.template = { id: manifest.id, version: manifest.version, sha256: preview.sha256, ...(preview.sourceUrl ? { sourceUrl: preview.sourceUrl } : {}) }
      const next = resizePagePanel(added.config, added.id, { w: manifest.layout.width, h: manifest.layout.height, heightMode: 'content' })
      onApply(next, added.id); onClose()
    } catch (cause) { setError(messageOf(cause)); setErrorDetail('') }
  }
  const loadingSource = <Modal title={t('添加数据来源', 'Add data source')} onClose={() => setSourceOpen(false)}><p role="status">{t('正在加载来源表单…', 'Loading the source form…')}</p></Modal>
  if (sourceOpen && space && canCreateSource && preview) return <Suspense fallback={loadingSource}><SourceDialog
    space={space} source={null} initialKind={sourceKind(preview.manifest.dataSchema.id)} requiredSchema={preview.manifest.dataSchema.id}
    contextNote={t('来源会立即保存到此空间；返回后仍保留当前模板预览和页面草稿。只有保存页面才会应用组件。', 'The source is saved to this space immediately. Your template preview and page draft will be kept when you return. The component is applied only when you save the page.')}
    onSaved={sourceSaved} onClose={() => setSourceOpen(false)} /></Suspense>

  return <Modal wide title={t('导入组件模板', 'Import a component template')} busy={busy} onClose={onClose}
    description={t('读取网页声明或 JSON，检查兼容性后连接自己的数据来源。', 'Read a page declaration or JSON, review compatibility and connect your own data source.')}>
    <div className="widget-import">
      <div className="widget-import-modes" aria-label={t('导入方式', 'Import method')}>
        <Button variant={mode === 'url' ? 'default' : 'outline'} type="button" aria-pressed={mode === 'url'} disabled={busy}
          onClick={() => { invalidate(); setMode('url') }}><Globe size={16} />{t('网页或 JSON 地址', 'Page or JSON URL')}</Button>
        <Button variant={mode === 'json' ? 'default' : 'outline'} type="button" aria-pressed={mode === 'json'} disabled={busy}
          onClick={() => { invalidate(); setMode('json') }}><FileJson size={16} />{t('JSON 模板', 'JSON template')}</Button>
      </div>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void inspect() }} onInvalid={event => handleFormInvalid(event, setError)}>
        {mode === 'url'
          ? <Field label={t('模板或发布页面地址', 'Template or publisher page URL')}
              hint={t('支持公开的 Home 模板 JSON，或在网页 head 中声明一个或多个模板的页面。', 'Use a public Home template JSON URL, or a page declaring one or more templates in its head.')}>
              <Input type="url" required maxLength={2048} value={url} disabled={busy} placeholder="https://example.org/component.json"
                onChange={event => { invalidate(); setURL(event.target.value) }} />
            </Field>
          : <>
            <Field label={t('选择模板文件', 'Choose a template file')}>
              <FilePicker accept=".json,application/json" filename={filename} disabled={busy} onFileChange={file => void readFile(file)} />
            </Field>
            <Field label={t('模板 JSON', 'Template JSON')} hint={t('也可以粘贴完整模板，最大 64 KiB。', 'You can also paste a complete template, up to 64 KiB.')}>
              <Textarea required value={json} disabled={busy} rows={7} spellCheck={false}
                onChange={event => { invalidate(); setJSON(event.target.value); setFilename('') }} />
            </Field>
          </>}
        <div className="widget-import-form-actions"><Button type="submit" variant="outline" disabled={busy}>
          {busy ? t('正在读取…', 'Reading…') : t('检查模板', 'Review template')}
        </Button>{busy && <Button type="button" variant="outline" onClick={stop}>{t('停止读取', 'Stop loading')}</Button>}</div>
      </form>
      {discovery && !discovery.preview && discovery.templates.length > 0 && <section className="widget-import-discovery" aria-label={t('网页中的模板', 'Templates on this page')}>
        <h3>{t('发现 {count} 个模板', 'Found {count} templates', { count: discovery.templates.length })}</h3>
        <p className="widget-import-note">{discovery.sourceUrl}</p>
        <Field label={t('选择网页模板', 'Choose a page template')}><StyledSelect value={templateURL} disabled={busy} onValueChange={value => { invalidate(true); setTemplateURL(value) }}
          options={discovery.templates.map((item, index) => ({ value: item.url, label: item.title ? item.title + ' · ' + item.url : t('模板 {index}', 'Template {index}', { index: index + 1 }) + ' · ' + item.url }))} /></Field>
        {discovery.truncated && <p className="widget-import-note">{t('此页面模板较多，仅显示前 8 个。也可直接填写所需模板的 JSON 地址。', 'This page contains more templates; only the first 8 are shown. You can enter the desired template JSON URL directly.')}</p>}
        <div className="widget-import-form-actions"><Button variant="outline" disabled={busy || !templateURL} onClick={() => { void inspect(templateURL) }}>{t('检查选中模板', 'Review selected template')}</Button></div>
      </section>}
      {error && <div className="widget-import-error"><ErrorMessage error={error} />
        {errorDetail && <details><summary>{t('错误详情', 'Error details')}</summary><p>{errorDetail}</p></details>}
        <p className="widget-import-note">{t('输入内容已保留。可以修改后重新检查，或使用下方示例继续。', 'Your input is preserved. Edit it and review again, or continue with an example below.')}</p>
      </div>}
      {preview && <section className="widget-import-review" aria-label={t('模板检查结果', 'Template review')}>
        <div className="widget-import-heading"><PackageCheck size={24} aria-hidden="true" /><div>
          <h3>{preview.manifest.name}</h3>{preview.manifest.description && <p>{preview.manifest.description}</p>}
        </div></div>
        <dl>
          <div><dt>{t('兼容性', 'Compatibility')}</dt><dd>{t('模板格式 v1 · 内置组件可用', 'Template format v1 · Bundled component available')}</dd></div>
          <div><dt>{t('组件类型', 'Component')}</dt><dd>{templateRenderers().find(item => item.value === preview.manifest.renderer)?.label || schemaNames[preview.manifest.dataSchema.id]}</dd></div>
          <div><dt>{t('数据格式', 'Data format')}</dt><dd><code>{preview.manifest.dataSchema.id}@{preview.manifest.dataSchema.version}</code></dd></div>
          <div><dt>{t('模板版本', 'Template version')}</dt><dd>{preview.manifest.version}</dd></div>
          <div><dt>{t('许可证', 'License')}</dt><dd>{preview.manifest.license}</dd></div>
          <div><dt>{t('来源', 'Source')}</dt><dd>{preview.sourceUrl || filename || t('粘贴的 JSON', 'Pasted JSON')}</dd></div>
        </dl>
        <p className="widget-import-note">{t('使用 Home 内置组件并随当前页面主题显示，不执行外部脚本。模板本身不会创建连接或开始采集数据。', 'Uses a component bundled with Home and the current page theme. No external scripts execute. The template itself does not create connections or start data collection.')}</p>
        {compatible.length ? <Field label={t('数据来源', 'Data source')} hint={t('{count} 个来源与此格式兼容', '{count} sources match this format', { count: compatible.length })}>
          <StyledSelect value={sourceID} disabled={busy} onValueChange={setSourceID} options={[
            { value: '', label: t('选择数据来源', 'Choose a data source') },
            ...compatible.map(source => ({ value: source.datasetId, label: (source.name || t('本地书签', 'Local bookmarks')) + (source.enabled === false ? t(' · 已停用', ' · Disabled') : '') }))
          ]} />
        </Field> : <p className="widget-import-note" role="status">{t('还没有兼容的数据来源。创建一个匹配格式的来源后，即可继续添加此模板。', 'No compatible data source is available yet. Create a source with the matching format to continue adding this template.')}</p>}
        {currentSource?.enabled === false && <p className="widget-import-note">{t('此来源已停用；组件只能显示已有快照，不会开始新的采集。可在数据来源管理中启用。', 'This source is disabled. The component can display an existing snapshot, but no new collection will start. Enable it in source management.')}</p>}
        <div className="widget-import-source-actions">
          {canCreateSource && space ? <Button type="button" variant="outline" disabled={busy} onClick={() => setSourceOpen(true)}><Plus size={15}/>{t('创建兼容来源', 'Create a compatible source')}</Button> : !compatible.length && <p className="widget-import-note">{t('请先登录有编辑权限的账号以创建来源，或在管理中心完成设置后刷新此列表。模板输入仍会保留。', 'Sign in with edit access to create a source, or configure one in admin and refresh this list. Your template input remains here.')}</p>}
          <Button type="button" variant="outline" disabled={busy} onClick={() => { void refreshSources() }}><RefreshCw size={15}/>{t('刷新数据来源', 'Refresh data sources')}</Button>
        </div>
        {sourceNotice && <p className="widget-import-note" role="status">{sourceNotice}</p>}
        <details><summary>{t('来源记录', 'Provenance record')}</summary><p>{preview.manifest.id}</p><code>{preview.sha256}</code>
          <p>{t('摘要用于记录本次模板内容，不代表作者身份或安全认证。', 'The digest records this template content; it does not certify the publisher or its safety.')}</p>
        </details>
      </section>}
      <details className="widget-import-examples">
        <summary>{t('模板示例与网页声明', 'Template examples and page declaration')}</summary>
        <div className="widget-import-example-content">
          <Field label={t('示例组件类型', 'Example component type')}><StyledSelect disabled={busy} value={exampleRenderer} onValueChange={setExampleRenderer} options={templateRenderers()}/></Field>
          <p className="widget-import-note">{t('示例只包含显示配置，不含数据来源地址、凭据或页面绑定。填入后仍需检查并选择自己的来源。', 'Examples contain display settings only, with no source URLs, credentials or page bindings. Review the example and select your own source before adding it.')}</p>
          <div className="widget-import-source-actions"><Button variant="outline" type="button" disabled={busy} onClick={useExample}><FileJson size={15}/>{t('填入示例', 'Use example')}</Button><Button variant="outline" type="button" disabled={busy} onClick={downloadExample}><Download size={15}/>{t('下载示例 JSON', 'Download example JSON')}</Button></div>
          <p className="widget-import-note">{t('在公开网页的 head 中加入以下声明，将地址改为你发布的 JSON。一个页面可声明多个模板。', 'Add this declaration to the head of a public page and replace the URL with your published JSON. A page can declare multiple templates.')}</p>
          <pre><code>{'<link rel="lingshu-home-component" href="https://example.org/component.json" title="My component">'}</code></pre>
        </div>
      </details>
      <div className="widget-import-actions"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button type="button" disabled={busy || !preview || !currentSource} onClick={apply}>{t('加入页面草稿', 'Add to page draft')}</Button>
      </div>
    </div>
  </Modal>
}
