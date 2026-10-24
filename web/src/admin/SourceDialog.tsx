import { useMemo, useState, type FormEvent } from 'react'
import { getLocale, t } from '../core/i18n'
import { messageOf, request } from '../core/api'
import type { Space } from '../core/types'
import type { SourceInfo } from './IntegrationsPanel'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Checkbox } from '../components/ui/checkbox'
import { StyledSelect } from '../components/ui/select'
import { ErrorMessage, Field, Modal, handleFormInvalid } from '../components/Shared'
import { sourceExample } from './source-examples'

export const sourceSchemas = () => [
  { value: 'navigation.collection', label: t('导航书签', 'Bookmarks') },
  { value: 'calendar.events', label: t('日程', 'Calendar') },
  { value: 'weather.forecast', label: t('天气', 'Weather') },
  { value: 'metrics.summary', label: t('统计指标', 'Metrics') },
  { value: 'status.collection', label: t('服务状态', 'Service status') }
]
const sourceKinds = () => [
  { value: 'calendar-ics', label: t('日程 · ICS 订阅', 'Calendar · ICS subscription') },
  { value: 'weather-open-meteo', label: t('天气 · Open-Meteo', 'Weather · Open-Meteo') },
  { value: 'external-json', label: t('外部 API · 定时读取 JSON', 'External API · Read JSON periodically') },
  { value: 'external-push', label: t('外部推送 / 日程文件导入', 'External push / Calendar file import') },
  { value: 'github-traffic', label: t('GitHub Traffic · 仓库流量', 'GitHub Traffic · Repository traffic') }
]
export function sourceKindLabel(kind: string) { return sourceKinds().find(value => value.value === kind)?.label || kind }
const defaultInterval = (kind: string) => kind === 'github-traffic' ? 21600 : kind === 'calendar-ics' ? 900 : kind === 'weather-open-meteo' ? 1800 : 60
const defaultTimezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || (getLocale() === 'zh-CN' ? 'Asia/Shanghai' : 'UTC') } catch { return 'UTC' } }
const cities = () => [
  { value: 'shanghai', label: t('上海', 'Shanghai'), latitude: '31.2304', longitude: '121.4737', timezone: 'Asia/Shanghai' },
  { value: 'beijing', label: t('北京', 'Beijing'), latitude: '39.9042', longitude: '116.4074', timezone: 'Asia/Shanghai' },
  { value: 'macau', label: t('澳门', 'Macau'), latitude: '22.1987', longitude: '113.5439', timezone: 'Asia/Macau' },
  { value: 'hong-kong', label: t('香港', 'Hong Kong'), latitude: '22.3193', longitude: '114.1694', timezone: 'Asia/Hong_Kong' },
  { value: 'london', label: t('伦敦', 'London'), latitude: '51.5074', longitude: '-0.1278', timezone: 'Europe/London' },
  { value: 'new-york', label: t('纽约', 'New York'), latitude: '40.7128', longitude: '-74.0060', timezone: 'America/New_York' },
  { value: 'san-francisco', label: t('旧金山', 'San Francisco'), latitude: '37.7749', longitude: '-122.4194', timezone: 'America/Los_Angeles' }
]
export default function SourceDialog({ space, source, onSaved, onClose, initialKind = 'external-push', initialSchema = 'navigation.collection', requiredSchema, contextNote }: { space: Space; source: SourceInfo | null; onSaved: (source: SourceInfo) => Promise<void> | void; onClose: () => void; initialKind?: string; initialSchema?: string; requiredSchema?: string; contextNote?: string }) {
  const [kind, setKind] = useState(source?.kind || initialKind), [name, setName] = useState(source?.name || '')
  const [schema, setSchema] = useState(source?.schemaId || requiredSchema || initialSchema), [enabled, setEnabled] = useState(source?.enabled ?? true)
  const [owner, setOwner] = useState(source?.connection.owner || ''), [repo, setRepo] = useState(source?.connection.repo || '')
  const [zone, setZone] = useState(source?.connection.timezone || defaultTimezone()), [url, setURL] = useState(''), [token, setToken] = useState(''), [bearer, setBearer] = useState(''), [apiKey, setAPIKey] = useState('')
  const [clearBearer, setClearBearer] = useState(false)
  const [latitude, setLatitude] = useState(source?.connection.latitude || ''), [longitude, setLongitude] = useState(source?.connection.longitude || '')
  const [locationName, setLocationName] = useState(source?.connection.locationName || ''), [city, setCity] = useState('custom')
  const [provider, setProvider] = useState(source?.connection.provider || 'open-meteo'), [forecastDays, setForecastDays] = useState(source?.connection.forecastDays || '5')
  const [pastDays, setPastDays] = useState(source?.connection.pastDays || '1'), [futureDays, setFutureDays] = useState(source?.connection.futureDays || '30')
  const [allowPrivate, setAllowPrivate] = useState(source?.connection.allowPrivateNetwork === 'true')
  const [interval, setIntervalValue] = useState(String(source?.sync.intervalSeconds || defaultInterval(kind)))
  const [staleAfter, setStaleAfter] = useState(String(source?.sync.staleAfterSeconds || (kind === 'external-push' ? 86400 : defaultInterval(kind) * 2)))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const isCalendar = kind === 'calendar-ics' || kind === 'external-push' && schema === 'calendar.events' || kind === 'external-json' && schema === 'calendar.events'
  const selectedSchema = kind === 'calendar-ics' ? 'calendar.events' : kind === 'weather-open-meteo' ? 'weather.forecast' : kind === 'github-traffic' ? 'github.traffic' : schema
  const exampleData = useMemo(() => JSON.stringify(sourceExample(selectedSchema), null, 2), [selectedSchema])
  const availableKinds = sourceKinds().filter(item => !requiredSchema || (item.value === 'calendar-ics' ? requiredSchema === 'calendar.events'
    : item.value === 'weather-open-meteo' ? requiredSchema === 'weather.forecast'
    : item.value === 'github-traffic' ? requiredSchema === 'github.traffic'
    : item.value === 'external-json' ? !['navigation.collection', 'github.traffic'].includes(requiredSchema)
    : requiredSchema !== 'github.traffic'))
  const secretHint = source?.credentialConfigured ? t('留空保留已保存的值；不会回显。', 'Leave blank to keep the saved value; it is never displayed again.') : t('只保存于服务器，不会出现在首页数据中。', 'Stored only on the server; never included in homepage data.')
  function changeKind(value: string) {
    setKind(value); setURL(''); setToken(''); setBearer(''); setClearBearer(false); setAPIKey(''); setAllowPrivate(false); setError('')
    if (value === 'external-json' && schema === 'navigation.collection') setSchema('metrics.summary')
    setIntervalValue(String(defaultInterval(value))); setStaleAfter(String(value === 'external-push' ? 86400 : defaultInterval(value) * 2))
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    if (requiredSchema && selectedSchema !== requiredSchema) { setError(t('请选择与当前模板匹配的数据格式。', 'Choose the data format required by this template.')); return }
    if (['calendar-ics', 'weather-open-meteo'].includes(kind)) {
      try { new Intl.DateTimeFormat('en', { timeZone: zone }).format() } catch { setError(t('请填写有效的 IANA 时区，例如 Asia/Shanghai。', 'Enter a valid IANA time zone, for example Asia/Shanghai.')); return }
    }
    if (kind === 'calendar-ics' && Number(pastDays) + Number(futureDays) > 90) { setError(t('过去与未来的日程范围合计不能超过 90 天。', 'The combined past and future calendar range must not exceed 90 days.')); return }
    if (url) { try { const address = new URL(url); if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error() } catch { setError(t('请填写不含用户名或密码的 HTTP/HTTPS 地址。', 'Enter an HTTP/HTTPS URL without an embedded username or password.')); return } }
    const connection: Record<string, string> = kind === 'github-traffic' ? { owner: owner.trim(), repo: repo.trim() }
      : kind === 'calendar-ics' ? { timezone: zone.trim(), pastDays: String(Number(pastDays)), futureDays: String(Number(futureDays)), allowPrivateNetwork: String(allowPrivate) }
      : kind === 'weather-open-meteo' ? { latitude, longitude, timezone: zone.trim(), forecastDays, provider, locationName: locationName.trim() }
      : kind === 'external-json' ? { schemaId: selectedSchema, schemaVersion: '1', allowPrivateNetwork: String(allowPrivate) } : {}
    const secret: Record<string, string | boolean> = {}
    if (kind === 'github-traffic' && token) secret.token = token
    if (['calendar-ics', 'external-json'].includes(kind) && url) secret.url = url.trim()
    if (kind === 'external-json' && clearBearer) secret.clearBearerToken = true
    else if (kind === 'external-json' && bearer) secret.bearerToken = bearer
    if (kind === 'weather-open-meteo' && provider === 'open-meteo-commercial' && apiKey) secret.apiKey = apiKey
    const config = { name: name.trim(), enabled, connection, sync: { mode: kind === 'external-push' ? 'push' : 'poll', ...(kind !== 'external-push' ? { intervalSeconds: Number(interval) } : {}), staleAfterSeconds: Number(staleAfter) }, ...(Object.keys(secret).length ? { secret } : {}) }
    setBusy(true)
    try {
      const result = await request<SourceInfo>(source ? `/sources/${source.id}` : `/spaces/${space.id}/sources`, { method: source ? 'PUT' : 'POST', body: source ? { ...config, expectedConfigRevision: source.configRevision } : { ...config, kind, schemaId: selectedSchema, schemaVersion: 1 } })
      setURL(''); setToken(''); setBearer(''); setClearBearer(false); setAPIKey(''); await onSaved(result); onClose()
    } catch (cause) { setError(messageOf(cause)) } finally { setBusy(false) }
  }
  return <Modal wide title={source ? t('编辑数据来源', 'Edit data source') : t('添加数据来源', 'Add data source')} description={t('所属空间：{name}', 'Space: {name}', { name: space.name })} busy={busy} onClose={onClose}>
    {contextNote && <p className="admin-info">{contextNote}</p>}
    <form onSubmit={save} onInvalid={event => handleFormInvalid(event, setError)}><fieldset disabled={busy} className="admin-plain-fieldset">
      <div className="admin-form-row equal"><Field label={t('名称', 'Name')}><Input required autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></Field><Field label={t('数据来源类型', 'Source type')}><StyledSelect disabled={!!source || busy} value={kind} onValueChange={changeKind} options={availableKinds} /></Field></div>
      {['external-push', 'external-json'].includes(kind) && <>
        <Field label={t('组件数据格式', 'Component data format')} hint={source ? t('已创建来源的数据格式不能更改。', 'An existing source’s data format cannot be changed.') : requiredSchema ? t('已按当前组件模板选择兼容格式。', 'The compatible format is selected for the current component template.') : t('选择 Home 已支持的内置格式；此处不能新增格式。', 'Choose a format built into Home; new formats cannot be added here.')}><StyledSelect value={schema} disabled={!!source || !!requiredSchema || busy} onValueChange={setSchema} options={sourceSchemas().filter(item => kind !== 'external-json' || item.value !== 'navigation.collection')} /></Field>
        <details className="admin-source-example">
          <summary>{t('查看数据格式示例', 'View data format example')}</summary>
          <p>{kind === 'external-push'
            ? t('下面是快照中的 data 内容。创建来源后，在列表点击“推送模板”获取完整请求，再将来源绑定到首页的对应组件。', 'This is the snapshot’s data content. After creating the source, choose Push template in the list for the full request, then bind the source to the matching homepage component.')
            : t('外部 API 需返回下面结构的 JSON 对象。保存来源后，将它绑定到首页的对应组件。', 'The external API must return a JSON object with this structure. After saving the source, bind it to the matching homepage component.')}</p>
          <pre className="admin-code-block" tabIndex={0} aria-label={t('数据格式 JSON 示例', 'Data format JSON example')}>{exampleData}</pre>
        </details>
      </>}
      {isCalendar && space.kind === 'shared' && space.published && <p className="admin-info">{t('日程内容将按此空间的访问权限展示；私人日程请使用个人空间。订阅地址始终保存在服务器。', 'Calendar content follows this space’s access permissions. Use a personal space for private calendars. Subscription URLs remain on the server.')}</p>}
      {kind === 'github-traffic' && <><div className="admin-form-row equal"><Field label={t('仓库所有者', 'Repository owner')}><Input required value={owner} onChange={event => setOwner(event.target.value)} /></Field><Field label={t('仓库名称', 'Repository name')}><Input required value={repo} onChange={event => setRepo(event.target.value)} /></Field></div><Field label={t('GitHub 访问令牌', 'GitHub access token')} hint={secretHint}><Input type="password" autoComplete="new-password" required={!source?.credentialConfigured} value={token} onChange={event => setToken(event.target.value)} /></Field><p className="admin-hint">{t('为指定仓库授予 Administration 只读权限。首次成功采集会保留不可覆盖的流量基线。', 'Grant read-only Administration permission for this repository. The first successful collection preserves an immutable traffic baseline.')}</p></>}
      {['calendar-ics', 'external-json'].includes(kind) && <><Field label={kind === 'calendar-ics' ? t('ICS 订阅地址', 'ICS subscription URL') : t('JSON 数据地址', 'JSON data URL')} hint={secretHint}><Input type="password" autoComplete="new-password" required={!source?.credentialConfigured} maxLength={2048} value={url} onChange={event => setURL(event.target.value)} placeholder="https://…" /></Field>{kind === 'external-json' && <><Field label={t('Bearer 访问令牌', 'Bearer access token')} hint={t('选填；留空保留已有令牌。更换数据地址的协议、主机或端口时，请填写新令牌或明确清除旧令牌。', 'Optional; leave blank to retain the saved token. When changing the URL scheme, host or port, provide a new token or explicitly clear the old one.')}><Input type="password" autoComplete="new-password" value={bearer} disabled={busy || clearBearer} onChange={event => setBearer(event.target.value)} /></Field>{source && <label className="admin-check-line"><Checkbox checked={clearBearer} disabled={busy} onCheckedChange={value => { setClearBearer(value); if (value) setBearer('') }} /><span>{t('清除已保存的 Bearer 凭据', 'Clear the saved Bearer credential')}</span></label>}</>}<label className="admin-check-line"><Checkbox checked={allowPrivate} onCheckedChange={setAllowPrivate} /><span>{t('允许读取内网地址', 'Allow private network addresses')}</span></label></>}
      {kind === 'calendar-ics' && <><Field label={t('默认时区', 'Default time zone')} hint={t('用于没有时区标记的事件，不改变原有带时区事件。', 'Used for events without a time zone; events with their own zone keep it.')}><Input required maxLength={80} value={zone} onChange={event => setZone(event.target.value)} placeholder="Asia/Shanghai" /></Field><div className="admin-form-row equal"><Field label={t('保留过去天数', 'Past days')}><Input type="number" required min={0} max={30} step={1} value={pastDays} onChange={event => setPastDays(event.target.value)} /></Field><Field label={t('读取未来天数', 'Future days')}><Input type="number" required min={1} max={90} step={1} value={futureDays} onChange={event => setFutureDays(event.target.value)} /></Field></div></>}
      {kind === 'weather-open-meteo' && <><Field label={t('天气地点', 'Weather location')} hint={t('手动选择地点；不会自动定位或请求城市搜索。', 'Choose a location manually; no automatic location or city search requests.')}><StyledSelect value={city} onValueChange={value => { setCity(value); const selected = cities().find(item => item.value === value); if (selected) { setLatitude(selected.latitude); setLongitude(selected.longitude); setZone(selected.timezone); setLocationName(selected.label) } }} options={[{ value: 'custom', label: t('自定义经纬度', 'Custom coordinates') }, ...cities().map(({ value, label }) => ({ value, label }))]} /></Field><div className="admin-form-row equal"><Field label={t('地点名称', 'Location name')}><Input maxLength={80} value={locationName} onChange={event => setLocationName(event.target.value)} /></Field><Field label={t('时区', 'Time zone')}><Input required value={zone} maxLength={80} onChange={event => setZone(event.target.value)} /></Field></div><div className="admin-form-row equal"><Field label={t('纬度', 'Latitude')}><Input type="number" step="any" min={-90} max={90} required value={latitude} onChange={event => { setLatitude(event.target.value); setCity('custom') }} /></Field><Field label={t('经度', 'Longitude')}><Input type="number" step="any" min={-180} max={180} required value={longitude} onChange={event => { setLongitude(event.target.value); setCity('custom') }} /></Field></div><div className="admin-form-row equal"><Field label={t('预报天数', 'Forecast days')}><StyledSelect value={forecastDays} onValueChange={setForecastDays} options={[1, 2, 3, 4, 5, 6, 7].map(value => ({ value: String(value), label: t('{value} 天', '{value} days', { value }) }))} /></Field><Field label={t('Open-Meteo 服务', 'Open-Meteo service')}><StyledSelect value={provider} onValueChange={setProvider} options={[{ value: 'open-meteo', label: t('非商业服务', 'Non-commercial service') }, { value: 'open-meteo-commercial', label: t('商业订阅', 'Commercial subscription') }]} /></Field></div>{provider === 'open-meteo-commercial' && <Field label={t('API 密钥', 'API key')} hint={secretHint}><Input type="password" autoComplete="new-password" required={!source?.credentialConfigured} value={apiKey} onChange={event => setAPIKey(event.target.value)} /></Field>}<p className="admin-hint">{t('温度使用 °C，风速使用 km/h；页面保留数据来源与署名。请按 Open-Meteo 的服务条件选择用途。', 'Uses °C and km/h and preserves provider attribution. Choose the service appropriate to your use under Open-Meteo’s terms.')}</p></>}
      {kind === 'external-push' && <p className="admin-hint">{schema === 'calendar.events' ? t('创建后可以导入 ICS 文件，或使用限定此来源的访问令牌推送日程快照。', 'After creating the source, import an ICS file or push calendar snapshots using a token scoped to this source.') : t('外部系统提交完整快照，独立于本地书签。创建后可复制对应格式的推送模板。', 'External systems submit complete snapshots independently of local bookmarks. A matching push template is available after creation.')}</p>}
      {kind === 'external-json' && <p className="admin-hint">{t('API 返回所选格式的规范化 data 对象；首次成功后组件读取已保存快照，上游失败保留最近成功数据。', 'The API returns a normalized data object in the selected format. Components use the saved snapshot; upstream failures retain the last successful data.')}</p>}
      <div className="admin-form-row equal">{kind !== 'external-push' && <Field label={t('采集间隔（秒）', 'Collection interval (seconds)')}><Input type="number" required min={kind === 'external-json' ? 30 : kind === 'weather-open-meteo' ? 900 : 300} max={604800} step={1} value={interval} onChange={event => setIntervalValue(event.target.value)} /></Field>}<Field label={t('过期提醒阈值（秒）', 'Stale threshold (seconds)')} hint={t('超过此时间仍显示最近快照，并标记过期。', 'Older snapshots remain visible and are marked stale.')}><Input type="number" required min={60} max={2592000} step={1} value={staleAfter} onChange={event => setStaleAfter(event.target.value)} /></Field></div>
      <label className="admin-check-line"><Checkbox checked={enabled} onCheckedChange={setEnabled} /><span>{t('启用数据来源', 'Enable this source')}</span></label><ErrorMessage error={error} />
      <div className="admin-form-footer"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button><Button type="submit" disabled={busy}>{busy ? t('正在保存…', 'Saving…') : source ? t('保存配置', 'Save configuration') : t('创建数据来源', 'Create source')}</Button></div>
    </fieldset></form>
  </Modal>
}
