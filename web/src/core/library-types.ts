import type { NavLink } from './types'

export type DocumentSource = {
  id: string; spaceId: string; name: string; path: string; readOnly: boolean;
  defaultWrite: boolean; defaultFolder: string; scanIntervalSeconds: number;
  enabled: boolean; status: 'ready' | 'offline' | 'error' | 'pending' | 'detached';
  lastScanAt: string; lastError: string; documentCount: number; revision: string;
}
export type DocumentSourceList = { items: DocumentSource[]; roots: string[]; canManage: boolean }
export type LibraryDocument = {
  id: string; sourceId: string; spaceId: string; sourceName: string; relativePath: string;
  title: string; revision: string; metadataRevision: string; size: number; updatedAt: string; status: 'ready' | 'missing';
  readOnly: boolean; unavailableReason?: string; published: boolean; hasUnpublishedChanges: boolean; tags: string[];
  linkedBookmarkIds: string[];
}
export type DocumentDetail = LibraryDocument & { content: string; links: { id: string; title: string; url: string }[] }
export type DocumentPage = { items: LibraryDocument[]; total: number; limit: number; offset: number }
export type LibraryBookmark = NavLink & { contextMarkdown?: string }
export type LibraryItem = { kind: 'document'; document: LibraryDocument } | { kind: 'bookmark'; bookmark: LibraryBookmark }
export type SourceInput = Pick<DocumentSource, 'name' | 'readOnly' | 'defaultWrite' | 'defaultFolder' | 'scanIntervalSeconds'>
