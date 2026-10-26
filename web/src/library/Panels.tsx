import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Download, Expand, ExternalLink, FilePenLine, FileText, Folder, History, Info, Link2, LockKeyhole, Pencil, Save, Settings2, Share2, Shrink, Trash2, X } from 'lucide-react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { formatUpdated, safeHref } from '../core/presentation'
import { requestNavigation } from '../core/navigation'
import { useUnsavedChanges } from '../core/useUnsavedChanges'
import type { Bootstrap, Space } from '../core/types'
import type { DocumentDetail, DocumentPage, DocumentSource, LibraryBookmark, LibraryDocument } from '../core/library-types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Checkbox } from '../components/ui/checkbox'
import { StyledSelect } from '../components/ui/select'
import { Empty, ErrorMessage, Field, handleFormInvalid, Loading, Modal } from '../components/Shared'
import DiscardChangesDialog from '../components/DiscardChangesDialog'
import { MarkdownView } from './MarkdownView'
import { isMarkdownPath } from './links'

const basePath = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/documents`
const docPath = (spaceId: string, id: string) => `${basePath(spaceId)}/${encodeURIComponent(id)}`
function saveText(content: string, name: string) { const href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = href; link.download = name.split('/').pop() || 'document.md'; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000) }
function conflictMessage(cause: unknown) { return cause instanceof ApiError && [409, 412].includes(cause.status) ? t('文件或记录已在其他地方修改。当前草稿仍然保留，请先下载草稿，再重新读取最新版本后合并。', 'The file or record changed elsewhere. Your draft is preserved. Download it, then reload the latest version and merge your changes.') : messageOf(cause) }
function PanelControls({ onClose, expanded, onExpand }: { onClose: () => void; expanded: boolean; onExpand: () => void }) { return <div className="library-panel-controls"><Button className="library-back" variant="ghost" size="sm" onClick={onClose}><ArrowLeft size={15}/>{t('返回列表', 'Back to list')}</Button><span className="grow"/><Button variant="ghost" size="icon-sm" onClick={onExpand} aria-label={expanded ? t('收起阅读区', 'Collapse reading pane') : t('展开阅读区', 'Expand reading pane')}>{expanded ? <Shrink size={17}/> : <Expand size={17}/>}</Button><Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('关闭预览', 'Close preview')}><X size={18}/></Button></div> }

export function DocumentPanel({ space, bootstrap, documentId, refreshToken, bookmarks, onClose, expanded, onExpand, onChanged, onDeleted, onDocumentLink, onNotice }: {
  space: Space; bootstrap: Bootstrap; documentId: string; refreshToken: number; bookmarks: LibraryBookmark[]; onClose: () => void; expanded: boolean; onExpand: () => void; onChanged: () => void; onDeleted: () => void; onDocumentLink: (sourceId: string, path: string) => void; onNotice: (message: string) => void
}) {
  const [document, setDocument] = useState<DocumentDetail | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [preview, setPreview] = useState(false), [busy, setBusy] = useState(false)
  const [action, setAction] = useState<'rename' | 'delete' | 'publish' | 'unpublish' | 'metadata' | 'history' | null>(null), [reload, setReload] = useState(0), [notice, setNotice] = useState('')
  const running = useRef(false)
  const writable = !!bootstrap.user && space.canEdit && !!document && !document.readOnly && document.status === 'ready'
  const canPublish = bootstrap.user?.role === 'Owner' && space.kind === 'shared' && !!document && document.status === 'ready' && !document.unavailableReason
  const dirty = editing && document !== null && draft !== document.content
  const guard = useUnsavedChanges(dirty, busy, () => { setEditing(false); setDraft(document?.content || '') })
  useEffect(() => {
    // Refresh the preview together with the list, while preserving an active editor draft.
    if (editing) return
    const abort = new AbortController()
    setLoading(true); setError(''); setDocument(null); setDraft('')
    request<DocumentDetail>(docPath(space.id, documentId), { signal: abort.signal }).then(value => { setDocument(value); setDraft(value.content); setEditing(false) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [space.id, documentId, reload, refreshToken])
  async function save() {
    if (!document || !dirty || !writable || running.current) return
    running.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const value = await request<DocumentDetail>(docPath(space.id, document.id), { method: 'PUT', body: { content: draft, expectedRevision: document.revision } })
      setDocument(value); setDraft(value.content); setEditing(false); setNotice(t('修改已保存到原文件。', 'Changes saved to the original file.')); onChanged()
    } catch (cause) { setError(conflictMessage(cause)) }
    finally { running.current = false; setBusy(false) }
  }
  function refresh() { guard.requestLeave(() => { setEditing(false); setReload(value => value + 1) }) }
  function changed(value?: LibraryDocument) { if (value && document) setDocument({ ...document, ...value }); setAction(null); onChanged() }
  return <>
    <PanelControls onClose={onClose} expanded={expanded} onExpand={onExpand}/>
    {loading ? <Loading/> : !document ? <div className="library-panel-empty"><ErrorMessage error={error}/><Button variant="outline" onClick={refresh}>{t('重新读取', 'Reload')}</Button></div> : <>
      <header className="library-document-heading" data-document-id={document.id}><h2>{document.title}</h2><div className="library-document-meta"><span><LockKeyhole size={13}/>{document.published ? t('已发布', 'Published') : t('未发布', 'Unpublished')}</span><span>{document.sourceName}</span>{document.readOnly && <span className="library-readonly">{t('只读', 'Read only')}</span>}{document.hasUnpublishedChanges && <span className="library-unpublished">{t('有未发布修改', 'Unpublished changes')}</span>}</div><p className="library-document-path" title={document.relativePath}><Folder size={16}/>{document.relativePath}</p><div className="library-panel-actions">{writable && !editing && <Button variant="outline" size="sm" onClick={() => { setDraft(document.content); setEditing(true); setPreview(false); setError(''); setNotice('') }}><Pencil size={14}/>{t('编辑', 'Edit')}</Button>}<Button variant="ghost" size="sm" disabled={!!document.unavailableReason} onClick={() => saveText(editing ? draft : document.content, document.relativePath)}><Download size={14}/>{editing ? t('下载草稿', 'Download draft') : t('导出 MD', 'Export MD')}</Button>{bootstrap.user && space.canEdit && <Button variant="ghost" size="sm" disabled={busy || editing} onClick={() => setAction('history')}><History size={14}/>{t('历史', 'History')}</Button>}{bootstrap.user && space.canEdit && !editing && <Button variant="ghost" size="sm" onClick={() => setAction('metadata')}><Link2 size={14}/>{t('关联与标签', 'Links and tags')}</Button>}{canPublish && !editing && <Button variant="ghost" size="sm" onClick={() => setAction('publish')}><Share2 size={14}/>{document.published ? t('发布当前版本', 'Publish current version') : t('发布', 'Publish')}</Button>}</div>
      {!!document.links?.length && <div className="library-related-bookmarks">{document.links.map(link => <a href={safeHref(link.url)} key={link.id} target="_blank" rel="noopener noreferrer"><Link2 size={14}/>{link.title}<ExternalLink size={12}/></a>)}</div>}{!!document.tags?.length && <div className="library-tags">{document.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
      </header>
      <div className="library-document-feedback"><ErrorMessage error={error}/>{error && <div className="admin-button-row"><Button variant="outline" size="sm" disabled={busy} onClick={refresh}>{t('重新读取', 'Reload')}</Button>{editing && <Button variant="outline" size="sm" onClick={() => saveText(draft, document.relativePath)}>{t('下载当前草稿', 'Download current draft')}</Button>}</div>}{notice && <p className="admin-info" role="status">{notice}</p>}{document.unavailableReason && <p className="admin-conflict">{document.unavailableReason === 'source_unavailable' ? t('目录当前无法访问，正文暂不可用。记录和历史仍然保留，请检查挂载后重新读取。', 'The directory is unavailable, so the current content cannot be read. Records and history are preserved. Check the mount and reload.') : t('此文件暂时无法安全读取。请检查文件编码、大小和访问权限后重新读取；历史记录仍然保留。', 'This file cannot currently be read safely. Check its encoding, size and permissions, then reload. Retained history is still available.')}</p>}{document.status === 'missing' && <p className="admin-conflict">{t('原文件当前缺失。目录离线不会自动删除记录；可在“历史”中查看或恢复已保存的版本。', 'The original file is missing. An offline directory never removes its record automatically. Open History to inspect or restore a saved version.')}</p>}</div>
      {editing ? <><div className="library-editor-tabs" role="group" aria-label={t('编辑器视图', 'Editor view')}><button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>{t('Markdown 源码', 'Markdown source')}</button><button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>{t('预览', 'Preview')}</button><span>{t('{count} 字符', '{count} characters', { count: draft.length })}</span></div><div className="library-document-body is-editing">{preview ? <MarkdownView content={draft} document={document} onDocumentLink={onDocumentLink}/> : <Textarea className="library-markdown-editor" aria-label={t('Markdown 文档正文', 'Markdown document content')} spellCheck={false} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save() } }}/>}</div><footer className="library-editor-footer"><span>{dirty ? t('有未保存修改', 'Unsaved changes') : t('没有新修改', 'No new changes')}</span><Button variant="outline" disabled={busy} onClick={() => guard.requestLeave(() => { setEditing(false); setDraft(document.content); setError('') })}>{t('取消', 'Cancel')}</Button><Button disabled={!dirty || busy} onClick={save}><Save size={15}/>{busy ? t('正在保存…', 'Saving…') : t('保存原文件', 'Save original file')}</Button></footer></> : <><div className="library-document-body"><MarkdownView content={document.content} document={document} onDocumentLink={onDocumentLink}/></div><footer className="library-document-footer"><p><Info size={14}/>{document.readOnly ? t('目录只读；可以查阅和导出文档。', 'This directory is read only. You can read and export documents.') : t('编辑后保存会修改原文件。', 'Saving an edit changes the original file.')}</p><small>{formatUpdated(document.updatedAt)}</small>{writable && <div className="library-file-actions"><button onClick={() => setAction('rename')}><FilePenLine size={13}/>{t('重命名', 'Rename')}</button><button className="is-danger" onClick={() => setAction('delete')}><Trash2 size={13}/>{t('删除原文件', 'Delete original file')}</button></div>}{canPublish && document.published && <button className="library-unpublish" onClick={() => setAction('unpublish')}>{t('取消发布', 'Unpublish')}</button>}</footer></>}
      {action === 'metadata' && <MetadataDialog document={document} bookmarks={bookmarks} onClose={() => setAction(null)} onSaved={value => { changed(value); setReload(current => current + 1); onNotice(t('文档关联与标签已保存', 'Document links and tags saved')) }}/>}
      {action === 'history' && <HistoryDialog document={document} canRestore={!!bootstrap.user && space.canEdit && !document.readOnly} onClose={() => setAction(null)} onRestored={() => { changed(); setReload(current => current + 1); onNotice(t('历史版本已恢复到原文件。', 'The historical version was restored to the original file.')) }}/>}
      {action && ['rename', 'delete', 'publish', 'unpublish'].includes(action) && <DocumentActionDialog action={action as 'rename' | 'delete' | 'publish' | 'unpublish'} document={document} onClose={() => setAction(null)} onDone={value => { if (action === 'delete') { setAction(null); onNotice(t('原文件已移入恢复记录，关联信息仍保留。', 'The original file is retained in recovery history; its links are preserved.')); onDeleted() } else { changed(value); setReload(current => current + 1) } }}/>}
    </>}
    {guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard} description={t('文档草稿尚未保存。继续编辑，或下载草稿后再离开。', 'Your document draft is not saved. Keep editing, or download it before leaving.')}/>}
  </>
}

export function BookmarkPanel({ bookmark, space, bootstrap, onClose, expanded, onExpand, onReload, onSaved, onDocumentLink }: {
  bookmark: LibraryBookmark; space: Space; bootstrap: Bootstrap; onClose: () => void; expanded: boolean; onExpand: () => void; onReload: () => void; onSaved: (value: LibraryBookmark) => void; onDocumentLink: (id: string) => void
}) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(bookmark.contextMarkdown || ''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [documents, setDocuments] = useState<LibraryDocument[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(false)
  const running = useRef(false)
  useEffect(() => { if (!editing) setDraft(bookmark.contextMarkdown || '') }, [bookmark.contextMarkdown, editing])
  const guard = useUnsavedChanges(editing && draft !== (bookmark.contextMarkdown || ''), busy, () => setEditing(false))
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    request<DocumentPage>(`${basePath(space.id)}?linkedBookmarkId=${encodeURIComponent(bookmark.id)}&limit=500`, { signal: abort.signal }).then(value => { setDocuments(value.items); setTotal(value.total) }).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [space.id, bookmark.id])
  async function save() {
    if (running.current) return
    if (new TextEncoder().encode(draft).length > 65536) { setError(t('使用说明不能超过 64 KiB。', 'Usage notes must not exceed 64 KiB.')); return }
    running.current = true; setBusy(true); setError('')
    try {
      const value = await request<LibraryBookmark>(`/spaces/${space.id}/links/${bookmark.id}/context`, { method: 'PUT', body: { contextMarkdown: draft, expectedUpdatedAt: bookmark.updatedAt } })
      setEditing(false); onSaved(value)
    } catch (cause) { setError(conflictMessage(cause)) }
    finally { running.current = false; setBusy(false) }
  }
  return <><PanelControls onClose={onClose} expanded={expanded} onExpand={onExpand}/><header className="library-document-heading"><h2>{bookmark.title}</h2><p className="library-bookmark-description">{bookmark.description}</p><a className="library-bookmark-url" href={safeHref(bookmark.url)} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/><span>{bookmark.url}</span></a>{!!bookmark.endpoints.length && <div className="library-related-bookmarks">{bookmark.endpoints.map((endpoint, index) => <a key={index} href={safeHref(endpoint.url)} target="_blank" rel="noopener noreferrer">{endpoint.label}<ExternalLink size={12}/></a>)}</div>}{!!bookmark.tags.length && <div className="library-tags">{bookmark.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</header><div className="library-document-feedback"><ErrorMessage error={error}/>{error && <Button variant="outline" size="sm" onClick={() => guard.requestLeave(() => { setEditing(false); setError(''); onReload() })}>{t('重新读取书签', 'Reload bookmark')}</Button>}</div><div className="library-notes-heading"><h3>{t('使用说明', 'Usage notes')}</h3>{space.canEdit && !editing && <Button variant="outline" size="sm" onClick={() => { setDraft(bookmark.contextMarkdown || ''); setEditing(true); setError('') }}><Pencil size={14}/>{t('编辑说明', 'Edit notes')}</Button>}</div>{editing ? <><div className="library-document-body is-editing"><Textarea className="library-markdown-editor" aria-label={t('书签使用说明', 'Bookmark usage notes')} value={draft} spellCheck={false} disabled={busy} onChange={event => setDraft(event.target.value)} placeholder={t('它是什么？什么时候用？有哪些操作要点？支持 Markdown。', 'What is this for? When should it be used? Add useful instructions in Markdown.')}/></div><footer className="library-editor-footer"><Button variant="ghost" onClick={() => saveText(draft, 'bookmark-notes.md')}>{t('下载草稿', 'Download draft')}</Button><span className="grow"/><Button variant="outline" disabled={busy} onClick={() => guard.requestLeave(() => setEditing(false))}>{t('取消', 'Cancel')}</Button><Button disabled={busy || draft === (bookmark.contextMarkdown || '')} onClick={save}>{busy ? t('正在保存…', 'Saving…') : t('保存说明', 'Save notes')}</Button></footer></> : <div className="library-document-body">{bookmark.contextMarkdown ? <MarkdownView content={bookmark.contextMarkdown}/> : <p className="library-empty-notes">{t('添加用途、使用场景与操作要点，方便自己和 Agent 查阅。', 'Describe its purpose, when to use it and useful steps for you and your agent.')}</p>}<section className="library-linked-documents"><h3>{t('关联文档', 'Related documents')}</h3>{loading ? <Loading/> : documents.length ? <>{documents.map(document => <button type="button" key={document.id} onClick={() => onDocumentLink(document.id)}><FileText size={17}/><span><strong>{document.title}</strong><small>{document.sourceName} / {document.relativePath}</small></span><ChevronLink/></button>)}{total > documents.length && <p className="admin-hint">{t('已显示 {shown}/{total} 篇关联文档。', 'Showing {shown}/{total} related documents.', { shown: documents.length, total })}</p>}</> : <p className="admin-hint">{t('在文档的“关联与标签”中关联此书签。', 'Link this bookmark from a document’s Links and tags dialog.')}</p>}</section></div>}<footer className="library-document-footer"><p><Info size={14}/>{t('使用说明是参考资料，不会授予 Agent 额外操作权限。', 'Usage notes are reference material; they do not grant extra permissions to an agent.')}</p></footer>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard} description={t('使用说明尚未保存。', 'Your usage notes have not been saved.')}/>}</>
}
function ChevronLink() { return <ExternalLink size={13}/> }

export function NewDocumentDialog({ spaceId, sources, preferredSourceId, onClose, onManage, onCreated }: { spaceId: string; sources: DocumentSource[]; preferredSourceId: string; onClose: () => void; onManage: () => void; onCreated: (value: DocumentDetail) => void }) {
  const initial = sources.find(item => item.id === preferredSourceId && item.enabled && !item.readOnly) || sources.find(item => item.defaultWrite && item.enabled)
  const [sourceId, setSourceId] = useState(initial?.id || ''), [path, setPath] = useState(initial?.defaultFolder ? `${initial.defaultFolder.replace(/\/$/, '')}/` : ''), [content, setContent] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const running = useRef(false)
  const guard = useUnsavedChanges(!!content || path !== (initial?.defaultFolder ? `${initial.defaultFolder.replace(/\/$/, '')}/` : ''), busy, onClose)
  const source = sources.find(item => item.id === sourceId), available = sources.filter(item => item.enabled && !item.readOnly && item.status !== 'detached')
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!source || !source.enabled || source.readOnly || ['offline', 'error'].includes(source.status)) { setError(t('请选择可访问的可写目录。不会自动改用其他目录。', 'Choose an accessible writable directory. A different directory is never selected automatically.')); return }
    if (!isMarkdownPath(path.trim())) { setError(t('文件名必须以 .md 或 .markdown 结尾。', 'The filename must end with .md or .markdown.')); return }
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { const value = await request<DocumentDetail>(basePath(spaceId), { method: 'POST', body: { sourceId, relativePath: path.trim(), content } }); onCreated(value) }
    catch (cause) { setError(messageOf(cause)) }
    finally { running.current = false; setBusy(false) }
  }
  return <><Modal title={t('新建 Markdown 文档', 'New Markdown document')} description={t('文档将以文件保存到选定目录，默认不发布。', 'The document is saved as a file in the selected directory and starts unpublished.')} wide busy={busy} onClose={() => guard.requestLeave(onClose)}><form onSubmit={save} onInvalidCapture={event => handleFormInvalid(event, setError)} className="library-new-document-form"><Field label={t('保存目录', 'Directory')}><StyledSelect value={sourceId} onValueChange={value => { setSourceId(value); const next = sources.find(item => item.id === value); if (!path || path.endsWith('/')) setPath(next?.defaultFolder ? `${next.defaultFolder.replace(/\/$/, '')}/` : '') }} disabled={busy} placeholder={t('选择文档目录', 'Choose a directory')} options={available.map(item => ({ value: item.id, label: `${item.name}${item.defaultWrite ? t(' · 默认写入', ' · Default') : ''}${['offline', 'error'].includes(item.status) ? t(' · 暂不可用', ' · Unavailable') : ''}` }))}/></Field>{!available.length && <div className="admin-info"><p>{t('当前空间还没有可写目录。', 'This space has no writable directory yet.')}</p><Button type="button" variant="outline" onClick={() => guard.requestLeave(onManage)}>{t('管理目录', 'Manage directories')}</Button></div>}<Field label={t('文件相对路径', 'Relative file path')} hint={t('例如 notes/部署手册.md', 'For example: notes/deployment.md')}><Input value={path} onChange={event => setPath(event.target.value)} disabled={busy} required maxLength={1000} placeholder="notes/README.md"/></Field><Field label={t('Markdown 正文', 'Markdown content')}><Textarea className="library-new-body" value={content} onChange={event => setContent(event.target.value)} disabled={busy} spellCheck={false} placeholder={'# ' + t('文档标题', 'Document title') + '\n\n'}/></Field><ErrorMessage error={error}/><footer className="admin-form-footer"><Button type="button" variant="outline" disabled={busy} onClick={() => guard.requestLeave(onClose)}>{t('取消', 'Cancel')}</Button><Button type="submit" disabled={busy || !available.length}>{busy ? t('正在创建…', 'Creating…') : t('创建文档', 'Create document')}</Button></footer></form></Modal>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard} description={t('新文档尚未保存。离开将放弃当前内容。', 'The new document is not saved. Leaving discards its content.')}/>}</>
}

function MetadataDialog({ document, bookmarks, onClose, onSaved }: { document: DocumentDetail; bookmarks: LibraryBookmark[]; onClose: () => void; onSaved: (value: LibraryDocument) => void }) {
  const [tags, setTags] = useState(document.tags.join(', ')), [ids, setIds] = useState(new Set(document.linkedBookmarkIds)), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const changed = tags !== document.tags.join(', ') || [...ids].sort().join() !== [...document.linkedBookmarkIds].sort().join()
  const guard = useUnsavedChanges(changed, busy, onClose)
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    try { const value = await request<LibraryDocument>(`${docPath(document.spaceId, document.id)}/metadata`, { method: 'PUT', body: { tags: [...new Set(tags.split(/[,，\n]/).map(item => item.trim()).filter(Boolean))], linkedBookmarkIds: [...ids], expectedRevision: document.revision, expectedMetadataRevision: document.metadataRevision } }); onSaved(value) }
    catch (cause) { setError(cause instanceof ApiError && [409, 412].includes(cause.status) ? t('文档、标签或关联已在其他地方修改。当前选择仍然保留，请关闭此面板并重新读取文档，再合并修改。', 'The document, tags or links changed elsewhere. Your selections are preserved. Close this panel, reload the document and merge your changes.') : messageOf(cause)) } finally { setBusy(false) }
  }
  return <><Modal title={t('关联与标签', 'Links and tags')} description={t('关联保存在 Home 中，不会改写 Markdown 文件。', 'Links are stored in Home and do not rewrite the Markdown file.')} busy={busy} onClose={() => guard.requestLeave(onClose)}><form className="library-metadata-form" onSubmit={save}><Field label={t('标签', 'Tags')} hint={t('用逗号分隔', 'Separate with commas')}><Input value={tags} onChange={event => setTags(event.target.value)} disabled={busy} maxLength={1300}/></Field><Field label={t('查找书签', 'Find bookmarks')}><Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索当前空间书签', 'Search bookmarks in this space')}/></Field><div className="library-link-picker">{bookmarks.filter(item => `${item.title} ${item.url}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <label key={item.id}><Checkbox checked={ids.has(item.id)} disabled={busy} onCheckedChange={checked => setIds(current => { const next = new Set(current); checked ? next.add(item.id) : next.delete(item.id); return next })}/><span><strong>{item.title}</strong><small>{item.url}</small></span></label>)}{!bookmarks.length && <p className="admin-hint">{t('当前空间没有书签。', 'This space has no bookmarks.')}</p>}</div><ErrorMessage error={error}/><footer className="admin-form-footer"><span className="admin-hint">{t('已关联 {count} 个书签', '{count} bookmarks linked', { count: ids.size })}</span><Button type="button" variant="outline" disabled={busy} onClick={() => guard.requestLeave(onClose)}>{t('取消', 'Cancel')}</Button><Button type="submit" disabled={busy || !changed || !document.metadataRevision}>{busy ? t('正在保存…', 'Saving…') : t('保存', 'Save')}</Button></footer></form></Modal>{guard.blocked && <DiscardChangesDialog onKeep={guard.keep} onDiscard={guard.discard} description={t('标签和关联还未保存。', 'Tags and links are not saved yet.')}/>}</>
}

