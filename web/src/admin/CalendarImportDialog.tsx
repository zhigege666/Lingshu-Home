import { useEffect, useRef, useState, type FormEvent } from 'react'
import { t } from '../core/i18n'
import { ApiError, request, messageOf } from '../core/api'
import type { Space } from '../core/types'
import type { SourceInfo } from './IntegrationsPanel'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorMessage, Field, FilePicker, Modal, handleFormInvalid } from '../components/Shared'

export default function CalendarImportDialog({ source, space, onClose, onImported }: { source: SourceInfo; space: Space; onClose: () => void; onImported: () => Promise<void> }) {
  const [text, setText] = useState(''), [filename, setFilename] = useState(''), [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  const attempt = useRef<{ key: string; id: string } | null>(null)
  useEffect(() => () => { generation.current++ }, [])
  async function read(file?: File) {
    const current = ++generation.current; attempt.current = null; setText(''); setFilename(file?.name || ''); setError(''); setReading(false)
    if (!file) return
    if (file.size > 1024 * 1024) { setError(t('ICS 文件不能超过 1 MiB。', 'The ICS file must not exceed 1 MiB.')); return }
    setReading(true)
    try { const value = await file.text(); if (current === generation.current) setText(value) } catch (cause) { if (current === generation.current) setError(messageOf(cause)) } finally { if (current === generation.current) setReading(false) }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    if (!text) { setError(t('请选择 ICS 日程文件。', 'Choose an ICS calendar file.')); return }
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format() } catch { setError(t('请填写有效的 IANA 时区。', 'Enter a valid IANA time zone.')); return }
    // A lost response may follow a successful write. Keep the same receipt key
    // for retries of this exact file, zone and expected revision.
    const key = `${generation.current}:${zone.trim()}:${source.revision || '0'}`
    if (attempt.current?.key !== key) attempt.current = { key, id: globalThis.crypto?.randomUUID?.() || `calendar-${Date.now()}-${Math.random().toString(36).slice(2)}` }
    setBusy(true)
    try { await request(`/sources/${source.id}/calendar-import`, { method: 'POST', body: { requestId: attempt.current.id, expectedRevision: source.revision || '0', icsText: text, timezone: zone.trim(), pastDays: 1, futureDays: 30 } }); setText(''); onClose(); await onImported() }
    catch (cause) { setError(cause instanceof ApiError && cause.status === 429 ? t('请求过于频繁，请稍后使用同一文件重试。文件内容仍保留。', 'Too many requests. Retry the same file shortly; its content is still here.') : cause instanceof ApiError && cause.status === 409 ? t('此来源已被更新，当前文件仍保留。请先核对最新快照；不会自动覆盖新版本。', 'This source has changed. Your file is still here. Review the latest snapshot first; the newer version will not be overwritten automatically.') : messageOf(cause)) }
    finally { setBusy(false) }
  }
  return <Modal title={t('导入日程文件', 'Import calendar file')} description={source.name} busy={busy} onClose={onClose}><form onSubmit={submit} onInvalid={event => handleFormInvalid(event, setError)}><fieldset disabled={busy} className="admin-plain-fieldset">
    {space.kind === 'shared' && space.published && <p className="admin-info">{t('日程内容将按此空间的访问权限展示；私人日程请使用个人空间。', 'Calendar content follows this space’s access permissions. Use a personal space for private calendars.')}</p>}
    <Field label={t('ICS 文件', 'ICS file')}><FilePicker accept=".ics,text/calendar" filename={filename} disabled={busy || reading} onFileChange={file => void read(file)} /></Field><Field label={t('默认时区', 'Default time zone')}><Input required value={zone} onChange={event => setZone(event.target.value)} placeholder="Asia/Shanghai" /></Field>
    <p className="admin-hint">{t('保存过去 1 天至未来 30 天的规范化日程，替换此来源的上一份快照。原始文件不会保留；重复规则按支持范围展开，不支持的规则会明确报错。', 'Replaces this source’s snapshot with normalized events from the past day through the next 30 days. The original file is not retained. Supported recurrence rules are expanded; unsupported rules return an error.')}</p>
    <ErrorMessage error={error} /><div className="admin-form-footer"><Button variant="outline" type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button><Button type="submit" disabled={busy || reading || !text}>{busy ? t('正在导入…', 'Importing…') : reading ? t('正在读文件…', 'Reading file…') : t('导入并替换快照', 'Import and replace snapshot')}</Button></div>
  </fieldset></form></Modal>
}
