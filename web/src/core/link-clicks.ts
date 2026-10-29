export type LinkClickEntry = 'primary' | 'internal' | 'external' | 'additional'
export type LinkClickItem = {
  linkId: string; title: string; url: string; categoryId: string | null; categoryName: string
  periodClicks: number; totalClicks: number; firstClickedAt: string | null; lastClickedAt: string | null
}
export type LinkClickStats = {
  from: string; to: string; timezone: 'UTC'; recordedFrom: string | null
  summary: { periodClicks: number; totalClicks: number; links: number; activeLinks: number; neverClickedLinks: number }
  days: { date: string; count: number; tracked: boolean }[]
  categories: { categoryId: string | null; categoryName: string; periodClicks: number; totalClicks: number; links: number }[]
  items: LinkClickItem[]; total: number; limit: number; offset: number; hasMore: boolean
}

// Keyboard Enter and modified primary clicks produce a click event. Middle
// click has its own auxclick event. Hover, pointerdown and right click do not.
export function isLinkActivation(event: { type: string; button: number; defaultPrevented: boolean }): boolean {
  return !event.defaultPrevented && (event.type === 'click' && event.button === 0 || event.type === 'auxclick' && event.button === 1)
}
export function clickDateRange(days: number, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return { from: new Date(end.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}
