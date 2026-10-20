import { StyledSelect } from '../components/ui/select';
import type { Space } from '../core/types';
import { t } from '../core/i18n';

// This module is requested only when the account can access more than one space.
export default function SpaceSelect({ spaces, value, disabled, theme, onChange }: {
  spaces: Space[]; value: string; disabled: boolean; theme: 'light' | 'dark'; onChange: (id: string) => void;
}) {
  return <StyledSelect className="lh-space-control" tone="home" theme={theme} aria-label={t('选择空间', 'Choose a space')} value={value} disabled={disabled} onValueChange={onChange}
    options={spaces.map(space => ({ value: space.id, label: `${space.name}${space.kind === 'personal' ? t(' · 私人', ' · Personal') : ''}` }))} />;
}
