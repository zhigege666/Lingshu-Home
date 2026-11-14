import type { WorkReference } from './work-types'
import type { WorkScheduleTemplate } from './work-schedule-types'
export type WorkAutomationTab = 'rules' | 'events' | 'executors' | 'executions'
export type WorkAutomationRule = {
  id: string; spaceId: string; name: string; eventType: string; projectId: string | null; statusId: string;
  template: WorkScheduleTemplate; executorId: string | null; enabled: boolean; archived: boolean; revision: string; createdAt: string; updatedAt: string; references: WorkReference[]
}
export type WorkAutomationRuleResponse = { rule: WorkAutomationRule; canEdit: boolean; canExecute: boolean }
export type WorkExecutorDefinition = {
  id: string; spaceId: string; name: string; endpoint: string; allowPrivateNetwork: boolean; resourceKey: string;
  pollIntervalSeconds: number; timeoutSeconds: number; enabled: boolean; archived: boolean; credentialConfigured: boolean; revision: string; createdAt: string; updatedAt: string
}
export type WorkExecutorResponse = { executor: WorkExecutorDefinition; canEdit: boolean; canExecute: boolean; activeExecutions: number }
export type WorkExecutionState = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'canceled'
export type WorkExecution = {
  id: string; spaceId: string; itemId: string; executorId: string; executorName: string; executorRevision: string; itemRevision: string; resourceKey: string; eventId: string | null;
  state: WorkExecutionState; revision: string; createdAt: string; startedAt: string; finishedAt: string; nextPollAt: string; deadlineAt: string; code: string; message: string; result: string; manualResolution: boolean
}
export type WorkExecutionResponse = { execution: WorkExecution; canExecute: boolean; canResolve: boolean; created?: boolean; replayed?: boolean; unchanged?: boolean }
export type WorkAutomationEvent = {
  id: string; spaceId: string; eventType: string; projectId: string | null; statusId: string; sourceItemId: string | null; origin: 'external' | 'work';
  payload: { summary: string; details: string; url: string }; state: 'queued' | 'processed' | 'failed' | 'skipped'; revision: string; createdAt: string; processedAt: string; code: string; message: string
}
export type WorkAutomationReceipt = { ruleId: string; ruleRevision: string; itemId: string | null; executionId: string | null; result: 'created' | 'failed' | 'skipped'; code: string; message: string; occurredAt: string }
export type WorkAutomationEventResponse = { event: WorkAutomationEvent; receipts: WorkAutomationReceipt[]; canEdit: boolean; canExecute: boolean; created?: boolean; replayed?: boolean }
export type WorkAutomationPage<T> = { items: T[]; nextCursor: string | null; canEdit?: boolean; canExecute?: boolean; canResolve?: boolean }
