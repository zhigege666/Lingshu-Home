import { t } from '../core/i18n'
import { Button } from './ui/button'
import { Modal } from './Shared'

export default function DiscardChangesDialog({ onKeep, onDiscard, description }: { onKeep: () => void; onDiscard: () => void; description?: string }) {
  return <Modal title={t('放弃未保存的修改？', 'Discard unsaved changes?')} description={description || t('页面草稿还没有保存。放弃后将使用之前保存的页面。', 'This page draft has not been saved. Discarding it restores the saved page.')} onClose={onKeep}>
    <div className="admin-form-footer"><Button type="button" autoFocus onClick={onKeep}>{t('继续编辑', 'Keep editing')}</Button><Button type="button" variant="destructive" onClick={onDiscard}>{t('放弃修改', 'Discard changes')}</Button></div>
  </Modal>
}
