export interface Bookmark {
  id: string;
  url: string;
  title: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  domain: string;
  tags: string[];
  collectionId?: string;
  favorite: boolean;
  archived: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  openCount: number;
  archive: ArchiveInfo;
}

export type ArchiveMode = "none" | "html";

export interface ArchiveInfo {
  mode: ArchiveMode;
  folder?: string;
  updatedAt?: string;
  htmlAvailable: boolean;
  textAvailable: boolean;
}

export interface PendingArchive {
  id: string;
  mode: ArchiveMode;
  queuedAt: string;
}

export interface SavedHtmlCopy {
  html: string;
  baseUrl: string;
}

export interface Collection {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  createdAt: string;
  updatedAt: string;
}

export interface TagSummary {
  name: string;
  count: number;
}

export interface AppSnapshot {
  version: number;
  bookmarks: Bookmark[];
  collections: Collection[];
  savedQueries: SavedQuery[];
  tags: TagSummary[];
  dataPath: string;
  dataDirectory: string;
  dataFileName: string;
  archiveDirectory: string;
  pendingArchives: PendingArchive[];
}

export interface SecurityStatus {
  passwordConfigured: boolean;
  timeoutMinutes: number;
  locked: boolean;
}

export interface ApiServerStatus {
  enabled: boolean;
  interface: string;
  port: number;
  running: boolean;
  url: string;
  error?: string;
}

export interface MiscellaneousStatus {
  maxMetadataBytes: number;
  requestTimeoutSecs: number;
}

export interface MetadataPreview {
  url: string;
  title: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  domain: string;
}

export interface BookmarkDraft {
  id?: string;
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  tags: string[];
  collectionId?: string;
  favorite: boolean;
  archived: boolean;
  notes?: string;
  archiveMode: ArchiveMode;
}

export interface SearchMatch {
  id: string;
  score: number;
}

export interface ArchiveTermMatch extends SearchMatch {
  term: string;
}

export interface ImportReport {
  imported: number;
  updated: number;
  skipped: number;
}

export type CsvImporter = "native" | "raindrop";

export interface CsvImportIssue {
  row?: number;
  message: string;
}

export interface CsvImportValidation {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errorCount: number;
  errors: CsvImportIssue[];
}
