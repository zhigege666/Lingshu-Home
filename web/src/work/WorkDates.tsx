import { CalendarDays, Clock } from 'lucide-react'
import { getLocale, t } from '../core/i18n'
import type { WorkSummary } from '../core/work-types'

export default function WorkDates({ item, terminal = false }: { item: WorkSummary; terminal?: boolean }) {
  if (!item.businessDate && !item.dueAt) return null
  const overdue = !terminal && !item.archived && !!item.dueAt && Date.parse(item.dueAt) < Date.now()
  return <div className="work-date-summary">
    {item.businessDate && <span><CalendarDays size={12}/><time dateTime={item.businessDate}>{item.businessDate}</time></span>}
    {item.dueAt && <span className={overdue ? 'overdue' : ''}><Clock size={12}/><time dateTime={item.dueAt}>{t('{date} 截止', 'Due {date}', { date: new Date(item.dueAt).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</time>{overdue && <span>{t('逾期', 'Overdue')}</span>}</span>}
  </div>
}
