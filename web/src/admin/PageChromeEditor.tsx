import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Link2, Plus, Trash2, Type } from 'lucide-react'
import { readPageChrome } from '../core/chrome'
import { t } from '../core/i18n'
import { ProjectLogo } from '../components/ProjectLogo'
import { viewId } from '../core/presentation'
import type { ChromeItem, PageChrome } from '../core/types'
import { Empty, Field } from '../components/Shared'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'

type Area = 'header' | 'footer'
type Alignment = 'left' | 'center' | 'right'
import { type ChromeValidationIssue } from '../core/chrome-validation'
export { validatePageChrome, type ChromeValidationIssue } from '../core/chrome-validation'
type Props = { chrome?: PageChrome; disabled: boolean; issue: ChromeValidationIssue | null; onChange: (chrome: PageChrome) => void }
const areas: Area[] = ['header', 'footer']
const alignments: Alignment[] = ['left', 'center', 'right']
const areaName = (area: Area) => area === 'header' ? t('页眉', 'Header') : t('页脚', 'Footer')
const alignmentName = (alignment: Alignment) => alignment === 'left' ? t('左侧', 'Left') : alignment === 'center' ? t('居中', 'Center') : t('右侧', 'Right')
const itemTypeName = (type: ChromeItem['type']) => type === 'branding' ? t('项目品牌', 'Project branding') : type === 'link' ? t('链接', 'Link') : t('文字', 'Text')

