import type { WorkStatusType, WorkSummary } from './work-types'

export type WorkPriority = '' | 'low' | 'normal' | 'high' | 'urgent'
export type WorkAssignee = { name: string; userId?: string }
export type WorkLabel = { id: string; name: string; color: string; archived: boolean; revision: string }
export type WorkVersion = { id: string; name: string; projectId: string | null; targetDate?: string; description: string; archived: boolean; revision: string }
export type WorkPlanning = { priority?: WorkPriority; labelIds?: string[]; assignee?: WorkAssignee | null; versionId?: string | null }
export type WorkPlanningDraft = { priority: WorkPriority; labelIds: string[]; assignee: WorkAssignee | null; versionId: string | null }
export type WorkCatalogPage<T> = { items: T[]; revision: string; canEdit: boolean; total: number; nextCursor: string | null; missingIds?: string[] }
export type WorkLink = { id: string; title: string; status: string; statusType: WorkStatusType; archived: boolean }
export type WorkRelations = { itemId: string; revision: string; parent: WorkLink | null; blockedBy: WorkLink[]; predecessor: WorkLink | null; childrenCount: number; blockedCount: number }
export type WorkRelationSummary = { parent: WorkLink | null; predecessor: WorkLink | null; childrenCount: number; blockedByCount: number; blockedCount: number; isBlocked: boolean }
export type WorkFilters = {
  q?: string; itemId?: string; projectId?: string; status?: string; archived?: boolean; attention?: boolean;
  date?: 'today' | 'overdue'; timezone?: string; businessDate?: string; priority?: Exclude<WorkPriority, ''> | 'none';
  labelIds?: string[]; assigneeUserId?: string; versionId?: string; parentId?: string; blocked?: boolean
}
export const workDisplayFields = ['id', 'priority', 'labels', 'assignee', 'version', 'project', 'nextStep', 'businessDate', 'dueAt', 'relations', 'collaboration'] as const
export type WorkDisplayField = typeof workDisplayFields[number]
export const defaultWorkFields: WorkDisplayField[] = ['id', 'priority', 'labels', 'assignee', 'version', 'project', 'nextStep', 'businessDate', 'dueAt', 'collaboration']
export type WorkLayout = 'board' | 'list' | 'calendar'
export type WorkCalendarBasis = 'businessDate' | 'dueAt'
export type WorkViewDefinition = { layout: WorkLayout; filters: WorkFilters; fields: WorkDisplayField[]; calendarBasis?: WorkCalendarBasis }
export type WorkSavedView = { id: string; name: string; visibility: 'private' | 'shared'; ownerUserId: string; definition: WorkViewDefinition; revision: string; createdAt: string; updatedAt: string; canEdit: boolean }
export type WorkCalendarPage = { revision: string; from: string; to: string; timezone: string; basis: WorkCalendarBasis; items: (WorkSummary & { calendarDate: string })[]; days: { date: string; total: number }[]; total: number; nextCursor: string | null }
export type WorkStats = {
  from: string; to: string; timezone: string;
  current: { total: number; unarchived: number; unfinished: number; attention: number; overdue: number; blocked: number; byStatus: { status: string; type: WorkStatusType; unarchived: number; archived: number }[] };
  period: { created: number; completedItems: number; completionEvents: number; cancellationEvents: number };
  days: { date: string; created: number; completionEvents: number; cancellationEvents: number }[];
  durations: { cycle: { samples: number; unknown: number; open: number; medianSeconds: number | null; p95Seconds: number | null }; blocked: { samples: number; unknown: number; open: number; totalSeconds: number | null; medianSeconds: number | null; p95Seconds: number | null } };
  coverage: { activityFrom: string | null; blockingFrom: string | null; unknownCompletedAt: number; unknownBlockedAt: number }
}
export type WorkFeatureSettings = { enabled: boolean; revision: string; canEdit: boolean }
export type WorkNotice = { id: string; spaceId: string; kind: string; subjectType: string; subjectId: string; occurrenceKey: string; itemId?: string; code: string; message: string; count: number; firstAt: string; lastAt: string; readAt: string }
export type WorkNoticePage = { enabled: boolean; items: WorkNotice[]; total: number; nextCursor: string | null }
export type WorkNoticeSummary = { enabled: boolean; unreadCount: number; byKind: { kind: string; total: number; unread: number }[]; spaceFailures: { scheduleFailed: number; automationFailed: number; executionFailed: number; executionUnknown: number } }

export function planningDraft(value?: WorkPlanning): WorkPlanningDraft {
  return { priority: value?.priority || '', labelIds: [...(value?.labelIds || [])], assignee: value?.assignee ? { ...value.assignee } : null, versionId: value?.versionId || null }
}
export function normalizePlanning(value: WorkPlanningDraft): WorkPlanningDraft {
  const name = value.assignee?.name.trim()
  return { priority: value.priority, labelIds: [...new Set(value.labelIds)].sort(), assignee: name ? { name, ...(value.assignee?.userId ? { userId: value.assignee.userId } : {}) } : null, versionId: value.versionId || null }
}
/** New items/templates keep their compact legacy payload when planning is unused. */
export function omitEmptyPlanning<T extends WorkPlanning>(value: T): T {
  const result = { ...value }
  if (!result.priority) delete result.priority
  if (!result.labelIds?.length) delete result.labelIds
  if (!result.assignee) delete result.assignee
  if (!result.versionId) delete result.versionId
  return result
}
const filterKeys = ['q', 'itemId', 'projectId', 'status', 'archived', 'attention', 'date', 'timezone', 'businessDate', 'priority', 'labelIds', 'assigneeUserId', 'versionId', 'parentId', 'blocked'] as const
export function workFilterParams(filters: WorkFilters, fields?: WorkDisplayField[]): URLSearchParams {
  const result = new URLSearchParams()
  for (const key of filterKeys) {
    const value = filters[key]
    if (value === undefined || value === '' || value === null) continue
    if (Array.isArray(value)) value.forEach(id => result.append(key, id))
    else result.set(key, String(value))
  }
  // Only relations requires additional server-side summary work.
  if (fields?.includes('relations')) result.append('fields', 'relations')
  return result
}
export function workFiltersFromParams(query: URLSearchParams): WorkFilters {
  const filters: WorkFilters = {}
  for (const key of filterKeys) {
    if (key === 'labelIds') { const ids = query.getAll(key).filter(Boolean); if (ids.length) filters.labelIds = ids; continue }
    const value = query.get(key)
    if (!value) continue
    if (key === 'archived' || key === 'attention' || key === 'blocked') { if (value === 'true' || value === 'false') filters[key] = value === 'true'; continue }
    if (key === 'date' && value !== 'today' && value !== 'overdue') continue
    if (key === 'priority' && !['low', 'normal', 'high', 'urgent', 'none'].includes(value)) continue
    Object.assign(filters, { [key]: value })
  }
  return filters
}
