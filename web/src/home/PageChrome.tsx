import { t } from '../core/i18n';
import type { ChromeArea, ChromeItem } from '../core/types';
import { useHomeEnvironment } from './HomeEnvironment';
import { safeLink } from './NavigationPanels';
import { ProjectLogo } from '../components/ProjectLogo';

function ChromeContent({ item, version }: { item: ChromeItem; version: string }) {
  const { preview } = useHomeEnvironment();
  if (item.type === 'branding') return <span className="lh-chrome-branding"><span className="lh-chrome-brand-name"><ProjectLogo size={18} />Lingshu-Home</span><small>{version}</small></span>;
  if (item.type === 'link') {
    const href = safeLink(item.url || '');
    return href ? <a href={preview ? undefined : href} role={preview ? 'link' : undefined} aria-disabled={preview || undefined} tabIndex={preview ? 0 : undefined}
      target={!preview && item.newTab !== false ? '_blank' : undefined} rel={!preview && item.newTab !== false ? 'noopener noreferrer' : undefined}>{item.text || href}</a> : <span>{item.text}</span>;
  }
  return <span>{item.text}</span>;
}

export function PageChromeArea({ area, placement, version, editing = false, selectedSlot, onSelect }: {
  area: ChromeArea; placement: 'header' | 'footer'; version: string; editing?: boolean;
  selectedSlot?: 'left' | 'center' | 'right'; onSelect?: (slot: 'left' | 'center' | 'right') => void;
}) {
  if (!area.enabled && !editing) return null;
  const Tag = placement === 'footer' ? 'footer' : 'div';
  const name = placement === 'header' ? t('页眉', 'Header') : t('页脚', 'Footer');
  return <Tag className={`lh-page-chrome ${placement === 'footer' ? 'lh-footer' : 'lh-custom-header'}${editing ? ' is-editing' : ''}${!area.enabled ? ' is-disabled' : ''}`}
    data-chrome-area={placement}
    role={placement === 'header' ? 'region' : undefined} aria-label={placement === 'header' ? t('自定义页眉', 'Custom header') : t('页脚', 'Footer')}>
    {(['left', 'center', 'right'] as const).map(slot => <div className={`lh-chrome-slot is-${slot}${editing && selectedSlot === slot ? ' is-selected' : ''}`} key={slot}
      data-chrome-slot={slot} role={editing ? 'button' : undefined} tabIndex={editing ? 0 : undefined}
      aria-label={editing ? t('编辑{name} · {position}', 'Edit {name} · {position}', { name, position: slot === 'left' ? t('左侧', 'Left') : slot === 'center' ? t('居中', 'Center') : t('右侧', 'Right') }) : undefined}
      aria-pressed={editing ? selectedSlot === slot : undefined}
      onClick={editing ? () => onSelect?.(slot) : undefined}
      onKeyDown={editing ? event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect?.(slot); } } : undefined}>
      {editing && <span className="lh-chrome-slot-label">{name} · {slot === 'left' ? t('左侧', 'Left') : slot === 'center' ? t('居中', 'Center') : t('右侧', 'Right')}{!area.enabled && <small>{t('未启用', 'Off')}</small>}</span>}
      {area[slot].map(item => <ChromeContent item={item} version={version} key={item.id} />)}
      {editing && !area[slot].length && <span className="lh-chrome-placeholder">{t('添加内容', 'Add content')}</span>}
    </div>)}
  </Tag>;
}
