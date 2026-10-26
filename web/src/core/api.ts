import { changesSessionCookie, createSessionReadGuard, createSessionRequestQueue } from './session-requests'
import { t } from './i18n'
import type { Bootstrap } from './types'
let csrf = ''
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); this.name = 'ApiError' }
}
export type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal }
const sessionRequest = createSessionRequestQueue()
const sessionRead = createSessionReadGuard()
export function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method || 'GET'
  const changesCookie = changesSessionCookie(path, method)
  if (changesCookie) sessionRead.invalidate()
  const result = sessionRequest(path, method, () => performRequest<T>(path, options))
  return changesCookie ? result.finally(() => sessionRead.invalidate()) : result
}
async function performRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const method = options.method || 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) headers['X-CSRF-TOKEN'] = csrf
  const response = await fetch('/api/v1' + path, { method, credentials: 'same-origin', headers, signal: options.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, data?.code || 'request_failed', data?.message || t("请求失败（{status}）", "Request failed ({status})", { status: response.status }), data || {})
  return data as T
}
export async function bootstrap(): Promise<Bootstrap> {
  const current = sessionRead.capture()
  const value = await request<Bootstrap>('/bootstrap')
  if (current()) csrf = value.csrfToken
  return value
}
export async function selectSetupLanguage(language: Bootstrap['language']): Promise<Bootstrap> {
  const current = sessionRead.capture()
  const value = await request<Bootstrap>('/setup/language', { method: 'POST', body: { language } })
  if (current()) csrf = value.csrfToken
  return value
}
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : t("操作未完成，请重试。", "The action could not be completed. Please try again.") }
export async function downloadExport(spaceId: string, format: 'html' | 'json'): Promise<void> {
  const response = await fetch(`/api/v1/spaces/${encodeURIComponent(spaceId)}/export?format=${format}`, { credentials: 'same-origin' })
  if (!response.ok) { const error = await response.json().catch(() => null); throw new ApiError(response.status, error?.code || 'export_failed', error?.message || t("导出失败", "Export failed")) }
  const href = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a')
  anchor.href = href; anchor.download = `Lingshu-Home-${new Date().toISOString().slice(0, 10)}.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000)
}
