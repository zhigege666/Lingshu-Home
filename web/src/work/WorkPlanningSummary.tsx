import { GitBranch, Tag, UserRound } from 'lucide-react'
import { t } from '../core/i18n'
import type { WorkSummary } from '../core/work-types'
import type { WorkDisplayField } from '../core/work-planning-types'

const priorityLabel = (value: string) => ({ low: t('低', 'Low'), normal: t('普通', 'Normal'), high: t('高', 'High'), urgent: t('紧急', 'Urgent') })[value] || ''
export default function WorkPlanningSummary({ item, fields }: { item: WorkSummary; fields: WorkDisplayField[] }) {
  const has = (field: WorkDisplayField) => fields.includes(field)
  return <div className="work-planning-summary">
    {has('priority') && item.priority && <span className={`work-priority work-priority-${item.priority}`}>{priorityLabel(item.priority)}</span>}
    {has('assignee') && item.assignee && <span title={item.assignee.userId ? t('已关联账号：{name}', 'Linked account: {name}', { name: item.assignee.name }) : item.assignee.name}><UserRound size={12}/>{item.assignee.name}</span>}
    {has('version') && item.version && <span><Tag size={12}/>{item.version.name}</span>}
    {has('labels') && item.labels?.map(label => <span className="work-summary-label" key={label.id}><i style={{ backgroundColor: label.color }}/>{label.name}</span>)}
    {has('relations') && item.relations && <>
      {item.relations.parent && <span><GitBranch size={12}/>{item.relations.parent.id}</span>}
      {item.relations.childrenCount > 0 && <span>{t('{count} 个子项', '{count} children', { count: item.relations.childrenCount })}</span>}
      {item.relations.isBlocked && <span className="work-blocked-count">{t('{count} 项阻塞', '{count} blockers', { count: item.relations.blockedCount })}</span>}
    </>}
  </div>
}
