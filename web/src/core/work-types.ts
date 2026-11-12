export const workStatuses = ['todo', 'doing', 'waiting', 'done'] as const
export type WorkStatus = typeof workStatuses[number]
export type WorkProject = { id: string; spaceId: string; name: string; revision: string; archived: boolean; updatedAt: string }
export type WorkReference = { kind: 'bookmark' | 'document'; id: string; title: string; subtitle?: string; url?: string; available: boolean }
export type WorkSummary = {
  id: string; spaceId: string; projectId: string | null; projectName: string; title: string; status: WorkStatus;
  revision: string; archived: boolean; updatedAt: string; nextStep: string; needsAttention: boolean; referenceCount: number
}
export type WorkItem = WorkSummary & {
  boardRevision: string; description: string; result: string; bookmarkIds: string[]; documentIds: string[]; references: WorkReference[]
}
export type WorkColumn = { status: WorkStatus; total: number; items: WorkSummary[]; nextCursor: string | null }
export type WorkBoard = { revision: string; canEdit: boolean; columns: WorkColumn[] }
export type WorkPage = { revision: string; canEdit: boolean; items: WorkSummary[]; total: number; nextCursor: string | null }
export type WorkDraft = Pick<WorkItem, 'title' | 'projectId' | 'status' | 'description' | 'nextStep' | 'result' | 'needsAttention' | 'bookmarkIds' | 'documentIds'>
export type WorkSelection = { id: string; create?: boolean; status?: WorkStatus; projectId?: string | null; reference?: WorkReference }
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
