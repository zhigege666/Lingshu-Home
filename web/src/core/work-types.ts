/** State identifiers belong to the space catalog and never follow display names. */
export type WorkStatus = string
export const workStatusTypes = ['todo', 'doing', 'waiting', 'done', 'canceled'] as const
export type WorkStatusType = typeof workStatusTypes[number]
export type WorkStatusDefinition = {
  id: WorkStatus; name: string; type: WorkStatusType; color: string; description: string;
  position: number; isDefault: boolean; total?: number; archivedTotal?: number
}
export type WorkStatusCatalog = { revision: string; defaultStatus: WorkStatus; canEdit: boolean; items: WorkStatusDefinition[] }
export type WorkStatusBatch = {
  expectedRevision: string;
  create?: Pick<WorkStatusDefinition, 'id' | 'name' | 'type' | 'color' | 'description'>[];
  patches?: (Pick<WorkStatusDefinition, 'id'> & Partial<Pick<WorkStatusDefinition, 'name' | 'type' | 'color' | 'description'>>)[];
  order?: WorkStatus[]; deletions?: { id: WorkStatus; moveToStatus?: WorkStatus }[]; defaultStatus?: WorkStatus
}
export type WorkStatusContext = { statuses: WorkStatusDefinition[]; statusRevision: string; defaultStatus: WorkStatus }
export type WorkProject = { id: string; spaceId: string; name: string; revision: string; archived: boolean; updatedAt: string }
export type WorkReference = { kind: 'bookmark' | 'document'; id: string; title: string; subtitle?: string; url?: string; available: boolean }
export type WorkSessionSummary = { id: string; agentName: string; clientName: string; role: string }
export type WorkSession = WorkSessionSummary & { spaceId: string; actor: { id: string; name: string }; createdAt: string; lastSeenAt: string; closedAt?: string }
export type WorkHandoff = { completed: string; workspace: string; nextStep: string; unknowns: string }
export type WorkCollaborationSummary = {
  enabled: boolean; state: 'unclaimed' | 'active' | 'expired' | 'released'; claimId?: string; generation: string;
  session?: WorkSession; expiresAt?: string; lastSeenAt?: string; lastProgressAt?: string;
  latestHandoff?: WorkHandoff; unresolved: boolean; canResolve: boolean; serverTime: string
}
export type WorkCollaborationContext = { enabled: boolean; effectiveEnabled: boolean; version: string; serverTime: string; defaultLeaseSeconds: number; minLeaseSeconds: number; maxLeaseSeconds: number }
export type WorkEvent = {
  id: string; sequence: string; operationId?: string; itemId: string; kind: string; body: string; occurredAt: string;
  origin: 'web' | 'api' | 'mcp'; actor: { id: string; name: string } | null; session?: WorkSessionSummary; handoff?: WorkHandoff
}
export type WorkEventPage = { itemId: string; items: WorkEvent[]; highWatermark: string; nextCursor: string | null; nextAfter: string }
export type WorkSummary = {
  id: string; spaceId: string; projectId: string | null; projectName: string; title: string; status: WorkStatus;
  revision: string; archived: boolean; updatedAt: string; nextStep: string; needsAttention: boolean; referenceCount: number; collaboration?: WorkCollaborationSummary
}
export type WorkItem = WorkSummary & {
  boardRevision: string; description: string; result: string; createdAt: string; bookmarkIds: string[]; documentIds: string[]; references: WorkReference[]; statusDefinition?: WorkStatusDefinition
}
export type WorkActivityChange = {
  field: string; before?: boolean | { id: string; name: string; type?: WorkStatusType } | null;
  after?: boolean | { id: string; name: string; type?: WorkStatusType } | null; added?: number; removed?: number
}
export type WorkActivityEvent = {
  id: string; action: 'create' | 'update' | 'move' | 'archive' | 'restore' | 'status_migrate' | 'status_definition';
  occurredAt: string; itemRevision: string; actor: { id: string; name: string } | null; origin: 'web' | 'api' | 'mcp'; changes: WorkActivityChange[]; session?: WorkSessionSummary
}
export type WorkActivityPage = { itemId: string; revision: string; historyStartedAt: string; historyComplete: boolean; items: WorkActivityEvent[]; nextCursor: string | null }
export type WorkColumn = { status: WorkStatus; total: number; items: WorkSummary[]; nextCursor: string | null }
export type WorkBoard = WorkStatusContext & { revision: string; collaborationRevision?: string; canEdit: boolean; columns: WorkColumn[] }
export type WorkPage = WorkStatusContext & { revision: string; collaborationRevision?: string; canEdit: boolean; items: WorkSummary[]; total: number; nextCursor: string | null }
export type WorkDraft = Pick<WorkItem, 'title' | 'projectId' | 'status' | 'description' | 'nextStep' | 'result' | 'needsAttention' | 'bookmarkIds' | 'documentIds'>
export type WorkSelection = { id: string; create?: boolean; status?: WorkStatus; projectId?: string | null; needsAttention?: boolean; reference?: WorkReference }
export const workPath = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/work`
export function newWorkId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('')
}
export function workDraft(item?: Partial<WorkItem>): WorkDraft {
  return { title: item?.title || '', projectId: item?.projectId || null, status: item?.status || 'todo', description: item?.description || '', nextStep: item?.nextStep || '', result: item?.result || '', needsAttention: item?.needsAttention || false, bookmarkIds: [...(item?.bookmarkIds || [])], documentIds: [...(item?.documentIds || [])] }
}
export function normalizeWorkDraft(draft: WorkDraft): WorkDraft {
  return { ...draft, title: draft.title.trim(), bookmarkIds: [...new Set(draft.bookmarkIds)].sort(), documentIds: [...new Set(draft.documentIds)].sort() }
}
export function changedWorkFields(before: WorkDraft, after: WorkDraft): Partial<WorkDraft> {
  const left = normalizeWorkDraft(before), right = normalizeWorkDraft(after)
  return Object.fromEntries((Object.keys(right) as (keyof WorkDraft)[]).filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])).map(key => [key, right[key]]))
}
export function workLibraryHref(spaceId: string, reference?: WorkReference): string {
  const query = new URLSearchParams({ space: spaceId })
  if (reference) query.set(reference.kind === 'document' ? 'document' : 'bookmark', reference.id)
  return `#/library?${query}`
}
export function workCreateHref(spaceId: string, kind: 'bookmark' | 'document', id: string, title: string): string {
  return '#/library?' + new URLSearchParams({ view: 'board', space: spaceId, new: '1', resourceKind: kind, resourceId: id, title })
}
export function workItemHref(spaceId: string, itemId: string): string {
  return '#/library?' + new URLSearchParams({ view: 'board', space: spaceId, item: itemId })
}
