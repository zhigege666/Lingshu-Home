import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ArrowRight, CheckCircle2, Database, Eye, EyeOff, HardDrive, Loader2, RefreshCw, Server, ShieldCheck } from 'lucide-react'
import { ProjectLogo } from './ProjectLogo'
import { Button } from './ui/button'
import { Input } from './ui/input'
import './storage-setup.css'

export type StorageBootstrap = {
  state: 'required' | 'ready' | 'error'
  provider?: 'sqlite' | 'postgres'
  source: 'default' | 'environment' | 'cli' | 'file' | 'legacy'
  language: '' | 'zh-CN' | 'en'
  csrfToken: string
  version: string
  error?: { code: string; message: string }
}
type StorageInput = {
  provider: 'sqlite' | 'postgres'
  postgres?: { host: string; port: number; database: string; username: string; password: string; sslMode: 'disable' | 'require' | 'verify-full' }
}
type Action = 'test' | 'configure' | 'retry' | 'check'
type Props = { bootstrap: StorageBootstrap; onReady: () => Promise<void> }
class StorageRequestError extends Error {
  constructor(readonly status: number, readonly code = '') { super('Storage request failed') }
}

export default function StorageSetup({ bootstrap, onReady }: Props) {
  const [current, setCurrent] = useState(bootstrap)
  const [provider, setProvider] = useState<'sqlite' | 'postgres'>('sqlite')
  const [host, setHost] = useState(''), [port, setPort] = useState('5432')
  const [database, setDatabase] = useState('lingshu_home'), [username, setUsername] = useState('lingshu_home')
  const [password, setPassword] = useState('')
  const [sslMode, setSSLMode] = useState<'disable' | 'require' | 'verify-full'>('require')
  const [showPassword, setShowPassword] = useState(false), [tested, setTested] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null), [error, setError] = useState('')
  const [needsCheck, setNeedsCheck] = useState(false)
  const inFlight = useRef(false), alive = useRef(true)
  const activeRequest = useRef<AbortController | null>(null), form = useRef<HTMLFormElement>(null)
  const language = current.language || bootstrap.language
  const english = language === 'en' || (!language && typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language))
  const t = (zh: string, en: string) => english ? en : zh
  const locked = busy !== null || needsCheck

  useEffect(() => { setCurrent(bootstrap) }, [bootstrap])
  useEffect(() => { alive.current = true; return () => { alive.current = false; activeRequest.current?.abort() } }, [])
  function edited(change: () => void) { change(); setTested(false); setError('') }
  function failure(cause: unknown): string {
    const code = cause instanceof StorageRequestError ? cause.code.toLowerCase() : ''
    const status = cause instanceof StorageRequestError ? cause.status : 0
    if (status === 429) return t('操作过于频繁，请稍后重试。', 'Too many attempts. Please wait and try again.')
    if (status === 401 || status === 403) return t('页面验证已失效，请重新检查状态后再试。', 'Page verification has expired. Check the current status before trying again.')
    if (status === 409) return t('存储状态已经改变，请重新检查状态。', 'Storage state has changed. Check the current status.')
    if (/auth|password|credential/.test(code)) return t('数据库认证失败，请检查用户名和密码。', 'Database authentication failed. Check the username and password.')
    if (/tls|ssl|certificate/.test(code)) return t('无法建立所选的安全连接，请检查 TLS 设置和数据库证书。', 'The selected secure connection could not be established. Check TLS settings and the database certificate.')
    if (/permission|privilege/.test(code)) return t('数据库账号权限不足，请检查此数据库的访问和建表权限。', 'The database account needs permission to access this database and create its tables.')
    if (/version|migration|schema|incompatible/.test(code)) return t('数据库结构与当前程序不兼容，请核对版本和恢复说明。', 'This database is not compatible with the application. Check its version and recovery instructions.')
    if (/lock|busy/.test(code)) return t('此存储可能正在被另一个 Home 实例使用，请检查后重试。', 'Another Home instance may be using this storage. Check it before retrying.')
    if (/write|persist|directory|config/.test(code)) return t('无法保存或读取存储配置，请检查持久化目录和文件权限。', 'The storage configuration could not be saved or read. Check the persistent directory and its permissions.')
    if (/database.*missing|database.*not.*exist/.test(code)) return t('找不到指定数据库，请先创建数据库并核对名称。', 'The specified database was not found. Create it first and check its name.')
    if (/database_not_empty/.test(code)) return t('请选择专供 Home 使用的空数据库，或已有的 Home 数据库。', 'Choose an empty database dedicated to Home, or an existing Home database.')
    if (/timeout|connect|unreachable|network/.test(code)) return t('暂时无法连接数据库，请检查地址、端口、网络以及数据库是否已启动。', 'The database could not be reached. Check its address, port, network and running state.')
    if (status === 400) return t('连接参数未通过校验，请检查填写内容和 TLS 选项。', 'The connection settings are invalid. Check the fields and TLS option.')
    return t('操作未完成，请检查连接配置后重试。', 'The operation could not be completed. Check the connection settings and try again.')
  }
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const controller = new AbortController(); activeRequest.current = controller
    const timeout = window.setTimeout(() => controller.abort(), method === 'GET' ? 12000 : 45000)
    try {
      const response = await fetch('/api/v1/storage/' + path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: method === 'GET' ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': current.csrfToken },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      })
      const value = await response.json().catch(() => null)
      if (!response.ok) throw new StorageRequestError(response.status, typeof value?.code === 'string' ? value.code : '')
      return value as T
    } catch (cause) {
      if (cause instanceof StorageRequestError) throw cause
      throw new StorageRequestError(0, 'network_error')
    } finally {
      window.clearTimeout(timeout)
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }
  function validateSnapshot(value: StorageBootstrap): StorageBootstrap {
    if (!value || !['required', 'ready', 'error'].includes(value.state)) throw new StorageRequestError(0, 'invalid_response')
    return value
  }
  async function accept(value: StorageBootstrap) {
    const next = validateSnapshot(value)
    if (!alive.current) return
    setCurrent(next); setNeedsCheck(false)
    if (next.state !== 'required') setPassword('')
    if (next.state === 'ready') {
      setError('')
      try { await onReady() }
      catch { if (alive.current) { setNeedsCheck(true); setError(t('存储已经就绪，但页面暂时未能加载。请重新检查状态。', 'Storage is ready, but the next page could not load. Check the current status.')) } }
    }
  }
  async function reconcile(cause: unknown) {
    if (!alive.current) return
    setError(failure(cause))
    try { await accept(validateSnapshot(await request<StorageBootstrap>('bootstrap'))) }
    catch { if (alive.current) { setNeedsCheck(true); setError(t('暂时无法确认是否已保存。为避免重复初始化，请先重新检查状态；你的输入仍然保留。', 'The saved state could not be confirmed. Check it before continuing to avoid repeating setup. Your input is retained.')) } }
  }
  function input(): StorageInput {
    return provider === 'sqlite' ? { provider } : { provider, postgres: { host: host.trim(), port: Number(port), database: database.trim(), username: username.trim(), password, sslMode } }
  }
  async function perform(action: Action) {
    if (inFlight.current) return
    if ((action === 'test' || action === 'configure') && !form.current?.reportValidity()) return
    if (action === 'configure' && provider === 'postgres' && !tested) { setError(t('请先测试当前连接，再保存继续。', 'Test this connection before saving.')); return }
    inFlight.current = true; setBusy(action); setError('')
    try {
      if (action === 'check') await accept(await request<StorageBootstrap>('bootstrap'))
      else if (action === 'test') {
        const result = await request<{ ok: boolean }>('test', 'POST', input())
        if (!result?.ok) throw new StorageRequestError(0, 'invalid_response')
        if (alive.current) setTested(true)
      } else await accept(await request<StorageBootstrap>(action, 'POST', action === 'configure' ? input() : {}))
    } catch (cause) {
      if (!alive.current) return
      if (action === 'configure' || action === 'retry' || cause instanceof StorageRequestError && [401, 403, 409].includes(cause.status)) await reconcile(cause)
      else { setError(failure(cause)); if (action === 'test') setTested(false); if (action === 'check') setNeedsCheck(true) }
    } finally { inFlight.current = false; if (alive.current) setBusy(null) }
  }
  function submit(event: FormEvent) { event.preventDefault(); void perform('configure') }
  const recovery = current.state !== 'required' || needsCheck
  const sourceLabel = current.source === 'environment' || current.source === 'cli' ? t('由启动配置管理', 'Managed by startup settings') : t('使用已保存的配置', 'Using saved settings')
  const recoveryMessage = error || (current.error ? failure(new StorageRequestError(503, current.error.code)) : '')

  return <main className="admin-ui storage-setup-page" id="main-content" data-testid="storage-setup" lang={english ? 'en' : 'zh-CN'}>
    <div className="storage-setup-shell">
      <div className="storage-setup-brand"><ProjectLogo size={32} /><span>Lingshu<span className="storage-setup-brand-divider">/</span>Home</span></div>
      <section className={'storage-setup-card' + (recovery ? ' storage-setup-card-recovery' : '')} aria-labelledby="storage-setup-title">
        <header className="storage-setup-heading">
          <span className="storage-setup-kicker"><Database size={15} aria-hidden="true" />{t('数据存储', 'Data storage')}</span>
          <h1 id="storage-setup-title">{recovery ? needsCheck || current.state === 'ready' ? t('确认存储状态', 'Check storage status') : t('数据存储尚未就绪', 'Storage is not ready') : t('选择数据保存方式', 'Choose where to keep your data')}</h1>
          <p>{recovery ? t('现有配置会保留。请检查数据库服务与连接，再继续。', 'Your existing settings are retained. Check the database and connection to continue.') : t('使用内置数据库即可开始，也可以连接你自己的 PostgreSQL。', 'Start with the built-in database, or connect your own PostgreSQL database.')}</p>
        </header>
        {recovery ? <div className="storage-setup-recovery">
          {current.provider && <div className="storage-setup-current"><Database size={20} aria-hidden="true" /><div><strong>{current.provider === 'postgres' ? 'PostgreSQL' : 'SQLite'}</strong><span>{sourceLabel}</span></div><ShieldCheck size={19} aria-hidden="true" /></div>}
          {recoveryMessage && <div className="storage-setup-notice storage-setup-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><p>{recoveryMessage}</p></div>}
          <p className="storage-setup-help">{t('重试会使用同一份配置。修改启动配置后，请重启 Home；已有实例不会重新选择数据库。', 'Retry uses the same settings. Restart Home after changing startup settings; an existing instance will not choose another database.')}</p>
          <div className="storage-setup-actions"><Button type="button" className="storage-setup-primary" disabled={busy !== null} onClick={() => void perform(needsCheck || current.state === 'ready' ? 'check' : 'retry')}>
            {busy ? <Loader2 className="storage-setup-spinner" size={17} aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}
            {busy ? t('正在检查…', 'Checking…') : needsCheck || current.state === 'ready' ? t('重新检查状态', 'Check status again') : t('重试连接', 'Retry connection')}
          </Button></div>
        </div> : <form ref={form} onSubmit={submit}>
          <fieldset className="storage-setup-options" disabled={locked}>
            <legend className="storage-setup-sr-only">{t('数据库类型', 'Database type')}</legend>
            <label className={'storage-setup-option' + (provider === 'sqlite' ? ' is-selected' : '')}><input type="radio" name="storage-provider" value="sqlite" checked={provider === 'sqlite'} onChange={() => edited(() => setProvider('sqlite'))} /><HardDrive size={23} aria-hidden="true" /><span><strong>{t('内置数据库', 'Built-in database')}<small className="storage-setup-recommended">{t('默认', 'Default')}</small></strong><small>{t('SQLite · 无需安装其他服务', 'SQLite · No additional service needed')}</small></span></label>
            <label className={'storage-setup-option' + (provider === 'postgres' ? ' is-selected' : '')}><input type="radio" name="storage-provider" value="postgres" checked={provider === 'postgres'} onChange={() => edited(() => setProvider('postgres'))} /><Server size={23} aria-hidden="true" /><span><strong>{t('外置数据库', 'External database')}</strong><small>{t('PostgreSQL · 使用已有数据库', 'PostgreSQL · Connect an existing database')}</small></span></label>
          </fieldset>
          {provider === 'postgres' ? <fieldset className="storage-setup-fields" disabled={locked}>
            <legend className="storage-setup-sr-only">{t('PostgreSQL 连接设置', 'PostgreSQL connection settings')}</legend>
            <label className="storage-setup-field storage-setup-host"><span>{t('数据库地址', 'Database host')}</span><Input name="storage-host" value={host} onChange={event => edited(() => setHost(event.target.value))} placeholder={t('例如 db.example.com 或内网 IP', 'db.example.com or a LAN IP')} required maxLength={253} autoComplete="off" spellCheck={false} /></label>
            <label className="storage-setup-field storage-setup-port"><span>{t('端口', 'Port')}</span><Input name="storage-port" type="number" inputMode="numeric" min={1} max={65535} step={1} value={port} onChange={event => edited(() => setPort(event.target.value))} required /></label>
            <label className="storage-setup-field"><span>{t('数据库名称', 'Database name')}</span><Input name="storage-database" value={database} onChange={event => edited(() => setDatabase(event.target.value))} required maxLength={128} autoComplete="off" spellCheck={false} /></label>
            <label className="storage-setup-field"><span>{t('用户名', 'Username')}</span><Input name="storage-username" value={username} onChange={event => edited(() => setUsername(event.target.value))} required maxLength={128} autoComplete="off" spellCheck={false} /></label>
            <div className="storage-setup-field"><label htmlFor="storage-password">{t('密码', 'Password')}</label><span className="storage-setup-password"><Input id="storage-password" name="storage-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => edited(() => setPassword(event.target.value))} maxLength={4096} autoComplete="new-password" /><button type="button" className="storage-setup-eye" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? t('隐藏密码', 'Hide password') : t('显示密码', 'Show password')} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></div>
            <label className="storage-setup-field"><span>{t('连接安全（TLS）', 'Connection security (TLS)')}</span><select name="storage-tls" value={sslMode} onChange={event => edited(() => setSSLMode(event.target.value as typeof sslMode))}>
              <option value="require">{t('加密连接，不校验证书', 'Encrypt without certificate verification')}</option><option value="verify-full">{t('验证证书与主机名', 'Verify certificate and hostname')}</option><option value="disable">{t('不加密，仅用于可信内网', 'No encryption, trusted LAN only')}</option>
            </select></label>
            <p className="storage-setup-field-note">{t('数据库需要提前创建。请填写 Home 所在机器能够访问的地址，支持内网与自定义端口。', 'Create the database first. Use an address reachable from the Home server; LAN addresses and custom ports are supported.')}</p>
            <div className="storage-setup-test-row"><Button type="button" variant="outline" className="storage-setup-test" disabled={locked} onClick={() => void perform('test')}>{busy === 'test' ? <Loader2 size={16} className="storage-setup-spinner" aria-hidden="true" /> : <Database size={16} aria-hidden="true" />}{busy === 'test' ? t('正在测试…', 'Testing…') : t('测试连接', 'Test connection')}</Button><span className={'storage-setup-test-status' + (tested ? ' is-success' : '')} role="status" aria-live="polite">{tested ? <><CheckCircle2 size={17} aria-hidden="true" />{t('连接成功，尚未保存', 'Connected; not saved yet')}</> : t('先测试连接，再保存继续。', 'Test the connection before saving.')}</span></div>
          </fieldset> : <div className="storage-setup-local-note"><ShieldCheck size={22} aria-hidden="true" /><div><strong>{t('数据保存在持久化目录', 'Data stays in the persistent directory')}</strong><p>{t('重启或升级时保留同一份目录，即可继续使用已有数据。', 'Keep the same directory when restarting or upgrading to retain your data.')}</p></div></div>}
          {error && <div className="storage-setup-notice storage-setup-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><p>{error}</p></div>}
          <div className="storage-setup-actions"><p>{t('完成后继续设置站点和账号。', 'Next, set up your site and account.')}</p><Button type="submit" className="storage-setup-primary" disabled={locked || provider === 'postgres' && !tested}>{busy === 'configure' ? <Loader2 size={17} className="storage-setup-spinner" aria-hidden="true" /> : null}{busy === 'configure' ? t('正在初始化…', 'Setting up…') : t('保存并继续', 'Save and continue')}{busy !== 'configure' && <ArrowRight size={17} aria-hidden="true" />}</Button></div>
        </form>}
      </section>
      {!language && <p className="storage-setup-language-note">{t('实例语言将在后续步骤中确定。', 'You will choose the instance language in the next step.')}</p>}
    </div>
  </main>
}
