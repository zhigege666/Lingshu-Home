import { Globe, Network, Plus, Trash2 } from 'lucide-react'
import { t } from '../core/i18n'
import type { Endpoint } from '../core/types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { Field } from '../components/Shared'
import './link-endpoints-editor.css'

function routed(endpoint: Endpoint) { return endpoint.route === 'internal' || endpoint.route === 'external' }
function validProbePath(path: string) {
  return !path || path.length <= 256 && path.startsWith('/') && !path.startsWith('//') && /^[A-Za-z0-9/_.~-]+$/.test(path) && !path.split('/').some(part => part === '.' || part === '..')
}
export function endpointValidationError(endpoints: Endpoint[]): string | undefined {
  if (endpoints.length > 12) return t('网络入口和附加链接合计不能超过 12 个。', 'Network routes and additional links must total no more than 12.')
  for (const endpoint of endpoints) if (routed(endpoint) && !validProbePath(endpoint.probePath || '')) {
    return t('探测路径须以单个 / 开头，最多 256 个 ASCII 字符，只包含字母、数字、/、_、-、.、~，不能包含 . 或 .. 路径段、查询或片段。', 'A probe path must start with one slash, contain at most 256 ASCII characters using letters, numbers, /, _, -, . or ~, and have no dot segments, query or fragment.')
  }
}

