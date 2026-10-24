import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactGridLayout, { useContainerWidth, verticalCompactor, type Layout, type LayoutItem } from 'react-grid-layout';
import { ChevronsUpDown, GripHorizontal, LockKeyhole } from 'lucide-react';
import { t } from '../core/i18n';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

export type GridPosition = { kind: 'grid'; region: 'main'; x: number; y: number; w: number; h: number; heightMode: 'content' | 'fixed'; locked: boolean };
export type GridPanel = { id: string; label: string; placement: GridPosition; content: ReactNode };
const ROW_HEIGHT = 12;

function MeasuredPanel({ panel, editing, disabled, width, widthRevision, onMeasure, onFitContent, selected, onSelect }: { selected: boolean; onSelect?: (id: string) => void; panel: GridPanel; editing: boolean; disabled: boolean; width: number; widthRevision?: string; onMeasure: (id: string, height: number) => void; onFitContent: (id: string) => void }) {
  const measure = useRef<HTMLDivElement>(null);
  // Sidebar changes and edit controls can rewrap content without a drag. Keep
  // the matching panel footprint in the same paint as that new width.
  useLayoutEffect(() => {
    const el = measure.current; if (el) onMeasure(panel.id, el.getBoundingClientRect().height + (editing ? 34 : 0) + 2);
  }, [panel.id, panel.content, editing, width, widthRevision, onMeasure]);
  useEffect(() => {
    const el = measure.current; if (!el) return;
    const ownerWindow = el.ownerDocument.defaultView; if (!ownerWindow) return;
    let frame = 0;
    const update = () => { ownerWindow.cancelAnimationFrame(frame); frame = ownerWindow.requestAnimationFrame(() => onMeasure(panel.id, el.getBoundingClientRect().height + (editing ? 34 : 0) + 2)); };
    const observer = new ResizeObserver(update); observer.observe(el); update();
    return () => { observer.disconnect(); ownerWindow.cancelAnimationFrame(frame); };
  }, [panel.id, editing, onMeasure]);
  return <div className={`lh-grid-frame ${editing ? 'is-editing' : ''} ${panel.placement.heightMode === 'fixed' ? 'is-fixed' : ''}${editing && selected ? ' is-selected' : ''}`} data-panel-id={panel.id} onClickCapture={editing ? () => onSelect?.(panel.id) : undefined}>
    {editing && <div className={`lh-grid-handle ${panel.placement.locked ? 'is-locked' : ''}`} title={panel.placement.locked ? t('位置已锁定，可在组件设置中解锁', 'Position locked. Unlock it in component settings.') : t('拖动此处调整位置', 'Drag here to move this panel')}>
      {panel.placement.locked ? <LockKeyhole size={13} /> : <GripHorizontal size={16} />}<button type="button" className="lh-grid-select" aria-label={t('编辑{name}组件', 'Edit {name} component', { name: panel.label })} aria-pressed={selected} onClick={() => onSelect?.(panel.id)}>{panel.label}</button><small>{t('{count} 列', '{count} columns', { count: panel.placement.w })} · {panel.placement.locked ? t('已锁定', 'Locked') : t('可调整', 'Adjustable')}</small>
      {!panel.placement.locked && <button type="button" className="lh-grid-fit" disabled={disabled} onClick={() => onFitContent(panel.id)}
        aria-label={t('{name}：适应内容', '{name}: fit content', { name: panel.label })} title={t('按内容调整高度，保持当前宽度', 'Fit height to content and keep the current width')}><ChevronsUpDown size={12} /><span>{t('适应内容', 'Fit content')}</span></button>}
    </div>}
    <div className="lh-grid-scroll"><div className="lh-grid-measure" ref={measure}>{panel.content}</div></div>
  </div>;
}

