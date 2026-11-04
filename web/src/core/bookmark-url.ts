/** Bookmark and additional-entry URLs use the same byte budget as Home's API. */
export const bookmarkURLMaxBytes = 4096
export function validBookmarkURL(raw: string): boolean {
  if (!/^https?:\/\/[^/]/i.test(raw) || /[\s\\\p{Cc}]/u.test(raw) || new TextEncoder().encode(raw).length > bookmarkURLMaxBytes) return false
  try {
    const url = new URL(raw)
    return !!url.hostname && !url.username && !url.password && !raw.slice(raw.indexOf('//') + 2).split(/[/?#]/, 1)[0].includes('@') && url.port !== '0'
  } catch { return false }
}