export default function LinkEndpointsEditor({ value, onChange, disabled, autoSelectEndpoint }: {
  value: Endpoint[]; onChange: (value: Endpoint[]) => void; disabled: boolean; autoSelectEndpoint: boolean
}) {
  const items = value.map((endpoint, index) => ({ endpoint, index }))
  const routes = items.filter(item => routed(item.endpoint)), additional = items.filter(item => !routed(item.endpoint))
  const full = value.length >= 12
  function update(index: number, change: Partial<Endpoint>) { if (!disabled) onChange(value.map((endpoint, i) => i === index ? { ...endpoint, ...change } : endpoint)) }
  function remove(index: number) { if (!disabled) onChange(value.filter((_, i) => i !== index)) }
  function add(route?: Endpoint['route']) {
    if (disabled || full) return
    onChange([...value, { label: route === 'internal' ? t('内网', 'Internal') : route === 'external' ? t('外网', 'External') : '', url: '', ...(route ? { route, probePath: '/favicon.ico' } : {}) }])
  }
  function makeAdditional(index: number) {
    if (disabled) return
    onChange(value.map((endpoint, i) => i === index ? { label: endpoint.label, url: endpoint.url } : endpoint))
  }
  return <div className="link-endpoints-editor">
    <section className="admin-settings-section">
      <div className="admin-content-toolbar"><h3><Network size={16}/>{t('内外网访问', 'Internal and external access')}</h3><div className="admin-button-row">
        <Button type="button" variant="outline" size="sm" disabled={disabled || full} onClick={() => add('internal')}><Plus size={14}/>{t('添加内网入口', 'Add internal route')}</Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || full} onClick={() => add('external')}><Plus size={14}/>{t('添加外网入口', 'Add external route')}</Button>
      </div></div>
      <p className="admin-hint">{autoSelectEndpoint
        ? t('点击链接时优先选择有响应的内网入口，短时间内无法确认则用外网；未配置外网时回到主入口。只有这里明确配置的入口参与选择。', 'When opening the link, an internal route with a response is preferred; otherwise an external route is used after a brief check. The primary URL is the fallback when no external route is configured. Only explicitly configured routes participate.')
        : t('全站自动选路已关闭，仍可配置和手动打开这些入口。主标题将直接打开主入口。', 'Automatic routing is disabled for this site. You can still configure and open these routes manually. The main title opens the primary URL directly.')}</p>
      {routes.map(({ endpoint, index }, order) => <div className="link-route-card" data-route={endpoint.route} key={index}>
        <div className="link-route-heading"><strong>{endpoint.route === 'internal' ? <Network size={14}/> : <Globe size={14}/>}{t('网络入口 {index}', 'Network route {index}', { index: order + 1 })}</strong><div className="admin-button-row">
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => makeAdditional(index)}>{t('改为附加链接', 'Make additional link')}</Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('移除网络入口 {index}', 'Remove network route {index}', { index: order + 1 })} onClick={() => remove(index)}><Trash2 size={15}/></Button>
        </div></div>
        <div className="admin-form-row equal">
          <Field label={t('入口名称', 'Route name')}><Input required maxLength={40} value={endpoint.label} onChange={event => update(index, { label: event.target.value })}/></Field>
          <Field label={t('网络类型', 'Network type')}><StyledSelect value={endpoint.route!} disabled={disabled} onValueChange={route => update(index, { route: route as Endpoint['route'] })} options={[{ value: 'internal', label: t('内网入口', 'Internal route') }, { value: 'external', label: t('外网入口', 'External route') }]}/></Field>
        </div>
        <Field label={endpoint.route === 'internal' ? t('内网地址', 'Internal URL') : t('外网地址', 'External URL')}><Input type="url" required maxLength={2048} value={endpoint.url} placeholder={endpoint.route === 'internal' ? 'http://192.168.1.10:8080/' : 'https://example.org/'} onChange={event => update(index, { url: event.target.value })}/></Field>
        <Field label={t('探测路径', 'Probe path')} hint={t('留空使用 /favicon.ico', 'Empty uses /favicon.ico')}><Input value={endpoint.probePath || ''} maxLength={256} placeholder="/favicon.ico" autoComplete="off" aria-invalid={!validProbePath(endpoint.probePath || '') || undefined} onChange={event => update(index, { probePath: event.target.value })}/></Field>
        <p className="admin-hint">{t('只读路径，相对于此入口的站点根目录，例如 /favicon.ico 或 /healthz，不带查询或片段。跨域路径需允许 Home 跨域读取；不支持时会回退，仍可手动打开入口。收到响应不代表服务健康。', 'Use a read-only path relative to this route’s site root, such as /favicon.ico or /healthz, without a query or fragment. Cross-origin paths must allow Home to read them; otherwise routing falls back and manual routes remain available. A response does not certify service health.')}</p>
      </div>)}
    </section>
    <section className="admin-settings-section">
      <div className="admin-content-toolbar"><h3>{t('其他入口', 'Additional URLs')}</h3><Button type="button" variant="outline" size="sm" disabled={disabled || full} onClick={() => add()}><Plus size={15}/>{t('添加入口', 'Add URL')}</Button></div>
      <p className="admin-hint">{t('文档、后台、帮助等附加页面直接打开，不参与内外网自动选择。名称包含“内网”或“外网”也不会自动改变用途。', 'Additional pages such as documentation, admin and help open directly and do not participate in automatic routing. Their purpose is never inferred from the label.')}</p>
      {additional.map(({ endpoint, index }, order) => <div className="link-additional-row" key={index}>
        <Field label={t('入口 {index} 名称', 'URL {index} name', { index: order + 1 })}><Input required maxLength={40} value={endpoint.label} onChange={event => update(index, { label: event.target.value })}/></Field>
        <Field label={t('入口 URL', 'URL')}><Input required type="url" maxLength={2048} value={endpoint.url} onChange={event => update(index, { url: event.target.value })}/></Field>
        <div className="admin-button-row"><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => update(index, { route: 'internal', probePath: '/favicon.ico' })}>{t('设为网络入口', 'Use as network route')}</Button><Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('移除入口 {index}', 'Remove URL {index}', { index: order + 1 })} onClick={() => remove(index)}><Trash2 size={16}/></Button></div>
      </div>)}
    </section>
    <p className="admin-hint">{t('网络入口与附加链接合计 {count} / 12。', 'Network routes and additional links: {count} / 12.', { count: value.length })}</p>
  </div>
}
