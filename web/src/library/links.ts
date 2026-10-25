/** Resolve a document-relative URL without ever granting access outside its registered root. */
export function documentRelativePath(documentPath: string, reference: string): string | null {
  if (!reference || reference.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith('//') || reference.includes('\\')) return null
  let decoded: string
  try { decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]!) } catch { return null }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded)) return null
  const pieces = documentPath.split('/').slice(0, -1)
  for (const piece of decoded.split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') { if (!pieces.length) return null; pieces.pop() }
    else pieces.push(piece)
  }
  return pieces.join('/') || null
}
export function safeExternalLink(reference: string): string | undefined {
  try { const url = new URL(reference); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined } catch { return undefined }
}
export function documentAssetURL(spaceId: string, documentId: string, reference: string): string {
  const relative = decodeURIComponent(reference.split(/[?#]/, 1)[0]!)
  return `/api/v1/spaces/${encodeURIComponent(spaceId)}/documents/${encodeURIComponent(documentId)}/asset?path=${encodeURIComponent(relative)}`
}
export function isMarkdownPath(path: string): boolean { return /\.(md|markdown)$/i.test(path) }
export function markdownDisplayBody(content: string): string {
  // Display metadata separately while preserving the complete file in the editor and API.
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '')
}
