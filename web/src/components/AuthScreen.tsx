import { getLocale, t } from '../core/i18n'
import { ProjectLogo } from './ProjectLogo'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { ApiError, request, messageOf } from '../core/api'
import type { AuthMode, Bootstrap } from '../core/types'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Checkbox } from './ui/checkbox'
import { StyledSelect } from './ui/select'
import { authModes, BuiltinIcon, ErrorMessage, Field, handleFormInvalid } from './Shared'

type Props = {
  bootstrap: Bootstrap
  onComplete: (preferShared?: boolean) => Promise<void>
  onRecheckSetup: () => Promise<boolean>
  onBrowse: () => void
}
type StarterPack = { id: string; version: string; name: string; groups: { name: string; links: { title: string; url: string }[] }[] }

function authError(cause: unknown, setup: boolean): string {
  if (cause instanceof ApiError) {
    if (cause.status === 429) return t('操作过于频繁，请稍后再试。', 'Too many attempts. Please wait before trying again.')
    if (setup && cause.status === 409) return t('初始化状态可能已经改变。请重新检查状态，再决定下一步。', 'The setup state may have changed. Check its status before continuing.')
    if (setup && [401, 403].includes(cause.status)) return t('页面验证已失效。请重新检查初始化状态后再试。', 'Page verification has expired. Check the setup status before trying again.')
    if (!setup && cause.status === 401) return t('用户名或密码不正确，或该账号当前不可用。', 'The username or password is incorrect, or this account is currently unavailable.')
    if (cause.message.startsWith('Username must use')) return t('用户名需为 3–40 位英文字母、数字或 . _ -。', 'Use 3–40 ASCII letters, numbers, or . _ - for the username.')
    if (cause.message.startsWith('Password must contain')) return t('密码需包含 10–128 个字符，且不能全部为空白。', 'Use a password of 10–128 characters that is not entirely whitespace.')
    if (cause.message.startsWith('siteName ')) return t('请填写 1–80 个字符的站点名称。', 'Enter a site name of 1–80 characters.')
    if (cause.message.startsWith('displayName ')) return t('显示名称最多 80 个字符，请移除无效字符。', 'Use no more than 80 characters for the display name and remove invalid characters.')
    if (cause.message === 'That username already exists.') return t('该用户名已被使用，请选择其他用户名。', 'That username is already in use. Choose another one.')
    if (setup && cause.message.startsWith('Unknown starter content pack')) return t('所选示例内容包不可用，请重新选择。', 'The selected example collection is unavailable. Choose another one.')
  }
  if (cause instanceof TypeError) return t('暂时无法连接 Home，请检查连接后重试。', 'Home could not be reached. Check the connection and try again.')
  return messageOf(cause)
}

