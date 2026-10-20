import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { iconAssetSource } from '../core/icon-assets'
import './icon-asset.css'

/** Decorative asset; its enclosing link/button supplies the accessible label. */
export function IconAsset({ name, size = 20, className = '', fallback = 'lucide:link' }: { name?: string; size?: number; className?: string; fallback?: string }) {
  const source = iconAssetSource(name, fallback)
  const [failure, setFailure] = useState({ source: '', stage: 0 })
  const stage = failure.source === source.src ? failure.stage : 0
  if (stage > 1) return <Link2 size={size} className={`lh-icon-asset is-builtin ${className}`} aria-hidden="true" />
  const current = stage ? iconAssetSource(fallback) : source
  return <img key={current.src} className={`lh-icon-asset ${current.imported ? 'is-color' : 'is-builtin'} ${className}`} src={current.src}
    width={size} height={size} alt="" aria-hidden="true" decoding="async" referrerPolicy="no-referrer"
    onError={() => setFailure({ source: source.src, stage: stage + 1 })} />
}
