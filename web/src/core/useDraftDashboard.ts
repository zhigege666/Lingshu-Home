import { useEffect, useMemo, useState } from 'react'
import { ApiError, messageOf, request } from './api'
import { t } from './i18n'
import type { Binding, Dashboard, Dataset, PageConfig } from './types'

type Source = { id: string; datasetId: string }
type SnapshotRequest = { datasetId: string; path: string; sourceId?: string }

function existingProjection(dashboard: Dashboard, alias: string, binding: Binding): Dataset<unknown> | undefined {
  const matches = (value?: Binding) => !!value && value.datasetId === binding.datasetId && JSON.stringify(value.query) === JSON.stringify(binding.query)
  if (matches(dashboard.page.config.bindings[alias]) && dashboard.datasets[alias]) return dashboard.datasets[alias]
  const match = Object.entries(dashboard.page.config.bindings).find(([name, value]) => matches(value) && dashboard.datasets[name])
  return match ? dashboard.datasets[match[0]] : undefined
}

export function useDraftDashboard(dashboard: Dashboard, name: string, config: PageConfig, sources: Source[]) {
  const [snapshotState, setSnapshotState] = useState<{ spaceId: string; datasets: Record<string, Dataset<unknown>> }>({ spaceId: dashboard.space.id, datasets: {} })
  const [loading, setLoading] = useState(false)
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [retry, setRetry] = useState(0)
  const snapshots = snapshotState.spaceId === dashboard.space.id ? snapshotState.datasets : {}
  const visibleAliases = new Set(config.views
    .filter(view => config.layout.placements[view.id]?.base.kind !== 'hidden')
    .flatMap(view => Object.values(view.inputs)))
  const bindings = Object.entries(config.bindings).filter(([alias]) => visibleAliases.has(alias))
  const missing = [...new Set(bindings
    .filter(([alias, binding]) => !existingProjection(dashboard, alias, binding) && !Object.keys(binding.query).length && !snapshots[binding.datasetId])
    .map(([, binding]) => binding.datasetId))].sort()
  const missingKey = JSON.stringify(missing)
  const sourceKey = JSON.stringify(sources.map(source => [source.id, source.datasetId]))

  useEffect(() => {
    const pending = new AbortController()
    const required = missing.map((datasetId): SnapshotRequest | null => {
      if (datasetId === 'local-navigation') return { datasetId, path: '/spaces/' + encodeURIComponent(dashboard.space.id) + '/navigation' }
      const source = sources.find(item => item.datasetId === datasetId)
      return source ? { datasetId, path: '/sources/' + encodeURIComponent(source.id) + '/snapshot', sourceId: source.id } : null
    }).filter((item): item is SnapshotRequest => item !== null)
    if (!required.length) { setLoading(false); return () => pending.abort() }
    setLoading(true)
    void Promise.allSettled(required.map(async item => {
      try {
        const dataset = await request<Dataset<unknown>>(item.path, { signal: pending.signal })
        if (dataset.datasetId !== item.datasetId) throw new Error(t('数据来源与绑定不一致。', 'The returned dataset does not match the binding.'))
        return dataset
      } catch (cause) {
        // A missing first snapshot and a deleted source share the API's 404.
        // Verify the live source once before describing this as awaiting data.
        if (item.sourceId && cause instanceof ApiError && cause.status === 404 && cause.code === 'not_found') {
          const source = await request<Source & { revision: string; lastSuccessAt: string | null; lastError: unknown | null }>(
            '/sources/' + encodeURIComponent(item.sourceId), { signal: pending.signal })
          if (source.id === item.sourceId && source.datasetId === item.datasetId && source.revision === '0'
            && source.lastSuccessAt === null && source.lastError === null) return undefined
        }
        throw cause
      }
    })).then(results => {
      if (pending.signal.aborted) return
      const resolved: Record<string, Dataset<unknown>> = {}, errors: Record<string, string> = {}
      results.forEach((result, index) => {
        const id = required[index]!.datasetId
        if (result.status === 'fulfilled') { if (result.value) resolved[id] = result.value }
        else errors[id] = messageOf(result.reason)
      })
      setSnapshotState(previous => ({ spaceId: dashboard.space.id, datasets: { ...(previous.spaceId === dashboard.space.id ? previous.datasets : {}), ...resolved } }))
      setFailures(errors); setLoading(false)
    })
    return () => pending.abort()
    // Serialized identifiers keep typing a title or changing appearance from refetching data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard.space.id, missingKey, sourceKey, retry])

  const preview = useMemo<Dashboard>(() => {
    const datasets: Record<string, Dataset<unknown>> = {}
    for (const [alias, binding] of Object.entries(config.bindings)) {
      const projected = existingProjection(dashboard, alias, binding)
      const dataset = projected || (!Object.keys(binding.query).length ? snapshots[binding.datasetId] : undefined)
      if (dataset) datasets[alias] = dataset
    }
    return { ...dashboard, page: { ...dashboard.page, name, config }, datasets }
  }, [dashboard, name, config, snapshotState])
  const incomplete = bindings.some(([alias]) => !preview.datasets[alias])
  return { preview, loading, incomplete, failed: Object.keys(failures).length > 0, retry: () => { setFailures({}); setRetry(value => value + 1) } }
}
