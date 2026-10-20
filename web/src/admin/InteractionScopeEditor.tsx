import { useEffect, useRef, useState } from 'react'
import { Link2, Plus, Unlink } from 'lucide-react'
import { t } from '../core/i18n'
import { viewId } from '../core/presentation'
import type { View } from '../core/types'
import { Field } from '../components/Shared'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { StyledSelect } from '../components/ui/select'

type Props = { view: View; views: View[]; disabled: boolean; onChange: (scope: string) => void }
const primaryScope = 'primary-navigation'
const effectiveScope = (view: View) => view.interactionScope || view.id
const namedScope = (value: string) => value.startsWith('user:') && !!value.slice(5).trim()

export function InteractionScopeEditor({ view, views, disabled, onChange }: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const scope = effectiveScope(view)
  const members = views.filter(item => effectiveScope(item) === scope)
  const independent = members.length === 1 && (!view.interactionScope || scope === view.id || scope.startsWith('independent:'))
  const groups = [...new Set([primaryScope, ...views.map(effectiveScope)])].filter(value => {
    const matching = views.filter(item => effectiveScope(item) === value)
    return value === primaryScope || !(matching.length === 1 && (value === matching[0]!.id || value.startsWith('independent:')))
  })
  const unknownGroups = groups.filter(value => value !== primaryScope && !namedScope(value))
  const groupName = (value: string) => value === primaryScope
    ? t('主导航', 'Main navigation')
    : namedScope(value) ? value.slice(5)
      : t('已有分组 {count}', 'Existing group {count}', { count: unknownGroups.indexOf(value) + 1 })

  useEffect(() => { if (creating) input.current?.focus() }, [creating])
  useEffect(() => { setCreating(false); setName(''); setError('') }, [view.id])

  function choose(value: string) {
    if (disabled) return
    setCreating(false); setError('')
    if (value === 'independent') {
      if (!independent) onChange('independent:' + viewId())
    } else onChange(value.slice('scope:'.length))
  }
  function createGroup() {
    if (disabled) return
    const cleaned = name.trim()
    if (!cleaned) { setError(t('请填写分组名称。', 'Enter a group name.')); input.current?.focus(); return }
    if (cleaned.length > 75 || /[\u0000-\u001f\u007f]/.test(cleaned)) {
      setError(t('分组名称最多 75 个字符，不能包含控制字符。', 'Use up to 75 characters without control characters.')); return
    }
    // The friendly name is persisted in the existing scope, so it survives reloads.
    onChange('user:' + cleaned)
    setCreating(false); setName(''); setError('')
  }

  return <section className="admin-linking-editor">
    <Field label={t('搜索与分类联动', 'Search and category linking')}>
      <StyledSelect aria-label={t('搜索与分类联动', 'Search and category linking')}
        value={independent ? 'independent' : 'scope:' + scope} onValueChange={choose} disabled={disabled}
        title={t('内部标识：{scope}', 'Internal identifier: {scope}', { scope })}
        options={[
          ...groups.map(value => ({ value: 'scope:' + value, label: groupName(value), title: value })),
          { value: 'independent', label: t('独立使用，不与其他积木联动', 'Independent from other panels') }
        ]} />
    </Field>
    <div className="admin-linking-summary">
      {independent ? <Unlink size={15} aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}
      <p>{independent
        ? t('此积木使用自己的搜索和分类状态。', 'This panel uses its own search and category state.')
        : t('同组的搜索、分类与链接积木一起筛选，共 {count} 个积木。', 'Search, categories and links in this group filter together across {count} panels.', { count: members.length })}</p>
      {!creating && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setCreating(true); setError('') }}><Plus size={14} />{t('新建分组', 'New group')}</Button>}
    </div>
    {creating && <div className="admin-linking-create">
      <Field label={t('分组名称', 'Group name')} hint={t('例如：工作、个人、服务器', 'For example: Work, Personal, Servers')}>
        <Input ref={input} value={name} maxLength={75} disabled={disabled}
          onChange={event => { setName(event.target.value); setError('') }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); createGroup() } }} />
      </Field>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      <div className="admin-button-row">
        <Button type="button" size="sm" disabled={disabled} onClick={createGroup}>{t('创建并选择', 'Create and select')}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setCreating(false); setError('') }}>{t('取消', 'Cancel')}</Button>
      </div>
    </div>}
  </section>
}
