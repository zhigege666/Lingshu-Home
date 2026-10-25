import { Children, isValidElement, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink, ImageOff } from 'lucide-react'
import { t } from '../core/i18n'
import { documentAssetURL, documentRelativePath, isMarkdownPath, markdownDisplayBody, safeExternalLink } from './links'
import type { DocumentDetail } from '../core/library-types'

type Props = { content: string; document?: DocumentDetail; onDocumentLink?: (sourceId: string, path: string) => void }
function ExternalImage({ src, alt }: { src: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false)
  return loaded ? <img src={src} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer"/> : <button className="library-external-image" type="button" onClick={() => setLoaded(true)}><ImageOff size={16}/>{t('加载外部图片', 'Load external image')}{alt ? ` · ${alt}` : ''}</button>
}
function headingText(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? headingText(child.props.children) : '').join('')
}
export function MarkdownView({ content, document, onDocumentLink }: Props) {
  const prefix = `md-${document?.id || 'notes'}-`, headingCounts = new Map<string, number>()
  const headingId = (children: ReactNode) => {
    const slug = headingText(children).trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section'
    const count = headingCounts.get(slug) || 0; headingCounts.set(slug, count + 1)
    return prefix + slug + (count ? `-${count}` : '')
  }
  return <div className="library-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => url} components={{
    h1: ({ children }) => <h1 id={headingId(children)}>{children}</h1>,
    h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
    h4: ({ children }) => <h4 id={headingId(children)}>{children}</h4>,
    h5: ({ children }) => <h5 id={headingId(children)}>{children}</h5>,
    h6: ({ children }) => <h6 id={headingId(children)}>{children}</h6>,
    a({ href = '', children }) {
      if (href.startsWith('#')) return <a href={href} onClick={event => { event.preventDefault(); try { const id = prefix + decodeURIComponent(href.slice(1)); globalThis.document.getElementById(id)?.scrollIntoView({ block: 'nearest' }) } catch {} }}>{children}</a>
      const external = safeExternalLink(href)
      if (external) return <a href={external} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={12} className="library-inline-icon"/></a>
      const relative = document && documentRelativePath(document.relativePath, href)
      if (!document || !relative) return <span>{children}</span>
      if (isMarkdownPath(relative)) return <a href="#" onClick={event => { event.preventDefault(); onDocumentLink?.(document.sourceId, relative) }}>{children}</a>
      return <a href={documentAssetURL(document.spaceId, document.id, href)} target="_blank" rel="noopener noreferrer">{children}</a>
    },
    img({ src, alt }) {
      if (typeof src !== 'string') return <span>{alt}</span>
      const external = safeExternalLink(src)
      if (external?.startsWith('https:')) return <ExternalImage src={external} alt={alt}/>
      if (!document || !documentRelativePath(document.relativePath, src)) return <span className="library-image-unavailable">{alt || t('图片不可用', 'Image unavailable')}</span>
      return <img src={documentAssetURL(document.spaceId, document.id, src)} alt={alt || ''} loading="lazy"/>
    },
  }}>{markdownDisplayBody(content)}</Markdown></div>
}
