import mark from '../assets/lingshu-home-logo.svg'
import './project-logo.css'

/** Decorative beside the project name or a labelled home link. */
export function ProjectLogo({ size = 36, className = '' }: { size?: number; className?: string }) {
  return <img className={`project-logo ${className}`.trim()} src={mark} width={size} height={size}
    alt="" aria-hidden="true" decoding="async" />
}
