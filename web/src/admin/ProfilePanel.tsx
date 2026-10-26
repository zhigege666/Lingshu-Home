import { SessionPanel } from './SessionPanel'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { LockKeyhole, RefreshCw, UserRound } from 'lucide-react'
import type { Bootstrap, User } from '../core/types'
import { ApiError, bootstrap as readBootstrap, request } from '../core/api'
import { t } from '../core/i18n'
import { beforeNavigationEvent } from '../core/navigation'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Field, handleFormInvalid } from '../components/Shared'
import { FieldHelp } from '../components/FieldHelp'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import { accountInitials } from '../components/AccountMenu'
import '../components/account-profile.css'

type Props = { user: User; bootstrap: Bootstrap; onSessionChanged: () => Promise<void>; onNotice: (message: string) => void; onCurrentSessionRevoked?: () => Promise<void> }
const emptyPasswords = { current: '', next: '', confirm: '' }
export default function ProfilePanel({ user, bootstrap, onSessionChanged, onNotice, onCurrentSessionRevoked }: Props) {
  const [name, setName] = useState(user.displayName), [base, setBase] = useState(user.displayName)
  const [passwords, setPasswords] = useState(emptyPasswords)
  const [profileError, setProfileError] = useState(''), [passwordError, setPasswordError] = useState('')
  const [profileSuccess, setProfileSuccess] = useState(''), [passwordSuccess, setPasswordSuccess] = useState('')
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<string | null>(null)
  const [busy, setBusy] = useState(''), [sessionError, setSessionError] = useState(''), [confirmLeave, setConfirmLeave] = useState(false)
  const previousName = useRef(user.displayName)
  const action = useRef(''), mounted = useRef(true), dirty = useRef(false), pending = useRef<(() => void) | null>(null)
  const nameDirty = name.trim() !== base, passwordDirty = !!(passwords.current || passwords.next || passwords.confirm)
  const locked = !!busy || !!sessionError
  dirty.current = nameDirty || passwordDirty
  useEffect(() => {
    if (previousName.current !== user.displayName) {
      previousName.current = user.displayName
      if (!nameDirty) { setBase(user.displayName); setName(user.displayName) }
    }
  }, [user.displayName, nameDirty])
  useEffect(() => {
    mounted.current = true
    const navigate = (event: Event) => {
      const proceed = (event as CustomEvent<{ proceed: () => void }>).detail?.proceed
      if (!proceed) return
      if (action.current) { event.preventDefault(); return }
      if (dirty.current) { event.preventDefault(); pending.current = proceed; setConfirmLeave(true) }
    }
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current || action.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener(beforeNavigationEvent, navigate); window.addEventListener('beforeunload', unload)
    return () => { mounted.current = false; window.removeEventListener(beforeNavigationEvent, navigate); window.removeEventListener('beforeunload', unload) }
  }, [])
  function begin(kind: string) { if (action.current) return false; action.current = kind; setBusy(kind); return true }
  function finish() { action.current = ''; if (mounted.current) setBusy('') }
  async function sync(saved = false) {
    try { await onSessionChanged(); if (mounted.current) setSessionError('') }
    catch { if (mounted.current) setSessionError(saved ? t('更改已保存，但登录状态暂未刷新，请重新检查后继续。', 'Your change was saved, but the sign-in state could not be refreshed. Check it before continuing.') : t('暂时无法刷新登录状态，请重新检查后继续。', 'Your sign-in state could not be refreshed. Check it before continuing.')) }
  }
  function failure(cause: unknown, password = false) {
    const status = cause instanceof ApiError ? cause.status : 0
    const code = cause instanceof ApiError ? cause.code : ''
    if (status === 429) return t('操作过于频繁，请稍后重试。', 'Too many attempts. Please wait before retrying.')
    if (code === 'current_password_incorrect') return t('当前密码不正确，请检查后重试。', 'The current password is incorrect. Check it and try again.')
    if (status === 401 || status === 403) return t('登录状态已改变，请重新检查。', 'Your sign-in state has changed. Check it again.')
    if (status === 400) return password ? t('请检查密码：新密码需为 10–128 个字符，且与当前密码不同。', 'Check the passwords. Use a different new password with 10–128 characters.') : t('显示名称不能为空，最多 80 个字符。', 'Enter a display name using 1–80 characters.')
    return password ? t('暂时无法确认密码修改结果，请先检查登录状态。', 'The password change could not be confirmed. Check your sign-in state first.') : t('暂时无法确认保存结果，请读取最新资料。', 'The saved result could not be confirmed. Read the latest profile.')
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault(); if (locked || !nameDirty || conflict || !begin('profile')) return
    setProfileError(''); setProfileSuccess('')
    try {
      const updated = await request<User>('/account/profile', { method: 'PUT', body: { displayName: name.trim(), expectedDisplayName: base } })
      if (!updated || updated.id !== user.id || typeof updated.displayName !== 'string') throw new Error('Invalid profile response')
      if (!mounted.current) return
      setBase(updated.displayName); setName(updated.displayName); setLatest(null)
      setProfileSuccess(t('个人资料已保存。', 'Your profile has been saved.')); onNotice(t('个人资料已更新', 'Profile updated'))
      await sync(true)
    } catch (cause) {
      if (!mounted.current) return
      const status = cause instanceof ApiError ? cause.status : 0
      setConflict(status === 409 || status === 0 || status >= 500)
      setProfileError(status === 409 ? t('资料已在其他地方更新。草稿已保留，请读取最新资料并核对。', 'Your profile changed elsewhere. Your draft is retained. Read the latest profile and review it.') : failure(cause))
      if (status === 401 || status === 403) setSessionError(failure(cause))
    } finally { finish() }
  }
  async function readLatest() {
    if (!begin('reload')) return
    setProfileError('')
    try {
      const result = await readBootstrap()
      if (!result.user || result.user.id !== user.id) { await sync(); setSessionError(t('账号状态已改变，请重新登录。', 'Your account state changed. Sign in again.')); return }
      if (!mounted.current) return
      setBase(result.user.displayName); setLatest(result.user.displayName); setConflict(false); await sync()
    } catch (cause) { if (mounted.current) { setProfileError(failure(cause)); setConflict(true) } } finally { finish() }
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault(); if (locked || !begin('password')) return
    setPasswordError(''); setPasswordSuccess('')
    try {
      if (passwords.next !== passwords.confirm) { setPasswordError(t('两次填写的新密码不一致。', 'The new passwords do not match.')); return }
      const result = await request<{ success: boolean }>('/account/password', { method: 'PUT', body: { currentPassword: passwords.current, newPassword: passwords.next } })
      if (result?.success !== true) throw new Error('Invalid password response')
      if (!mounted.current) return
      setPasswords(emptyPasswords); setPasswordSuccess(t('密码已更新。本设备保持登录，其他会话和旧访问令牌已失效。', 'Password updated. This device stays signed in; other sessions and existing access tokens have been revoked.'))
      onNotice(t('密码已更新', 'Password updated')); await sync(true)
    } catch (cause) {
      if (!mounted.current) return
      setPasswordError(failure(cause, true)); const status = cause instanceof ApiError ? cause.status : 0
      if (status === 0 || status >= 500 || status === 401 || status === 403) setSessionError(t('请先检查登录状态；密码修改不会自动重复提交。', 'Check your sign-in state first. The password change will not be submitted again automatically.'))
    } finally { finish() }
  }
  async function checkSession() {
    if (!begin('session')) return
    try { const result = await readBootstrap(); await sync(); if (!result.user || result.user.id !== user.id) setSessionError(t('请重新登录当前账号后继续。', 'Sign in to this account again before continuing.')) }
    catch { if (mounted.current) setSessionError(t('登录状态读取失败，请稍后重试。', 'Unable to read your sign-in state. Please try again.')) }
    finally { finish() }
  }
  function editPassword(key: keyof typeof passwords, value: string) { setPasswords(previous => ({ ...previous, [key]: value })); setPasswordError(''); setPasswordSuccess('') }
  function leave() {
    const proceed = pending.current; pending.current = null; dirty.current = false
    setName(base); setPasswords(emptyPasswords); setConfirmLeave(false); proceed?.()
  }
  return <>
    <section className="profile-panel" aria-label={t('个人资料', 'Personal profile')}>
      {sessionError && <div className="profile-session-notice" role="alert"><span>{sessionError}</span><Button type="button" variant="outline" disabled={!!busy} onClick={() => void checkSession()}><RefreshCw size={15}/>{t('重新检查', 'Check again')}</Button></div>}
      <section className="profile-card" aria-labelledby="profile-details-heading">
        <header className="profile-card-heading"><UserRound size={20}/><h2 id="profile-details-heading">{t('基本资料', 'Profile details')}</h2><FieldHelp label={t('基本资料', 'Profile details')}>{t('显示名称用于账号菜单。用户名用于登录，保持不变。', 'Your display name identifies your account in menus. Your sign-in username stays unchanged.')}</FieldHelp></header>
        <div className="profile-identity"><span className="profile-avatar" aria-hidden="true">{accountInitials(user)}</span><div><strong>{user.displayName}</strong><span>@{user.username}</span></div><span className="profile-role">{user.role === 'Owner' ? t('管理员', 'Owner') : t('成员', 'Member')}</span></div>
        <form onSubmit={saveProfile} onInvalidCapture={event => handleFormInvalid(event, setProfileError)}>
          <fieldset className="profile-form-fields" disabled={locked}>
            <Field className="admin-field-inline" label={t('用户名', 'Username')}><Input name="profile-username" value={user.username} readOnly autoComplete="username"/></Field>
            <Field className="admin-field-inline" label={t('显示名称', 'Display name')}><Input name="profile-display-name" value={name} required maxLength={80} autoComplete="nickname" onChange={event => { setName(event.target.value); setProfileError(''); setProfileSuccess('') }}/></Field>
          </fieldset>
          {latest !== null && <div className="profile-info" role="status">{t('当前已保存名称：{name}。你的草稿已保留，请核对后保存。', 'Currently saved name: {name}. Your draft is retained; review it before saving.', { name: latest })}</div>}
          <ErrorMessage error={profileError}/>
          {conflict && <Button type="button" variant="outline" disabled={locked} onClick={() => void readLatest()}><RefreshCw size={15}/>{t('读取最新资料', 'Read latest profile')}</Button>}
          {profileSuccess && <p className="profile-success" role="status">{profileSuccess}</p>}
          <footer className="profile-card-actions"><Button type="submit" disabled={locked || !nameDirty || conflict}>{busy === 'profile' ? t('正在保存…', 'Saving…') : t('保存资料', 'Save profile')}</Button><Button type="button" variant="outline" disabled={locked || !nameDirty} onClick={() => { setName(base); setProfileError(''); setProfileSuccess('') }}>{t('取消修改', 'Cancel changes')}</Button></footer>
        </form>
      </section>
      <section className="profile-card" aria-labelledby="profile-password-heading">
        <header className="profile-card-heading"><LockKeyhole size={20}/><h2 id="profile-password-heading">{t('修改密码', 'Change password')}</h2><FieldHelp label={t('修改密码', 'Change password')}>{t('使用当前密码确认修改。新密码需为 10–128 个字符。更新后本设备保持登录，其他会话与旧 API/MCP 令牌将失效。', 'Confirm with your current password. Use 10–128 characters for the new password. This device stays signed in; other sessions and existing API/MCP tokens are revoked.')}</FieldHelp></header>
        <form onSubmit={savePassword} onInvalidCapture={event => handleFormInvalid(event, setPasswordError)}>
          <fieldset className="profile-form-fields" disabled={locked}>
            <Field className="admin-field-inline" label={t('当前密码', 'Current password')}><Input name="profile-current-password" type="password" value={passwords.current} required maxLength={128} autoComplete="current-password" onChange={event => editPassword('current', event.target.value)}/></Field>
            <Field className="admin-field-inline" label={t('新密码', 'New password')}><Input name="profile-new-password" type="password" value={passwords.next} required minLength={10} maxLength={128} autoComplete="new-password" onChange={event => editPassword('next', event.target.value)}/></Field>
            <Field className="admin-field-inline" label={t('确认新密码', 'Confirm new password')}><Input name="profile-confirm-password" type="password" value={passwords.confirm} required minLength={10} maxLength={128} autoComplete="new-password" onChange={event => editPassword('confirm', event.target.value)}/></Field>
          </fieldset>
          <ErrorMessage error={passwordError}/>{passwordSuccess && <p className="profile-success" role="status">{passwordSuccess}</p>}
          <footer className="profile-card-actions"><Button type="submit" disabled={locked || !passwordDirty}>{busy === 'password' ? t('正在修改…', 'Changing…') : t('更新密码', 'Update password')}</Button><Button type="button" variant="outline" disabled={locked || !passwordDirty} onClick={() => { setPasswords(emptyPasswords); setPasswordError(''); setPasswordSuccess('') }}>{t('清空输入', 'Clear inputs')}</Button></footer>
        </form>
      </section>
      <SessionPanel bootstrap={bootstrap} onSessionChanged={onSessionChanged} onNotice={onNotice} onCurrentSessionRevoked={onCurrentSessionRevoked} disabled={locked || nameDirty || passwordDirty}/>
    </section>
    {confirmLeave && <DiscardChangesDialog onKeep={() => { pending.current = null; setConfirmLeave(false) }} onDiscard={leave} description={t('个人资料或密码表单还有未保存的输入。离开后将丢弃这些输入。', 'Your profile or password form contains unsaved input. Leaving will discard it.')}/>}
  </>
}
