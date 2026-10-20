import { t } from '../core/i18n'

/** Examples use normalized source contracts, separate from local navigation CRUD. */
export function sourceExample(schema: string): unknown {
  const now = Math.floor(Date.now() / 1000), tomorrow = new Date((now + 86400) * 1000).toISOString().slice(0, 10)
  if (schema === 'calendar.events') return { timezone: 'UTC', windowStart: now - 86400, windowEnd: now + 30 * 86400, events: [{ id: 'example-event', title: t('示例日程', 'Example event'), startAt: now + 3600, endAt: now + 7200, allDay: false, timezone: 'UTC', status: 'confirmed' }] }
  if (schema === 'weather.forecast') return { timezone: 'UTC', latitude: 0, longitude: 0, locationName: t('示例地点', 'Example location'), current: { time: now, temperature: 22, weatherCode: 1, isDay: true }, daily: [{ date: tomorrow, weatherCode: 1, temperatureMax: 24, temperatureMin: 17 }] }
  if (schema === 'metrics.summary') return { metrics: [{ id: 'cpu', label: 'CPU', value: 24, unit: '%', min: 0, max: 100, status: 'ok' }, { id: 'disk', label: t('磁盘', 'Disk'), value: null, unit: '%', min: 0, max: 100, status: 'unknown' }] }
  if (schema === 'status.collection') return { items: [{ id: 'api', label: 'API', status: 'up', latencyMs: 24, url: 'https://example.com' }] }
  return { categories: [{ externalId: 'tools', name: t('工具', 'Tools'), icon: 'lucide:folder', sortOrder: 0 }], links: [{ externalId: 'example', categoryExternalId: 'tools', title: t('示例入口', 'Example link'), url: 'https://example.com', description: t('替换为你的内容', 'Replace with your content'), icon: 'lucide:link', tags: [], isFavorite: false, sortOrder: 0, endpoints: [] }] }
}
