import type { ComposerSource } from './composition'

export const validExternalSource = (source: ComposerSource) =>
  /^[0-9a-f]{32}$/.test(source.id) && source.datasetId === 'source:' + source.id

/** Ordinary add and presets use the enabled inventory; explicit snapshot reuse is separate. */
export function matchingEnabledSources(schema: string, version: number, sources: readonly ComposerSource[]): ComposerSource[] {
  const counts = new Map<string, number>()
  for (const source of sources) counts.set(source.datasetId, (counts.get(source.datasetId) || 0) + 1)
  return sources.filter(source => validExternalSource(source) && counts.get(source.datasetId) === 1
    && source.schemaId === schema && source.schemaVersion === version && source.enabled !== false)
}

export function initialSourceKind(schema: string) {
  return schema === 'calendar.events' ? 'calendar-ics' : schema === 'weather.forecast' ? 'weather-open-meteo'
    : schema === 'github.traffic' ? 'github-traffic' : schema === 'navigation.collection' ? 'external-push' : 'external-json'
}