export function PageChromeEditor({ chrome, disabled, issue, onChange }: Props) {
  const value = useMemo(() => readPageChrome(chrome), [chrome])
  const [area, setArea] = useState<Area>(issue?.area || 'header')
  const [alignment, setAlignment] = useState<Alignment>(issue?.alignment || 'left')
  const [selectedId, setSelectedId] = useState(issue?.itemId || '')
  const [addType, setAddType] = useState<ChromeItem['type']>('text')
  const inspector = useRef<HTMLDivElement>(null)
  const pendingIssueFocus = useRef<ChromeValidationIssue | null>(null)
  const items = value[area][alignment]
  const selected = items.find(item => item.id === selectedId) || items[0]
  const selectedIndex = selected ? items.findIndex(item => item.id === selected.id) : -1
  const enabled = value[area].enabled

  useLayoutEffect(() => {
    pendingIssueFocus.current = issue
    if (!issue) return
    setArea(issue.area); setAlignment(issue.alignment); setSelectedId(issue.itemId || '')
  }, [issue])

  // A frame scheduled while changing slots can still see the old inspector.
  // Focus only after the matching selection has committed, once per validation
  // attempt, so subsequent manual navigation never steals focus back.
  useLayoutEffect(() => {
    if (!issue || pendingIssueFocus.current !== issue || disabled
      || area !== issue.area || alignment !== issue.alignment
      || issue.itemId && selected?.id !== issue.itemId) return
    const target = inspector.current
    const control = (issue.field && target?.querySelector<HTMLElement>('[data-chrome-field="' + issue.field + '"]'))
      || target?.querySelector<HTMLElement>('input:invalid, textarea:invalid')
      || target?.querySelector<HTMLElement>('textarea, input:not([aria-hidden="true"]):not([type="hidden"])')
      || target?.querySelector<HTMLElement>('[role="combobox"]')
    if (!control?.isConnected || !control.getClientRects().length) return
    control.focus()
    if (control.ownerDocument.activeElement === control) pendingIssueFocus.current = null
  }, [issue, area, alignment, selected?.id, disabled])

  function edit(change: (next: PageChrome) => void) {
    if (disabled) return
    const next = readPageChrome(chrome); change(next); onChange(next)
  }
  function addItem() {
    if (disabled || items.length >= 8) return
    const id = 'chrome-' + viewId()
    const item: ChromeItem = addType === 'branding' ? { id, type: 'branding' }
      : addType === 'link' ? { id, type: 'link', text: '', url: '', newTab: true }
        : { id, type: 'text', text: '' }
    edit(next => { next[area][alignment].push(item) })
    setSelectedId(id)
  }
  function updateItem(change: (item: ChromeItem) => ChromeItem) {
    if (!selected) return
    edit(next => { next[area][alignment] = next[area][alignment].map(item => item.id === selected.id ? change(item) : item) })
  }
  function changeType(type: ChromeItem['type']) {
    updateItem(item => type === 'branding' ? { id: item.id, type }
      : type === 'text' ? { id: item.id, type, text: item.text || '' }
        : { id: item.id, type, text: item.text || '', url: item.url || '', newTab: item.newTab ?? true })
  }
  function removeItem() {
    if (!selected) return
    setSelectedId(items[selectedIndex + 1]?.id || items[selectedIndex - 1]?.id || '')
    edit(next => { next[area][alignment] = next[area][alignment].filter(item => item.id !== selected.id) })
  }
  function reorder(direction: number) {
    const other = selectedIndex + direction
    if (!selected || other < 0 || other >= items.length) return
    edit(next => {
      const list = next[area][alignment], previous = list[selectedIndex]!
      list[selectedIndex] = list[other]!; list[other] = previous
    })
  }
  function moveItem(targetArea: Area, targetAlignment: Alignment) {
    if (!selected || (area === targetArea && alignment === targetAlignment) || value[targetArea][targetAlignment].length >= 8) return
    edit(next => {
      next[area][alignment] = next[area][alignment].filter(item => item.id !== selected.id)
      next[targetArea][targetAlignment].push(selected)
    })
    setArea(targetArea); setAlignment(targetAlignment)
  }

  return <div className="admin-chrome-editor">
    <Tabs value={area} onValueChange={next => { setArea(next as Area); setSelectedId('') }} className="admin-chrome-tabs">
      <TabsList variant="line" aria-label={t('页眉页脚区域', 'Header and footer area')}>
        <TabsTrigger value="header" disabled={disabled}>{t('页眉', 'Header')}</TabsTrigger>
        <TabsTrigger value="footer" disabled={disabled}>{t('页脚', 'Footer')}</TabsTrigger>
      </TabsList>
      {areas.map(current => <TabsContent value={current} key={current}>
        <div className="admin-chrome-area-state">
          <label className="admin-check-line"><Checkbox checked={value[current].enabled} disabled={disabled}
            onCheckedChange={checked => edit(next => { next[current].enabled = checked })} />
            {current === 'header' ? t('显示页眉内容', 'Show header content') : t('显示页脚内容', 'Show footer content')}</label>
          {!value[current].enabled && <p>{t('此区域已关闭，已配置的内容仍会保留。', 'This area is off. Its configured items are retained.')}</p>}
        </div>
      </TabsContent>)}
    </Tabs>
    <div className="admin-chrome-alignments" role="group" aria-label={t('选择对齐位置', 'Choose alignment')}>
      {alignments.map(position => {
        const Icon = position === 'left' ? AlignLeft : position === 'center' ? AlignCenter : AlignRight
        return <button type="button" key={position} aria-pressed={alignment === position}
          className={alignment === position ? 'selected' : ''} disabled={disabled}
          onClick={() => { setAlignment(position); setSelectedId('') }}>
          <Icon size={16} aria-hidden="true" /><span>{alignmentName(position)}</span><small>{value[area][position].length}</small>
        </button>
      })}
    </div>
    <div className="admin-chrome-toolbar">
      <span>{t('{area} / {alignment} · 共 {count} 项', '{area} / {alignment} · {count} items', { area: areaName(area), alignment: alignmentName(alignment), count: items.length })}</span>
      <div className="admin-inline-controls">
        <StyledSelect aria-label={t('要添加的页眉页脚内容', 'Header or footer item to add')} value={addType}
          onValueChange={next => setAddType(next as ChromeItem['type'])} disabled={disabled || items.length >= 8}
          options={(['text', 'link', 'branding'] as const).map(type => ({ value: type, label: itemTypeName(type) }))} />
        <Button type="button" disabled={disabled || items.length >= 8} onClick={addItem}><Plus size={15} />{t('添加内容', 'Add item')}</Button>
      </div>
    </div>
    {selected ? <div className="admin-chrome-content">
      <aside className="admin-chrome-item-list" aria-label={t('当前位置的内容', 'Items at this position')}>
        <ul>{items.map((item, index) => {
          const Icon = item.type === 'link' ? Link2 : Type
          const title = item.type === 'branding' ? t('Lingshu-Home 品牌', 'Lingshu-Home branding') : item.text || t('未填写文本', 'Text pending')
          return <li key={item.id}><button type="button" disabled={disabled} className={selected.id === item.id ? 'selected' : ''}
            aria-pressed={selected.id === item.id} aria-label={t('编辑 {type} {count}', 'Edit {type} {count}', { type: itemTypeName(item.type), count: index + 1 })}
            title={title} onClick={() => setSelectedId(item.id)}>{item.type === 'branding' ? <ProjectLogo size={18} /> : <Icon size={16} aria-hidden="true" />}<span><strong>{title}</strong><small>{itemTypeName(item.type)}</small></span></button></li>
        })}</ul>
      </aside>
      <section className="admin-chrome-inspector">
        <header><h3>{itemTypeName(selected.type)}</h3><span className="grow" />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t('上移内容', 'Move item up')} disabled={disabled || selectedIndex <= 0} onClick={() => reorder(-1)}><ArrowUp size={15} /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t('下移内容', 'Move item down')} disabled={disabled || selectedIndex >= items.length - 1} onClick={() => reorder(1)}><ArrowDown size={15} /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t('删除内容', 'Remove item')} disabled={disabled} onClick={removeItem}><Trash2 size={15} /></Button>
        </header>
        <div ref={inspector} className="admin-chrome-inspector-body" role="region" aria-label={t('页眉页脚内容配置', 'Header or footer item settings')} tabIndex={0}>
          {!enabled && <p className="admin-info">{t('开启上方的区域显示后，内容会出现在首页。', 'Enable this area above to show its content on the homepage.')}</p>}
          <div className="admin-form-row equal">
            <Field label={t('内容类型', 'Item type')}><StyledSelect value={selected.type} disabled={disabled}
              onValueChange={next => changeType(next as ChromeItem['type'])}
              options={(['text', 'link', 'branding'] as const).map(type => ({ value: type, label: itemTypeName(type) }))} /></Field>
            <Field label={t('显示区域', 'Area')}><StyledSelect value={area} disabled={disabled}
              onValueChange={next => moveItem(next as Area, alignment)}
              options={areas.map(next => ({ value: next, label: areaName(next), disabled: next !== area && value[next][alignment].length >= 8 }))} /></Field>
            <Field label={t('对齐位置', 'Alignment')}><StyledSelect value={alignment} disabled={disabled}
              onValueChange={next => moveItem(area, next as Alignment)}
              options={alignments.map(next => ({ value: next, label: alignmentName(next), disabled: next !== alignment && value[area][next].length >= 8 }))} /></Field>
          </div>
          {selected.type === 'branding' ? <div className="admin-chrome-branding"><ProjectLogo size={48} /><strong>Lingshu-Home</strong><p>{t('使用内置项目标识，可移动或移除。', 'Uses the built-in project branding. You can move or remove it.')}</p></div>
            : selected.type === 'text' ? <Field label={t('文本', 'Text')} hint={t('最多 500 个字符，可换行', 'Up to 500 characters; line breaks allowed')}>
              <Textarea data-chrome-field="text" required maxLength={500} value={selected.text || ''} disabled={disabled} rows={5} onChange={event => updateItem(item => ({ ...item, text: event.target.value }))} />
            </Field> : <>
              <Field label={t('链接文本', 'Link text')} hint={t('最多 160 个字符', 'Up to 160 characters')}>
                <Input data-chrome-field="text" required maxLength={160} value={selected.text || ''} disabled={disabled} onChange={event => updateItem(item => ({ ...item, text: event.target.value }))} />
              </Field>
              <Field label={t('链接网址', 'Link URL')} hint={t('使用完整的 HTTP 或 HTTPS 网址', 'Use a complete HTTP or HTTPS URL')}>
                <Input data-chrome-field="url" required type="url" maxLength={2048} placeholder="https://example.com" value={selected.url || ''} disabled={disabled}
                  onChange={event => updateItem(item => ({ ...item, url: event.target.value }))} />
              </Field>
              <label className="admin-check-line"><Checkbox checked={selected.newTab ?? true} disabled={disabled}
                onCheckedChange={checked => updateItem(item => ({ ...item, newTab: checked }))} />{t('在新标签页打开', 'Open in a new tab')}</label>
            </>}
        </div>
      </section>
    </div> : <Empty title={t('此位置暂无内容', 'No items at this position')} detail={t('选择文字、链接或项目品牌，再添加内容。每个位置最多 8 项。', 'Choose text, a link or project branding, then add an item. Each position supports up to 8 items.')} />}
  </div>
}
