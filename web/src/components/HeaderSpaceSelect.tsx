import type { Bootstrap } from '../core/types'
import { t } from '../core/i18n'
import { StyledSelect } from './ui/select'

export default function HeaderSpaceSelect({ bootstrap, value, onChange, disabled = false, theme = 'light' }: {
  bootstrap: Bootstrap
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  theme?: 'light' | 'dark'
}) {
  if (!bootstrap.spaces.length) return null
  return <div className="app-header-space">
    <StyledSelect className="app-header-space-select" tone="home" theme={theme} aria-label={t('选择空间', 'Choose a space')}
      value={value} disabled={disabled} onValueChange={id => { if (id !== value) onChange(id) }}
      options={bootstrap.spaces.map(space => ({ value: space.id, label: space.name + (space.kind === 'personal' ? t(' · 私人', ' · Personal') : '') }))}/>
  </div>
}
