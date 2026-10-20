// Original Lingshu-Home wrapper around the installed Radix primitives (Apache-2.0).
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import { Check } from 'lucide-react'
import type { AriaAttributes } from 'react'
import '../form-controls.css'

type CheckboxProps = Pick<AriaAttributes, 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  id?: string
  name?: string
  disabled?: boolean
  required?: boolean
  className?: string
  'data-field-label'?: string
}

export function Checkbox({ checked, onCheckedChange, className = '', ...props }: CheckboxProps) {
  return <CheckboxPrimitive.Root checked={checked} onCheckedChange={next => onCheckedChange(next === true)}
    className={`lh-control-checkbox ${className}`} {...props}>
    <CheckboxPrimitive.Indicator className="lh-checkbox-indicator"><Check size={12} strokeWidth={3} aria-hidden="true" /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
}
