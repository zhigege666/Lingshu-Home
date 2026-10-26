import { t } from '../core/i18n'
import type { SessionChoiceValue, SessionOptions, SessionStatus } from '../core/types'
import { Field } from './Shared'
import { StyledSelect } from './ui/select'
import './session-controls.css'
export function allowedRememberDays(options?: SessionOptions): number[] {
  return [...new Set(options?.rememberDays || [])].filter(days => [7,30,90].includes(days) && days <= (options?.maxIdleDays || 0)).sort((a,b) => a-b)
}
export function choiceFromOptions(options?: SessionOptions): SessionChoiceValue {
  if (!options) return { sessionMode: 'temporary' }
  if (options.defaultMode === 'until_logout' && options.allowUntilLogout) return { sessionMode: 'until_logout' }
  const days = allowedRememberDays(options)
  if (options.defaultMode === 'remember' && days.length) return { sessionMode: 'remember', rememberDays: days.includes(options.defaultIdleDays) ? options.defaultIdleDays : days[days.length-1] }
  return { sessionMode: 'temporary' }
}
export function normalizeSessionChoice(value: SessionChoiceValue, options?: SessionOptions): SessionChoiceValue {
  if (!options) return { sessionMode: 'temporary' }
  if (value.sessionMode === 'temporary') return { sessionMode: 'temporary' }
  if (value.sessionMode === 'until_logout' && options.allowUntilLogout) return { sessionMode: 'until_logout' }
  if (value.sessionMode === 'remember' && allowedRememberDays(options).includes(value.rememberDays || 0)) return { sessionMode: 'remember', rememberDays: value.rememberDays }
  return choiceFromOptions(options)
}
export function sessionChoiceBody(value: SessionChoiceValue, options?: SessionOptions): Partial<SessionChoiceValue> { return options ? normalizeSessionChoice(value, options) : {} }
export function sessionModeLabel(session: Pick<SessionStatus,'mode'|'idleDays'>): string {
  if (session.mode === 'until_logout') return t('保持登录，直到退出','Until I sign out')
  if (session.mode === 'remember') return t('记住此浏览器 · {days} 天','Remember this browser · {days} days',{days:session.idleDays || 0})
  return t('临时登录 · 12 小时','Temporary · 12 hours')
}
export function SessionChoice({ options, value, onChange, disabled = false, label = t('登录保持','Stay signed in') }: {
  options?: SessionOptions; value: SessionChoiceValue; onChange: (value: SessionChoiceValue) => void; disabled?: boolean; label?: string
}) {
  if (!options) return null
  const selected = normalizeSessionChoice(value, options)
  const choices = [{value:'temporary',label:t('临时登录 · 12 小时','Temporary · 12 hours')},
    ...allowedRememberDays(options).map(days=>({value:'remember:'+days,label:t('记住 · {days} 天未使用后退出','Remember · {days} idle days',{days})})),
    ...(options.allowUntilLogout ? [{value:'until_logout',label:t('保持登录，直到退出','Until I sign out')}] : [])]
  return <Field className="admin-field-inline session-choice" label={label} help={<><p>{t('记住模式按最后使用时间计算，正常操作会延长有效期，关闭浏览器后也可继续登录。','Remembered sessions expire after the selected period without use. Normal interaction renews them, including across browser restarts.')}</p><p>{t('退出登录、撤销设备或账号安全变更仍会结束登录；浏览器清理登录信息也会使其失效。','Signing out, revoking a login or account security changes can end a session. Clearing browser data also removes the login.')}</p></>}><StyledSelect tone="admin" aria-label={label} disabled={disabled} value={selected.sessionMode === 'remember' ? 'remember:'+selected.rememberDays : selected.sessionMode} options={choices} onValueChange={next=>onChange(next.startsWith('remember:') ? {sessionMode:'remember',rememberDays:Number(next.slice(9))} : {sessionMode:next === 'until_logout' ? 'until_logout' : 'temporary'})}/></Field>
}
