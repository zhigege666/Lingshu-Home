import { t } from '../core/i18n'
import type { WorkAutomationEvent, WorkExecutionState } from '../core/work-automation-types'
export const workEventTypeLabel = (value: string) => ({ 'work.created': t('事项创建', 'Item created'), 'work.status_changed': t('事项状态变化', 'Item status changed'), 'work.completed': t('事项完成', 'Item completed') })[value] || value
export const automationEventStateLabel = (state: WorkAutomationEvent['state']) => ({ queued: t('待处理', 'Queued'), processed: t('已处理', 'Processed'), failed: t('处理失败', 'Failed'), skipped: t('已跳过', 'Skipped') })[state]
export const executionStateLabel = (state: WorkExecutionState) => ({ queued: t('排队中', 'Queued'), dispatching: t('派发中', 'Dispatching'), running: t('执行中', 'Running'), succeeded: t('执行成功', 'Succeeded'), failed: t('执行失败', 'Failed'), unknown: t('结果未知', 'Unknown'), canceled: t('已取消', 'Canceled') })[state]
