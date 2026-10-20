import { t } from '../../core/i18n'
// Original Lingshu-Home wrapper around the installed Radix primitives (Apache-2.0).
// This is not a copied REUI component; Radix retains its own MIT notice.
import { useId, type AriaAttributes } from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import '../form-controls.css'

export type SelectOption = { value: string; label: string; disabled?: boolean; title?: string }
export type StyledSelectProps = Pick<AriaAttributes, 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'> & {
  value: string
  onValueChange?: (value: string) => void
  options: readonly SelectOption[]
  id?: string
  name?: string
  disabled?: boolean
  required?: boolean
  className?: string
  placeholder?: string
  title?: string
  tone?: 'admin' | 'home'
  theme?: 'light' | 'dark'
  'data-field-label'?: string
}

/** A styled, keyboard-accessible single-select. Empty optional choices retain their labels. */
export function StyledSelect({ value, onValueChange, options, id, name, disabled = false, required = false,
  className = '', placeholder, title, tone = 'admin', theme = 'light', ...aria }: StyledSelectProps) {
  const instanceId = useId()
  // Radix reserves the empty string for its placeholder; our callers use it for “all” or “none”.
  const emptyOption = options.find(option => option.value === '')
  const emptyValue = `lingshu-empty-${instanceId}`
  const selectedValue = value === '' && emptyOption && !required ? emptyValue : value
  const palette = tone === 'home' ? theme : 'light'
  return <><SelectPrimitive.Root value={selectedValue} onValueChange={next => onValueChange?.(next === emptyValue ? '' : next)}
    disabled={disabled} required={required}>
    <SelectPrimitive.Trigger id={id} title={title} className={`lh-control-select ${className}`} data-tone={tone} data-theme={palette} {...aria}>
      <SelectPrimitive.Value placeholder={placeholder ?? emptyOption?.label ?? t("请选择", "Select an option")} />
      <SelectPrimitive.Icon className="lh-select-chevron"><ChevronDown size={15} aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className="lh-select-content" data-tone={tone} data-theme={palette} position="popper" sideOffset={5} collisionPadding={12}>
        <SelectPrimitive.ScrollUpButton className="lh-select-scroll"><ChevronUp size={14} aria-hidden="true" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="lh-select-viewport">
          {options.map(option => <SelectPrimitive.Item key={option.value} value={option.value === '' ? emptyValue : option.value}
            disabled={option.disabled} title={option.title} className="lh-select-option" textValue={option.label}>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="lh-select-indicator"><Check size={15} aria-hidden="true" /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="lh-select-scroll"><ChevronDown size={14} aria-hidden="true" /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>{name && <input type="hidden" name={name} value={value} disabled={disabled} />}</>
}
