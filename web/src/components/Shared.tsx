import { t } from '../core/i18n'
import { Children, cloneElement, isValidElement, useId, useRef, useState, type AriaAttributes, type FormEvent, type ReactElement, type ReactNode } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { iconPath } from '../core/presentation'
import { parseIconAssetReference } from '../core/icon-assets'
import { IconAsset } from './IconAsset'
import './form-controls.css'
export { authModes } from '../core/presentation'
export function BuiltinIcon({ name = 'lucide:link', className = '' }: { name?: string; className?: string }) {
  if (parseIconAssetReference(name)) return <IconAsset name={name} size={20} className={`admin-image-icon ${className}`} />
  return <span aria-hidden="true" className={`admin-mask-icon ${className}`} style={{ maskImage: `url(${iconPath(name)})`, WebkitMaskImage: `url(${iconPath(name)})` }} />
}
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const generatedId = useId()
  const [validation, setValidation] = useState('')
  let controlId = `field-${generatedId}`
  let bound = false
  const controls = Children.map(children, child => {
    if (bound || !isValidElement(child)) return child
    bound = true
    const control = child as ReactElement<{ id?: string; 'data-field-label'?: string } & Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid'>>
    controlId = control.props.id || controlId
    const describedBy = [control.props['aria-describedby'], hint ? `${controlId}-hint` : undefined, validation ? `${controlId}-validation` : undefined].filter(Boolean).join(' ')
    return cloneElement(control, { id: controlId, 'aria-describedby': describedBy || undefined, 'aria-invalid': control.props['aria-invalid'] ?? (validation ? true : undefined), 'data-field-label': label })
  })
  function recheck(event: FormEvent<HTMLDivElement>) {
    if (!validation) return
    const invalid = event.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:invalid, textarea:invalid, select:invalid')
    setValidation(invalid ? validationDetail(invalid) : '')
  }
  // Recheck in the change bubble, after the child's controlled onChange. A
  // capture-phase state update can restore the old input value before that
  // child handler has received the user's edit.
  return <div className={`admin-field ${className}`} onInvalidCapture={event => {
    const control = event.target
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) setValidation(validationDetail(control))
  }} onChange={recheck}><div className="admin-field-label"><label htmlFor={controlId}>{label}</label>{hint && <small id={`${controlId}-hint`}>{hint}</small>}</div>{controls}{validation && <small className="admin-field-validation" id={`${controlId}-validation`}>{validation}</small>}</div>
}
function validationDetail(first: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const validity = first.validity
  let detail = t("请检查填写内容", "check the entered value")
  if (validity.valueMissing) detail = t("不能为空", "is required")
  else if (validity.typeMismatch) detail = first instanceof HTMLInputElement && first.type === 'url' ? t("请填写完整网址", "enter a complete URL") : t("格式不正确", "has an invalid format")
  else if (validity.tooShort && 'minLength' in first) detail = t("至少需要 {min} 个字符", "use at least {min} characters", { min: first.minLength })
  else if (validity.tooLong && 'maxLength' in first) detail = t("最多允许 {max} 个字符", "use no more than {max} characters", { max: first.maxLength })
  else if (validity.rangeUnderflow && first instanceof HTMLInputElement) detail = t("不能小于 {min}", "must be at least {min}", { min: first.min })
  else if (validity.rangeOverflow && first instanceof HTMLInputElement) detail = t("不能大于 {max}", "must be no greater than {max}", { max: first.max })
  else if (validity.badInput || validity.stepMismatch) detail = t("请填写有效数字", "enter a valid number")
  else if (validity.patternMismatch) detail = t("请使用要求的格式", "use the required format")
  return detail
}
/** Keep HTML constraints and keyboard focus, but present validation in the form instead of OS bubbles. */
export function handleFormInvalid(event: FormEvent<HTMLFormElement>, setError: (message: string) => void) {
  event.preventDefault()
  const first = event.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:invalid, textarea:invalid, select:invalid')
  if (!first || first !== event.target) return
  const field = first.closest('.admin-field') || first.closest('label')
  const label = first.dataset.fieldLabel || field?.querySelector('label')?.textContent || first.getAttribute('aria-label') || t('此项', 'This field')
  setError(t('{label}：{detail}。', '{label}: {detail}.', { label, detail: validationDetail(first) }))
  const focusTarget = first.getAttribute('aria-hidden') === 'true' ? field?.querySelector<HTMLElement>('[role="combobox"], [role="checkbox"]') : first
  focusTarget?.focus()
}
export function FilePicker({ id, accept, filename, onFileChange, disabled = false, ...aria }: {
  id?: string; accept: string; filename: string; onFileChange: (file?: File) => void; disabled?: boolean;
  'aria-label'?: string; 'aria-describedby'?: string; 'aria-invalid'?: AriaAttributes['aria-invalid']; 'data-field-label'?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  return <div className="admin-file-picker"><input ref={input} type="file" accept={accept} disabled={disabled} hidden tabIndex={-1} onChange={event => {
    onFileChange(event.target.files?.[0]); event.target.value = ''
  }} /><Button id={id} type="button" variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()} {...aria}>{t("选择文件", "Choose file")}</Button><span aria-live="polite" title={filename || undefined}>{filename || t("未选择文件", "No file selected")}</span></div>
}
export function ErrorMessage({ error }: { error?: string | null }) { return error ? <div role="alert" className="admin-error">{error}</div> : null }
export function Loading({ text = t("正在读取…", "Loading…") }: { text?: string }) { return <div className="admin-loading" role="status"><LoaderCircle className="admin-spin" size={21} />{text}</div> }
export function Empty({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) { return <div className="admin-empty"><BuiltinIcon name="lucide:bookmark" /><h3>{title}</h3>{detail && <p>{detail}</p>}{children}</div> }
export function Modal({ title, description, busy = false, wide = false, onClose, children }: { title: string; description?: string; busy?: boolean; wide?: boolean; onClose: () => void; children: ReactNode }) {
  const returnFocus = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose() }}><DialogContent className={`admin-ui admin-dialog ${wide ? 'admin-dialog-wide' : ''}`} showCloseButton={false} onCloseAutoFocus={event => {
    event.preventDefault()
    if (returnFocus.current?.isConnected && returnFocus.current !== document.body) returnFocus.current.focus({ preventScroll: true })
    else { const main = document.getElementById('main-content'); if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }) } }
  }} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }} {...(description ? {} : { 'aria-describedby': undefined })}><DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>{!busy && <DialogClose asChild><Button type="button" variant="ghost" className="cn-dialog-close" size="icon-sm" aria-label={t('关闭', 'Close')}><X aria-hidden="true"/></Button></DialogClose>}<div className="admin-dialog-body">{children}</div></DialogContent></Dialog>
}
