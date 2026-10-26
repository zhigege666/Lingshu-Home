import { useId, type ReactNode } from 'react'
import { Info, X } from 'lucide-react'
import { Popover } from 'radix-ui'
import { t } from '../core/i18n'
import './field-help.css'

/** Optional guidance opens only on an explicit click or keyboard activation. */
export function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className="lh-field-help-trigger" aria-label={t('{label}说明', 'Help for {label}', { label })}>
        <Info size={15} aria-hidden="true"/>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="admin-ui lh-field-help" role="dialog" aria-labelledby={id}
        side="bottom" align="start" sideOffset={8} collisionPadding={16}>
        <div className="lh-field-help-heading"><h2 id={id}>{label}</h2><Popover.Close asChild>
          <button type="button" className="lh-field-help-close" aria-label={t('关闭说明', 'Close help')}><X size={15}/></button>
        </Popover.Close></div>
        <div className="lh-field-help-copy">{children}</div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
