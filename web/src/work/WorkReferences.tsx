import { ArrowUpRight, FileText, Link2, Plus, X } from 'lucide-react'
import { t } from '../core/i18n'
import { safeHref } from '../core/presentation'
import { requestNavigation } from '../core/navigation'
import { workLibraryHref, type WorkReference } from '../core/work-types'
import { Button } from '../components/ui/button'
import ResourcePicker from './ResourcePicker'

type Props = { spaceId: string; references: WorkReference[]; documentsEnabled: boolean; editable: boolean; busy: boolean; picker: boolean; onPickerChange: (open: boolean) => void; onToggle: (reference: WorkReference) => void }
export default function WorkReferences({ spaceId, references, documentsEnabled, editable, busy, picker, onPickerChange, onToggle: toggleReference }: Props) {
  return <section className="work-reference-section"><header><h3>{t('关联资料', 'Linked resources')}</h3>{editable && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onPickerChange(!picker)}><Plus size={14}/>{t('关联资料', 'Link resources')}</Button>}</header>
          <div className="work-references">{references.map(item => {
            const available = item.available && (item.kind !== 'document' || documentsEnabled)
            const direct = !documentsEnabled && item.kind === 'bookmark'
            const href = available ? direct ? safeHref(item.url || '') : workLibraryHref(spaceId, item) : undefined
            return <div key={`${item.kind}:${item.id}`} className={!available ? 'unavailable' : ''}>
              {item.kind === 'document' ? <FileText size={16}/> : <Link2 size={16}/>}
              {href ? <a href={href} target={direct ? '_blank' : undefined} rel={direct ? 'noopener noreferrer' : undefined} onClick={event => {
                if (direct || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
                event.preventDefault(); requestNavigation(() => { window.location.hash = href })
              }} title={item.title}>{item.title}</a> : <span className="work-reference-unavailable">{available ? item.title : t('资料暂不可用', 'Resource unavailable')}</span>}
              {documentsEnabled && item.kind === 'bookmark' && available && item.url && <a href={safeHref(item.url)} target="_blank" rel="noopener noreferrer" aria-label={t('打开书签：{title}', 'Open bookmark: {title}', { title: item.title })}><ArrowUpRight size={14}/></a>}
              {editable && (item.kind !== 'document' || documentsEnabled) && <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t('取消关联：{title}', 'Unlink: {title}', { title: item.title })} onClick={() => toggleReference(item)}><X size={13}/></Button>}
            </div>
          })}</div>
          {picker && <ResourcePicker spaceId={spaceId} selected={references} disabled={busy} documentsEnabled={documentsEnabled} onToggle={toggleReference} onClose={() => onPickerChange(false)}/>}
        </section>
}
