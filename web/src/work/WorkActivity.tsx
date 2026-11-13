import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated } from '../core/presentation'
import { workPath, type WorkActivityChange, type WorkActivityEvent, type WorkActivityPage } from '../core/work-types'
import { Button } from '../components/ui/button'
import { ErrorMessage, Loading } from '../components/Shared'
import './work-activity.css'

const actionLabel = (action: WorkActivityEvent['action']) => ({
  create: t('创建事项', 'Created item'), update: t('更新事项', 'Updated item'), move: t('移动事项', 'Moved item'),
  archive: t('归档事项', 'Archived item'), restore: t('恢复事项', 'Restored item'),
  status_migrate: t('迁移状态', 'Migrated status'), status_definition: t('更新状态配置', 'Updated status definition'),
})[action] || t('更新事项', 'Updated item')

function changeLabel(change: WorkActivityChange): string {
  const named = (value: WorkActivityChange['before']) => value && typeof value === 'object' && 'name' in value ? value.name : t('未分组', 'No project')
  if (change.field === 'status' && change.before && typeof change.before === 'object' && change.after && typeof change.after === 'object' && change.before.type && change.after.type && change.before.type !== change.after.type) {
    const labels = { todo: t('未开始', 'Not started'), doing: t('进行中', 'In progress'), waiting: t('等待', 'Waiting'), done: t('已完成', 'Completed'), canceled: t('已取消', 'Canceled') }
    return `${t('状态', 'Status')}：${named(change.before)} (${labels[change.before.type]}) → ${named(change.after)} (${labels[change.after.type]})`
  }
  if (change.field === 'status' || change.field === 'projectId') return `${change.field === 'status' ? t('状态', 'Status') : t('项目', 'Project')}：${named(change.before)} → ${named(change.after)}`
  if (change.field === 'needsAttention') return change.after ? t('标记为待我处理', 'Marked as needing attention') : t('取消待我处理标记', 'Cleared attention flag')
  if (change.field === 'archived') return change.after ? t('已归档', 'Archived') : t('恢复为未归档', 'Restored to active items')
  if (change.field === 'bookmarkIds' || change.field === 'documentIds') {
    const kind = change.field === 'bookmarkIds' ? t('书签', 'Bookmarks') : t('文档', 'Documents')
    const changes = [change.added ? t('新增 {count}', 'Added {count}', { count: change.added }) : '', change.removed ? t('移除 {count}', 'Removed {count}', { count: change.removed }) : ''].filter(Boolean)
    return `${kind}：${changes.join(t('，', ', ')) || t('关联已调整', 'Links changed')}`
  }
  return ({ title: t('修改标题', 'Changed title'), description: t('修改说明', 'Changed description'), nextStep: t('更新下一步', 'Changed next step'), result: t('更新结果', 'Changed result'), order: t('调整排序', 'Changed order'), statusDefinition: t('调整状态名称或语义', 'Changed status name or meaning') } as Record<string, string>)[change.field] || t('修改事项字段', 'Changed an item field')
}

export default function WorkActivity({ spaceId, itemId, revision }: { spaceId: string; itemId: string; revision: string }) {
  const [page, setPage] = useState<WorkActivityPage | null>(null), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const generation = useRef(0), paging = useRef(false), active = useRef(true)
  const path = `${workPath(spaceId)}/items/${encodeURIComponent(itemId)}/activity`
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++ } }, [])
  useEffect(() => {
    const abort = new AbortController(), token = ++generation.current
    setPage(null); setError(''); setLoading(true); setLoadingMore(false); paging.current = false
    request<WorkActivityPage>(`${path}?limit=20`, { signal: abort.signal }).then(value => { if (active.current && token === generation.current) setPage(value) })
      .catch(cause => { if (!abort.signal.aborted && active.current && token === generation.current) setError(messageOf(cause)) })
      .finally(() => { if (!abort.signal.aborted && active.current && token === generation.current) setLoading(false) })
    return () => abort.abort()
  }, [path, revision, refresh])
  async function more() {
    if (!page?.nextCursor || paging.current) return
    const token = generation.current, cursor = page.nextCursor
    paging.current = true; setLoadingMore(true); setError('')
    try {
      const value = await request<WorkActivityPage>(`${path}?${new URLSearchParams({ limit: '20', cursor })}`)
      if (active.current && token === generation.current) setPage(previous => ({ ...value, items: [...(previous?.items || []), ...value.items.filter(item => !previous?.items.some(old => old.id === item.id))] }))
    } catch (cause) {
      if (active.current && token === generation.current) {
        if (cause instanceof ApiError && [401,403,404].includes(cause.status)) setPage(null)
        setError(messageOf(cause))
      }
    } finally { if (active.current && token === generation.current) { paging.current = false; setLoadingMore(false) } }
  }
  return <section className="work-activity" aria-label={t('变更记录', 'Activity history')} aria-busy={loading || loadingMore || undefined}>
    <header><h3>{t('变更记录', 'Activity history')}</h3><Button type="button" variant="ghost" size="icon-sm" disabled={loading || loadingMore} onClick={() => setRefresh(value => value + 1)} aria-label={t('刷新变更记录', 'Refresh activity history')} title={t('刷新变更记录', 'Refresh activity history')}><RefreshCw size={14}/></Button></header>
    <ErrorMessage error={error}/>
    {error && <Button type="button" variant="outline" size="sm" disabled={loading || loadingMore} onClick={() => setRefresh(value => value + 1)}>{t('重新读取记录', 'Reload history')}</Button>}
    {loading ? <Loading/> : page && <>
      <ol>{page.items.map(event => <li key={event.id} data-work-activity-id={event.id}>
        <div className="work-activity-heading"><strong>{actionLabel(event.action)}</strong><time dateTime={event.occurredAt} title={formatUpdated(event.occurredAt)}>{formatUpdated(event.occurredAt)}</time></div>
        <p className="work-activity-actor">{event.actor?.name || t('操作者未记录', 'Actor not recorded')}<span>·</span>{event.origin === 'mcp' ? 'MCP' : event.origin === 'api' ? 'API' : t('网页', 'Web')}</p>
        {event.changes.length > 0 && <ul className="work-activity-changes">{event.changes.map((change, index) => <li key={`${change.field}:${index}`}>{changeLabel(change)}</li>)}</ul>}
      </li>)}</ol>
      {!page.items.length && <p className="work-activity-empty">{t('暂无变更记录', 'No activity recorded yet')}</p>}
      {page.nextCursor ? <Button type="button" variant="ghost" size="sm" className="work-activity-more" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? t('正在加载…', 'Loading…') : t('加载更早记录', 'Load earlier activity')}</Button> : !page.historyComplete && <p className="work-activity-boundary">{page.historyStartedAt ? t('从 {time} 起记录变更，更早的历史未记录。', 'Changes are recorded from {time}; earlier history is unavailable.', { time: formatUpdated(page.historyStartedAt) }) : t('更早的变更历史未记录。', 'Earlier activity was not recorded.')}</p>}
    </>}
  </section>
}