function DocumentActionDialog({ action, document, onClose, onDone }: { action: 'rename' | 'delete' | 'publish' | 'unpublish'; document: DocumentDetail; onClose: () => void; onDone: (value?: LibraryDocument) => void }) {
  const [path, setPath] = useState(document.relativePath), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const title = action === 'rename' ? t('重命名原文件', 'Rename original file') : action === 'delete' ? t('删除原文件？', 'Delete original file?') : action === 'publish' ? t('发布当前文档版本？', 'Publish this document version?') : t('取消发布文档？', 'Unpublish document?')
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    const base = docPath(document.spaceId, document.id)
    try {
      let value: LibraryDocument | undefined
      if (action === 'delete') await request(`${base}?expectedRevision=${encodeURIComponent(document.revision)}`, { method: 'DELETE' })
      else if (action === 'unpublish') await request(`${base}/publish`, { method: 'DELETE' })
      else value = await request<LibraryDocument>(`${base}/${action}`, { method: 'POST', body: action === 'rename' ? { relativePath: path.trim(), expectedRevision: document.revision } : { expectedRevision: document.revision, expectedMetadataRevision: document.metadataRevision } })
      onDone(value)
    } catch (cause) { setError(cause instanceof ApiError && [409, 412].includes(cause.status) ? t('文档已在其他地方修改。此操作已停止，请关闭对话框并重新读取最新版本后重试。', 'The document changed elsewhere. This operation stopped. Close the dialog and reload the latest version before retrying.') : messageOf(cause)) } finally { setBusy(false) }
  }
  return <Modal title={title} busy={busy} onClose={onClose}><form className="library-file-action-form" onSubmit={submit} onInvalidCapture={event => handleFormInvalid(event, setError)}><p className="library-action-description">{action === 'delete' ? t('将从外挂目录移除“{path}”。操作前的内容会保留在恢复历史中；书签关联不会因此丢失。', 'Remove “{path}” from its mounted directory. Its content is retained in recovery history and bookmark links are preserved.', { path: document.relativePath }) : action === 'publish' ? t('公开当前文档及它引用的受支持附件快照。以后对原文件的修改仍需重新发布。', 'Publish this document and snapshots of its supported attachments. Later edits to the original file require publishing again.') : action === 'unpublish' ? t('访客将不能再读取此文档及其已发布附件；原文件保留。', 'Visitors will lose access to this document and its published attachments. The original file is retained.') : t('修改同一目录内的文件相对路径，文档编号与书签关联保持不变。', 'Change the file path within this source. Its document ID and bookmark links remain unchanged.')}</p>{action === 'rename' && <Field label={t('新相对路径', 'New relative path')}><Input required maxLength={1000} value={path} disabled={busy} onChange={event => setPath(event.target.value)}/></Field>}<ErrorMessage error={error}/><footer className="admin-form-footer"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button><Button type="submit" variant={action === 'delete' ? 'destructive' : 'default'} disabled={busy || action === 'rename' && path === document.relativePath}>{busy ? t('正在处理…', 'Working…') : action === 'delete' ? t('确认删除原文件', 'Delete original file') : action === 'publish' ? t('确认发布', 'Publish') : action === 'unpublish' ? t('取消发布', 'Unpublish') : t('保存名称', 'Save name')}</Button></footer></form></Modal>
}

