import { useEffect, useId, useState, type ComponentType } from 'react'
import { request } from '../core/api'
import { t } from '../core/i18n'
import { readDocumentActivitySettings } from '../core/document-activity'
import type { DocumentSourceList } from '../core/library-types'
import type { View } from '../core/types'
import type { NavigationCheckProps, NavigationSelectProps } from './NavigationContentFields'
import { Input } from './ui/input'
import './document-activity-fields.css'

type Props = {
  view: View; views: View[]; spaceId?: string; disabled: boolean
  SelectControl: ComponentType<NavigationSelectProps>; CheckControl: ComponentType<NavigationCheckProps>
  onChange: (values: Record<string, unknown>) => void; onScopeChange: (scope?: string) => void
}

/** The same per-instance contract in both page editors. */
export function DocumentActivityFields({ view, views, spaceId, disabled, SelectControl, CheckControl, onChange, onScopeChange }: Props) {
  const value = readDocumentActivitySettings(view.settings)
  const [directories, setDirectories] = useState<{ id: string; name: string; enabled: boolean }[]>([])
  const [error, setError] = useState(false), [retry, setRetry] = useState(0)
  const listId = useId()
  useEffect(() => {
    const abort = new AbortController(); setDirectories([]); setError(false)
    if (spaceId) request<DocumentSourceList>(`/spaces/${encodeURIComponent(spaceId)}/document-sources`, { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setDirectories(result.items) })
      .catch(() => { if (!abort.signal.aborted) setError(true) })
    return () => abort.abort()
  }, [spaceId, retry])
  const names = [...new Set(views.filter(item => item.panel.id === 'builtin/document-activity').map(item => item.interactionScope).filter((scope): scope is string => !!scope && !scope.startsWith('independent:')))]
  const scope = view.interactionScope && !view.interactionScope.startsWith('independent:') ? view.interactionScope.replace(/^activity:/, '') : ''
  const unavailable = value.sourceIds.filter(id => !directories.some(source => source.id === id))
  const zones = ['local', 'UTC', ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Shanghai']), ...(value.timezone !== 'local' ? [value.timezone] : [])].filter((zone, index, all) => all.indexOf(zone) === index)
  return <div className="document-activity-fields" data-document-activity-settings>
    <SelectControl label={t('展示样式', 'Presentation')} value={value.presentation} disabled={disabled} options={[
      { value: 'heatmap', label: t('热力图', 'Heatmap') }, { value: 'split', label: t('热力图与记录', 'Heatmap and records') }, { value: 'month', label: t('月历', 'Calendar') }
    ]} onChange={presentation => onChange({ presentation })}/>
    <SelectControl label={t('统计视角', 'Activity scope')} value={value.perspective} disabled={disabled} options={[
      { value: 'mine', label: t('我的编辑', 'My edits') }, { value: 'library', label: t('文档库变更', 'Library changes') }
    ]} onChange={perspective => onChange({ perspective })}/>
    {value.presentation !== 'month' && <SelectControl label={t('时间范围', 'Time range')} value={String(value.months)} disabled={disabled} options={[3, 6, 12].map(months => ({ value: String(months), label: t('近 {count} 个月', 'Last {count} months', { count: months }) }))} onChange={months => onChange({ months: Number(months) })}/>}
    {value.presentation === 'split' && <SelectControl label={t('明细位置', 'Record position')} value={value.detailLayout} disabled={disabled} options={[
      { value: 'auto', label: t('自动', 'Automatic') }, { value: 'side', label: t('右侧', 'Right') }, { value: 'below', label: t('下方', 'Below') }
    ]} onChange={detailLayout => onChange({ detailLayout })}/>}
    <SelectControl label={t('最近记录', 'Recent records')} value={String(value.recentLimit)} disabled={disabled} options={[
      { value: '0', label: t('隐藏', 'Hidden') }, ...[3, 5].map(count => ({ value: String(count), label: t('{count} 条', '{count} records', { count }) }))
    ]} onChange={recentLimit => onChange({ recentLimit: Number(recentLimit) })}/>
    <CheckControl label={t('显示摘要', 'Show summary')} checked={value.showSummary} disabled={disabled} onChange={showSummary => onChange({ showSummary })}/>
    <SelectControl label={t('时区', 'Time zone')} value={value.timezone} disabled={disabled} options={zones.map(zone => ({ value: zone, label: zone === 'local' ? t('跟随浏览器', 'Browser time zone') : zone }))} onChange={timezone => onChange({ timezone })}/>
    <fieldset className="document-activity-directories"><legend>{t('文档目录', 'Document directories')}</legend>
      <CheckControl label={t('全部目录', 'All directories')} checked={value.sourceIds.length === 0} disabled={disabled} onChange={checked => { if (checked) onChange({ sourceIds: [] }) }}/>
      {directories.map(source => <CheckControl key={source.id} label={source.name} checked={value.sourceIds.includes(source.id)} disabled={disabled} onChange={checked => onChange({ sourceIds: checked ? [...value.sourceIds, source.id] : value.sourceIds.filter(id => id !== source.id) })}/>)}
      {unavailable.map(id => <CheckControl key={id} label={t('不可用目录', 'Unavailable directory')} checked disabled={disabled} onChange={checked => { if (!checked) onChange({ sourceIds: value.sourceIds.filter(item => item !== id) }) }}/>)}
      {error && <button type="button" className="document-activity-fields-retry" disabled={disabled} onClick={() => setRetry(current => current + 1)}>{t('重新读取目录', 'Reload directories')}</button>}
    </fieldset>
    <label className="document-activity-scope-field"><span>{t('日期联动组', 'Date linking group')}</span><Input list={listId} value={scope} maxLength={71} disabled={disabled} placeholder={t('独立', 'Independent')} title={t('相同组名共享选中日期', 'Matching group names share the selected date')} onChange={event => onScopeChange(event.target.value.trim() ? 'activity:' + event.target.value : undefined)}/></label>
    <datalist id={listId}>{names.map(name => <option key={name} value={name.replace(/^activity:/, '')}/>)}</datalist>
  </div>
}
