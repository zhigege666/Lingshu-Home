import type { NavigationData } from '../core/types'

/** Homepage content controls always edit canonical local navigation in one draft. */
export type NavigationEditor = {
  spaceId: string
  navigation: NavigationData
  selectedLinkId?: string
  selectedCategoryId?: string
  busy?: boolean
  onEditLink: (id: string) => void
  onEditCategory: (id: string) => void
  onRenameCategory: (id: string, name: string) => void
  /** null appends to the destination category; beforeId is a real record ID. */
  onMoveLink: (id: string, categoryId: string | null, beforeId: string | null) => void
  /** Category drag only reorders siblings; null appends after its last sibling. */
  onMoveCategory: (id: string, beforeId: string | null) => void
}