type HistoryEntry = { revision: string; createdAt: string; size: number }
function HistoryDialog({ document, canRestore, onClose, onRestored }: { document: DocumentDetail; canRestore: boolean; onClose: () => void; onRestored: () => void }) {
  const [items, setItems] = useState<HistoryEntry[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [snapshot, setSnapshot] = useState<{ revision: string; content: string } | null>(null), [confirm, setConfirm] = useState(false), [reading, setReading] = useState('')
  const generation = useRef(0)
  useEffect(() => { const abort = new AbortController(); request<{ items: HistoryEntry[] }>(`${docPath(document.spaceId, document.id)}/history`, { signal: abort.signal }).then(value => setItems(value.items)).catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) }); return () => abort.abort() }, [document.spaceId, document.id])
  async function read(entry: HistoryEntry) {
    const current = ++generation.current; setReading(entry.revision); setConfirm(false); setError('')
    try { const value = await request<{ revision: string; content: string }>(`${docPath(document.spaceId, document.id)}/history/${encodeURIComponent(entry.revision)}`); if (current === generation.current) setSnapshot(value) }
    catch (cause) { if (current === generation.current) setError(messageOf(cause)) } finally { if (current === generation.current) setReading('') }
  }
  async function restore() {
    if (!snapshot || busy) return; setBusy(true); setError('')
    try { await request(`${docPath(document.spaceId, document.id)}/restore`, { method: 'POST', body: { revision: snapshot.revision, expectedRevision: document.revision } }); onRestored() }
    catch (cause) { setError(conflictMessage(cause)); setConfirm(false) } finally { setBusy(false) }
  }
  return <Modal title={t('文档历史与恢复', 'Document history and recovery')} description={t('显示 Home 保留的版本。外部编辑器产生的所有中间版本不一定都会被记录。', 'Versions retained by Home. Intermediate edits made in other applications may not all be captured.')} wide busy={busy} onClose={onClose}><ErrorMessage error={error}/>{loading ? <Loading/> : !items.length ? <Empty title={t('暂无保留的历史版本', 'No retained versions yet')}/> : <div className="library-history"><div className="library-history-list">{items.map(item => <button className={snapshot?.revision === item.revision ? 'active' : ''} key={item.revision} disabled={busy || !!reading} onClick={() => read(item)}><strong>{formatUpdated(item.createdAt)}</strong><small>{item.revision.slice(0, 12)} · {(item.size / 1024).toFixed(1)} KiB</small></button>)}</div><div className="library-history-content">{reading ? <Loading/> : snapshot ? <Textarea value={snapshot.content} readOnly aria-label={t('历史版本内容', 'Historical version content')} spellCheck={false}/> : <p className="admin-hint">{t('选择一个版本查看内容。', 'Select a version to inspect its content.')}</p>}</div></div>}{confirm && <div className="admin-conflict">{t('恢复会将此历史内容写回原路径。当前文件若已在外部变化，恢复会停止，不会静默覆盖。', 'Restoring writes this version to the original path. If the current file changed elsewhere, restoration stops instead of silently overwriting it.')}</div>}<footer className="admin-form-footer"><Button variant="outline" disabled={busy} onClick={onClose}>{t('关闭', 'Close')}</Button>{snapshot && <Button variant="outline" disabled={busy} onClick={() => saveText(snapshot.content, document.relativePath)}><Download size={14}/>{t('下载此版本', 'Download version')}</Button>}{canRestore && snapshot && <Button disabled={busy || !!reading} onClick={() => confirm ? restore() : setConfirm(true)}>{busy ? t('正在恢复…', 'Restoring…') : confirm ? t('确认写回原文件', 'Confirm restoration') : t('恢复此版本', 'Restore version')}</Button>}</footer></Modal>
}
