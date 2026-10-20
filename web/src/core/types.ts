export type AuthMode = 'open_edit' | 'public_read' | 'private_single' | 'private_multi'
export type Role = 'Owner' | 'Member'
export type User = { id: string; username: string; displayName: string; role: Role }
export type AdminUser = User & { isEnabled: boolean; modeSuspended?: boolean; createdAt?: string }
export type Space = { id: string; name: string; kind: 'shared' | 'personal'; published: boolean; canEdit: boolean }
export type Bootstrap = {
  version: string; language: 'zh-CN' | 'en'; initialized: boolean; siteName: string; mode: AuthMode; registrationEnabled: boolean; autoFetchIcons?: boolean; autoSelectEndpoint?: boolean;
  user: User | null; spaces: Space[]; defaultSpaceId: string | null; csrfToken: string;
  capabilities: { sourceKinds: string[]; deliveryModes: string[]; datasetSchemas: { id: string; version: number }[];
    pageSchemaVersions: number[]; themePackages: string[]; pageThemes: string[]; panelThemes: string[];
    layoutModes: string[]; authModes: AuthMode[]; [key: string]: unknown }
}
export type Category = { id: string; spaceId: string; name: string; icon: string; parentId: string | null; sortOrder: number }
export type Endpoint = { label: string; url: string; route?: 'internal' | 'external'; probePath?: string }
export type IconMode = 'auto' | 'manual'
export type LinkInput = { categoryId: string | null; title: string; url: string; description: string; icon: string; iconMode?: IconMode; tags: string[]; isFavorite: boolean; sortOrder: number; endpoints: Endpoint[] }
export type NavLink = LinkInput & { id: string; spaceId: string; createdAt?: string; updatedAt: string }
export type NavigationData = { categories: Category[]; links: NavLink[] }
export type Dataset<T = NavigationData> = { datasetId: string; schemaId: string; schemaVersion: number; revision: string; data: T; meta: { sourceUpdatedAt: string | null; receivedAt: string | null; lastSuccessAt: string | null; freshness: string; [key: string]: unknown } }
export type Region = 'top' | 'left' | 'main' | 'right' | 'bottom'
export type Slot = Region | 'hidden'
export type Placement =
  | { kind: 'region'; region: Region; order: number; size?: { widthPx?: number; maxWidthPx?: number }; sticky?: boolean; locked?: boolean }
  | { kind: 'grid'; region: 'main'; x: number; y: number; w: number; h: number; heightMode: 'content' | 'fixed'; locked: boolean }
  | { kind: 'flow'; region: Region; order: number; locked?: boolean }
  | { kind: 'hidden' }
export type Binding = { datasetId: string; space: 'current-page-space'; query: Record<string, unknown> }
export type View = { id: string; panel: { id: string }; inputs: Record<string, string>; interactionScope?: string; settings: Record<string, unknown>; template?: { id: string; version: string; sha256: string; sourceUrl?: string } }
export type ChromeItem = { id: string; type: 'text' | 'link' | 'branding'; text?: string; url?: string; newTab?: boolean }
export type ChromeArea = { enabled: boolean; left: ChromeItem[]; center: ChromeItem[]; right: ChromeItem[] }
export type PageChrome = { header: ChromeArea; footer: ChromeArea }
export type PageConfig = { schemaVersion: 2; pageTheme: { id: string }; appearance: { colorMode: 'light' | 'dark' | 'system'; density: 'comfortable' | 'compact' }; chrome?: PageChrome; bindings: Record<string, Binding>; views: View[]; layout: { mode: 'regions-grid'; gap: number; grid: { columns: 24 }; placements: Record<string, { base: Placement; overrides?: { narrow?: Placement } }> } }
export type Page = { id: string; spaceId: string; name: string; revision: string; config: PageConfig }
export type Dashboard = { space: Space; page: Page; datasets: Record<string, Dataset<unknown>> }
export type Settings = { siteName: string; mode: AuthMode; registrationEnabled: boolean; autoFetchIcons?: boolean; autoSelectEndpoint?: boolean; hasOwner: boolean }
export type NetworkProxySettings = { revision: string; mode: 'direct' | 'proxy'; url: string; credentialConfigured: boolean }
export type BookmarkPreviewItem = { title: string; url: string; folderPath: string[]; status: 'valid' | 'duplicate' | 'invalid'; reason?: string }
export type BookmarkPreview = { total: number; valid: number; invalid: number; duplicates: number; truncated: boolean; items: BookmarkPreviewItem[] }
export type BookmarkResult = { imported: number; skipped: number; invalid: number; categoriesCreated: number }
export type TrafficMetrics = { count: number; uniques: number }
export type TrafficWindow = { capturedAt: string; windowBasis: 'github-last-14-days'; windowStart: string | null; windowEnd: string | null; views: TrafficMetrics; clones: TrafficMetrics }
export type TrafficData = { repository: { owner: string; name: string; url: string }; baseline: TrafficWindow; current: TrafficWindow; daily: { date: string; views: TrafficMetrics | null; clones: TrafficMetrics | null; isPartial: boolean; observedAt: string | null; viewsObservedAt?: string | null; clonesObservedAt?: string | null }[]; popularPaths: { path: string; title: string; count: number; uniques: number }[]; referrers: { referrer: string; count: number; uniques: number }[]; auxiliaryStatus: Record<'paths' | 'referrers', { state: 'ok' | 'unavailable' | 'stale'; lastSuccessAt: string | null; code?: string }> }
export type CalendarEvent = { id: string; title: string; startAt: number; endAt: number; allDay: boolean; startDate?: string; endDate?: string; timezone?: string; location?: string; description?: string; url?: string; status?: 'confirmed' | 'tentative' | 'cancelled' }
export type CalendarData = { timezone: string; windowStart: number; windowEnd: number; events: CalendarEvent[] }
export type WeatherData = { timezone: string; latitude: number; longitude: number; locationName?: string; current?: { time: number; temperature: number; apparentTemperature?: number; weatherCode: number; humidity?: number; windSpeed?: number; isDay: boolean }; daily: { date: string; weatherCode: number; temperatureMax: number; temperatureMin: number; sunrise?: number; sunset?: number; precipitationProbability?: number }[] }
export type MetricsData = { metrics: { id: string; label: string; value: number | null; unit?: string; min?: number; max?: number; status?: 'ok' | 'warning' | 'critical' | 'unknown' }[] }
export type StatusData = { items: { id: string; label: string; status: 'up' | 'degraded' | 'down' | 'unknown'; message?: string; latencyMs?: number; url?: string }[] }
