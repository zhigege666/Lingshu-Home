import { useId, useState, type CSSProperties } from 'react'
import { Trash2 } from 'lucide-react'
import { ConfirmPopover } from '../components/ConfirmPopover'
import { Button } from '../components/ui/button'
import { t } from '../core/i18n'

export function HomeContentDeleteButton({ name, disabled, onDelete, compact = false }: {
  name: string; disabled?: boolean; onDelete: () => void; compact?: boolean
}) {
  const id = useId(), [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [theme, setTheme] = useState<CSSProperties>({})
  const label = t('删除链接 {name}', 'Delete link {name}', { name })
  return <>
    <button type="button" className={compact ? 'lh-nav-edit-button lh-content-delete-link' : 'lh-quiet-button lh-content-delete-action'}
      disabled={disabled} aria-label={label} title={compact ? t('删除链接', 'Delete link') : undefined}
      aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? id : undefined}
      onClick={event => {
        event.stopPropagation()
        const computed = getComputedStyle(event.currentTarget)
        setTheme({ colorScheme: computed.colorScheme, ...Object.fromEntries([
          ['--admin-bg', '--lh-bg'], ['--admin-card', '--lh-surface'], ['--admin-ink', '--lh-ink'],
          ['--admin-muted', '--lh-muted'], ['--admin-border', '--lh-line'], ['--admin-accent', '--lh-accent'],
        ].map(([target, source]) => [target, computed.getPropertyValue(source!)])) })
        setAnchor(anchor ? null : event.currentTarget)
      }}>
      <Trash2 size={compact ? 14 : 16} aria-hidden="true"/>{!compact && t('删除链接', 'Delete link')}
    </button>
    {anchor && <ConfirmPopover id={id} kind="link" anchor={anchor} title={t('删除「{name}」？', 'Delete “{name}”?', { name })} busy={disabled}
      className="lh-content-delete-confirm" style={theme}
      onClose={() => setAnchor(null)} getReturnFocus={() => anchor.isConnected ? anchor : document.querySelector<HTMLElement>('.lh-folder-dialog input[type=search],.lh-content-toolbar button:not(:disabled)')}>
      <p>{t('保存后生效，保存前可以撤销。', 'Applied on Save. You can undo before saving.')}</p>
      <div className="admin-form-footer"><Button variant="outline" data-confirm-cancel disabled={disabled} onClick={() => setAnchor(null)}>{t('保留', 'Keep')}</Button>
        <Button variant="destructive" disabled={disabled} onClick={() => { setAnchor(null); onDelete() }}>{t('确认删除', 'Delete link')}</Button></div>
    </ConfirmPopover>}
  </>
}
