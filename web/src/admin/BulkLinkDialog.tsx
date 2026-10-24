import { useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError, messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import type { Category, NavLink } from '../core/types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { ErrorMessage, Field, handleFormInvalid, Modal } from '../components/Shared'

export type BulkLinkAction = 'move' | 'tags' | 'favorite'
export type BulkLinkResult = { selectedCount: number; updatedCount: number; revision: string }
type Props = {
  spaceId: string; spaceName: string; revision: string; links: NavLink[]; action: BulkLinkAction
  categories: Category[]; categoryLabels: Map<string, string>
  onClose: () => void; onReload: () => void; onSaved: (result: BulkLinkResult) => Promise<void>
}

export function BulkLinkDialog({ spaceId, spaceName, revision, links, action, categories, categoryLabels, onClose, onReload, onSaved }: Props) {
  const [category, setCategory] = useState('uncategorized'), [tagsText, setTagsText] = useState('')
  const [tagMode, setTagMode] = useState('add-tags'), [favorite, setFavorite] = useState('true')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const running = useRef(false)
  const tags = useMemo(() => [...new Set(tagsText.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))], [tagsText])
  const validTags = tags.length > 0 && tags.length <= 32 && tags.every(tag => [...tag].length <= 40 && !/[\u0000-\u001f\u007f]/.test(tag))
  const affected = links.filter(link => action === 'move' ? (link.categoryId || 'uncategorized') !== category
    : action === 'favorite' ? link.isFavorite !== (favorite === 'true')
    : tags.some(tag => tagMode === 'add-tags' ? !link.tags.includes(tag) : link.tags.includes(tag))).length
  const title = action === 'move' ? t('批量移动分类', 'Move selected links') : action === 'tags' ? t('批量维护标签', 'Edit selected tags') : t('批量设置收藏', 'Set selected favorites')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (running.current || stale) return
    if (action === 'tags' && !validTags) { setError(t('请输入 1–32 个标签，每个不超过 40 个字符。', 'Enter 1–32 tags, with at most 40 characters each.')); return }
    if (action === 'tags' && tagMode === 'add-tags' && links.some(link => new Set([...link.tags, ...tags]).size > 32)) {
      setError(t('添加后有链接会超过 32 个标签。请减少标签或缩小选择范围。', 'Some links would exceed 32 tags. Remove some tags or select fewer links.')); return
    }
    running.current = true; setBusy(true); setError('')
    try {
      const change = action === 'move' ? { operation: 'move', categoryId: category === 'uncategorized' ? null : category }
        : action === 'tags' ? { operation: tagMode, tags } : { operation: 'favorite', isFavorite: favorite === 'true' }
      const result = await request<BulkLinkResult>('/spaces/' + encodeURIComponent(spaceId) + '/links/batch', {
        method: 'POST', body: { linkIds: links.map(link => link.id), expectedRevision: revision, ...change }
      })
      await onSaved(result)
    } catch (cause) {
      const outdated = cause instanceof ApiError && (cause.status === 409 || cause.status === 404)
      setStale(outdated)
      setError(outdated ? t('列表已发生变化，本次没有修改任何链接。请刷新列表并重新选择。', 'The list changed. No links were changed by this request. Refresh the list and select again.') : messageOf(cause))
    } finally { running.current = false; setBusy(false) }
  }
  return <Modal title={title} busy={busy} onClose={onClose}>
    <form onSubmit={submit} onInvalidCapture={event => handleFormInvalid(event, setError)} className="admin-bulk-form">
      <p className="admin-bulk-summary">{t('将在「{space}」中处理已选的 {count} 个链接。', 'Apply to the {count} selected links in “{space}”.', { space: spaceName, count: links.length })}</p>
      <p className="admin-hint admin-bulk-examples">{links.slice(0, 3).map(link => link.title).join(' · ')}{links.length > 3 ? t(' 等 {count} 项', ' and {count} more', { count: links.length - 3 }) : ''}</p>
      <fieldset disabled={busy || stale} className="admin-plain-fieldset">
        {action === 'move' && <Field label={t('目标分类', 'Destination category')}>
          <StyledSelect aria-label={t('目标分类', 'Destination category')} value={category} onValueChange={setCategory} disabled={busy || stale}
            options={[{ value: 'uncategorized', label: t('未分类', 'Uncategorized') }, ...categories.map(item => ({ value: item.id, label: categoryLabels.get(item.id) || item.name }))]}/>
        </Field>}
        {action === 'tags' && <>
          <Field label={t('标签操作', 'Tag operation')}><StyledSelect aria-label={t('标签操作', 'Tag operation')} value={tagMode} onValueChange={setTagMode} disabled={busy || stale}
            options={[{ value: 'add-tags', label: t('添加标签', 'Add tags') }, { value: 'remove-tags', label: t('移除标签', 'Remove tags') }]}/></Field>
          <Field label={t('标签', 'Tags')} hint={t('以逗号分隔。只添加或移除这些标签，保留其他标签。', 'Separate with commas. Other existing tags are preserved.')}>
            <Input autoFocus required value={tagsText} onChange={event => setTagsText(event.target.value)} placeholder={t('例如：工作, 常用', 'For example: work, daily')} maxLength={1400}/>
          </Field>
        </>}
        {action === 'favorite' && <Field label={t('收藏状态', 'Favorite status')}><StyledSelect aria-label={t('收藏状态', 'Favorite status')} value={favorite} onValueChange={setFavorite} disabled={busy || stale}
          options={[{ value: 'true', label: t('设为收藏', 'Add to favorites') }, { value: 'false', label: t('取消收藏', 'Remove from favorites') }]}/></Field>}
      </fieldset>
      <p className="admin-hint" role="status">{action !== 'tags' || validTags ? t('预计修改 {count} 个链接；已经符合条件的链接保持不变。', '{count} links will change; links already matching this choice stay as they are.', { count: affected }) : t('填写标签后可查看预计修改数量。', 'Enter tags to see how many links will change.')}</p>
      <ErrorMessage error={error}/>
      <div className="admin-form-footer">
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button>
        {stale ? <Button type="button" onClick={onReload}>{t('刷新并重新选择', 'Refresh and select again')}</Button>
          : <Button type="submit" disabled={busy || action === 'tags' && !validTags}>{busy ? t('正在应用…', 'Applying…') : t('应用到 {count} 个链接', 'Apply to {count} links', { count: links.length })}</Button>}
      </div>
    </form>
  </Modal>
}
