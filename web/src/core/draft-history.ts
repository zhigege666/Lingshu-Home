/** Bounded, in-memory snapshots. Revisions and persisted baselines live outside history. */
export const DRAFT_HISTORY_LIMIT = 60
export type DraftHistory<T> = { past: T[]; present: T; future: T[]; group?: object; changedAt?: number }
export function createDraftHistory<T>(value: T): DraftHistory<T> {
  return { past: [], present: structuredClone(value), future: [] }
}
export function recordDraft<T>(history: DraftHistory<T>, value: T, group?: object, at = Date.now()): DraftHistory<T> {
  if (JSON.stringify(history.present) === JSON.stringify(value)) return history
  const merge = group !== undefined && group === history.group && history.changedAt !== undefined && at >= history.changedAt && at - history.changedAt < 750
  return {
    past: merge ? history.past : [...history.past, history.present].slice(-DRAFT_HISTORY_LIMIT),
    present: structuredClone(value), future: [], group, changedAt: at,
  }
}
export function undoDraft<T>(history: DraftHistory<T>): DraftHistory<T> {
  if (!history.past.length) return history
  return { past: history.past.slice(0, -1), present: history.past[history.past.length - 1]!, future: [history.present, ...history.future] }
}
export function redoDraft<T>(history: DraftHistory<T>): DraftHistory<T> {
  if (!history.future.length) return history
  return { past: [...history.past, history.present].slice(-DRAFT_HISTORY_LIMIT), present: history.future[0]!, future: history.future.slice(1) }
}
const focusGroups = new WeakMap<Element, object>()
/** Called during an edit; a blur or pause creates a new typing step. No timer. */
export function inputHistoryGroup(ownerDocument: Document = document): object | undefined {
  const target = ownerDocument.activeElement
  if (!target || !['INPUT', 'TEXTAREA'].includes(target.tagName)) return undefined
  if (target.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'submit', 'file'].includes((target as HTMLInputElement).type)) return undefined
  let group = focusGroups.get(target)
  if (!group) {
    group = {}
    focusGroups.set(target, group)
    target.addEventListener('blur', () => focusGroups.delete(target), { once: true })
  }
  return group
}
