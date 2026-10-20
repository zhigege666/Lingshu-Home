import { t } from '../core/i18n'
import { useEffect, useState, type FormEvent } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { messageOf, request } from '../core/api'
import type { AdminUser, AuthMode, Bootstrap, Settings } from '../core/types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Checkbox } from '../components/ui/checkbox'
import { Table,TableHeader,TableBody,TableRow,TableHead,TableCell } from '../components/ui/table'
import { authModes,BuiltinIcon,ErrorMessage,Field,handleFormInvalid,Loading,Modal } from '../components/Shared'
export function AccessSettings({ bootstrap, onSaved, onLogin }: { bootstrap: Bootstrap; onSaved: () => Promise<void>; onLogin: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [owner, setOwner] = useState({ username: '', displayName: '', password: '' })
  const [createOwner, setCreateOwner] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { let active = true; request<Settings>('/settings').then(value => { if (active) setSettings(value) }).catch(cause => { if (active) setError(messageOf(cause)) }); return () => { active = false } }, [])
  const editable = bootstrap.user?.role === 'Owner' || !!settings && !settings.hasOwner && bootstrap.mode === 'open_edit'
  const needsOwner = !!settings && !settings.hasOwner && (settings.mode !== 'open_edit' || createOwner)
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings || !editable || busy) return
    setBusy(true); setError('')
    try {
      const saved = await request<Settings>('/settings', { method: 'PUT', body: {
        siteName: settings.siteName.trim(), mode: settings.mode, registrationEnabled: settings.mode === 'private_multi' && settings.registrationEnabled,
        autoFetchIcons: settings.autoFetchIcons !== false,
        ...(needsOwner ? { owner: { ...owner, username: owner.username.trim(), displayName: owner.displayName.trim() || owner.username.trim() } } : {}),
      } })
      // The response establishes whether an Owner now exists. Keep that result
      // even if the subsequent session refresh fails, so a retry cannot create
      // the same account again or retain its password in the form.
      setSettings(saved); setOwner({ username: '', displayName: '', password: '' }); setCreateOwner(false)
      try { await onSaved() }
      catch { setError(t('访问设置已保存，但会话重新读取失败。请刷新页面后继续。', 'Access settings were saved, but the session could not be reloaded. Refresh the page to continue.')) }
    } catch (cause) { setError(messageOf(cause)) }
    finally { setBusy(false) }
  }
  if (!settings) return <><ErrorMessage error={error}/>{!error && <Loading/>}</>
  return <>
    {!editable && <div className="admin-info"><p>{t('本站已有管理员。请登录管理员账号后修改访问设置。', 'This site already has an administrator. Sign in to that account to change access settings.')}</p><Button type="button" variant="outline" onClick={onLogin}>{t('管理员登录', 'Administrator sign-in')}</Button></div>}
    <form onSubmit={save} onInvalidCapture={event => handleFormInvalid(event, setError)}><fieldset disabled={busy || !editable} className="admin-plain-fieldset">
      <Field label={t('站点名称', 'Site name')}><Input required maxLength={80} value={settings.siteName} onChange={event => setSettings({ ...settings, siteName: event.target.value })}/></Field>
      <section className="admin-settings-section"><h3>{t('网页图标', 'Website icons')}</h3><label className="admin-check-line"><Checkbox aria-label={t('自动获取网页图标', 'Automatically fetch website icons')} checked={settings.autoFetchIcons !== false} disabled={busy || !editable} onCheckedChange={checked => setSettings({ ...settings, autoFetchIcons: checked })}/>{t('自动获取网页图标', 'Automatically fetch website icons')}</label><p className="admin-hint">{t('保存或导入自动模式链接时获取并缓存网页图标。关闭后停止后台获取，保留已有图标及手动操作；重新启用不会扫描旧链接。', 'Website icons are fetched and cached when links in automatic mode are saved or imported. Turning this off stops background fetching while keeping saved icons and manual controls; turning it back on does not scan existing links.')}</p></section>
      <fieldset className="admin-mode-options"><legend>{t('访问方式', 'Access mode')}</legend>{authModes.map(mode => <label className={`admin-mode-option ${settings.mode === mode.id ? 'selected' : ''}`} key={mode.id}><input type="radio" name="access-mode" checked={settings.mode === mode.id} onChange={() => setSettings({ ...settings, mode: mode.id as AuthMode, registrationEnabled: mode.id === 'private_multi' && settings.registrationEnabled })}/><BuiltinIcon name={mode.icon}/><span><strong>{mode.title}</strong><small>{mode.detail}</small></span></label>)}</fieldset>
      {settings.mode === 'private_multi' && <label className="admin-check-line"><Checkbox checked={settings.registrationEnabled} disabled={busy || !editable} onCheckedChange={checked => setSettings({ ...settings, registrationEnabled: checked })}/>{t('允许访客自行注册 Member 账号', 'Allow visitors to register member accounts')}</label>}
      {!settings.hasOwner && settings.mode === 'open_edit' && <section className="admin-settings-section">
        <label className="admin-check-line"><Checkbox aria-label={t('同时创建首个管理员（可选）', 'Also create the first administrator (optional)')} checked={createOwner} disabled={busy || !editable} onCheckedChange={checked => { setCreateOwner(checked); if (!checked) setOwner({ username: '', displayName: '', password: '' }) }}/>{t('同时创建首个管理员（可选）', 'Also create the first administrator (optional)')}</label>
        <p className="admin-hint">{t('可以继续免账号维护导航。创建管理员后仍保留当前免账号编辑模式，并登录此账号，可配置数据源、访问令牌和服务器代理；无需切换访问模式。', 'You can continue managing bookmarks without an account. Creating an administrator keeps account-free editing enabled and signs you in, so you can configure sources, access tokens and the server proxy. No access-mode change is required.')}</p>
      </section>}
      {needsOwner && <section className="admin-settings-section"><h3>{t('创建首个管理员', 'Create the first administrator')}</h3>
        <Field label={t('用户名', 'Username')}><Input required pattern={'[A-Za-z0-9._\\-]{3,40}'} minLength={3} maxLength={40} autoComplete="username" value={owner.username} onChange={event => setOwner({ ...owner, username: event.target.value })}/></Field>
        <Field label={t('显示名称', 'Display name')}><Input maxLength={80} value={owner.displayName} onChange={event => setOwner({ ...owner, displayName: event.target.value })}/></Field>
        <Field label={t('密码', 'Password')}><Input required type="password" minLength={10} maxLength={128} autoComplete="new-password" value={owner.password} onChange={event => setOwner({ ...owner, password: event.target.value })}/></Field>
      </section>}
      <p className="admin-info">{t('切换访问模式会使旧会话失效，请重新登录。个人空间不会自动公开；成员数据会保留。', 'Changing the access mode signs out existing sessions. Personal spaces stay private and member data is retained.')}</p>
      <ErrorMessage error={error}/><div className="admin-form-footer"><Button type="submit">{busy ? t('正在保存…', 'Saving…') : t('保存访问设置', 'Save access settings')}</Button></div>
    </fieldset></form>
  </>
}
export function MembersPanel({onNotice}:{onNotice:(message:string)=>void}) {
  const [users,setUsers]=useState<AdminUser[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [formError,setFormError]=useState('');const [open,setOpen]=useState(false);const [editing,setEditing]=useState<AdminUser|null>(null);const [busy,setBusy]=useState(false)
  const [form,setForm]=useState({username:'',displayName:'',password:'',isEnabled:true})
  async function load(){setLoading(true);setError('');try{setUsers(await request<AdminUser[]>('/admin/users'))}catch(cause){setError(messageOf(cause))}finally{setLoading(false)}}
  useEffect(()=>{void load()},[])
  function start(user:AdminUser|null){setEditing(user);setForm({username:user?.username||'',displayName:user?.displayName||'',password:'',isEnabled:user?.isEnabled??true});setFormError('');setOpen(true)}
  async function save(e:FormEvent){e.preventDefault();setBusy(true);setFormError('');try{await request(`/admin/users${editing?'/'+editing.id:''}`,{method:editing?'PUT':'POST',body:editing?{displayName:form.displayName.trim(),isEnabled:form.isEnabled,...(form.password?{password:form.password}:{})}:{username:form.username.trim(),displayName:form.displayName.trim()||form.username.trim(),password:form.password}});setOpen(false);setForm({...form,password:''});onNotice(editing?t("成员设置已保存", "Member settings saved"):t("成员账号已创建", "Member account created"));await load()}catch(cause){setFormError(messageOf(cause))}finally{setBusy(false)}}
  return <><div className="admin-content-toolbar"><h3>{t("成员账号", "Member accounts")}</h3><Button onClick={()=>start(null)}><Plus size={16}/>{t("创建成员", "Create member")}</Button></div><ErrorMessage error={error}/>{loading?<Loading/>:<Table><TableHeader><TableRow><TableHead>{t("账号", "Account")}</TableHead><TableHead>{t("角色", "Role")}</TableHead><TableHead>{t("状态", "Status")}</TableHead><TableHead>{t("操作", "Actions")}</TableHead></TableRow></TableHeader><TableBody>{users.map(user=><TableRow key={user.id}><TableCell><strong>{user.displayName}</strong><small>{user.username}</small></TableCell><TableCell>{user.role === 'Owner' ? t('管理员', 'Owner') : t('成员', 'Member')}</TableCell><TableCell>{!user.isEnabled?t("已停用", "Disabled"):user.modeSuspended?t("模式暂停", "Suspended by access mode"):t("已启用", "Enabled")}</TableCell><TableCell>{user.role==='Member'?<Button variant="ghost" size="sm" onClick={()=>start(user)}><Pencil size={14}/>{t("编辑", "Edit")}</Button>:<span className="admin-muted">{t("管理员", "Administrator")}</span>}</TableCell></TableRow>)}</TableBody></Table>}{open&&<Modal title={editing?t("编辑成员", "Edit member"):t("创建成员", "Create member")} busy={busy} onClose={()=>{setOpen(false);setForm({...form,password:''})}}><form onSubmit={save} onInvalidCapture={event=>handleFormInvalid(event,setFormError)}><fieldset disabled={busy} className="admin-plain-fieldset"><Field label={t("用户名", "Username")}><Input required autoFocus disabled={!!editing} minLength={3} maxLength={40} pattern={'[A-Za-z0-9._\\-]{3,40}'} value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></Field><Field label={t("显示名称", "Display name")}><Input required={!!editing} maxLength={80} value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})}/></Field><Field label={editing?t("重置密码", "Reset password"):t("初始密码", "Initial password")} hint={editing?t("留空保留现有密码", "Leave blank to keep the current password"):undefined}><Input type="password" required={!editing} minLength={10} maxLength={128} autoComplete="new-password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></Field>{editing&&<label className="admin-check-line"><Checkbox checked={form.isEnabled} disabled={busy} onCheckedChange={checked=>setForm({...form,isEnabled:checked})}/>{t("启用此账号", "Enable this account")}</label>}<p className="admin-hint">{t("停用账号或重置密码会撤销该账号的旧会话。", "Disabling an account or resetting its password signs out its existing sessions.")}</p><ErrorMessage error={formError}/><div className="admin-form-footer"><Button type="button" variant="outline" onClick={()=>{setOpen(false);setForm({...form,password:''})}}>{t("取消", "Cancel")}</Button><Button type="submit">{busy?t("正在保存…", "Saving…"):t("保存成员", "Save member")}</Button></div></fieldset></form></Modal>}</>
}
