import { getLocale, t } from '../core/i18n'
import type { WorkSchedule } from '../core/work-schedule-types'

export function scheduleTime(value: string, timezone?: string): string {
  return value ? new Date(value).toLocaleString(getLocale(), { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
}
export function scheduleRuleLabel(rule: WorkSchedule['rule']): string {
  const days = [t('一', 'Mon'), t('二', 'Tue'), t('三', 'Wed'), t('四', 'Thu'), t('五', 'Fri'), t('六', 'Sat'), t('日', 'Sun')]
  const cadence = rule.frequency === 'daily' ? t('每天', 'Daily') : rule.frequency === 'weekdays' ? t('周一至周五', 'Mon–Fri') : rule.frequency === 'weekly' ? t('每周 {days}', 'Weekly: {days}', { days: (rule.weekdays || []).map(day => days[day - 1]).join('、') }) : t('每月 {day} 日', 'Day {day} of each month', { day: rule.monthDay || 1 })
  return `${cadence} · ${rule.time}`
}
export function occurrenceLabel(result: string): string {
  return ({ created: t('已生成', 'Created'), skipped: t('已跳过', 'Skipped'), failed: t('生成失败', 'Failed') })[result] || '—'
}
