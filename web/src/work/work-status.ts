import type { WorkStatus, WorkStatusDefinition } from '../core/work-types'
export const workStatusLabel = (status: WorkStatus, statuses: WorkStatusDefinition[]) => statuses.find(item => item.id === status)?.name || status
