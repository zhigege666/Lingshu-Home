import { FieldHelp } from '../components/FieldHelp'
import { cloneElement, isValidElement, useId, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { Checkbox } from '../components/ui/checkbox'
import { StyledSelect, type SelectOption } from '../components/ui/select'

export function ComposerField({ label, hint, help, children }: { label: string; hint?: string; help?: ReactNode; children: ReactNode }) {
  const id = useId(), hintId = `${id}-hint`
  return <div className="lh-composer-field">
    {help ? <div style={{display: 'flex', alignItems: 'center', gap: 6}}><label htmlFor={id}>{label}</label><FieldHelp label={label}>{help}</FieldHelp></div> : <label htmlFor={id}>{label}</label>}
    {isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id, ...(hint ? { 'aria-describedby': hintId } : {}) }) : children}
    {hint && <small id={hintId}>{hint}</small>}
  </div>
}

export function ComposerSelect({ label, hint, value, options, onChange, disabled = false }: {
  label: string; hint?: string; value: string; options: readonly SelectOption[]; onChange: (value: string) => void; disabled?: boolean
}) {
  return <ComposerField label={label} help={hint}><StyledSelect aria-label={label} value={value} options={options} onValueChange={onChange} disabled={disabled} tone="admin" theme="light" /></ComposerField>
}

export function ComposerButton({ kind = 'plain', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'plain' | 'primary' | 'icon' | 'danger' }) {
  return <button type="button" className={`lh-composer-button is-${kind} ${className}`} {...props} />
}

export function ComposerCheck({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const id = useId()
  return <label className="lh-composer-check" htmlFor={id}><Checkbox id={id} aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled} /><span>{label}</span></label>
}
