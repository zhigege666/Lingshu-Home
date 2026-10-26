import { t } from '../core/i18n'
import { panelContracts } from '../home/composition'

export const templateRenderers = () => [
  { value: 'builtin/navigation', label: t('书签导航', 'Bookmarks') },
  { value: 'builtin/favorites', label: t('常用收藏', 'Favorites') },
  { value: 'builtin/calendar', label: t('日程', 'Calendar') },
  { value: 'builtin/weather', label: t('天气', 'Weather') },
  { value: 'builtin/metrics', label: t('统计指标', 'Metrics') },
  { value: 'builtin/status', label: t('服务状态', 'Service status') },
  { value: 'builtin/github-traffic', label: 'GitHub Traffic' },
  { value: 'builtin/document-activity', label: t('文档活动', 'Document activity') }
]
export function componentTemplateExample(renderer: string) {
  const selected = templateRenderers().find(item => item.value === renderer) || templateRenderers()[0]!
  const settings = selected.value === 'builtin/document-activity' ? { presentation: 'heatmap', months: 6, perspective: 'mine', sourceIds: [], showSummary: true, recentLimit: 3, detailLayout: 'auto', timezone: 'local' }
    : selected.value === 'builtin/calendar' ? { viewMode: 'week' }
    : selected.value === 'builtin/weather' ? { forecastDays: 5 }
    : selected.value === 'builtin/metrics' ? { showBars: true }
    : selected.value === 'builtin/status' ? { showLatency: true } : {}
  return {
    format: 'lingshu-home-component', manifestVersion: 1,
    id: 'examples/' + selected.value.slice(8), version: '1.0.0', name: selected.label,
    description: t('使用自己的数据来源，并随页面主题显示。', 'Connect your own data source and use the current page theme.'),
    license: 'Apache-2.0', renderer: selected.value,
    dataSchema: { id: panelContracts[selected.value]!.schema, version: 1 },
    settings: { title: selected.label, ...settings }, layout: { width: 12, height: 8 }
  }
}
