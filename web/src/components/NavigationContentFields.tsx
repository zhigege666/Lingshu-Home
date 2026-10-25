import type { ComponentType } from 'react'
import { t } from '../core/i18n'
import { readNavigationAppearanceSettings, type NavigationAppearanceSettings } from '../core/navigation-appearance'

export type NavigationSelectProps = {
  label: string; value: string; disabled: boolean; hint?: string
  options: { value: string; label: string }[]; onChange: (value: string) => void
}
export type NavigationCheckProps = { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }

/** The same content options in the homepage inspector and administration. */
export function NavigationContentFields({ settings, disabled, SelectControl, CheckControl, onChange }: {
  settings: Record<string, unknown>; disabled: boolean
  SelectControl: ComponentType<NavigationSelectProps>; CheckControl: ComponentType<NavigationCheckProps>
  onChange: (key: keyof NavigationAppearanceSettings, value: string | number | boolean | undefined) => void
}) {
  const value = readNavigationAppearanceSettings(settings)
  return <>
    {settings.variant !== 'directory' && <SelectControl label={t('每行最多链接数', 'Maximum links per row')} value={String(value.maxColumns)} disabled={disabled}
      hint={t('空间不足时自动换行，不改变组件宽度。', 'Fewer links fit on narrow screens. This does not change the component width.')}
      options={[{ value: '0', label: t('自动', 'Automatic') }, ...Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: t('{count} 个', '{count} links', { count: index + 1 }) }))]}
      onChange={next => onChange('maxColumns', Number(next))}/>}
    <SelectControl label={t('网址显示', 'URL display')} value={value.urlDisplay} disabled={disabled}
      options={[{ value: 'fallback', label: t('无描述时', 'When no description') }, { value: 'always', label: t('始终', 'Always') }, { value: 'hidden', label: t('隐藏', 'Hidden') }]}
      onChange={next => onChange('urlDisplay', next)}/>
    <SelectControl label={t('描述行数', 'Description lines')} value={String(value.descriptionLines)} disabled={disabled}
      options={[{ value: '0', label: t('隐藏', 'Hidden') }, ...[1, 2, 3].map(count => ({ value: String(count), label: t('{count} 行', '{count} lines', { count }) }))]}
      onChange={next => onChange('descriptionLines', Number(next))}/>
    <SelectControl label={t('标签显示', 'Tags')} value={value.showTags === null ? 'inherit' : String(value.showTags)} disabled={disabled}
      options={[{ value: 'inherit', label: t('跟随样式', 'Follow style') }, { value: 'true', label: t('显示', 'Show') }, { value: 'false', label: t('隐藏', 'Hide') }]}
      onChange={next => onChange('showTags', next === 'inherit' ? undefined : next === 'true')}/>
    <CheckControl label={t('显示其他入口', 'Show additional URLs')} checked={value.showEndpoints} disabled={disabled} onChange={next => onChange('showEndpoints', next)}/>
    <CheckControl label={t('显示分组标题', 'Show group titles')} checked={value.showGroupTitles} disabled={disabled} onChange={next => onChange('showGroupTitles', next)}/>
    <CheckControl label={t('显示链接数量', 'Show link counts')} checked={value.showCounts} disabled={disabled} onChange={next => onChange('showCounts', next)}/>
    <SelectControl label={t('内容密度', 'Content density')} value={value.density} disabled={disabled}
      options={[{ value: 'inherit', label: t('跟随页面', 'Follow page') }, { value: 'comfortable', label: t('宽松', 'Comfortable') }, { value: 'compact', label: t('紧凑', 'Compact') }]}
      onChange={next => onChange('density', next)}/>
  </>
}