export default function AuthScreen({ bootstrap, onComplete, onRecheckSetup, onBrowse }: Props) {
  const setup = !bootstrap.initialized
  const [registering, setRegistering] = useState(false)
  const [siteName, setSiteName] = useState(bootstrap.siteName || 'Lingshu-Home')
  const [mode, setMode] = useState<AuthMode>('public_read')
  const [createOwner, setCreateOwner] = useState(false)
  const [username, setUsername] = useState(''), [displayName, setDisplayName] = useState(''), [password, setPassword] = useState('')
  const [seedDemo, setSeedDemo] = useState(false), [starterPack, setStarterPack] = useState(getLocale())
  const [busy, setBusy] = useState<'submit' | 'check' | null>(null), [error, setError] = useState('')
  const [setupFailed, setSetupFailed] = useState(false), [recoveryNote, setRecoveryNote] = useState('')
  const [packs, setPacks] = useState<StarterPack[]>([]), [packsError, setPacksError] = useState('')
  const actionInFlight = useRef(false)
  const disabled = busy !== null
  const needsAccount = !setup || mode !== 'open_edit' || createOwner
  const publicMode = mode === 'open_edit' || mode === 'public_read'

  useEffect(() => {
    if (!setup || !seedDemo) return
    const pending = new AbortController()
    request<StarterPack[]>('/starter-packs', { signal: pending.signal })
      .then(value => { if (!pending.signal.aborted) { setPacks(value); setPacksError('') } })
      .catch(() => { if (!pending.signal.aborted) setPacksError(t('示例预览暂时无法加载，不影响创建。', 'The example preview is unavailable. You can still create your Home.')) })
    return () => pending.abort()
  }, [setup, seedDemo])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (actionInFlight.current) return
    actionInFlight.current = true; setBusy('submit'); setError(''); setRecoveryNote('')
    try {
      const path = setup ? '/setup' : registering ? '/auth/register' : '/auth/login'
      const identity = { username: username.trim(), displayName: displayName.trim() || username.trim(), password }
      const body = setup
        ? { siteName: siteName.trim(), mode, seedDemo, ...(seedDemo ? { starterPack } : {}), ...(needsAccount ? identity : {}) }
        : registering ? identity : { username: username.trim(), password }
      await request(path, { method: 'POST', body })
      setPassword('')
      await onComplete(setup && (publicMode || seedDemo))
    } catch (cause) {
      setError(authError(cause, setup))
      if (setup) setSetupFailed(true)
    } finally {
      actionInFlight.current = false; setBusy(null)
    }
  }

  async function recheckSetup() {
    if (actionInFlight.current) return
    actionInFlight.current = true; setBusy('check'); setError(''); setRecoveryNote('')
    try {
      if (await onRecheckSetup()) {
        setPassword(''); setSetupFailed(false)
      } else {
        setRecoveryNote(t('尚未完成初始化。你的输入已保留，请检查后再点击“创建我的 Home”。', 'Setup is not complete. Your entries are preserved; review them before choosing “Create my Home” again.'))
      }
    } catch {
      setError(t('暂时无法读取初始化状态，输入已保留。连接恢复后请再次检查。', 'The setup status could not be read. Your entries are preserved; check again when the connection is restored.'))
    } finally {
      actionInFlight.current = false; setBusy(null)
    }
  }

  return <main className="admin-ui auth-page" id="main-content">
    <a href="#/" className="auth-brand" onClick={event => { event.preventDefault(); if (!setup && !disabled) onBrowse() }}>
      <span className="admin-brand-mark"><ProjectLogo size={39} /></span>Lingshu<span>/ Home</span>
    </a>
    <section className={'auth-card' + (setup ? ' auth-setup' : '')}>
      <h1>{setup ? t('初始化 Home', 'Set up Home') : registering ? t('创建账号', 'Create an account') : t('登录', 'Sign in')}</h1>
      {setup && <p className="auth-intro">{t('界面语言：简体中文，由服务启动配置决定。示例内容可以另选语言。', 'Interface language: English, set by the service startup configuration. Example content can use a different language.')}</p>}
      <form onSubmit={submit} onInvalidCapture={event => handleFormInvalid(event, setError)}>
        <fieldset disabled={disabled} className="admin-plain-fieldset">
          {setup && <>
            <Field label={t('站点名称', 'Site name')}><Input value={siteName} onChange={event => setSiteName(event.target.value)} required maxLength={80} autoFocus /></Field>
            <fieldset className="admin-mode-options">
              <legend>{t('访问方式', 'Access mode')}</legend>
              {authModes.map(option => <label key={option.id} className={'admin-mode-option' + (mode === option.id ? ' selected' : '')}>
                <input type="radio" name="setup-mode" checked={mode === option.id} onChange={() => setMode(option.id as AuthMode)} />
                <BuiltinIcon name={option.icon} /><span><strong>{option.title}</strong><small>{option.detail}</small></span>
              </label>)}
            </fieldset>
            {mode === 'open_edit' && <>
              <label className="admin-check-line">
                <Checkbox aria-label={t('同时创建管理员（可选）', 'Also create an administrator (optional)')} checked={createOwner} disabled={disabled} onCheckedChange={setCreateOwner} />
                <span>{t('同时创建管理员（可选）', 'Also create an administrator (optional)')}</span>
              </label>
              <p className="admin-hint">{t('管理员可配置网络和外部数据源；共享导航仍可免登录维护。也可以稍后在“访问与账号”中创建。', 'An administrator can configure networking and external sources. Shared navigation stays editable without signing in; you can also create the account later in Access and accounts.')}</p>
            </>}
            {mode === 'private_multi' && <p className="admin-info">{t('成员自行注册默认关闭。创建后可在“成员管理”添加账号，或在“访问与账号”开启注册。', 'Member self-registration starts off. After setup, add accounts in Member management or enable registration in Access and accounts.')}</p>}
          </>}
          {needsAccount && <div className="auth-account-fields">
            {setup && <h3>{t('创建管理员', 'Create administrator')}</h3>}
            <div className={setup || registering ? 'admin-form-row equal' : undefined}>
              <Field label={t('用户名', 'Username')}>
                <Input value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={40} pattern={'[A-Za-z0-9._\\-]{3,40}'} autoComplete="username" autoFocus={!setup} spellCheck={false} placeholder={t('3–40 位字母、数字或 . _ -', '3–40 letters, numbers, or . _ -')} />
              </Field>
              {(setup || registering) && <Field label={t('显示名称', 'Display name')} hint={t('选填', 'Optional')}><Input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={80} autoComplete="nickname" /></Field>}
            </div>
            <Field label={t('密码', 'Password')}>
              <Input value={password} onChange={event => setPassword(event.target.value)} required type="password" minLength={setup || registering ? 10 : undefined} maxLength={128} autoComplete={setup || registering ? 'new-password' : 'current-password'} placeholder={setup || registering ? t('至少 10 个字符', 'At least 10 characters') : t('输入你的密码', 'Enter your password')} />
            </Field>
          </div>}
          {setup && <>
            <label className="admin-check-line">
              <Checkbox aria-label={t('填充示例导航', 'Add example bookmarks')} checked={seedDemo} disabled={disabled} onCheckedChange={setSeedDemo} />
              <span>{t('填充示例导航', 'Add example bookmarks')} <small>{t('稍后可以编辑或删除', 'You can edit or delete them later')}</small></span>
            </label>
            <p className="admin-hint">{seedDemo
              ? t('12 个示例网站将保存在共享空间，使用内置图标，不会接入外部数据源。', 'The 12 example websites are saved in the shared space with bundled icons. No external sources are connected.')
              : t('不勾选将从空白导航开始。日程、天气等组件可稍后按需添加。', 'Leave this off to start with no bookmarks. Calendar, weather and other components can be added later.')}</p>
          </>}
          {setup && seedDemo && <div className="auth-starter-pack">
            <Field label={t('示例内容包', 'Example content pack')} hint={t('只在初始化时填充，不会改变界面语言。', 'Applied only during setup; does not change the interface language.')}>
              <StyledSelect value={starterPack} onValueChange={value => setStarterPack(value as 'zh-CN' | 'en')} disabled={disabled} options={[{ value: 'zh-CN', label: t('中文网站预置', 'Chinese website collection') }, { value: 'en', label: t('英文网站预置', 'English website collection') }]} />
            </Field>
            {packsError ? <p className="admin-hint">{packsError}</p> : <details>
              <summary>{t('预览将添加的网站', 'Preview the websites to add')}</summary>
              {packs.find(pack => pack.id === starterPack)?.groups.map(group => <section key={group.name}>
                <h4>{group.name}</h4><ul>{group.links.map(link => <li key={link.url}><span>{link.title}</span><small>{link.url}</small></li>)}</ul>
              </section>) || <p className="admin-hint">{t('正在读取预置内容…', 'Loading the collection…')}</p>}
            </details>}
          </div>}
          {setup && <p className="admin-info">{publicMode
            ? needsAccount
              ? t('完成后进入共享空间。共享导航对访客开放，个人空间仅自己可见。', 'Setup opens the shared space. Shared navigation is public; your personal space stays private.')
              : t('完成后进入共享空间，无需登录即可浏览和维护。', 'Setup opens the shared space, where anyone can browse and edit without signing in.')
            : seedDemo
              ? t('完成后进入有示例内容的共享空间，仅登录账号可访问；个人空间保持空白。', 'Setup opens the shared examples, accessible only after signing in. Your personal space starts empty.')
              : t('完成后进入个人空间，仅自己可见。共享内容可通过空间选择器进入。', 'Setup opens your private personal space. Use the space selector to open shared content.')}</p>}
          <ErrorMessage error={error} />
          {setup && recoveryNote && <p className="admin-info" role="status">{recoveryNote}</p>}
          {setup && setupFailed && <div className="admin-info">
            <p>{t('创建请求可能已完成，或其他窗口已完成初始化。重新检查只读取状态，不会再次提交，也不会清空当前输入。', 'Setup may already have completed here or in another window. Checking only reads the current state; it does not submit again or discard your entries.')}</p>
            <Button type="button" variant="outline" disabled={disabled} onClick={recheckSetup} aria-label={t('重新检查初始化状态', 'Check setup status again')}>
              <RefreshCw size={15} />{busy === 'check' ? t('正在检查…', 'Checking…') : t('重新检查初始化状态', 'Check setup status again')}
            </Button>
          </div>}
          <Button type="submit" className="admin-full" disabled={disabled}>
            {busy === 'submit' ? t('正在处理…', 'Processing…') : setup ? t('创建我的 Home', 'Create my Home') : registering ? t('注册并进入', 'Register and continue') : t('登录', 'Sign in')}<ArrowRight size={16} />
          </Button>
        </fieldset>
      </form>
      <div className="auth-links">
        {!setup && bootstrap.mode === 'private_multi' && bootstrap.registrationEnabled && <Button variant="link" type="button" disabled={disabled} onClick={() => { setRegistering(!registering); setPassword(''); setError('') }}>
          {registering ? t('已有账号？返回登录', 'Already registered? Sign in') : t('创建个人空间', 'Create a personal space')}
        </Button>}
        {!setup && ['open_edit', 'public_read'].includes(bootstrap.mode) && <Button variant="link" type="button" disabled={disabled} onClick={onBrowse}>{t('返回公开导航', 'Back to public bookmarks')}</Button>}
      </div>
    </section>
    <footer className="auth-footer">{bootstrap.version}</footer>
  </main>
}
