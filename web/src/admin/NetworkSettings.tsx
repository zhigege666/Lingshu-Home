import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Globe, Network, RefreshCw, Shield } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import type { Bootstrap, NetworkProxySettings, Settings } from '../core/types'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { ErrorMessage, Field, handleFormInvalid, Loading } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import './network-settings.css'

type Props = { bootstrap: Bootstrap; onSettingsSaved: () => Promise<void>; onNotice: (message: string) => void; onOpenAccounts: () => void }
const proxyAddressPattern = /^(https?|socks5):\/\/(\[[^\]]+\]|[^:/?#@\s]+):([0-9]+)$/i
function proxyEndpoint(value: string) {
  try { const parsed = new URL(value), match = proxyAddressPattern.exec(value); return match ? parsed.protocol + '//' + parsed.hostname.toLowerCase() + ':' + Number(match[3]) : value }
  catch { return value }
}

export default function NetworkSettings({ bootstrap, onSettingsSaved, onNotice, onOpenAccounts }: Props) {
  const owner = bootstrap.user?.role === 'Owner'
  const [settings, setSettings] = useState<Settings | null>(null)
  const [autoSelect, setAutoSelect] = useState(bootstrap.autoSelectEndpoint !== false)
  const [routingError, setRoutingError] = useState(''), [routingSaving, setRoutingSaving] = useState(false)
  const [proxy, setProxy] = useState<NetworkProxySettings | null>(null)
  const [mode, setMode] = useState<'direct' | 'proxy'>('direct'), [url, setURL] = useState('')
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [clearCredentials, setClearCredentials] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false), [proxySaving, setProxySaving] = useState(false)
  const [proxyError, setProxyError] = useState(''), [proxyConflict, setProxyConflict] = useState(false), [confirmReload, setConfirmReload] = useState(false)
  const settingsRead = useRef<AbortController | null>(null), proxyRead = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const canEditRouting = owner || !!settings && !settings.hasOwner && bootstrap.mode === 'open_edit'
  const routingDirty = !!settings && autoSelect !== (settings.autoSelectEndpoint !== false)
  const proxyDirty = !!proxy && (mode !== proxy.mode || url.trim() !== proxy.url || !!username || !!password || clearCredentials)
  const busy = routingSaving || proxySaving

  function applyProxy(value: NetworkProxySettings) {
    setProxy(value); setMode(value.mode); setURL(value.url); setUsername(''); setPassword(''); setClearCredentials(false); setProxyConflict(false)
  }
  function resetDrafts() {
    if (settings) setAutoSelect(settings.autoSelectEndpoint !== false)
    if (proxy) applyProxy(proxy)
  }
  const leaveGuard = useUnsavedChanges(routingDirty || proxyDirty, busy, resetDrafts)

  async function loadSettings() {
    settingsRead.current?.abort()
    const controller = new AbortController(); settingsRead.current = controller; setRoutingError('')
    try {
      const value = await request<Settings>('/settings', { signal: controller.signal })
      if (!controller.signal.aborted && mounted.current) { setSettings(value); setAutoSelect(value.autoSelectEndpoint !== false) }
    } catch (cause) { if (!controller.signal.aborted && mounted.current) setRoutingError(messageOf(cause)) }
  }
  async function loadProxy() {
    if (!owner) return
    proxyRead.current?.abort()
    const controller = new AbortController(); proxyRead.current = controller; setProxyLoading(true); setProxyError('')
    try {
      const value = await request<NetworkProxySettings>('/network-proxy', { signal: controller.signal })
      if (!controller.signal.aborted && mounted.current) applyProxy(value)
    } catch (cause) { if (!controller.signal.aborted && mounted.current) setProxyError(messageOf(cause)) }
    finally { if (!controller.signal.aborted && mounted.current) setProxyLoading(false) }
  }
  useEffect(() => {
    mounted.current = true
    setSettings(null); setProxy(null); setUsername(''); setPassword(''); setClearCredentials(false)
    void loadSettings(); if (owner) void loadProxy()
    return () => { mounted.current = false; settingsRead.current?.abort(); proxyRead.current?.abort(); write.current?.abort() }
  }, [bootstrap.user?.id, bootstrap.mode, owner])

  async function saveRouting(event: FormEvent) {
    event.preventDefault()
    if (!settings || !canEditRouting || busy) return
    const controller = new AbortController(); write.current = controller; setRoutingSaving(true); setRoutingError('')
    try {
      const value = await request<{ autoSelectEndpoint: boolean }>('/settings/navigation', { method: 'PUT', body: { autoSelectEndpoint: autoSelect }, signal: controller.signal })
      if (controller.signal.aborted || !mounted.current) return
      setSettings(current => current ? { ...current, autoSelectEndpoint: value.autoSelectEndpoint } : current); setAutoSelect(value.autoSelectEndpoint)
      onNotice(t('自动选路设置已保存。', 'Automatic routing settings saved.'))
      await onSettingsSaved()
    } catch (cause) { if (!controller.signal.aborted && mounted.current) setRoutingError(messageOf(cause)) }
    finally { if (!controller.signal.aborted && mounted.current) setRoutingSaving(false) }
  }

  async function saveProxy(event: FormEvent) {
    event.preventDefault()
    if (!owner || !proxy || busy || proxyLoading) return
    setProxyError(''); setProxyConflict(false)
    const address = url.trim()
    if (mode === 'proxy' && !address) { setProxyError(t('请填写代理地址。', 'Enter a proxy address.')); return }
    if (address) {
      try {
        const parsed = new URL(address)
        const match = proxyAddressPattern.exec(address)
        if (!match || !['http:', 'https:', 'socks5:'].includes(parsed.protocol) || parsed.username || parsed.password
          || Number(match[3]) < 1 || Number(match[3]) > 65535) throw new Error()
      } catch {
        setProxyError(t('代理地址须为带端口的 HTTP、HTTPS 或 SOCKS5 地址，不含用户名、密码、路径、查询或片段。', 'Use an HTTP, HTTPS or SOCKS5 proxy URL with an explicit port and no username, password, path, query or fragment.')); return
      }
    }
    if (!clearCredentials && (!!username !== !!password)) { setProxyError(t('请同时填写代理用户名和密码，或全部留空以保留已保存凭据。', 'Enter both proxy username and password, or leave both blank to keep saved credentials.')); return }
    if (new TextEncoder().encode(username).length > 255 || new TextEncoder().encode(password).length > 255) { setProxyError(t('代理用户名和密码各不能超过 255 个 UTF-8 字节。', 'Proxy username and password must each be at most 255 UTF-8 bytes.')); return }
    if (proxy.credentialConfigured && proxyEndpoint(address) !== proxyEndpoint(proxy.url) && !clearCredentials && !username) { setProxyError(t('更换代理地址时，请重新填写凭据，或勾选清除已保存凭据。', 'When changing the proxy address, enter replacement credentials or select Clear saved credentials.')); return }
    if (!address && proxy.credentialConfigured && !clearCredentials) { setProxyError(t('清空代理地址时，也请清除已保存凭据。', 'Clear saved credentials when removing the proxy address.')); return }
    if (!address && (username || password) && !clearCredentials) { setProxyError(t('请填写代理地址后再保存凭据，或清空凭据字段。', 'Enter a proxy URL before saving credentials, or clear the credential fields.')); return }
    const controller = new AbortController(); write.current = controller; setProxySaving(true)
    try {
      const value = await request<NetworkProxySettings>('/network-proxy', { method: 'PUT', signal: controller.signal, body: {
        expectedRevision: proxy.revision, mode, url: address,
        ...(clearCredentials ? { clearCredentials: true } : username && password ? { secret: { username, password } } : {})
      } })
      if (controller.signal.aborted || !mounted.current) return
      applyProxy(value); onNotice(t('服务端代理设置已保存。', 'Server proxy settings saved.'))
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        if (cause instanceof ApiError && cause.code === 'network_proxy_version_conflict') {
          setProxyConflict(true); setProxyError(t('代理配置已在其他页面更改，当前输入已保留。请重新读取已保存配置后再修改。', 'The proxy configuration changed in another page. Your input is preserved. Reload the saved configuration before editing again.'))
        } else setProxyError(messageOf(cause))
      }
    } finally { if (!controller.signal.aborted && mounted.current) setProxySaving(false) }
  }

  function reloadProxy() { if (proxyDirty) setConfirmReload(true); else void loadProxy() }

  return <div className="admin-network-settings">
    <section className="admin-card">
      <h2 className="network-section-heading"><Network size={20}/>{t('浏览器选路', 'Browser routing')}</h2>
      <p className="admin-hint">{t('为同一链接设置内网和外网访问地址，点击时选择可用入口。', 'Configure internal and external addresses for a link, then choose an available route when opening it.')}</p>
      <ErrorMessage error={routingError}/>
      {!settings ? routingError ? <Button variant="outline" onClick={() => { void loadSettings() }}><RefreshCw size={15}/>{t('重新读取设置', 'Reload settings')}</Button> : <Loading/> : <form onSubmit={saveRouting}>
        <fieldset className="admin-plain-fieldset" disabled={busy || !canEditRouting}>
          <label className="admin-check-line"><Checkbox checked={autoSelect} onCheckedChange={setAutoSelect} disabled={busy || !canEditRouting} aria-label={t('自动选择内外网入口', 'Automatically select internal or external routes')}/>{t('自动选择内外网入口', 'Automatically select internal or external routes')}</label>
          <p className="admin-hint">{t('默认开启，仅检查所点击链接中明确配置的网络入口，不会在首页加载时探测所有链接。浏览器阻止检测或未收到响应时使用外网入口；没有外网入口时使用主入口。', 'Enabled by default. Only explicitly configured network routes for the clicked link are checked; loading Home does not probe every bookmark. If the browser blocks the check or no response arrives, the external route is used, falling back to the primary URL when none is configured.')}</p>
          <p className="admin-hint">{t('跨域探测路径需允许 Home 跨域读取；不支持时会回退，仍可手动打开入口。检测响应不代表服务健康。文档、后台等附加链接不会参与自动选路。', 'Cross-origin probe paths must allow Home to read them. If unsupported, routing falls back and manual routes remain available. A response does not certify service health. Additional links such as documentation and admin pages do not participate in automatic routing.')}</p>
          {!canEditRouting && <p className="admin-info">{t('只有管理员可以修改全站自动选路设置。', 'Only the owner can change site-wide routing settings.')}</p>}
          <div className="admin-form-footer"><Button type="submit" disabled={busy || !canEditRouting || !routingDirty}>{routingSaving ? t('正在保存…', 'Saving…') : t('保存选路设置', 'Save routing settings')}</Button></div>
        </fieldset>
      </form>}
    </section>
    <section className="admin-card">
      <h2 className="network-section-heading"><Globe size={20}/>{t('服务端代理', 'Server proxy')}</h2>
      <p className="admin-hint">{t('仅影响 Home 服务器获取网页图标、组件模板和数据源。浏览器打开书签仍使用自己的网络。', 'Applies only when the Home server fetches website icons, component templates and data sources. Your browser continues opening bookmarks through its own network.')}</p>
      {!owner ? <div className="network-owner-note"><Shield size={20}/><p>{t('服务端代理只能由已登录的管理员配置。请先在站点设置中创建或登录管理员账号。', 'Server proxy settings require a signed-in owner. Create or sign in to an owner account in Site settings first.')}</p><Button variant="outline" onClick={onOpenAccounts}>{t('站点设置', 'Site settings')}</Button></div> : <>
        <ErrorMessage error={proxyError}/>
        {!proxy ? proxyLoading ? <Loading/> : <Button variant="outline" onClick={() => { void loadProxy() }}><RefreshCw size={15}/>{t('重新读取代理配置', 'Reload proxy configuration')}</Button> : <form onSubmit={saveProxy} onInvalidCapture={event => handleFormInvalid(event, setProxyError)}>
          <fieldset className="admin-plain-fieldset" disabled={busy || proxyLoading}>
            <fieldset className="admin-mode-options network-proxy-modes"><legend>{t('连接方式', 'Connection mode')}</legend>
              <label className={'admin-mode-option ' + (mode === 'direct' ? 'selected' : '')}><input type="radio" name="network-proxy-mode" value="direct" checked={mode === 'direct'} onChange={() => setMode('direct')}/><span><strong>{t('直接连接', 'Direct connection')}</strong><small>{t('默认，不使用代理', 'Default; no proxy')}</small></span></label>
              <label className={'admin-mode-option ' + (mode === 'proxy' ? 'selected' : '')}><input type="radio" name="network-proxy-mode" value="proxy" checked={mode === 'proxy'} onChange={() => setMode('proxy')}/><span><strong>{t('使用代理', 'Use proxy')}</strong><small>{t('HTTP、HTTPS 或 SOCKS5', 'HTTP, HTTPS or SOCKS5')}</small></span></label>
            </fieldset>
            <Field label={t('代理地址', 'Proxy URL')} hint={t('须显式填写端口', 'An explicit port is required')}><Input type="url" inputMode="url" required={mode === 'proxy'} maxLength={2048} value={url} onChange={event => setURL(event.target.value)} placeholder="http://127.0.0.1:7890" autoComplete="off"/></Field>
            <p className="admin-hint">{mode === 'direct' ? t('保存为直接连接后，填写的代理地址和凭据可以保留，供下次启用时使用。清空地址时也需清除原凭据。', 'Direct mode can retain the configured proxy and credentials for later use. Clear existing credentials when removing the proxy URL.') : t('代理失败时会报告错误，不会自动改为直连。保存只校验配置格式；实际获取结果见对应数据源或图标状态。', 'Proxy failures are reported without silently switching to a direct connection. Saving validates the configuration; actual fetch results appear in the relevant source or icon status.')}</p>
            <div className="admin-form-row equal">
              <Field label={t('代理用户名', 'Proxy username')} hint={t('选填', 'Optional')}><Input value={username} disabled={busy || proxyLoading || clearCredentials} maxLength={255} onChange={event => setUsername(event.target.value)} autoComplete="off"/></Field>
              <Field label={t('代理密码', 'Proxy password')} hint={t('选填', 'Optional')}><Input type="password" value={password} disabled={busy || proxyLoading || clearCredentials} maxLength={255} onChange={event => setPassword(event.target.value)} autoComplete="new-password"/></Field>
            </div>
            <p className="admin-hint">{proxy.credentialConfigured ? t('已保存代理凭据，不会回显。两个字段全部留空可保留；更换代理地址时须替换或清除旧凭据。', 'Proxy credentials are saved and never shown again. Leave both fields blank to keep them; replace or clear old credentials when changing the proxy URL.') : t('凭据只保存于服务器，不会出现在首页或返回给浏览器。', 'Credentials are stored only on the server and are never included in homepage data or returned to the browser.')}</p>
            {proxy.credentialConfigured && <label className="admin-check-line"><Checkbox checked={clearCredentials} disabled={busy || proxyLoading} onCheckedChange={checked => { setClearCredentials(checked); if (checked) { setUsername(''); setPassword('') } }} aria-label={t('清除已保存的代理凭据', 'Clear saved proxy credentials')}/>{t('清除已保存的代理凭据', 'Clear saved proxy credentials')}</label>}
            <div className="admin-form-footer">
              <Button type="button" variant="outline" disabled={busy || proxyLoading} onClick={reloadProxy}><RefreshCw size={15} className={proxyLoading ? 'admin-spin' : undefined}/>{t('重新读取代理配置', 'Reload proxy configuration')}</Button>
              <Button type="submit" disabled={busy || proxyLoading || !proxyDirty || proxyConflict}>{proxySaving ? t('正在保存…', 'Saving…') : t('保存代理设置', 'Save proxy settings')}</Button>
            </div>
          </fieldset>
        </form>}
      </>}
    </section>
    {leaveGuard.blocked && <DiscardChangesDialog onKeep={leaveGuard.keep} onDiscard={leaveGuard.discard} description={t('网络设置还没有保存。放弃后将使用之前保存的配置，未提交的凭据会被清除。', 'Network settings have not been saved. Discarding restores the saved configuration and clears credentials entered in this draft.')}/>}
    {confirmReload && <DiscardChangesDialog onKeep={() => setConfirmReload(false)} onDiscard={() => { setConfirmReload(false); if (proxy) applyProxy(proxy); void loadProxy() }} description={t('重新读取会放弃当前代理输入和未提交的凭据，浏览器选路设置的草稿会保留。', 'Reloading discards current proxy input and unsubmitted credentials. The browser-routing draft is kept.')}/>}
  </div>
}
