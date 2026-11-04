import { lazy, Suspense, useState } from 'react'
import { t } from '../core/i18n'
import type { Space } from '../core/types'
import type { ComposerSource } from '../home/composition'
import { initialSourceKind, matchingEnabledSources } from '../home/panel-sources'
import { Button } from './ui/button'
import { Modal } from './Shared'

const SourceDialog = lazy(() => import('../admin/SourceDialog'))

type Props = {
  schema: string; space?: Space; canCreate: boolean; sources: ComposerSource[]
  onSourcesChange: (sources: ComposerSource[]) => void
  onChoose: (source: ComposerSource) => void; onClose: () => void
}

export default function PanelSourceDialog({ schema, space, canCreate, sources, onSourcesChange, onChoose, onClose }: Props) {
  const choices = matchingEnabledSources(schema, 1, sources)
  const [creating, setCreating] = useState(!!space && canCreate && !choices.length)
  const [savedMismatch, setSavedMismatch] = useState(false)
  if (creating && canCreate && space) {
    let saved = false
    return <Suspense fallback={<Modal title={t('添加数据来源', 'Add data source')} onClose={onClose}><p role="status">{t('正在加载…', 'Loading…')}</p></Modal>}>
      <SourceDialog space={space} source={null} initialKind={initialSourceKind(schema)} requiredSchema={schema}
        contextNote={t('来源会立即保存，组件加入当前页面草稿。', 'The source is saved now. The component is added to your page draft.')}
        onSaved={source => {
          saved = true
          const item = { id: source.id, datasetId: source.datasetId, name: source.name, schemaId: source.schemaId, schemaVersion: source.schemaVersion, enabled: source.enabled }
          onSourcesChange([...sources.filter(s => s.datasetId !== item.datasetId), item])
          if (matchingEnabledSources(schema, 1, [item]).length) onChoose(item)
          else { setSavedMismatch(true); setCreating(false) }
        }}
        onClose={() => { if (!saved) { if (choices.length) setCreating(false); else onClose() } }} />
    </Suspense>
  }
  return <Modal title={t('选择数据来源', 'Choose a data source')} onClose={onClose}>
    {savedMismatch && <p role="status">{t('来源已保存；启用且格式匹配后才可添加组件。', 'Source saved. Enable a compatible source to add the component.')}</p>}
    {choices.length ? <div className="admin-button-row">{choices.map(source =>
      <Button key={source.id} type="button" variant="outline" onClick={() => onChoose(source)}>{source.name}</Button>
    )}</div> : !savedMismatch && <p>{t('此空间没有已启用的兼容来源。', 'No compatible source is enabled in this space.')}</p>}
    {space && canCreate && <div className="admin-form-footer"><Button type="button" variant="outline" onClick={() => setCreating(true)}>{t('新建来源', 'Create source')}</Button></div>}
  </Modal>
}
