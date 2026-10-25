import { StyledSelect } from '../components/ui/select';
import { SpacePreferenceMenu } from '../components/SpacePreferenceMenu';
import type { Space } from '../core/types';
import type { SpaceBootstrap } from '../core/space-selection';
import { t } from '../core/i18n';

// This module is requested only when the account can access more than one space.
export default function SpaceSelect({ spaces, value, disabled, theme, onChange, bootstrap }: {
  spaces: Space[]; value: string; disabled: boolean; theme: 'light' | 'dark'; onChange: (id: string) => void; bootstrap?: SpaceBootstrap;
}) {
  return <div className="lh-space-controls"><StyledSelect className="lh-space-control" tone="home" theme={theme} aria-label={t('选择空间', 'Choose a space')} value={value} disabled={disabled} onValueChange={onChange}
    options={spaces.map(space => ({ value: space.id, label: `${space.name}${space.kind === 'personal' ? t(' · 私人', ' · Personal') : ''}` }))} />
    {bootstrap && <SpacePreferenceMenu bootstrap={bootstrap} disabled={disabled} theme={theme}/>}</div>;
}