export function HomeGrid({ panels, editing, gap, onChange, widthRevision, disabled = false, selectedId, onSelect, onInteractionChange }: {
  panels: GridPanel[]; editing: boolean; gap: number;
  onChange: (positions: Record<string, GridPosition>) => void; onInteractionChange?: (active: boolean) => void; widthRevision?: string; disabled?: boolean; selectedId?: string; onSelect?: (id: string) => void;
}) {
  const { containerRef, width, mounted, measureWidth } = useContainerWidth({ initialWidth: 1440 });
  // RGL's default position strategy emits pixel widths even on its first render.
  // Resolve the container width before paint; the hook still observes later resizes.
  useLayoutEffect(() => { measureWidth(); }, [measureWidth, widthRevision]);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const interaction = useRef(false);
  useEffect(() => () => { if (interaction.current) onInteractionChange?.(false); }, [onInteractionChange]);
  const measure = useCallback((id: string, height: number) => {
    setHeights(previous => Math.abs((previous[id] || 0) - height) < 1 ? previous : { ...previous, [id]: height });
  }, []);
  const gridConfig = useMemo(() => ({ cols: 24, rowHeight: ROW_HEIGHT, margin: [gap, gap] as [number, number], containerPadding: [0, 0] as [number, number] }), [gap]);
  const dragConfig = useMemo(() => ({ enabled: editing && !disabled, handle: '.lh-grid-handle:not(.is-locked)', cancel: 'button,a,input,select,textarea', bounded: false }), [editing, disabled]);
  const resizeConfig = useMemo(() => ({ enabled: editing && !disabled, handles: ['se' as const] }), [editing, disabled]);
  const fitContent = useCallback((id: string) => {
    if (!editing || disabled || interaction.current) return;
    const original = panels.find(panel => panel.id === id)?.placement;
    if (!original || original.locked) return;
    // An explicit draft action releases a manually fixed/minimum height while
    // retaining the panel's width, position and the saved configuration.
    onChange({ [id]: { ...original, h: 3, heightMode: 'content' } });
  }, [panels, editing, disabled, onChange]);
  const children = useMemo(() => panels.map(panel => <div key={panel.id}><MeasuredPanel panel={panel} selected={selectedId === panel.id} onSelect={onSelect} editing={editing} disabled={disabled} width={width} widthRevision={widthRevision} onMeasure={measure} onFitContent={fitContent} /></div>), [panels, editing, disabled, width, widthRevision, measure, fitContent, selectedId, onSelect]);
  const layout = useMemo(() => {
    const locked = panels.filter(item => item.placement.locked);
    return panels.map(panel => {
      const p = panel.placement;
      let h = p.heightMode === 'content' ? Math.max(p.h, Math.ceil(((heights[panel.id] || 0) + gap) / (ROW_HEIGHT + gap))) : p.h;
      // A locked block keeps its saved footprint. A growing block above a locked
      // one scrolls within the available room instead of covering that block.
      if (p.locked) h = p.h;
      else for (const obstacle of locked) {
        const q = obstacle.placement;
        if (q.y >= p.y + p.h && q.x < p.x + p.w && q.x + q.w > p.x) h = Math.min(h, q.y - p.y);
      }
      return { i: panel.id, x: p.x, y: p.y, w: p.w, h, minW: 4, maxW: 24, minH: 3,
        static: p.locked, isDraggable: editing && !disabled && !p.locked, isResizable: editing && !disabled && !p.locked } satisfies LayoutItem;
    });
  }, [panels, heights, editing, disabled, gap]);

  const commit = useCallback((value: Layout, resized?: string) => {
    if (!interaction.current) return;
    interaction.current = false; onInteractionChange?.(false);
    const positions: Record<string, GridPosition> = {};
    for (const item of value) {
      const original = panels.find(panel => panel.id === item.i)?.placement;
      if (!original || original.locked) continue;
      positions[item.i] = { ...original, x: item.x, y: item.y, w: item.w,
        h: resized === item.i ? item.h : original.h,
        heightMode: resized === item.i ? 'fixed' : original.heightMode };
    }
    onChange(positions);
  }, [onChange, panels, onInteractionChange]);
  // RGL also compares stop-handler identities when memoizing individual grid items.
  const startInteraction = useCallback(() => { interaction.current = true; onInteractionChange?.(true); }, [onInteractionChange]);
  const stopDrag = useCallback((value: Layout) => commit(value), [commit]);
  const stopResize = useCallback((value: Layout, _old: LayoutItem | null, updated: LayoutItem | null) => commit(value, updated?.i), [commit]);

  return <div className={`lh-home-grid${editing ? ' is-editing' : ''}`} ref={containerRef}>
    {mounted && width > 0 && <ReactGridLayout width={width} layout={layout}
      gridConfig={gridConfig} dragConfig={dragConfig} resizeConfig={resizeConfig} compactor={verticalCompactor}
      onDragStart={startInteraction} onResizeStart={startInteraction} onDragStop={stopDrag} onResizeStop={stopResize}>
      {children}
    </ReactGridLayout>}
  </div>;
}
