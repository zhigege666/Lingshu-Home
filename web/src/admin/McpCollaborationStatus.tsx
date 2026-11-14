import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { messageOf, request } from '../core/api'
import { t } from '../core/i18n'
import { workPath, type WorkCollaborationContext } from '../core/work-types'
import { Button } from '../components/ui/button'
import './mcp-collaboration-status.css'

export default function McpCollaborationStatus({ spaceId }: { spaceId: string }) {
  const [value, setValue] = useState<WorkCollaborationContext | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setError(''); setValue(null)
    request<WorkCollaborationContext>(`${workPath(spaceId)}/collaboration`, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setValue(result) })
      .catch(cause => { if (!abort.signal.aborted) setError(messageOf(cause)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [spaceId, refresh])
  return <section className="admin-mcp-collaboration" data-mcp-collaboration-status aria-label={t('多 Agent 协作状态', 'Multi-agent collaboration status')}>
    <div><strong>{t('多 Agent 协作', 'Multi-agent collaboration')}</strong><span className="admin-badge muted">{loading ? t('正在读取…', 'Loading…') : value ? value.enabled ? t('已开启', 'Enabled') : t('已关闭', 'Disabled') : t('状态未知', 'Unknown')}</span><Button type="button" variant="ghost" size="icon-sm" disabled={loading} onClick={() => setRefresh(number => number + 1)} aria-label={t('刷新协作配置', 'Refresh collaboration configuration')}><RefreshCw size={14}/></Button></div>
    {value && <p className="admin-hint">{t('实例启动配置，只读。', 'Read-only instance startup configuration.')}{value.enabled && !value.effectiveEnabled && ` ${t('当前授权不包含完整的事项读写权限。', 'Current authorization does not include full work read and write access.')}`}</p>}
    {error && <p className="admin-inline-error" role="status">{error}</p>}
  </section>
}
