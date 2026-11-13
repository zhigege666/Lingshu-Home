import { getLocale, t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import './work-activity.css'

export function WorkUpdatedTime({ value, label = true }: { value: string; label?: boolean }) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const text = date.toLocaleString(getLocale(), {
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const full = t('更新于 {time}', 'Updated {time}', { time: formatUpdated(value) })
  return <time className="work-updated-time" dateTime={value} title={full} aria-label={full}>{label ? t('更新 {time}', 'Updated {time}', { time: text }) : text}</time>
}
