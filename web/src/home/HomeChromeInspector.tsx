import { useLayoutEffect, useRef, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Link2, Plus, Trash2, Type } from 'lucide-react'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { ProjectLogo } from '../components/ProjectLogo'
import { readPageChrome } from '../core/chrome'
import type { ChromeValidationIssue } from '../core/chrome-validation'
import { t } from '../core/i18n'
import { viewId } from '../core/presentation'
import type { ChromeItem, PageChrome } from '../core/types'
import { ComposerButton, ComposerCheck, ComposerField, ComposerSelect } from './HomeEditorControls'
import type { ChromeAlignment, ChromeAreaName, HomeSelection } from './composition'

const alignments: ChromeAlignment[] = ['left', 'center', 'right']
const alignmentName = (value: ChromeAlignment) => value === 'left' ? t('左侧', 'Left') : value === 'center' ? t('居中', 'Center') : t('右侧', 'Right')
const typeName = (value: ChromeItem['type']) => value === 'branding' ? t('项目标识', 'Branding') : value === 'link' ? t('链接', 'Link') : t('文字', 'Text')

export function HomeChromeInspector({ chrome, area, alignment = 'left', disabled, issue, onChange, onSelect }: {
  chrome?: PageChrome; area: ChromeAreaName; alignment?: ChromeAlignment; disabled: boolean; issue: ChromeValidationIssue | null;
  onChange: (chrome: PageChrome) => void; onSelect: (selection: HomeSelection) => void
}) {
  const value = readPageChrome(chrome), items = value[area][alignment]
  const [selectedId, setSelectedId] = useState('')
  const selected = items.find(item => item.id === selectedId) || items[0]
  const selectedIndex = selected ? items.findIndex(item => item.id === selected.id) : -1
  const inspector = useRef<HTMLDivElement>(null), pending = useRef<ChromeValidationIssue | null>(null)
  const matchingIssue = issue?.area === area && issue.alignment === alignment ? issue : null

  useLayoutEffect(() => {
    pending.current = matchingIssue
    if (matchingIssue?.itemId) setSelectedId(matchingIssue.itemId)
  }, [matchingIssue])
  useLayoutEffect(() => {
    if (!matchingIssue || pending.current !== matchingIssue || disabled || matchingIssue.itemId && matchingIssue.itemId !== selected?.id) return
    const control = inspector.current?.querySelector<HTMLElement>(`[data-composer-chrome-field="${matchingIssue.field || 'text'}"]`)
    if (control?.isConnected && control.getClientRects().length) { control.focus(); pending.current = null }
  }, [matchingIssue, selected?.id, disabled])

  function edit(change: (next: PageChrome) => void) {
    if (disabled) return
    const next = readPageChrome(chrome); change(next); onChange(next)
  }
  function add(type: ChromeItem['type']) {
    if (disabled || items.length >= 8) return
    const id = 'chrome-' + viewId()
    const item: ChromeItem = type === 'branding' ? { id, type } : type === 'text' ? { id, type, text: '' } : { id, type, text: '', url: '', newTab: true }
    edit(next => { next[area].enabled = true; next[area][alignment].push(item) })
    setSelectedId(id)
  }
  function update(change: (item: ChromeItem) => ChromeItem) {
    if (selected) edit(next => { next[area][alignment] = next[area][alignment].map(item => item.id === selected.id ? change(item) : item) })
  }
  function remove() {
    if (!selected) return
    setSelectedId(items[selectedIndex + 1]?.id || items[selectedIndex - 1]?.id || '')
    edit(next => { next[area][alignment] = next[area][alignment].filter(item => item.id !== selected.id) })
  }
  function reorder(direction: -1 | 1) {
    const other = selectedIndex + direction
    if (!selected || other < 0 || other >= items.length) return
    edit(next => { const list = next[area][alignment]; [list[selectedIndex], list[other]] = [list[other]!, list[selectedIndex]!] })
  }
  function move(targetArea: ChromeAreaName, targetAlignment: ChromeAlignment) {
    if (!selected || targetArea === area && targetAlignment === alignment || value[targetArea][targetAlignment].length >= 8) return
    edit(next => {
      next[area][alignment] = next[area][alignment].filter(item => item.id !== selected.id)
      next[targetArea][targetAlignment].push(selected)
    })
    onSelect({ kind: 'chrome', area: targetArea, alignment: targetAlignment })
  }

  return <div className="lh-composer-chrome" ref={inspector}>
    <div className="lh-composer-inspector-section">
      <ComposerCheck label={area === 'header' ? t('显示页眉', 'Show header') : t('显示页脚', 'Show footer')} checked={value[area].enabled} disabled={disabled}
        onChange={checked => edit(next => { next[area].enabled = checked })} />
      <div className="lh-composer-slot-options" role="group" aria-label={t('对齐位置', 'Alignment')}>
        {alignments.map(slot => {
          const Icon = slot === 'left' ? AlignLeft : slot === 'center' ? AlignCenter : AlignRight
          return <button type="button" key={slot} aria-pressed={alignment === slot} disabled={disabled}
            onClick={() => { setSelectedId(''); onSelect({ kind: 'chrome', area, alignment: slot }) }}>
            <Icon size={16} /><span>{alignmentName(slot)}</span><small>{value[area][slot].length}</small>
          </button>
        })}
      </div>
      <div className="lh-composer-add-chrome" aria-label={t('添加页眉页脚内容', 'Add header or footer content')}>
        <ComposerButton disabled={disabled || items.length >= 8} onClick={() => add('text')}><Type size={14} />{t('文字', 'Text')}</ComposerButton>
        <ComposerButton disabled={disabled || items.length >= 8} onClick={() => add('link')}><Link2 size={14} />{t('链接', 'Link')}</ComposerButton>
        <ComposerButton disabled={disabled || items.length >= 8} onClick={() => add('branding')}><ProjectLogo size={15} />{t('标识', 'Branding')}</ComposerButton>
      </div>
      {!value[area].enabled && <p className="lh-composer-hint">{t('已关闭显示，内容仍然保留。', 'Hidden; configured content is retained.')}</p>}
      {!!items.length && <div className="lh-composer-chrome-items" aria-label={t('当前位置的内容', 'Items at this position')}>
        {items.map((item, index) => <button type="button" key={item.id} data-composer-chrome-item={item.id} disabled={disabled} aria-pressed={selected?.id === item.id}
          onClick={() => setSelectedId(item.id)} aria-label={t('编辑{type} {number}', 'Edit {type} {number}', { type: typeName(item.type), number: index + 1 })}>
          {item.type === 'branding' ? <ProjectLogo size={16} /> : item.type === 'link' ? <Link2 size={15} /> : <Type size={15} />}
          <span>{item.type === 'branding' ? 'Lingshu-Home' : item.text || t('待填写', 'Enter content')}</span>
        </button>)}
      </div>}
      {!selected && <p className="lh-composer-empty"><Plus size={18} />{t('添加内容，在画布中查看效果', 'Add content to see it on the canvas')}</p>}
    </div>
    {selected && <div className="lh-composer-inspector-section" key={selected.id}>
      <div className="lh-composer-section-title"><h3>{typeName(selected.type)}</h3><div className="lh-composer-mini-actions">
        <ComposerButton kind="icon" title={t('上移内容', 'Move item up')} aria-label={t('上移内容', 'Move item up')} disabled={disabled || selectedIndex <= 0} onClick={() => reorder(-1)}><ArrowUp size={15} /></ComposerButton>
        <ComposerButton kind="icon" title={t('下移内容', 'Move item down')} aria-label={t('下移内容', 'Move item down')} disabled={disabled || selectedIndex >= items.length - 1} onClick={() => reorder(1)}><ArrowDown size={15} /></ComposerButton>
        <ComposerButton kind="icon" title={t('删除内容', 'Remove item')} aria-label={t('删除内容', 'Remove item')} disabled={disabled} onClick={remove}><Trash2 size={15} /></ComposerButton>
      </div></div>
      <ComposerSelect label={t('内容类型', 'Item type')} disabled={disabled} value={selected.type} options={(['text', 'link', 'branding'] as const).map(type => ({ value: type, label: typeName(type) }))}
        onChange={type => update(item => type === 'branding' ? { id: item.id, type } : type === 'text' ? { id: item.id, type, text: item.text || '' } : { id: item.id, type: 'link', text: item.text || '', url: item.url || '', newTab: item.newTab ?? true })} />
      {selected.type === 'branding' ? <div className="lh-composer-brand-preview"><ProjectLogo size={42} /><strong>Lingshu-Home</strong></div>
        : selected.type === 'text' ? <ComposerField label={t('文本', 'Text')}><Textarea className="lh-composer-input" data-composer-chrome-field="text" aria-invalid={matchingIssue?.itemId === selected.id && matchingIssue.field === 'text' || undefined}
          value={selected.text || ''} maxLength={500} rows={4} disabled={disabled} placeholder={t('输入页眉或页脚文字', 'Enter header or footer text')} onChange={event => update(item => ({ ...item, text: event.target.value }))} /></ComposerField>
          : <>
            <ComposerField label={t('链接文本', 'Link text')}><Input className="lh-composer-input" data-composer-chrome-field="text" aria-invalid={matchingIssue?.itemId === selected.id && matchingIssue.field === 'text' || undefined}
              value={selected.text || ''} maxLength={160} disabled={disabled} onChange={event => update(item => ({ ...item, text: event.target.value }))} /></ComposerField>
            <ComposerField label={t('链接网址', 'Link URL')}><Input className="lh-composer-input" type="url" data-composer-chrome-field="url" aria-invalid={matchingIssue?.itemId === selected.id && matchingIssue.field === 'url' || undefined}
              value={selected.url || ''} maxLength={2048} disabled={disabled} placeholder="https://example.com" onChange={event => update(item => ({ ...item, url: event.target.value }))} /></ComposerField>
            <ComposerCheck label={t('在新标签页打开', 'Open in a new tab')} checked={selected.newTab ?? true} disabled={disabled} onChange={checked => update(item => ({ ...item, newTab: checked }))} />
          </>}
      {matchingIssue?.itemId === selected.id && <p className="lh-composer-inline-error" role="alert">{matchingIssue.message}</p>}
      <div className="lh-composer-field-pair">
        <ComposerSelect label={t('显示区域', 'Area')} value={area} disabled={disabled} onChange={next => move(next as ChromeAreaName, alignment)} options={(['header', 'footer'] as const).map(next => ({ value: next, label: next === 'header' ? t('页眉', 'Header') : t('页脚', 'Footer'), disabled: next !== area && value[next][alignment].length >= 8 }))} />
        <ComposerSelect label={t('对齐位置', 'Alignment')} value={alignment} disabled={disabled} onChange={next => move(area, next as ChromeAlignment)} options={alignments.map(next => ({ value: next, label: alignmentName(next), disabled: next !== alignment && value[area][next].length >= 8 }))} />
      </div>
    </div>}
  </div>
}
