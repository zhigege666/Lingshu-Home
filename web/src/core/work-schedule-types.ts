import { planningDraft, normalizePlanning, type WorkPlanning } from './work-planning-types'
import { workDraft, type WorkItem, type WorkReference } from './work-types'
import { workToday, workTimezone } from '../work/work-dates'

export type WorkScheduleTemplate = WorkPlanning & Pick<WorkItem, 'title' | 'projectId' | 'status' | 'description' | 'nextStep' | 'needsAttention' | 'bookmarkIds' | 'documentIds'>
export type WorkScheduleRule = {
  frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly'; time: string; timezone: string;
  startDate: string; endDate?: string; weekdays?: number[]; monthDay?: number;
  monthPolicy?: 'skip' | 'last_day'; dueTime?: string; dueDayOffset?: number; dueAfterMinutes?: number
}
export type WorkScheduleDraft = {
  name: string; template: WorkScheduleTemplate; rule: WorkScheduleRule; enabled: boolean;
  missedPolicy: 'latest' | 'skip' | 'all'; overlapPolicy: 'create' | 'skip'
}
export type WorkSchedule = WorkScheduleDraft & {
  id: string; spaceId: string; archived: boolean; revision: string; createdAt: string; updatedAt: string;
  nextRunAt: string; lastRunAt: string; lastResult: string; lastError: string
  references?: WorkReference[]
}
export type WorkScheduleResponse = { schedule: WorkSchedule; canEdit: boolean }
export type WorkSchedulePage = { items: WorkSchedule[]; total: number; nextCursor: string | null; canEdit: boolean }
export type WorkScheduleOccurrence = {
  businessDate: string; scheduledAt: string; dueAt?: string; itemId: string | null;
  result: 'created' | 'skipped' | 'failed'; reason: string; occurredAt: string; templateRevision: string
}
export type WorkScheduleOccurrences = { items: WorkScheduleOccurrence[]; nextCursor: string | null }
export type WorkSchedulePreview = { items: { businessDate: string; scheduledAt: string; dueAt: string }[]; timezone: string }
export type WorkScheduleSelection = { id: string; create?: boolean; source?: WorkItem; projectId?: string | null }

export function scheduleDraft(source?: Partial<WorkSchedule>, item?: WorkItem, projectId?: string | null, status = 'todo'): WorkScheduleDraft {
  const base = workDraft(item)
  return {
    name: source?.name || item?.title || '',
    template: source?.template ? { ...structuredClone(source.template), ...planningDraft(source.template) } : {
      ...planningDraft(item),
      title: item?.title || '', projectId: item?.projectId || projectId || null, status,
      description: base.description, nextStep: base.nextStep, needsAttention: base.needsAttention,
      bookmarkIds: [...base.bookmarkIds], documentIds: [...base.documentIds]
    },
    rule: source?.rule ? structuredClone(source.rule) : { frequency: 'daily', time: '09:00', timezone: workTimezone(), startDate: workToday(), endDate: '', dueTime: '', dueDayOffset: 0 },
    enabled: source?.enabled ?? true, missedPolicy: source?.missedPolicy || 'latest', overlapPolicy: source?.overlapPolicy || 'create'
  }
}

export function normalizeSchedule(draft: WorkScheduleDraft): WorkScheduleDraft {
  const rule = { ...draft.rule, timezone: draft.rule.timezone.trim() }
  if (rule.frequency === 'weekly') rule.weekdays = [...(rule.weekdays || [])].sort((a, b) => a - b)
  else delete rule.weekdays
  if (rule.frequency !== 'monthly') { delete rule.monthDay; delete rule.monthPolicy }
  if (rule.dueAfterMinutes !== undefined) { delete rule.dueTime; delete rule.dueDayOffset }
  else if (!rule.dueTime) { delete rule.dueTime; delete rule.dueDayOffset }
  if (!rule.endDate) delete rule.endDate
  return { ...draft, name: draft.name.trim(), template: { ...draft.template, ...normalizePlanning(planningDraft(draft.template)), title: draft.template.title.trim(), bookmarkIds: [...new Set(draft.template.bookmarkIds)].sort(), documentIds: [...new Set(draft.template.documentIds)].sort() }, rule }
}

export function scheduleChanges(base: WorkScheduleDraft, value: WorkScheduleDraft): Partial<WorkScheduleDraft> {
  const before = normalizeSchedule(base), after = normalizeSchedule(value)
  return Object.fromEntries((Object.keys(after) as (keyof WorkScheduleDraft)[]).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => [key, after[key]]))
}

/** Preserve concurrent fields the draft did not change, including nested rules. */
export function mergeScheduleDraft(base: WorkScheduleDraft, draft: WorkScheduleDraft, latest: WorkScheduleDraft): WorkScheduleDraft {
  const result = structuredClone(latest)
  for (const key of ['name', 'enabled', 'missedPolicy', 'overlapPolicy'] as const) {
    if (base[key] !== draft[key]) Object.assign(result, { [key]: draft[key] })
  }
  for (const group of ['template', 'rule'] as const) {
    const original = base[group] as unknown as Record<string, unknown>, intended = draft[group] as unknown as Record<string, unknown>
    const target = result[group] as unknown as Record<string, unknown>
    for (const key of new Set([...Object.keys(original), ...Object.keys(intended)])) {
      if (JSON.stringify(original[key]) === JSON.stringify(intended[key])) continue
      if (intended[key] === undefined) delete target[key]
      else target[key] = structuredClone(intended[key])
    }
  }
  return normalizeSchedule(result)
}
