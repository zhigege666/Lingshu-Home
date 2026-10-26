import { t } from '../core/i18n'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Upload } from 'lucide-react'
import { messageOf, request } from '../core/api'
import { categoryLabel, linkInput, navigationData, safeHref } from '../core/presentation'
import type { BookmarkPreview, BookmarkResult, Category, Dashboard, LinkInput, NavLink } from '../core/types'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { StyledSelect } from '../components/ui/select'
import { Checkbox } from '../components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { ErrorMessage, Field, FilePicker, handleFormInvalid, Modal } from '../components/Shared'
import { IconPicker } from '../components/IconPicker'
import LinkEndpointsEditor, { endpointValidationError } from './LinkEndpointsEditor'
type Common = { dashboard: Dashboard; onClose: () => void; onSaved: (message: string) => Promise<void> }
const emptyLink: LinkInput = { title: '', url: '', description: '', contextMarkdown: '', categoryId: null, icon: 'lucide:link', iconMode: 'auto', tags: [], isFavorite: false, sortOrder: 0, endpoints: [] }
function categoryOptions(categories: Category[]) { return categories.map(category => ({ value: category.id, label: categoryLabel(category,categories) })) }
export function LinkEditor({ dashboard, link, onClose, onSaved, autoFetchIcons = true, autoSelectEndpoint = true, onApplyDraft }: Common & { link: NavLink | null; autoFetchIcons?: boolean; autoSelectEndpoint?: boolean; onApplyDraft?: (input: LinkInput) => void }) {
  const categories = navigationData(dashboard.datasets.navigation)?.categories || []
  const [form,setForm] = useState<LinkInput>(() => link ? linkInput(link) : structuredClone(emptyLink))
  const [tags,setTags] = useState(form.tags.join(', ')); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [iconBusy,setIconBusy] = useState(false)
  function field<K extends keyof LinkInput>(key: K, value: LinkInput[K]) { setForm(previous => ({ ...previous,[key]: value })) }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || iconBusy || !dashboard.space.canEdit) return; setError('')
    if (!safeHref(form.url) || form.endpoints.some(item=>!safeHref(item.url))) { setError(t("主入口和其他入口均须使用完整的 HTTP 或 HTTPS 网址。", "The primary and additional URLs must be complete HTTP or HTTPS addresses.")); return }
    const endpointError = endpointValidationError(form.endpoints); if (endpointError) { setError(endpointError); return }
    if (new TextEncoder().encode(form.contextMarkdown || '').length > 64 * 1024) { setError(t('使用说明不能超过 64 KiB。', 'Usage notes must be at most 64 KiB.')); return }
    if (onApplyDraft) { onApplyDraft({ ...form, iconMode: form.iconMode === 'auto' ? 'auto' : 'manual', title: form.title.trim(), url: form.url.trim(), tags: [...new Set(tags.split(/[,，]/).map(value => value.trim()).filter(Boolean))] }); return }
    setBusy(true)
    try { await request(`/spaces/${dashboard.space.id}/links${link ? '/'+link.id : ''}`,{method:link?'PUT':'POST',body:{...form,expectedUpdatedAt:link?.updatedAt,iconMode:form.iconMode === 'auto' ? 'auto' : 'manual',title:form.title.trim(),url:form.url.trim(),tags:[...new Set(tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean))]}}); await onSaved(form.iconMode === 'auto' && autoFetchIcons ? t('链接已保存；图标在后台获取，刷新后显示。', 'Link saved. Its icon is fetched in the background; refresh to see it.') : link?t("链接已更新", "Link updated"):t("链接已添加", "Link added")) } catch (cause) { setError(messageOf(cause)) } finally { setBusy(false) }
  }
  return <Modal title={link ? t('编辑链接', 'Edit link') : t('添加链接', 'Add link')}
    description={onApplyDraft ? t('先应用到草稿，再通过列表的“保存全部”提交。', 'Apply to the draft, then use Save all in the list.') : t('保存到 {name}', 'Save to {name}', { name: dashboard.space.name })}
    busy={busy || iconBusy} wide className={'admin-link-dialog' + (onApplyDraft ? ' admin-inline-detail' : '')} onClose={onClose}>
    <form onSubmit={save} onInvalidCapture={event => handleFormInvalid(event, setError)}>
      <fieldset disabled={busy || iconBusy || !dashboard.space.canEdit} className="admin-plain-fieldset">
        <div className="admin-link-details">
          <div className="admin-link-basics">
            <div className="admin-form-row equal">
              <Field label={t('链接名称', 'Link name')}><Input autoFocus required maxLength={160} value={form.title} onChange={e => field('title', e.target.value)}/></Field>
              <Field label={t('分类', 'Category')}><StyledSelect name="categoryId" value={form.categoryId || ''} onValueChange={value => field('categoryId', value || null)} disabled={busy} options={[{ value: '', label: t('未分类', 'Uncategorized') }, ...categoryOptions(categories)]}/></Field>
            </div>
            <Field label={t('主入口 URL', 'Primary URL')} hint={t('关闭自动选路或没有网络入口时使用', 'Used when routing is off or no network route is configured')}>
              <Input type="url" required maxLength={2048} placeholder="https://" value={form.url} onChange={e => field('url', e.target.value)}/>
            </Field>
            <Field label={t('描述', 'Description')} hint={t('选填', 'Optional')}><Textarea maxLength={2000} value={form.description} onChange={e => field('description', e.target.value)}/></Field>
            <div className="admin-form-row equal">
              <Field label={t('标签', 'Tags')} hint={t('使用逗号分隔', 'Separate with commas')}><Input value={tags} onChange={e => setTags(e.target.value)} maxLength={1300}/></Field>
              <Field className="admin-field-inline" label={t('排序', 'Sort order')}><Input type="number" value={form.sortOrder} onChange={e => field('sortOrder', Number(e.target.value))}/></Field>
            </div>
            <label className="admin-check-line"><Checkbox checked={form.isFavorite} onCheckedChange={value => field('isFavorite', value)} disabled={busy}/>{t('加入常用收藏', 'Add to favorites')}</label>
          </div>
          <div className="admin-link-icon-panel">
            <IconPicker value={form.icon} onChange={icon => setForm(previous => ({ ...previous, icon, iconMode: 'manual' }))}
              iconMode={form.iconMode || 'manual'} onModeChange={mode => field('iconMode', mode)} autoFetchIcons={autoFetchIcons}
              spaceId={dashboard.space.id} canEdit={dashboard.space.canEdit} allowLibraryChanges={!onApplyDraft} disabled={busy} url={form.url} onBusyChange={setIconBusy}/>
          </div>
        </div>
        {!onApplyDraft && <Field label={t('使用说明', 'Usage notes')} hint={t('选填 · Markdown · 最多 64 KiB', 'Optional · Markdown · Up to 64 KiB')}>
          <Textarea rows={7} maxLength={65536} value={form.contextMarkdown || ''} onChange={e => field('contextMarkdown', e.target.value)} placeholder={t('记录何时使用、适用场景和相关操作说明…', 'Describe when to use this bookmark and add relevant guidance…')}/>
          <p className="admin-hint">{t('供你和 Agent 阅读。这里的文字不会授予额外权限，也不会自动执行。使用说明与书签具有相同的可见范围。', 'Reference material for you and agents. These notes grant no permissions and do not run automatically. Usage notes have the same visibility as their bookmark.')}</p>
        </Field>}
        {onApplyDraft && <p className="admin-hint">{t('列表保存会保留已有使用说明；请在单条编辑中修改使用说明。', 'List saves preserve existing usage notes. Edit those notes in the individual bookmark editor.')}</p>}
        <LinkEndpointsEditor value={form.endpoints} onChange={endpoints => field('endpoints', endpoints)} disabled={busy || iconBusy || !dashboard.space.canEdit} autoSelectEndpoint={autoSelectEndpoint}/>
        <div className="admin-form-footer">
          <ErrorMessage error={error}/>
          <Button type="button" variant="outline" onClick={onClose}>{t('取消', 'Cancel')}</Button>
          <Button type="submit">{busy ? t('正在保存…', 'Saving…') : onApplyDraft ? t('应用到草稿', 'Apply to draft') : t('保存链接', 'Save link')}</Button>
        </div>
      </fieldset>
    </form>
  </Modal>
}
export function CategoryEditor({ dashboard, category, onClose, onSaved, onApplyDraft }: Common & { category: Category | null; onApplyDraft?: (input: Omit<Category, 'id' | 'spaceId'>) => void }) {
  const categories = navigationData(dashboard.datasets.navigation)?.categories || []
  const [form,setForm] = useState({name:category?.name||'',parentId:category?.parentId||null as string|null,icon:category?.icon||'lucide:folder',sortOrder:category?.sortOrder||0})
  const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [iconBusy,setIconBusy] = useState(false)
  const forbidden = new Set<string>(category?[category.id]:[]); let growing=true
  while(growing){growing=false;for(const c of categories)if(c.parentId&&forbidden.has(c.parentId)&&!forbidden.has(c.id)){forbidden.add(c.id);growing=true}}
  async function save(event: FormEvent) { event.preventDefault();if(busy || iconBusy || !dashboard.space.canEdit)return;if(onApplyDraft){onApplyDraft({...form,name:form.name.trim()});return}setBusy(true);setError('');try{await request(`/spaces/${dashboard.space.id}/categories${category?'/'+category.id:''}`,{method:category?'PUT':'POST',body:{...form,name:form.name.trim()}});await onSaved(category?t("分类已更新", "Category updated"):t("分类已添加", "Category added"))}catch(cause){setError(messageOf(cause))}finally{setBusy(false)} }
  return <Modal title={category?t("编辑分类", "Edit category"):t("添加分类", "Add category")} className={'admin-category-dialog' + (onApplyDraft ? ' admin-inline-detail' : '')} busy={busy || iconBusy} onClose={onClose}><form onSubmit={save} onInvalidCapture={event=>handleFormInvalid(event,setError)}><fieldset disabled={busy || iconBusy || !dashboard.space.canEdit} className="admin-plain-fieldset"><Field className="admin-field-inline" label={t("分类名称", "Category name")}><Input required autoFocus maxLength={80} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field><div className="admin-form-row equal"><Field className="admin-field-inline" label={t("父分类", "Parent category")}><StyledSelect name="parentId" value={form.parentId||''} onValueChange={value=>setForm({...form,parentId:value||null})} disabled={busy} options={[{value:'',label:t("顶层分类", "Top level")},...categoryOptions(categories.filter(c=>!forbidden.has(c.id)))]}/></Field><Field className="admin-field-inline" label={t("排序", "Sort order")}><Input type="number" value={form.sortOrder} onChange={e=>setForm({...form,sortOrder:Number(e.target.value)})}/></Field></div><IconPicker value={form.icon} onChange={icon=>setForm({...form,icon})} spaceId={dashboard.space.id} canEdit={dashboard.space.canEdit} allowLibraryChanges={!onApplyDraft} disabled={busy} fallback="lucide:folder" onBusyChange={setIconBusy}/><ErrorMessage error={error}/><div className="admin-form-footer"><Button type="button" variant="outline" onClick={onClose}>{t("取消", "Cancel")}</Button><Button type="submit">{busy?t("正在保存…", "Saving…"):onApplyDraft?t("应用到草稿", "Apply to draft"):t("保存分类", "Save category")}</Button></div></fieldset></form></Modal>
}
export function BookmarkImporter({ dashboard, onClose, onSaved, autoFetchIcons = true }: Common & { autoFetchIcons?: boolean }) {
  const categories = navigationData(dashboard.datasets.navigation)?.categories || []
  const [html,setHtml] = useState(''); const [filename,setFilename] = useState(''); const [policy,setPolicy] = useState<'skip'|'keep'>('skip'); const [target,setTarget] = useState('')
  const [preview,setPreview] = useState<BookmarkPreview|null>(null); const [busy,setBusy] = useState(false); const [error,setError] = useState('')
  const fileVersion = useRef(0)
  useEffect(()=>()=>{fileVersion.current++},[])
  async function select(file?:File) { const version=++fileVersion.current;setError('');setPreview(null);setHtml('');setFilename(file?.name||'');if(!file)return;if(file.size>2*1024*1024){setError(t("文件不能超过 2 MiB。", "The file must be no larger than 2 MiB."));return}try{const markup=await file.text();if(version===fileVersion.current)setHtml(markup)}catch{if(version===fileVersion.current)setError(t("无法读取文件，请重新选择。", "Unable to read this file. Please select it again."))} }
  async function submit(importing:boolean) {setBusy(true);setError('');try{const body={html,duplicatePolicy:policy,targetCategoryId:target||null};if(importing){const result=await request<BookmarkResult>(`/spaces/${dashboard.space.id}/bookmarks/import`,{method:'POST',body});await onSaved(t("已导入 {count} 个链接，跳过 {skipped} 个重复项", "Imported {count} links; skipped {skipped} duplicates", { count: result.imported, skipped: result.skipped }) + (result.imported && autoFetchIcons ? t('；图标在后台获取，刷新列表后显示。', ' Icons are fetched in the background; refresh the list to see them.') : ''))}else{setPreview(await request<BookmarkPreview>(`/spaces/${dashboard.space.id}/bookmarks/preview`,{method:'POST',body}))}}catch(cause){setError(messageOf(cause))}finally{setBusy(false)} }
  return <Modal title={t("导入浏览器书签", "Import browser bookmarks")} description={t("支持 Chrome / Netscape HTML，最大 2 MiB、10,000 个链接。", "Chrome / Netscape HTML; up to 2 MiB and 10,000 links.")} busy={busy} wide onClose={onClose}><fieldset disabled={busy} className="admin-plain-fieldset"><Field label={t("HTML 书签文件", "HTML bookmark file")}><FilePicker accept=".html,.htm,text/html" filename={filename} disabled={busy} onFileChange={file=>{void select(file)}}/></Field><div className="admin-form-row equal"><Field label={t("重复网址", "Duplicate URLs")}><StyledSelect value={policy} disabled={busy} onValueChange={value=>{setPolicy(value as 'skip'|'keep');setPreview(null)}} options={[{value:'skip',label:t("跳过重复项", "Skip duplicates")},{value:'keep',label:t("保留重复项", "Keep duplicates")}]}/></Field><Field label={t("导入到分类", "Import into category")}><StyledSelect value={target} disabled={busy} onValueChange={value=>{setTarget(value);setPreview(null)}} options={[{value:'',label:t("根目录", "Root")},...categoryOptions(categories)]}/></Field></div><p className="admin-hint">{autoFetchIcons ? t('导入的链接使用自动图标。保存后后台获取，刷新列表后显示。', 'Imported links use automatic icons. They are fetched after import; refresh the list to see them.') : t('导入的链接保留自动模式，但本站已暂停自动获取图标。已保存图标继续显示，你仍可手动选择或获取。', 'Imported links keep automatic mode, but automatic icon fetching is paused for this site. Saved icons stay visible; you can still select or fetch icons manually.')}</p><ErrorMessage error={error}/>{preview&&<><div className="admin-import-counts"><span>{t("总计", "Total")} <strong>{preview.total}</strong></span><span>{t("有效", "Valid")} <strong>{preview.valid}</strong></span><span>{t("重复", "Duplicate")} <strong>{preview.duplicates}</strong></span><span>{t("无效", "Invalid")} <strong>{preview.invalid}</strong></span></div><Table><TableHeader><TableRow><TableHead>{t("名称 / URL", "Name / URL")}</TableHead><TableHead>{t("文件夹", "Folder")}</TableHead><TableHead>{t("状态", "Status")}</TableHead></TableRow></TableHeader><TableBody>{preview.items.map((item,index)=><TableRow key={index}><TableCell><strong>{item.title}</strong><small>{item.url}</small></TableCell><TableCell>{item.folderPath?.join(' / ')||t("根目录", "Root")}</TableCell><TableCell>{{valid:t("有效", "Valid"),duplicate:t("重复", "Duplicate"),invalid:t("无效网址", "Invalid URL")}[item.status]}</TableCell></TableRow>)}</TableBody></Table>{preview.truncated&&<p className="admin-hint">{t("这里只显示前 200 项；统计覆盖完整文件。", "Only the first 200 items are shown. Totals cover the entire file.")}</p>}</>}<div className="admin-form-footer"><Button type="button" variant="outline" onClick={onClose}>{t("取消", "Cancel")}</Button><Button type="button" variant={preview?'outline':'default'} disabled={!html||busy} onClick={()=>submit(false)}>{t("预览文件", "Preview file")}</Button>{preview&&<Button type="button" disabled={busy||!preview.valid} onClick={()=>submit(true)}><Upload size={16}/>{busy?t("正在导入…", "Importing…"):t("确认导入", "Import bookmarks")}</Button>}</div></fieldset></Modal>
}
