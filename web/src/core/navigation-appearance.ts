import { normalizeNavigationGroupPreviewCount } from './navigation-folder.ts'
/** Content presentation belongs to each navigation/favorites view, not its placement. */
export type NavigationAppearanceSettings = {
  groupPreviewCount: number
  maxColumns: number
  urlDisplay: 'fallback' | 'always' | 'hidden'
  descriptionLines: number
  showTags: boolean | null
  showEndpoints: boolean
  showGroupTitles: boolean
  showCounts: boolean
  density: 'inherit' | 'comfortable' | 'compact'
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export function readNavigationAppearanceSettings(settings: Record<string, unknown> = {}): NavigationAppearanceSettings {
  return {
    groupPreviewCount: normalizeNavigationGroupPreviewCount(settings.groupPreviewCount),
    maxColumns: boundedInteger(settings.maxColumns, 0, 8, 0),
    urlDisplay: settings.urlDisplay === 'always' || settings.urlDisplay === 'hidden' ? settings.urlDisplay : 'fallback',
    descriptionLines: boundedInteger(settings.descriptionLines, 0, 3, 1),
    // An omitted value preserves the existing theme/density/variant behavior.
    showTags: typeof settings.showTags === 'boolean' ? settings.showTags : null,
    showEndpoints: settings.showEndpoints !== false,
    showGroupTitles: settings.showGroupTitles !== false,
    showCounts: settings.showCounts !== false,
    density: settings.density === 'comfortable' || settings.density === 'compact' ? settings.density : 'inherit',
  }
}
