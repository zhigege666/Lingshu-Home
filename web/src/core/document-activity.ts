/** Shared settings and calendar math for all document activity presentations. */
export type ActivityPresentation = 'heatmap' | 'split' | 'month'
export type ActivityPerspective = 'mine' | 'library'
export type DocumentActivitySettings = {
  presentation: ActivityPresentation
  months: 3 | 6 | 12
  perspective: ActivityPerspective
  sourceIds: string[]
  showSummary: boolean
  recentLimit: 0 | 3 | 5
  detailLayout: 'auto' | 'side' | 'below'
  timezone: string
}
export type ActivityDay = { date: string; count: number; created: number; updated: number }
export type ActivityDocument = {
  documentId: string; title: string; relativePath: string; sourceId: string; sourceName: string
  date: string; lastAt: string; count: number; actions: string[]; origins: string[]; status: string
}
export type ActivitySource = { id: string; name: string; status: string; lastScanAt?: string; recordedFrom?: string }
export type DocumentActivityData = {
  timezone: string; from: string; to: string; perspective: ActivityPerspective; recordedFrom: string
  days: ActivityDay[]; summary: { documents: number; activeDays: number }
  items: ActivityDocument[]; total: number; hasMore: boolean; sources: ActivitySource[]
}
export type DocumentActivityQuery = {
  from: string; to: string; timezone: string; perspective: ActivityPerspective
  sourceIds: string[]; date?: string; limit?: number; offset?: number
}

export function validActivityTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100 || value === 'Local' || /^[+-]/.test(value) || /^(?:UTC|GMT)[+-]/i.test(value)) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true } catch { return false }
}

export function readDocumentActivitySettings(input: Record<string, unknown> = {}): DocumentActivitySettings {
  return {
    presentation: input.presentation === 'split' || input.presentation === 'month' ? input.presentation : 'heatmap',
    months: input.months === 3 || input.months === 12 ? input.months : 6,
    perspective: input.perspective === 'library' ? 'library' : 'mine',
    sourceIds: Array.isArray(input.sourceIds) ? [...new Set(input.sourceIds.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)))].slice(0, 100).sort() : [],
    showSummary: input.showSummary !== false,
    recentLimit: input.recentLimit === 0 || input.recentLimit === 5 ? input.recentLimit : 3,
    detailLayout: input.detailLayout === 'side' || input.detailLayout === 'below' ? input.detailLayout : 'auto',
    timezone: input.timezone === 'local' || !validActivityTimezone(input.timezone) ? 'local' : new Intl.DateTimeFormat('en', { timeZone: input.timezone }).resolvedOptions().timeZone,
  }
}

export function activityTimezone(setting: string, browserTimezone?: string): string {
  if (setting !== 'local' && validActivityTimezone(setting)) return new Intl.DateTimeFormat('en', { timeZone: setting }).resolvedOptions().timeZone
  const candidate = browserTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone
  return validActivityTimezone(candidate) ? new Intl.DateTimeFormat('en', { timeZone: candidate }).resolvedOptions().timeZone : 'UTC'
}

export function activityDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-')
}

export function validActivityDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value
}

// Calendar calculations use UTC noon as a date-only value; event bucketing uses the requested IANA timezone.
export function activityAddDays(day: string, count: number): string {
  const value = new Date(day + 'T12:00:00Z')
  value.setUTCDate(value.getUTCDate() + count)
  return value.toISOString().slice(0, 10)
}
export function activityMonthStart(day: string, offset = 0): string {
  const value = new Date(day.slice(0, 7) + '-01T12:00:00Z')
  value.setUTCMonth(value.getUTCMonth() + offset)
  return value.toISOString().slice(0, 10)
}
export function activityMonthWindow(month: string, today: string): { from: string; to: string } {
  const from = activityMonthStart(month), last = activityAddDays(activityMonthStart(month, 1), -1)
  return { from, to: last < today ? last : today }
}
export function activityWindow(today: string, months: number, offset = 0): { from: string; to: string } {
  const endMonth = activityMonthStart(today, offset * months)
  return {
    from: activityMonthStart(endMonth, 1 - months),
    to: offset === 0 ? today : activityAddDays(activityMonthStart(endMonth, 1), -1),
  }
}
export function activityCalendarDays(from: string, to: string): string[] {
  const weekday = (new Date(from + 'T12:00:00Z').getUTCDay() + 6) % 7
  const start = activityAddDays(from, -weekday)
  const lastWeekday = (new Date(to + 'T12:00:00Z').getUTCDay() + 6) % 7
  const end = activityAddDays(to, 6 - lastWeekday)
  const result: string[] = []
  for (let date = start; date <= end && result.length < 380; date = activityAddDays(date, 1)) result.push(date)
  return result
}
export function activityHeatLevel(count: number): number {
  return count <= 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4
}
export function activityRecordedDate(recordedFrom: string, timezone: string): string | null {
  if (!recordedFrom) return null
  const value = new Date(recordedFrom)
  return Number.isFinite(value.getTime()) ? activityDateKey(value, timezone) : null
}
export function documentActivityQueryKey(query: DocumentActivityQuery): string {
  const parameters = new URLSearchParams({ from: query.from, to: query.to, timezone: query.timezone, perspective: query.perspective })
  const sources = [...new Set(query.sourceIds)].sort()
  if (sources.length) parameters.set('sourceIds', sources.join(','))
  if (query.date) parameters.set('date', query.date)
  parameters.set('limit', String(query.limit ?? 20))
  parameters.set('offset', String(query.offset ?? 0))
  return parameters.toString()
}
export function activityDocumentHref(spaceId: string, documentId: string): string {
  return '#/library?' + new URLSearchParams({ document: documentId, space: spaceId })
}

export function isDocumentActivityData(value: unknown): value is DocumentActivityData {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<DocumentActivityData>
  return validActivityDate(data.from) && validActivityDate(data.to) && validActivityTimezone(data.timezone)
    && typeof data.recordedFrom === 'string' && !!data.summary
    && typeof data.summary.documents === 'number' && typeof data.summary.activeDays === 'number'
    && Array.isArray(data.days) && data.days.every(day => validActivityDate(day.date) && Number.isFinite(day.count) && day.count >= 0)
    && Array.isArray(data.items) && data.items.every(item => typeof item.documentId === 'string' && typeof item.title === 'string'
      && typeof item.relativePath === 'string' && typeof item.sourceName === 'string' && typeof item.lastAt === 'string'
      && Array.isArray(item.actions) && Array.isArray(item.origins))
    && Array.isArray(data.sources) && typeof data.total === 'number' && typeof data.hasMore === 'boolean'
}
