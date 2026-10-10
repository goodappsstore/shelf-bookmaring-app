import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import QRCode from "qrcode";
import { BookmarkVirtualizer } from "./bookmarkVirtualizer";
import { icon } from "./icons";
import type {
  ApiServerStatus,
  ArchiveTermMatch,
  ArchiveMode,
  AppSnapshot,
  Bookmark,
  BookmarkDraft,
  Collection,
  CsvImporter,
  CsvImportValidation,
  ImportReport,
  MetadataPreview,
  MiscellaneousStatus,
  SavedQuery,
  SavedHtmlCopy,
  SecurityStatus,
} from "./types";
import "./styles.css";

type Scope = "all" | "favorites" | "saved-copies" | "archive" | "collection" | "tag" | "saved-query";
type ViewMode = "grid" | "list";
type SortMode = "newest" | "oldest" | "title" | "domain" | "visited";
type SecurityOperation = "updating";
type SettingsTab = "appearance" | "security" | "api" | "storage" | "transfer" | "misc";

interface Filters {
  query: string;
  scope: Scope;
  scopeId?: string;
  sort: SortMode;
  view: ViewMode;
  addedFrom: string;
  addedTo: string;
  domains: string[];
  hasSavedCopy: boolean;
  favoritesOnly: boolean;
  neverOpened: boolean;
  hasNotes: boolean;
  hasNoTags: boolean;
}

interface ModalState {
  kind: "bookmark" | "bookmark-details" | "collection" | "saved-query" | "tag-rename" | "move-search" | "settings" | "archive" | "share";
  id?: string;
  ids?: string[];
  title?: string;
  html?: string;
  baseUrl?: string;
  qrDataUrl?: string;
  qrError?: boolean;
}

const root = document.querySelector<HTMLDivElement>("#app")!;
const appWindow = getCurrentWindow();
const appWebview = getCurrentWebview();
const platform = /mac/i.test(navigator.platform || navigator.userAgent)
  ? "macos"
  : /win/i.test(navigator.platform || navigator.userAgent)
    ? "windows"
    : "linux";
const INTERFACE_SCALE_LEVELS = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2] as const;
const DEFAULT_INTERFACE_SCALE = 1;
const storedInterfaceScale = Number(localStorage.getItem("shelf-interface-scale"));
let interfaceScale = INTERFACE_SCALE_LEVELS.includes(storedInterfaceScale as typeof INTERFACE_SCALE_LEVELS[number])
  ? storedInterfaceScale
  : DEFAULT_INTERFACE_SCALE;
let snapshot: AppSnapshot = { version: 4, bookmarks: [], collections: [], savedQueries: [], tags: [], dataPath: "", dataDirectory: "", dataFileName: "shelf.sqlite3", archiveDirectory: "", pendingArchives: [] };
let filters: Filters = {
  query: "",
  scope: "all",
  sort: "newest",
  view: (localStorage.getItem("shelf-view") as ViewMode) || "grid",
  addedFrom: "",
  addedTo: "",
  domains: [],
  hasSavedCopy: false,
  favoritesOnly: false,
  neverOpened: false,
  hasNotes: false,
  hasNoTags: false,
};
let modal: ModalState | null = null;
let openMenuId: string | null = null;
let loading = true;
let locked = false;
let unlocking = false;
let unlockError = "";
let security: SecurityStatus = { passwordConfigured: false, timeoutMinutes: 15, locked: false };
let securityOperation: SecurityOperation | null = null;
let settingsTab: SettingsTab = "security";
let apiServer: ApiServerStatus = { enabled: false, interface: "localhost", port: 9876, running: false, url: "http://localhost:9876" };
let apiServerSaving = false;
let miscellaneous: MiscellaneousStatus = { maxMetadataBytes: 10_000_000, requestTimeoutSecs: 30 };
let miscSaving = false;
let csvImporter: CsvImporter | null = null;
let csvImportPath = "";
let csvImportValidation: CsvImportValidation | null = null;
let csvImportBusy = false;
let inactivityTimer: number | undefined;
let lastInteractionAt = Date.now();
let locking = false;
let sessionGeneration = 0;
let windowMaximized = false;
let windowChromeSyncTimer: number | undefined;
let windowChromeSyncRequest = 0;
let archiveSearchScores = new Map<string, Map<string, number>>();
let archiveSearchRequest = 0;
let archiveSearchTimer: number | undefined;
let searchInput = "";
let searchInputTimer: number | undefined;
let closePromptOpen = false;
let forceWindowClose = false;
const fallbackBoundImages = new WeakSet<HTMLImageElement>();
const API_LIBRARY_CHANGED_EVENT = "shelf://api-library-changed";
const API_REFRESH_DELAY_MS = 1_500;
let apiRefreshTimer: number | undefined;
let renderedSidebarHtml = "";
let renderedTopbarHtml = "";
let renderedContentHtml = "";
let renderedModalHtml = "";
let bookmarkVirtualizer: BookmarkVirtualizer<Bookmark> | null = null;
let virtualResetRequested = false;
let visibleBookmarksRevision = 0;
let addedFilterOpen = false;
let domainFilterOpen = false;
let domainFilterQuery = "";
let visibleBookmarksCache: {
  snapshot: AppSnapshot;
  archiveScores: Map<string, Map<string, number>>;
  filterKey: string;
  bookmarks: Bookmark[];
  revision: number;
} | null = null;

const sortOptions: Array<{ value: SortMode; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A–Z" },
  { value: "domain", label: "Website A–Z" },
  { value: "visited", label: "Most visited" },
];

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const safeImage = (value?: string): string => {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "data:"].includes(parsed.protocol) ? escapeHtml(value) : "";
  } catch {
    return "";
  }
};

const collectionFor = (bookmark: Bookmark): Collection | undefined =>
  snapshot.collections.find((item) => item.id === bookmark.collectionId);

function dateLabel(value: string): string {
  const date = new Date(value);
  const difference = Date.now() - date.getTime();
  const days = Math.floor(difference / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
}

function fullDateLabel(value?: string): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function fuzzyPartScore(haystack: string, needle: string): number {
  const text = haystack.toLocaleLowerCase();
  const query = needle.toLocaleLowerCase().trim();
  if (!query) return 1;
  if (text === query) return 12;
  const exact = text.indexOf(query);
  if (exact >= 0) return 9 - Math.min(exact / 100, 2);

  let queryIndex = 0;
  let streak = 0;
  let score = 0;
  for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
    if (text[index] === query[queryIndex]) {
      streak += 1;
      score += 1 + streak * 0.6 + (index === 0 || /[\s/._-]/.test(text[index - 1]) ? 1.5 : 0);
      queryIndex += 1;
    } else {
      streak = 0;
    }
  }
  return queryIndex === query.length ? score / Math.max(query.length, 1) : 0;
}

type SearchExpression =
  | { kind: "term"; value: string; tag: boolean; excluded: boolean }
  | { kind: "and" | "or"; left: SearchExpression; right: SearchExpression };

function parseSearchQuery(query: string): SearchExpression | null {
  const tokens = query.match(/\(|\)|[^\s()]+/g) ?? [];
  let index = 0;
  const operator = (value: string | undefined): "AND" | "OR" | null => {
    const normalized = value?.toLocaleUpperCase();
    return normalized === "AND" || normalized === "OR" ? normalized : null;
  };
  const startsPrimary = (): boolean => Boolean(tokens[index] && tokens[index] !== ")" && !operator(tokens[index]));
  const parsePrimary = (): SearchExpression | null => {
    const token = tokens[index];
    if (!token || token === ")" || operator(token)) return null;
    index += 1;
    if (token === "(") {
      const expression = parseOr();
      if (tokens[index] === ")") index += 1;
      return expression;
    }
    const excluded = token.startsWith("-") && token.length > 1;
    const value = excluded ? token.slice(1) : token;
    const tag = value.startsWith("#") && value.length > 1;
    return { kind: "term", value: tag ? value.slice(1) : value, tag, excluded };
  };
  const parseAnd = (): SearchExpression | null => {
    let expression = parsePrimary();
    while (expression && (operator(tokens[index]) === "AND" || startsPrimary())) {
      if (operator(tokens[index]) === "AND") index += 1;
      const right = parsePrimary();
      if (!right) break;
      expression = { kind: "and", left: expression, right };
    }
    return expression;
  };
  function parseOr(): SearchExpression | null {
    let expression = parseAnd();
    while (expression && operator(tokens[index]) === "OR") {
      index += 1;
      const right = parseAnd();
      if (!right) break;
      expression = { kind: "or", left: expression, right };
    }
    return expression;
  }
  return parseOr();
}

function searchTerms(expression: SearchExpression | null): string[] {
  if (!expression) return [];
  if (expression.kind === "term") return expression.tag ? [] : [expression.value.toLowerCase()];
  return [...new Set([...searchTerms(expression.left), ...searchTerms(expression.right)])];
}

function evaluateSearch(expression: SearchExpression, scoreTerm: (term: SearchExpression & { kind: "term" }) => number): number {
  if (expression.kind === "term") {
    const score = scoreTerm(expression);
    return expression.excluded ? (score > 0 ? 0 : 1) : score;
  }
  const left = evaluateSearch(expression.left, scoreTerm);
  const right = evaluateSearch(expression.right, scoreTerm);
  if (expression.kind === "and") return left > 0 && right > 0 ? left + right : 0;
  return Math.max(left, right);
}

function searchScore(bookmark: Bookmark, query: string, expression: SearchExpression | null): number {
  if (!query.trim()) return 1;
  const collection = collectionFor(bookmark)?.name ?? "";
  if (!expression) return 0;
  const fields: Array<[string, number]> = [
    [bookmark.title, 5],
    [bookmark.tags.join(" "), 4.5],
    [bookmark.description ?? "", 3],
    [bookmark.domain, 3],
    [bookmark.url, 2],
    [collection, 3],
    [bookmark.author ?? "", 2],
    [bookmark.siteName ?? "", 2],
    [bookmark.notes ?? "", 2],
  ];
  return evaluateSearch(expression, (term) => {
    if (term.tag) return Math.max(...bookmark.tags.map((tag) => fuzzyPartScore(tag, term.value) * 4.5), 0);
    const archiveScore = archiveSearchScores.get(bookmark.id)?.get(term.value.toLowerCase()) ?? 0;
    return Math.max(archiveScore, ...fields.map(([field, weight]) => fuzzyPartScore(field, term.value) * weight));
  });
}

function combinedSearchScore(bookmark: Bookmark, query: string, expression: SearchExpression | null): number {
  if (!query.trim()) return 1;
  return searchScore(bookmark, query, expression);
}

function hasSavedCopy(bookmark: Bookmark): boolean {
  return bookmark.archive.htmlAvailable;
}

function localDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hasActiveFilters(): boolean {
  return Boolean(
    filters.query
    || filters.scope !== "all"
    || filters.addedFrom
    || filters.addedTo
    || filters.domains.length
    || filters.hasSavedCopy
    || filters.favoritesOnly
    || filters.neverOpened
    || filters.hasNotes
    || filters.hasNoTags
  );
}

function clearFilterState(): void {
  filters = {
    ...filters,
    query: "",
    scope: "all",
    scopeId: undefined,
    addedFrom: "",
    addedTo: "",
    domains: [],
    hasSavedCopy: false,
    favoritesOnly: false,
    neverOpened: false,
    hasNotes: false,
    hasNoTags: false,
  };
  addedFilterOpen = false;
  domainFilterOpen = false;
  domainFilterQuery = "";
}

function pendingArchiveFor(bookmark: Bookmark) {
  return snapshot.pendingArchives.find((item) => item.id === bookmark.id);
}

function visibleBookmarks(): Bookmark[] {
  const filterKey = JSON.stringify([
    filters.query,
    filters.scope,
    filters.scopeId,
    filters.sort,
    filters.addedFrom,
    filters.addedTo,
    filters.domains,
    filters.hasSavedCopy,
    filters.favoritesOnly,
    filters.neverOpened,
    filters.hasNotes,
    filters.hasNoTags,
  ]);
  if (
    visibleBookmarksCache?.snapshot === snapshot
    && visibleBookmarksCache.archiveScores === archiveSearchScores
    && visibleBookmarksCache.filterKey === filterKey
  ) {
    return visibleBookmarksCache.bookmarks;
  }

  const searchExpression = parseSearchQuery(filters.query);
  const bookmarks = snapshot.bookmarks
    .map((bookmark) => ({ bookmark, score: combinedSearchScore(bookmark, filters.query, searchExpression) }))
    .filter(({ bookmark, score }) => {
      if (score === 0) return false;
      if (filters.scope !== "archive" && filters.scope !== "saved-copies" && bookmark.archived) return false;
      if (filters.scope === "archive" && !bookmark.archived) return false;
      if (filters.scope === "saved-copies" && !hasSavedCopy(bookmark)) return false;
      if (filters.scope === "favorites" && !bookmark.favorite) return false;
      if (filters.scope === "collection" && bookmark.collectionId !== filters.scopeId) return false;
      if (filters.scope === "tag" && !bookmark.tags.includes(filters.scopeId ?? "")) return false;
      const createdDate = localDateKey(bookmark.createdAt);
      if (filters.addedFrom && (!createdDate || createdDate < filters.addedFrom)) return false;
      if (filters.addedTo && (!createdDate || createdDate > filters.addedTo)) return false;
      if (filters.domains.length && !filters.domains.includes(bookmark.domain)) return false;
      if (filters.hasSavedCopy && !hasSavedCopy(bookmark)) return false;
      if (filters.favoritesOnly && !bookmark.favorite) return false;
      if (filters.neverOpened && (bookmark.openCount > 0 || bookmark.lastOpenedAt)) return false;
      if (filters.hasNotes && !bookmark.notes?.trim()) return false;
      if (filters.hasNoTags && bookmark.tags.length) return false;
      return true;
    })
    .sort((left, right) => {
      if (filters.query && Math.abs(right.score - left.score) > 0.01) return right.score - left.score;
      switch (filters.sort) {
        case "oldest": return Date.parse(left.bookmark.createdAt) - Date.parse(right.bookmark.createdAt);
        case "title": return left.bookmark.title.localeCompare(right.bookmark.title);
        case "domain": return left.bookmark.domain.localeCompare(right.bookmark.domain);
        case "visited": return (right.bookmark.openCount - left.bookmark.openCount) || Date.parse(right.bookmark.lastOpenedAt ?? "0") - Date.parse(left.bookmark.lastOpenedAt ?? "0");
        default: return Date.parse(right.bookmark.createdAt) - Date.parse(left.bookmark.createdAt);
      }
    })
    .map(({ bookmark }) => bookmark);
  visibleBookmarksRevision += 1;
  visibleBookmarksCache = {
    snapshot,
    archiveScores: archiveSearchScores,
    filterKey,
    bookmarks,
    revision: visibleBookmarksRevision,
  };
  return bookmarks;
}

function scopeTitle(count: number): { eyebrow: string; title: string; subtitle: string } {
  const noun = count === 1 ? "bookmark" : "bookmarks";
  if (filters.scope === "favorites") return { eyebrow: "Your highlights", title: "Favorites", subtitle: `${count} ${noun} worth returning to` };
  if (filters.scope === "saved-copies") return { eyebrow: "Kept for later", title: "Saved copies", subtitle: `${count} ${noun} with a local HTML copy` };
  if (filters.scope === "archive") return { eyebrow: "Out of sight, still nearby", title: "Archive", subtitle: `${count} archived ${noun}` };
  if (filters.scope === "collection") {
    const item = snapshot.collections.find((collection) => collection.id === filters.scopeId);
    return { eyebrow: "Collection", title: item?.name ?? "Collection", subtitle: `${count} ${noun} in this collection` };
  }
  if (filters.scope === "saved-query") {
    const item = snapshot.savedQueries.find((savedQuery) => savedQuery.id === filters.scopeId);
    return { eyebrow: "Saved query", title: item?.name ?? "Saved query", subtitle: `${count} fresh ${noun}` };
  }
  if (filters.scope === "tag") return { eyebrow: "Tagged", title: `#${filters.scopeId ?? "tag"}`, subtitle: `${count} matching ${noun}` };
  return { eyebrow: "Your library", title: "All bookmarks", subtitle: `${count} ${noun}` };
}

function navItem(scope: Scope, label: string, iconName: Parameters<typeof icon>[0], count: number, scopeId?: string): string {
  const active = filters.scope === scope && (!scopeId || filters.scopeId === scopeId);
  return `<button class="nav-item ${active ? "active" : ""}" data-nav="${scope}" ${scopeId ? `data-scope-id="${escapeHtml(scopeId)}"` : ""}>${icon(iconName)}<span>${escapeHtml(label)}</span><span class="nav-count">${count}</span></button>`;
}

function sidebarHtml(): string {
  const current = snapshot.bookmarks.filter((item) => !item.archived);
  const collections = snapshot.collections.map((collection) => {
    const count = current.filter((item) => item.collectionId === collection.id).length;
    const active = filters.scope === "collection" && filters.scopeId === collection.id;
    return `<div class="nav-item-row"><button class="nav-item collection-nav-item ${active ? "active" : ""}" data-nav="collection" data-scope-id="${escapeHtml(collection.id)}"><span class="collection-dot" style="background:${escapeHtml(collection.color)}"></span><span class="collection-nav-name">${escapeHtml(collection.name)}</span><span class="nav-count">${count}</span></button><button class="nav-item-action" data-action="edit-collection" data-id="${escapeHtml(collection.id)}" title="Rename or delete ${escapeHtml(collection.name)}" aria-label="Rename or delete ${escapeHtml(collection.name)}">${icon("edit")}</button></div>`;
  }).join("");
  const tags = snapshot.tags.map((tag) => {
    const active = filters.scope === "tag" && filters.scopeId === tag.name;
    return `<button class="nav-item ${active ? "active" : ""}" data-nav="tag" data-scope-id="${escapeHtml(tag.name)}">${icon("tag")}<span>${escapeHtml(tag.name)}</span><span class="nav-count">${tag.count}</span></button>`;
  }).join("");
  const savedQueries = snapshot.savedQueries.map((savedQuery) => {
    const active = filters.scope === "saved-query" && filters.scopeId === savedQuery.id;
    return `<div class="nav-item-row"><button class="nav-item collection-nav-item ${active ? "active" : ""}" data-nav="saved-query" data-scope-id="${escapeHtml(savedQuery.id)}" title="${escapeHtml(savedQuery.query)}">${icon("search")}<span class="collection-nav-name">${escapeHtml(savedQuery.name)}</span></button><button class="nav-item-action" data-action="edit-saved-query" data-id="${escapeHtml(savedQuery.id)}" title="Edit or delete ${escapeHtml(savedQuery.name)}" aria-label="Edit or delete ${escapeHtml(savedQuery.name)}">${icon("edit")}</button></div>`;
  }).join("");
  return `<aside class="sidebar">
    <div class="brand"><span class="brand-mark">${icon("logo")}</span><span class="brand-name">Shelf</span></div>
    <div class="nav-scroll">
      <div class="nav-group"><div class="nav-label">Library</div>
        ${navItem("all", "All bookmarks", "inbox", current.length)}
        ${navItem("favorites", "Favorites", "star", current.filter((item) => item.favorite).length)}
        ${navItem("saved-copies", "Saved copies", "download", snapshot.bookmarks.filter(hasSavedCopy).length)}
        <button class="nav-item" data-action="rename-tag">${icon("edit")}<span>Tag rename</span></button>
        ${navItem("archive", "Archive", "archive", snapshot.bookmarks.filter((item) => item.archived).length)}
      </div>
      <div class="nav-group"><div class="nav-label">Saved queries</div>${savedQueries}<button class="nav-item nav-item-add" data-action="new-saved-query">${icon("plus")}<span>New saved query</span></button></div>
      <div class="nav-group"><div class="nav-label">Collections</div>${collections}<button class="nav-item nav-item-add" data-action="new-collection">${icon("plus")}<span>New collection</span></button></div>
      ${snapshot.tags.length ? `<div class="nav-group"><div class="nav-label">All tags</div>${tags}</div>` : ""}
    </div>
    <div class="sidebar-footer"><div class="storage-note" title="${escapeHtml(snapshot.dataPath)}">${icon("check")}<div><strong>Saved locally</strong>Every change is on this device</div></div></div>
  </aside>`;
}

function fallbackImage(bookmark: Bookmark): string {
  const initial = bookmark.domain.charAt(0).toUpperCase() || "S";
  return `<div class="image-fallback"><span>${escapeHtml(initial)}</span></div>`;
}

function archiveModeLabel(mode: ArchiveMode): string {
  if (mode === "html") return "Raw HTML";
  return "None";
}

function archiveStatusHtml(bookmark: Bookmark): string {
  const archive = bookmark.archive;
  const pending = pendingArchiveFor(bookmark);
  const formats = archive.htmlAvailable ? "Raw HTML" : "";
  if (!formats && !pending) return "";
  if (pending && !formats) {
    return `<span class="archive-status pending" title="Saving ${escapeHtml(archiveModeLabel(pending.mode))}"><span class="spinner"></span><span>Saving ${escapeHtml(archiveModeLabel(pending.mode))}…</span></span>`;
  }
  return `<span class="archive-status" title="Saved copy: ${escapeHtml(formats)}">${pending ? `<span class="spinner"></span>` : icon("download")}<span>${escapeHtml(formats)} saved${pending ? ` · Updating ${escapeHtml(archiveModeLabel(pending.mode))}` : ""}</span></span>`;
}

function cardHtml(bookmark: Bookmark): string {
  const collection = collectionFor(bookmark);
  const image = safeImage(bookmark.imageUrl);
  const favicon = safeImage(bookmark.faviconUrl);
  const tags = bookmark.tags.slice(0, 4).map((tag) => `<button class="tag-pill" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join("");
  const extra = bookmark.tags.length > 4 ? `<span class="tag-pill">+${bookmark.tags.length - 4}</span>` : "";
  return `<article class="bookmark-card${openMenuId === bookmark.id ? " menu-open" : ""}" data-action="view-bookmark" data-id="${escapeHtml(bookmark.id)}" role="button" tabindex="0" aria-label="View details for ${escapeHtml(bookmark.title)}">
    <div class="card-image">
      ${image ? `<img src="${image}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback-image />` : fallbackImage(bookmark)}
      <button class="card-favorite ${bookmark.favorite ? "active" : ""}" data-action="favorite" data-id="${escapeHtml(bookmark.id)}" title="${bookmark.favorite ? "Remove from favorites" : "Add to favorites"}">${icon("star")}</button>
    </div>
    <div class="card-body">
      <button class="domain" data-action="open-bookmark" data-id="${escapeHtml(bookmark.id)}" title="Open ${escapeHtml(bookmark.domain)} in your browser">${favicon ? `<img class="favicon" src="${favicon}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ""}<span>${escapeHtml(bookmark.siteName || bookmark.domain)}</span>${icon("external", "domain-external")}</button>
      ${archiveStatusHtml(bookmark)}
      <h2 class="card-title">${escapeHtml(bookmark.title)}</h2>
      <p class="card-description">${escapeHtml(bookmark.description || bookmark.notes || "No description yet — edit this bookmark to add your own note.")}</p>
      <div class="tag-row">${tags}${extra}</div>
      <div class="card-foot">
        <div class="collection-label">${collection ? `<span class="collection-dot" style="background:${escapeHtml(collection.color)}"></span><span>${escapeHtml(collection.name)}</span>` : `<span>${dateLabel(bookmark.createdAt)}</span>`}</div>
        <div class="card-menu"><button data-action="menu" data-id="${escapeHtml(bookmark.id)}" aria-label="Bookmark actions" aria-expanded="${openMenuId === bookmark.id}">${icon("more")}</button>
          ${openMenuId === bookmark.id ? contextMenuHtml(bookmark) : ""}
        </div>
      </div>
    </div>
  </article>`;
}

function contextMenuHtml(bookmark: Bookmark): string {
  return `<div class="context-menu">
            <button data-action="open-bookmark" data-id="${escapeHtml(bookmark.id)}">${icon("external")}Open</button>
            <button data-action="share-bookmark" data-id="${escapeHtml(bookmark.id)}">${icon("share")}Share</button>
            ${bookmark.archive.htmlAvailable ? `<button data-action="open-archive" data-id="${escapeHtml(bookmark.id)}">${icon("archive")}View Saved Copy</button>` : ""}
            ${pendingArchiveFor(bookmark) ? `<div class="context-menu-note"><span class="spinner"></span>Saving ${escapeHtml(archiveModeLabel(pendingArchiveFor(bookmark)!.mode))} in the background…</div>` : ""}
            ${bookmark.archive.mode !== "none" ? `<button data-action="refresh-archive" data-id="${escapeHtml(bookmark.id)}">${icon("refresh")}Refresh Saved Copy</button>` : ""}
            <button data-action="refresh-metadata" data-id="${escapeHtml(bookmark.id)}">${icon("refresh")}Refresh Metadata</button>
            <button data-action="edit-bookmark" data-id="${escapeHtml(bookmark.id)}">${icon("edit")}Edit Details</button>
            ${!hasSavedCopy(bookmark) && !pendingArchiveFor(bookmark) ? `<button data-action="save-offline-copy" data-id="${escapeHtml(bookmark.id)}">${icon("download")}Save Offline Copy</button>` : ""}
            <button data-action="archive" data-id="${escapeHtml(bookmark.id)}">${icon("archive")}${bookmark.archived ? "Restore" : "Archive"}</button>
            <button class="danger" data-action="delete-bookmark" data-id="${escapeHtml(bookmark.id)}">${icon("trash")}Delete</button>
          </div>`;
}

function emptyHtml(): string {
  const isFiltered = hasActiveFilters();
  return `<div class="empty-state"><div><div class="empty-art">${icon(isFiltered ? "search" : "logo")}</div><h2>${isFiltered ? "Nothing found on this shelf" : "Your shelf is waiting"}</h2><p>${isFiltered ? "Try a looser phrase or clear the active filters. Fuzzy search is forgiving, but even it needs a breadcrumb." : "Save the first corner of the web you want to keep. Shelf will fetch the title, description, image, and site details for you."}</p><button class="btn btn-primary" data-action="${isFiltered ? "clear-filters" : "new-bookmark"}">${icon(isFiltered ? "close" : "plus")} ${isFiltered ? "Clear filters" : "Add your first bookmark"}</button></div></div>`;
}

function securityOperationLabel(): string {
  return "Saving security…";
}

function topbarHtml(): string {
  const lockTitle = securityOperation
    ? "Updating Shelf security…"
    : locking
      ? "Locking Shelf…"
      : security.passwordConfigured
        ? "Lock Shelf"
        : "Set a password to enable locking";
  const lockControl = locking || securityOperation ? '<span class="spinner"></span>' : icon("lock");
  return `<header class="topbar">
      <div class="search-wrap">${icon("search")}<input id="global-search" class="search-input" value="${escapeHtml(searchInput)}" placeholder="Search titles, notes, #tags, and saved pages…" autocomplete="off" aria-describedby="search-help" /><span class="shortcut">⌘ K</span><span class="search-help" id="search-help">Use AND, OR, parentheses, or -term to exclude — for example, rust -wasm</span></div>
      ${securityOperation ? `<div class="security-progress" role="status" aria-live="polite">${icon("lock")}<span>${securityOperationLabel()}</span><span class="security-progress-dots" aria-hidden="true"></span></div>` : ""}
      <div class="top-actions"><button class="btn btn-primary" data-action="new-bookmark">${icon("plus")}<span>Add bookmark</span></button><button class="btn btn-icon home-lock-button" data-action="lock-now" title="${lockTitle}" aria-label="${lockTitle}" ${!security.passwordConfigured || locking || securityOperation ? "disabled" : ""}>${lockControl}</button><button class="btn btn-icon" data-action="settings" title="Settings">${icon("settings")}</button></div>
    </header>`;
}

function filterDateLabel(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(year, month - 1, day));
}

function availableDomains(): string[] {
  return [...new Set([
    ...snapshot.bookmarks.map((bookmark) => bookmark.domain),
    ...filters.domains,
  ].filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function addedFilterLabel(): string {
  if (filters.addedFrom && filters.addedTo) return `Added · ${filterDateLabel(filters.addedFrom)} – ${filterDateLabel(filters.addedTo)}`;
  if (filters.addedFrom) return `Added since ${filterDateLabel(filters.addedFrom)}`;
  if (filters.addedTo) return `Added through ${filterDateLabel(filters.addedTo)}`;
  return "Added";
}

function domainFilterLabel(): string {
  if (filters.domains.length === 1) return filters.domains[0];
  if (filters.domains.length > 1) return `Domains · ${filters.domains.length}`;
  return "Domain";
}

function domainMatchesFilter(domain: string, query = domainFilterQuery): boolean {
  return domain.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function filterDomainOptions(rawQuery: string): void {
  domainFilterQuery = rawQuery;
  let matchingDomains = 0;
  document.querySelectorAll<HTMLElement>("#domain-filter-options .filter-option").forEach((option) => {
    const domain = option.querySelector<HTMLInputElement>("[data-domain-filter]")?.value ?? "";
    const matches = domainMatchesFilter(domain, rawQuery);
    option.hidden = !matches;
    if (matches) matchingDomains += 1;
  });
  const empty = document.querySelector<HTMLElement>("#domain-filter-empty");
  if (empty) empty.hidden = matchingDomains > 0;
}

function filterBarHtml(searchActions: string): string {
  const domains = availableDomains();
  const matchingDomainCount = domains.filter((domain) => domainMatchesFilter(domain)).length;
  const domainOptions = domains.map((domain) => `<label class="filter-option" ${domainMatchesFilter(domain) ? "" : "hidden"}><input type="checkbox" data-domain-filter value="${escapeHtml(domain)}" ${filters.domains.includes(domain) ? "checked" : ""}/><span>${escapeHtml(domain)}</span></label>`).join("");
  return `<div class="filter-bar">
      <div class="filter-picker added-filter-picker">
        <button class="filter-chip filter-menu-trigger ${filters.addedFrom || filters.addedTo ? "active" : ""}" data-action="toggle-added-filter" aria-haspopup="dialog" aria-controls="added-filter-options" aria-expanded="${addedFilterOpen}">${icon("calendar")}<span>${escapeHtml(addedFilterLabel())}</span>${icon("chevron", "filter-chevron")}</button>
        <div class="filter-popover date-filter-options" id="added-filter-options" role="group" aria-label="Filter by date added" ${addedFilterOpen ? "" : "hidden"}>
          <div class="filter-popover-title">Date added</div>
          <div class="date-filter-fields">
            <label><span>From</span><input type="date" id="added-from-filter" value="${escapeHtml(filters.addedFrom)}" ${filters.addedTo ? `max="${escapeHtml(filters.addedTo)}"` : ""}/></label>
            <label><span>To</span><input type="date" id="added-to-filter" value="${escapeHtml(filters.addedTo)}" ${filters.addedFrom ? `min="${escapeHtml(filters.addedFrom)}"` : ""}/></label>
          </div>
          ${filters.addedFrom || filters.addedTo ? '<button class="filter-popover-clear" data-action="clear-added-filter">Clear dates</button>' : ""}
        </div>
      </div>
      <div class="filter-picker domain-filter-picker">
        <button class="filter-chip filter-menu-trigger ${filters.domains.length ? "active" : ""}" data-action="toggle-domain-filter" aria-haspopup="dialog" aria-controls="domain-filter-options" aria-expanded="${domainFilterOpen}">${icon("external")}<span>${escapeHtml(domainFilterLabel())}</span>${icon("chevron", "filter-chevron")}</button>
        <div class="filter-popover domain-filter-options" id="domain-filter-options" role="group" aria-label="Filter by domain" ${domainFilterOpen ? "" : "hidden"}>
          <div class="filter-popover-title">Domains</div>
          <div class="domain-filter-search">${icon("search")}<input id="domain-filter-search" type="search" value="${escapeHtml(domainFilterQuery)}" placeholder="Search domains…" aria-label="Search domains" autocomplete="off" ${domains.length ? "" : "disabled"}/></div>
          <div class="filter-options-list">${domainOptions}<div class="filter-options-empty" id="domain-filter-empty" ${matchingDomainCount ? "hidden" : ""}>${domains.length ? "No matching domains." : "Domains appear after you add bookmarks."}</div></div>
          ${filters.domains.length ? '<button class="filter-popover-clear" data-action="clear-domain-filter">Clear domains</button>' : ""}
        </div>
      </div>
      <button class="filter-chip ${filters.hasSavedCopy ? "active" : ""}" data-filter="saved-copy">${icon("download")}Has saved copy</button>
      <button class="filter-chip ${filters.favoritesOnly ? "active" : ""}" data-filter="favorite">${icon("star")}Favorite</button>
      <button class="filter-chip ${filters.neverOpened ? "active" : ""}" data-filter="never-opened">${icon("eye-off")}Never opened</button>
      <button class="filter-chip ${filters.hasNotes ? "active" : ""}" data-filter="notes">${icon("edit")}Has notes</button>
      <button class="filter-chip ${filters.hasNoTags ? "active" : ""}" data-filter="no-tags">${icon("tag")}No tags</button>
      ${hasActiveFilters() ? `<button class="filter-chip clear-filter-chip" data-action="clear-filters">${icon("close")}Clear</button>` : ""}
      ${searchActions}
    </div>`;
}

function contentHtml(): string {
  const visible = visibleBookmarks();
  const heading = scopeTitle(visible.length);
  const searchActions = filters.query.trim()
    ? `<div class="search-result-actions"><button class="filter-chip search-export-chip" data-action="new-saved-query">${icon("search")}Save query</button><button class="filter-chip search-move-chip" data-action="move-search" ${visible.length && snapshot.collections.length ? "" : "disabled"} title="${snapshot.collections.length ? "Move these search results to a collection" : "Create a collection before moving search results"}">${icon("folder")}Move ${visible.length} ${visible.length === 1 ? "result" : "results"}</button><button class="filter-chip search-export-chip" data-action="export-search" ${visible.length ? "" : "disabled"}>${icon("download")}Export ${visible.length} ${visible.length === 1 ? "result" : "results"}</button></div>`
    : "";
  return `<section class="content">
      <div class="page-head"><div><div class="eyebrow">${escapeHtml(heading.eyebrow)}</div><h1>${escapeHtml(heading.title)}</h1><p class="page-subtitle">${escapeHtml(heading.subtitle)}</p></div>
        <div class="view-tools">
          <div class="sort-picker">
            <button class="sort-trigger" data-action="toggle-sort-picker" aria-haspopup="listbox" aria-expanded="false">${icon("sliders")}<span>${escapeHtml(sortOptions.find((option) => option.value === filters.sort)?.label)}</span>${icon("chevron", "picker-chevron")}</button>
            <div class="sort-options" id="sort-options" role="listbox" hidden>${sortOptions.map((option) => `<button class="sort-option ${filters.sort === option.value ? "selected" : ""}" data-sort="${option.value}"><span>${escapeHtml(option.label)}</span>${filters.sort === option.value ? icon("check") : ""}</button>`).join("")}</div>
          </div>
          <div class="segmented"><button class="${filters.view === "grid" ? "active" : ""}" data-view="grid" title="Grid view">${icon("grid")}</button><button class="${filters.view === "list" ? "active" : ""}" data-view="list" title="List view">${icon("list")}</button></div>
        </div>
      </div>
      ${filterBarHtml(searchActions)}
      ${visible.length ? `<div class="bookmark-virtualizer" data-virtual-view="${filters.view}" data-visible-revision="${visibleBookmarksCache?.revision ?? 0}"></div>` : emptyHtml()}
    </section>`;
}

function titlebarHtml(): string {
  const maximizeLabel = windowMaximized ? "Restore window" : "Maximize window";
  const maximizeIcon = icon(windowMaximized ? "window-restore" : "window-maximize");
  return [
    '<header class="window-titlebar" data-platform="', platform, '" data-tauri-drag-region>',
    '<div class="titlebar-leading"><span class="titlebar-mark">', icon("logo"), '</span><span class="titlebar-wordmark">Shelf</span></div>',
    '<div class="titlebar-caption"><strong>Shelf</strong><span>Bookmark library</span></div>',
    '<div class="window-controls" aria-label="Window controls">',
    '<button class="window-control window-control-minimize" data-window-action="minimize" title="Minimize window" aria-label="Minimize window">', icon("window-minimize"), '</button>',
    '<button class="window-control window-control-maximize" data-window-action="maximize" title="', maximizeLabel, '" aria-label="', maximizeLabel, '">', maximizeIcon, '</button>',
    '<button class="window-control window-control-close" data-window-action="close" title="Close window" aria-label="Close window">', icon("close"), '</button>',
    '</div></header>',
  ].join("");
}

function lockScreenHtml(): string {
  const buttonLabel = unlocking ? "Unlocking…" : "Unlock Shelf";
  return `<main class="lock-screen"><section class="lock-card" aria-labelledby="lock-title">
    <div class="lock-mark">${icon("lock")}</div>
    <div class="eyebrow">Private shelf</div>
    <h1 id="lock-title">Shelf is locked</h1>
    <p class="lock-copy">Enter your password to return to your shelf.</p>
    <form id="unlock-form" class="lock-form">
      <div class="field"><label for="unlock-password">Password</label><input id="unlock-password" class="input" name="password" type="password" autocomplete="current-password" required ${unlocking ? "disabled" : ""} /></div>
      ${unlockError ? `<div class="fetch-status error">${icon("close")}${escapeHtml(unlockError)}</div>` : ""}
      <button type="submit" class="btn btn-primary lock-submit" ${unlocking ? "disabled" : ""}>${unlocking ? '<span class="spinner spinner-light"></span>' : icon("lock")}${buttonLabel}</button>
    </form>
    <p class="lock-hint">Your password is never stored by Shelf. There is no recovery path.</p>
  </section></main>`;
}

function emptySnapshot(): AppSnapshot {
  return {
    version: 4,
    bookmarks: [],
    collections: [],
    savedQueries: [],
    tags: [],
    dataPath: "",
    dataDirectory: "",
    dataFileName: "shelf.sqlite3",
    archiveDirectory: "",
    pendingArchives: [],
  };
}

function sessionIsActive(generation: number): boolean {
  return !locked && generation === sessionGeneration;
}

function acceptSnapshot(next: AppSnapshot, generation: number): boolean {
  if (!sessionIsActive(generation)) return false;
  snapshot = next;
  if (filters.scope === "saved-query") {
    const savedQuery = snapshot.savedQueries.find((item) => item.id === filters.scopeId);
    if (savedQuery && savedQuery.query !== filters.query) {
      activateSavedQuery(savedQuery);
    } else if (!savedQuery) {
      searchInput = "";
      clearFilterState();
      scheduleArchiveSearch("");
      requestVirtualReset();
    }
  }
  return true;
}

function clearInactivityTimer(): void {
  if (inactivityTimer !== undefined) {
    window.clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  }
}

function scheduleInactivityLock(): void {
  clearInactivityTimer();
  if (!security.passwordConfigured || locked || unlocking || securityOperation) return;
  const timeout = security.timeoutMinutes * 60_000;
  const remaining = Math.max(timeout - (Date.now() - lastInteractionAt), 0);
  inactivityTimer = window.setTimeout(() => {
    void enforceInactivityLock();
  }, remaining);
}

function noteInteraction(): void {
  if (!security.passwordConfigured || locked || unlocking || securityOperation) return;
  lastInteractionAt = Date.now();
  scheduleInactivityLock();
}

async function enforceInactivityLock(): Promise<void> {
  if (!security.passwordConfigured || locked || unlocking || securityOperation) return;
  const timeout = security.timeoutMinutes * 60_000;
  if (Date.now() - lastInteractionAt < timeout) {
    scheduleInactivityLock();
    return;
  }
  await lockShelf();
}

async function lockShelf(): Promise<void> {
  if (!security.passwordConfigured || locked || locking || securityOperation) return;
  locking = true;
  clearInactivityTimer();
  render();
  try {
    security = await invoke<SecurityStatus>("lock_app");
    locked = security.locked;
    if (locked) sessionGeneration += 1;
    snapshot = emptySnapshot();
    modal = null;
    closeBookmarkMenu();
    clearFilterState();
    searchInput = "";
    if (searchInputTimer) window.clearTimeout(searchInputTimer);
    searchInputTimer = undefined;
    if (archiveSearchTimer) window.clearTimeout(archiveSearchTimer);
    archiveSearchTimer = undefined;
    archiveSearchRequest += 1;
    archiveSearchScores.clear();
    if (locked) render();
  } catch (error) {
    locking = false;
    render();
    toast("Could not lock Shelf", errorMessage(error), true);
    lastInteractionAt = Date.now();
    scheduleInactivityLock();
  } finally {
    locking = false;
  }
}

async function unlockShelf(form: HTMLFormElement): Promise<void> {
  const password = String(new FormData(form).get("password") || "");
  if (!password) return;
  unlocking = true;
  unlockError = "";
  clearInactivityTimer();
  render();
  try {
    const nextSnapshot = await invoke<AppSnapshot>("unlock_app", { password });
    security = await invoke<SecurityStatus>("get_security_status");
    locked = false;
    sessionGeneration += 1;
    snapshot = nextSnapshot;
    lastInteractionAt = Date.now();
    modal = null;
    unlocking = false;
    render();
    scheduleInactivityLock();
    if (snapshot.pendingArchives.length) void processPendingArchives();
  } catch (error) {
    unlockError = errorMessage(error);
    render();
    setTimeout(() => document.querySelector<HTMLInputElement>("#unlock-password")?.focus(), 0);
  } finally {
    if (unlocking) {
      unlocking = false;
      if (locked) render();
    }
  }
}

function updateWindowChrome(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-window-action=\"maximize\"]");
  if (!button) return;
  const label = windowMaximized ? "Restore window" : "Maximize window";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon(windowMaximized ? "window-restore" : "window-maximize");
}

async function syncWindowChrome(): Promise<void> {
  const request = ++windowChromeSyncRequest;
  try {
    const maximized = await appWindow.isMaximized();
    if (request !== windowChromeSyncRequest) return;
    windowMaximized = maximized;
    updateWindowChrome();
  } catch {
    // The web preview does not have a native Tauri window.
  }
}

async function installWindowChromeSync(): Promise<void> {
  try {
    await appWindow.onResized(() => {
      if (windowChromeSyncTimer !== undefined) window.clearTimeout(windowChromeSyncTimer);
      windowChromeSyncTimer = window.setTimeout(() => {
        windowChromeSyncTimer = undefined;
        void syncWindowChrome();
      }, 50);
    });
  } catch {
    // The browser preview does not expose native window resize events.
  }
}

async function installWindowCloseGuard(): Promise<void> {
  try {
    await appWindow.onCloseRequested(async (event) => {
      if (forceWindowClose || !securityOperation) return;
      event.preventDefault();
      if (closePromptOpen) return;
      closePromptOpen = true;
      try {
        const operation = "The app-lock update";
        const shouldClose = await confirm(
          `${operation} is still in progress. Closing now may leave the new setting unsaved. Close Shelf anyway?`,
          { title: `${operation} in progress`, kind: "warning" },
        );
        if (shouldClose) {
          forceWindowClose = true;
          await appWindow.destroy();
        }
      } catch (error) {
        toast("Could not close Shelf", errorMessage(error), true);
      } finally {
        closePromptOpen = false;
      }
    });
  } catch {
    // The browser preview does not expose native window close events.
  }
}

async function handleWindowAction(action: string): Promise<void> {
  try {
    if (action === "minimize") await appWindow.minimize();
    if (action === "maximize") {
      await appWindow.toggleMaximize();
      await syncWindowChrome();
    }
    if (action === "close") await appWindow.close();
  } catch (error) {
    toast("Window action unavailable", errorMessage(error), true);
  }
}

function destroyBookmarkVirtualizer(): void {
  bookmarkVirtualizer?.destroy();
  bookmarkVirtualizer = null;
}

function requestVirtualReset(): void {
  virtualResetRequested = true;
}

function mountBookmarkVirtualizer(preservedScrollTop?: number): void {
  const content = root.querySelector<HTMLElement>(".content");
  const host = content?.querySelector<HTMLElement>(".bookmark-virtualizer");
  const shouldResetScroll = virtualResetRequested;
  if (content && shouldResetScroll) content.scrollTop = 0;
  if (!content || !host) {
    destroyBookmarkVirtualizer();
    virtualResetRequested = false;
    return;
  }
  virtualResetRequested = false;

  if (bookmarkVirtualizer?.hostElement === host) {
    bookmarkVirtualizer.refresh();
  } else {
    destroyBookmarkVirtualizer();
    bookmarkVirtualizer = new BookmarkVirtualizer({
      scrollElement: content,
      hostElement: host,
      items: visibleBookmarks(),
      view: filters.view,
      renderItem: cardHtml,
      onRendered: attachImageFallbacks,
    });
  }

  // A replaced virtualizer starts with an empty host, so restoring the scroll
  // position before mounting it would be clamped to zero by the browser.
  if (!shouldResetScroll && typeof preservedScrollTop === "number") {
    content.scrollTop = preservedScrollTop;
    bookmarkVirtualizer.refresh();
  }
}

function replaceScrollableFragment(selector: string, html: string, restoreScroll = true): number | undefined {
  const current = root.querySelector<HTMLElement>(selector);
  if (!current) return undefined;
  const scrollTop = current.scrollTop;
  const existingImages = new Map<string, HTMLImageElement>();
  current.querySelectorAll<HTMLImageElement>(".bookmark-card img").forEach((image) => {
    const key = cardImageKey(image);
    if (key) existingImages.set(key, image);
  });
  current.outerHTML = html;
  const replacement = root.querySelector<HTMLElement>(selector);
  if (!replacement) return undefined;
  if (restoreScroll) replacement.scrollTop = scrollTop;
  replacement.querySelectorAll<HTMLImageElement>(".bookmark-card img").forEach((image) => {
    const key = cardImageKey(image);
    const existing = key ? existingImages.get(key) : undefined;
    if (existing) image.replaceWith(existing);
  });
  return scrollTop;
}

function resetRenderedFragments(): void {
  renderedSidebarHtml = "";
  renderedTopbarHtml = "";
  renderedContentHtml = "";
  renderedModalHtml = "";
}

function render(preserveSearch = false): void {
  if (locked) {
    modal = null;
    snapshot = emptySnapshot();
  }
  const selection = preserveSearch ? document.querySelector<HTMLInputElement>("#global-search")?.selectionStart : null;
  const hasLibraryShell = Boolean(root.querySelector(":scope > .app-shell .sidebar"));
  let modalChanged = false;
  let preservedContentScrollTop: number | undefined;
  let fullRender = loading || locked || !hasLibraryShell;

  if (fullRender) {
    destroyBookmarkVirtualizer();
    resetRenderedFragments();
    if (loading) {
      root.innerHTML = `<div class="app-shell"><div class="empty-state" style="grid-column:1/-1;border:0"><div><div class="empty-art">${icon("logo")}</div><h2>Opening your shelf…</h2></div></div></div>`;
    } else if (locked) {
      root.innerHTML = `<div class="locked-shell">${titlebarHtml()}${lockScreenHtml()}</div>`;
    } else {
      renderedSidebarHtml = sidebarHtml();
      renderedTopbarHtml = topbarHtml();
      renderedContentHtml = contentHtml();
      renderedModalHtml = modal ? modalHtml() : "";
      root.innerHTML = `<div class="app-shell">${titlebarHtml()}${renderedSidebarHtml}<main class="main">${renderedTopbarHtml}${renderedContentHtml}</main></div><div id="modal-root">${renderedModalHtml}</div><div class="toast-stack" id="toast-stack"></div>`;
      modalChanged = true;
    }
  } else {
    const nextSidebarHtml = sidebarHtml();
    const nextTopbarHtml = topbarHtml();
    const nextContentHtml = contentHtml();
    const nextModalHtml = modal ? modalHtml() : "";
    if (nextSidebarHtml !== renderedSidebarHtml) {
      replaceScrollableFragment(".sidebar", nextSidebarHtml);
      renderedSidebarHtml = nextSidebarHtml;
    }
    if (nextTopbarHtml !== renderedTopbarHtml) {
      root.querySelector(".topbar")?.replaceWith(document.createRange().createContextualFragment(nextTopbarHtml));
      renderedTopbarHtml = nextTopbarHtml;
    }
    if (nextContentHtml !== renderedContentHtml) {
      destroyBookmarkVirtualizer();
      preservedContentScrollTop = replaceScrollableFragment(".content", nextContentHtml, false);
      renderedContentHtml = nextContentHtml;
    }
    if (nextModalHtml !== renderedModalHtml) {
      const modalRoot = root.querySelector<HTMLElement>("#modal-root");
      if (modalRoot) modalRoot.innerHTML = nextModalHtml;
      renderedModalHtml = nextModalHtml;
      modalChanged = true;
    }
  }
  void syncWindowChrome();
  if (fullRender || modalChanged) bindFormHandlers();
  if (preserveSearch) {
    const search = document.querySelector<HTMLInputElement>("#global-search");
    search?.focus();
    if (typeof selection === "number") search?.setSelectionRange(selection, selection);
  }
  mountBookmarkVirtualizer(preservedContentScrollTop);
  attachImageFallbacks();
  if (fullRender || modalChanged) attachArchiveViewer();
  if (modalChanged && modal?.kind === "bookmark") {
    const isEditing = Boolean(modal.id);
    setTimeout(() => document.querySelector<HTMLInputElement>(isEditing ? "#bookmark-title" : "#bookmark-url")?.focus(), 0);
  }
  if (modalChanged && modal?.kind === "bookmark-details") setTimeout(() => document.querySelector<HTMLButtonElement>(".bookmark-details-edit")?.focus(), 0);
  if (modalChanged && modal?.kind === "collection") setTimeout(() => document.querySelector<HTMLInputElement>("#collection-name")?.focus(), 0);
  if (modalChanged && modal?.kind === "saved-query") setTimeout(() => document.querySelector<HTMLInputElement>("#saved-query-name")?.focus(), 0);
  if (modalChanged && modal?.kind === "tag-rename") setTimeout(() => document.querySelector<HTMLButtonElement>(".tag-rename-trigger")?.focus(), 0);
  if (modalChanged && modal?.kind === "move-search") setTimeout(() => document.querySelector<HTMLButtonElement>(".move-search-trigger")?.focus(), 0);
}

function cardImageKey(image: HTMLImageElement): string | null {
  const card = image.closest<HTMLElement>(".bookmark-card");
  const id = card?.dataset.id;
  const src = image.getAttribute("src");
  if (!id || !src) return null;
  return `${id}:${image.classList.contains("favicon") ? "favicon" : "cover"}:${src}`;
}

function archiveDocumentHtml(html: string, baseUrl: string): string {
  if (!baseUrl || /<base\b/i.test(html)) return html;
  const baseTag = `<base href="${escapeHtml(baseUrl)}" />`;
  const head = html.match(/<head\b[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}${baseTag}`);
  const document = html.match(/<html\b[^>]*>/i);
  if (document) return html.replace(document[0], `${document[0]}<head>${baseTag}</head>`);
  return `<!doctype html><html><head>${baseTag}</head><body>${html}</body></html>`;
}

function attachArchiveViewer(): void {
  if (modal?.kind !== "archive") return;
  const frame = document.querySelector<HTMLIFrameElement>("#archive-viewer-frame");
  if (frame) frame.srcdoc = archiveDocumentHtml(modal.html ?? "", modal.baseUrl ?? "");
}

function setSecurityFormBusy(busy: boolean): void {
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#security-form button, #security-form input").forEach((control) => {
    control.disabled = busy;
  });
}

function bindFormHandlers(): void {
  const unlockForm = document.querySelector<HTMLFormElement>("#unlock-form");
  unlockForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void unlockShelf(unlockForm);
  });

  const bookmarkForm = document.querySelector<HTMLFormElement>("#bookmark-form");
  bookmarkForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveBookmark(bookmarkForm);
  });

  const collectionForm = document.querySelector<HTMLFormElement>("#collection-form");
  collectionForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCollection(collectionForm);
  });

  const savedQueryForm = document.querySelector<HTMLFormElement>("#saved-query-form");
  savedQueryForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSavedQuery(savedQueryForm);
  });

  const tagRenameForm = document.querySelector<HTMLFormElement>("#tag-rename-form");
  tagRenameForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void renameTag(tagRenameForm);
  });

  const moveSearchForm = document.querySelector<HTMLFormElement>("#move-search-form");
  moveSearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void moveSearchResults(moveSearchForm);
  });

  const storageForm = document.querySelector<HTMLFormElement>("#storage-form");
  storageForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveStorage(storageForm);
  });

  const securityForm = document.querySelector<HTMLFormElement>("#security-form");
  securityForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSecurity(securityForm);
  });

  const apiServerForm = document.querySelector<HTMLFormElement>("#api-server-form");
  apiServerForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveApiServer(apiServerForm);
  });

  const miscForm = document.querySelector<HTMLFormElement>("#misc-form");
  miscForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveMisc(miscForm);
  });
}

function attachImageFallbacks(): void {
  document.querySelectorAll<HTMLImageElement>("[data-fallback-image]").forEach((image) => {
    if (fallbackBoundImages.has(image)) return;
    fallbackBoundImages.add(image);
    image.addEventListener("error", () => {
      const bookmark = snapshot.bookmarks.find((item) => item.id === image.closest<HTMLElement>("[data-id]")?.dataset.id);
      image.parentElement?.insertAdjacentHTML("afterbegin", fallbackImage(bookmark ?? ({ domain: "s" } as Bookmark)));
      image.remove();
    }, { once: true });
  });
}

function bookmarkDetailsModalHtml(): string {
  const bookmark = snapshot.bookmarks.find((item) => item.id === modal?.id);
  if (!bookmark) return "";
  const collection = collectionFor(bookmark);
  const image = safeImage(bookmark.imageUrl);
  const favicon = safeImage(bookmark.faviconUrl);
  const tags = bookmark.tags.length
    ? bookmark.tags.map((tag) => `<span class="bookmark-detail-tag">#${escapeHtml(tag)}</span>`).join("")
    : `<span class="bookmark-detail-empty">No tags</span>`;
  const detail = (label: string, value?: string, className = "") => `<div class="bookmark-detail-item ${className}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "Not available")}</dd></div>`;

  return `<div class="backdrop"><section class="modal bookmark-details-modal" role="dialog" aria-modal="true" aria-labelledby="bookmark-details-title" data-modal-panel data-id="${escapeHtml(bookmark.id)}">
    <div class="modal-head"><div><h2 id="bookmark-details-title">Bookmark details</h2><p>Everything saved about this bookmark.</p></div><div class="modal-head-actions"><button class="btn bookmark-details-edit" data-action="edit-bookmark" data-id="${escapeHtml(bookmark.id)}">${icon("edit")}Edit</button><button class="close-btn" data-action="close-modal" aria-label="Close bookmark details">${icon("close")}</button></div></div>
    <div class="modal-body bookmark-details-body">
      <div class="bookmark-details-hero">
        <div class="bookmark-details-image">${image ? `<img src="${image}" alt="" referrerpolicy="no-referrer" data-fallback-image />` : fallbackImage(bookmark)}</div>
        <div class="bookmark-details-summary">
          <button class="bookmark-details-site" data-action="open-bookmark" data-id="${escapeHtml(bookmark.id)}" title="Open ${escapeHtml(bookmark.domain)} in your browser">${favicon ? `<img class="favicon" src="${favicon}" alt="" referrerpolicy="no-referrer" />` : ""}<span>${escapeHtml(bookmark.siteName || bookmark.domain)}</span>${icon("external")}</button>
          <h3>${escapeHtml(bookmark.title)}</h3>
          <p>${escapeHtml(bookmark.description || "No description has been saved.")}</p>
          <div class="bookmark-detail-flags"><span>${bookmark.favorite ? icon("star") + " Favorite" : "Not a favorite"}</span><span>${bookmark.archived ? icon("archive") + " Archived" : "In library"}</span></div>
        </div>
      </div>
      <section class="bookmark-detail-section"><h4>Tags</h4><div class="bookmark-detail-tags">${tags}</div></section>
      <section class="bookmark-detail-section"><h4>Personal notes</h4><p class="bookmark-detail-notes">${escapeHtml(bookmark.notes || "No personal notes have been added.")}</p></section>
      <dl class="bookmark-details-grid">
        ${detail("Web address", bookmark.url, "bookmark-detail-wide bookmark-detail-wrap")}
        ${detail("Domain", bookmark.domain)}
        ${detail("Site name", bookmark.siteName)}
        ${detail("Author", bookmark.author)}
        ${detail("Published", bookmark.publishedAt ? fullDateLabel(bookmark.publishedAt) : undefined)}
        <div class="bookmark-detail-item"><dt>Collection</dt><dd>${collection ? `<span class="bookmark-detail-collection"><span class="collection-dot" style="background:${escapeHtml(collection.color)}"></span>${escapeHtml(collection.name)}</span>` : "No collection"}</dd></div>
        ${detail("Times opened", String(bookmark.openCount))}
        ${detail("Added", fullDateLabel(bookmark.createdAt))}
        ${detail("Last updated", fullDateLabel(bookmark.updatedAt))}
        ${detail("Last opened", bookmark.lastOpenedAt ? fullDateLabel(bookmark.lastOpenedAt) : undefined)}
        ${bookmark.imageUrl ? detail("Cover image address", bookmark.imageUrl, "bookmark-detail-wide bookmark-detail-wrap") : ""}
        ${bookmark.faviconUrl ? detail("Favicon address", bookmark.faviconUrl, "bookmark-detail-wide bookmark-detail-wrap") : ""}
      </dl>
    </div>
  </section></div>`;
}

function shareModalHtml(): string {
  const bookmark = snapshot.bookmarks.find((item) => item.id === modal?.id);
  if (!bookmark) return "";
  return `<div class="backdrop"><section class="modal modal-small share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" data-modal-panel>
    <div class="modal-head"><div><h2 id="share-title">Share bookmark</h2><p>Scan the code or copy the saved details.</p></div><button class="close-btn" data-action="close-modal" aria-label="Close sharing">${icon("close")}</button></div>
    <div class="modal-body share-body">
      <div class="share-qr" aria-label="QR code for ${escapeHtml(bookmark.url)}">${modal?.qrDataUrl ? `<img src="${escapeHtml(modal.qrDataUrl)}" alt="QR code for ${escapeHtml(bookmark.title)}" />` : modal?.qrError ? `<span class="share-qr-error">QR code unavailable</span>` : `<span class="spinner"></span>`}</div>
      <div class="share-summary"><strong>${escapeHtml(bookmark.title)}</strong><span>${escapeHtml(bookmark.url)}</span></div>
      <div class="share-actions"><button class="btn" data-action="copy-bookmark-url" data-id="${escapeHtml(bookmark.id)}">${icon("copy")}Copy link</button><button class="btn btn-primary" data-action="copy-bookmark-details" data-id="${escapeHtml(bookmark.id)}">${icon("copy")}Copy details</button></div>
    </div>
  </section></div>`;
}

function bookmarkModalHtml(): string {
  const bookmark = snapshot.bookmarks.find((item) => item.id === modal?.id);
  const selectedCollection = snapshot.collections.find((item) => item.id === bookmark?.collectionId);
  const archiveMode = bookmark?.archive.mode ?? "none";
  const collectionOptions = snapshot.collections.map((item) => `<button type="button" class="collection-option ${selectedCollection?.id === item.id ? "selected" : ""}" data-select-collection="${escapeHtml(item.id)}"><span class="collection-dot" style="background:${escapeHtml(item.color)}"></span><span>${escapeHtml(item.name)}</span>${selectedCollection?.id === item.id ? icon("check") : ""}</button>`).join("");
  return `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel>
    <div class="modal-head"><div><h2 id="modal-title">${bookmark ? "Edit bookmark" : "Add to your shelf"}</h2><p>${bookmark ? "Tidy the details or move it somewhere new." : "Paste a URL and Shelf will fill in the useful bits."}</p></div><button class="close-btn" data-action="close-modal">${icon("close")}</button></div>
    <form id="bookmark-form" class="modal-body">
      <input type="hidden" name="id" value="${escapeHtml(bookmark?.id)}" />
      <input type="hidden" name="imageUrl" value="${escapeHtml(bookmark?.imageUrl)}" /><input type="hidden" name="faviconUrl" value="${escapeHtml(bookmark?.faviconUrl)}" /><input type="hidden" name="siteName" value="${escapeHtml(bookmark?.siteName)}" /><input type="hidden" name="author" value="${escapeHtml(bookmark?.author)}" /><input type="hidden" name="publishedAt" value="${escapeHtml(bookmark?.publishedAt)}" />
      <div class="url-fetch"><div class="field"><label for="bookmark-url">Web address</label><input id="bookmark-url" class="input" name="url" type="text" value="${escapeHtml(bookmark?.url)}" placeholder="example.com/article" required /></div><button type="button" class="btn" data-action="fetch-metadata">${icon("spark")}Fetch details</button></div>
      <div id="fetch-status" class="fetch-status">${bookmark ? "You can fetch again to refresh page details." : "We only contact the page when you ask us to fetch details."}</div>
      <div id="metadata-preview">${bookmark?.imageUrl ? previewHtml({ ...bookmark, imageUrl: bookmark.imageUrl } as MetadataPreview) : ""}</div>
      <div class="form-grid">
        <div class="field field-full"><label for="bookmark-title">Title</label><input id="bookmark-title" class="input" name="title" value="${escapeHtml(bookmark?.title)}" placeholder="Page title" /></div>
        <div class="field field-full"><label for="bookmark-description">Description</label><textarea id="bookmark-description" class="textarea" name="description" placeholder="A short summary of what is here">${escapeHtml(bookmark?.description)}</textarea></div>
        <div class="field"><label id="bookmark-collection-label">Collection</label>
          <div class="collection-picker">
            <input type="hidden" id="bookmark-collection" name="collectionId" value="${escapeHtml(selectedCollection?.id)}" />
            <button type="button" class="collection-trigger" data-action="toggle-collection-picker" aria-labelledby="bookmark-collection-label" aria-haspopup="listbox" aria-expanded="false">
              <span class="collection-choice">${selectedCollection ? `<span class="collection-dot" style="background:${escapeHtml(selectedCollection.color)}"></span><span>${escapeHtml(selectedCollection.name)}</span>` : `${icon("folder")}<span>No collection</span>`}</span>${icon("chevron", "picker-chevron")}
            </button>
            <div class="collection-options" id="collection-options" role="listbox" hidden>
              <button type="button" class="collection-option ${selectedCollection ? "" : "selected"}" data-select-collection="">${icon("folder")}<span>No collection</span>${selectedCollection ? "" : icon("check")}</button>
              ${collectionOptions || `<div class="collection-picker-empty">Create a collection from the sidebar first.</div>`}
            </div>
          </div>
        </div>
        <div class="field"><label>Tags</label>${tagEditorHtml(bookmark?.tags ?? [])}<div class="field-hint">Type a tag, then press Enter or comma</div></div>
        <div class="field field-full"><label for="bookmark-notes">Personal notes</label><textarea id="bookmark-notes" class="textarea" name="notes" placeholder="Why did you save this? A quote, an idea, a reminder…">${escapeHtml(bookmark?.notes)}</textarea></div>
        <div class="field field-full archive-choice"><label class="offline-copy-toggle" for="bookmark-save-offline-copy"><span>Save Offline Copy</span><input id="bookmark-save-offline-copy" type="checkbox" name="saveOfflineCopy" role="switch" ${archiveMode !== "none" ? "checked" : ""} /><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span></label><div class="field-hint">Shelf saves the raw HTML copy in its archive folder.</div></div>
        <div class="field-full check-row"><label class="check-label"><input type="checkbox" name="favorite" ${bookmark?.favorite ? "checked" : ""}/> Favorite</label><label class="check-label"><input type="checkbox" name="archived" ${bookmark?.archived ? "checked" : ""}/> Archived</label></div>
      </div>
      <div class="modal-actions">${bookmark ? `<button type="button" class="btn btn-ghost btn-danger" data-action="delete-bookmark" data-id="${escapeHtml(bookmark.id)}">${icon("trash")}Delete</button>` : ""}<div class="actions-right"><button type="button" class="btn" data-action="close-modal">Cancel</button><button id="save-bookmark-button" type="submit" class="btn btn-primary">${icon("check")}Save bookmark</button></div></div>
    </form>
  </div></div>`;
}

function tagEditorHtml(tags: string[]): string {
  return `<div class="tag-editor" id="tag-editor" data-tags="${escapeHtml(JSON.stringify(tags))}"><div id="selected-tags">${tags.map(selectedTagHtml).join("")}</div><input id="tag-input" class="tag-input" placeholder="Add tags…" autocomplete="off" /><div id="tag-suggestions"></div></div>`;
}

function selectedTagHtml(tag: string): string {
  return `<span class="selected-tag" data-selected-tag="${escapeHtml(tag)}">${escapeHtml(tag)}<button type="button" data-remove-tag="${escapeHtml(tag)}">${icon("close")}</button></span>`;
}

function previewHtml(metadata: MetadataPreview): string {
  const image = safeImage(metadata.imageUrl);
  return `<div class="metadata-preview">${image ? `<img src="${image}" alt="" referrerpolicy="no-referrer" />` : `<div class="image-fallback"><span>${escapeHtml(metadata.domain?.[0]?.toUpperCase() || "S")}</span></div>`}<div class="metadata-copy"><strong>${escapeHtml(metadata.title)}</strong><span>${escapeHtml(metadata.description || metadata.domain)}</span></div></div>`;
}

function collectionModalHtml(): string {
  const item = snapshot.collections.find((collection) => collection.id === modal?.id);
  const colors = ["#e46f4b", "#c38b37", "#788b6b", "#9a6f5b", "#a14e44", "#716a62"];
  const selected = item?.color ?? colors[0];
  return `<div class="backdrop"><div class="modal modal-small" data-modal-panel><div class="modal-head"><div><h2>${item ? "Edit collection" : "New collection"}</h2><p>Give related bookmarks a place of their own.</p></div><button class="close-btn" data-action="close-modal">${icon("close")}</button></div><form id="collection-form" class="modal-body"><input type="hidden" name="id" value="${escapeHtml(item?.id)}"/><input type="hidden" id="collection-color" name="color" value="${escapeHtml(selected)}"/><div class="field"><label for="collection-name">Collection name</label><input id="collection-name" class="input" name="name" value="${escapeHtml(item?.name)}" placeholder="Reading list" required /></div><div class="field" style="margin-top:17px"><label>Color</label><div class="color-row">${colors.map((color) => `<button type="button" class="color-swatch ${color === selected ? "active" : ""}" style="background:${color}" data-color="${color}" aria-label="Use color ${color}"></button>`).join("")}</div></div><div class="modal-actions">${item ? `<button type="button" class="btn btn-ghost btn-danger" data-action="delete-collection" data-id="${escapeHtml(item.id)}">${icon("trash")}Delete</button>` : ""}<div class="actions-right"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Save collection</button></div></div></form></div></div>`;
}

function savedQueryModalHtml(): string {
  const item = snapshot.savedQueries.find((savedQuery) => savedQuery.id === modal?.id);
  const query = item?.query ?? filters.query;
  return `<div class="backdrop"><div class="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="saved-query-title" data-modal-panel><div class="modal-head"><div><h2 id="saved-query-title">${item ? "Edit saved query" : "Save query"}</h2><p>Run this search again later against the latest bookmarks.</p></div><button class="close-btn" data-action="close-modal" aria-label="Close saved query">${icon("close")}</button></div><form id="saved-query-form" class="modal-body"><input type="hidden" name="id" value="${escapeHtml(item?.id)}"/><div class="field"><label for="saved-query-name">Name</label><input id="saved-query-name" class="input" name="name" value="${escapeHtml(item?.name)}" placeholder="Rust tutorials" maxlength="100" required /></div><div class="field" style="margin-top:17px"><label for="saved-query-text">Query</label><input id="saved-query-text" class="input" name="query" value="${escapeHtml(query)}" placeholder="#rust AND tutorial -video" maxlength="2000" required /><div class="field-hint">Supports AND, OR, parentheses, #tags, and -term exclusions.</div></div><div id="saved-query-status" class="fetch-status"></div><div class="modal-actions">${item ? `<button type="button" class="btn btn-ghost btn-danger" data-action="delete-saved-query" data-id="${escapeHtml(item.id)}">${icon("trash")}Delete</button>` : ""}<div class="actions-right"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${icon("check")}Save query</button></div></div></form></div></div>`;
}

function moveSearchModalHtml(): string {
  const count = modal?.ids?.length ?? 0;
  const options = snapshot.collections
    .map((collection) => `<button type="button" class="collection-option" data-select-move-collection="${escapeHtml(collection.id)}" role="option" aria-selected="false"><span class="collection-dot" style="background:${escapeHtml(collection.color)}"></span><span>${escapeHtml(collection.name)}</span></button>`)
    .join("");
  return `<div class="backdrop"><div class="modal modal-small" data-modal-panel><div class="modal-head"><div><h2 id="modal-title">Move search results</h2><p>Choose one collection for all ${count} matching ${count === 1 ? "bookmark" : "bookmarks"}.</p></div><button class="close-btn" data-action="close-modal">${icon("close")}</button></div><form id="move-search-form" class="modal-body"><div class="field"><label id="move-search-collection-label">Destination collection</label><div class="collection-picker move-search-picker"><input type="hidden" id="move-search-collection" name="collectionId" value="" /><button type="button" class="collection-trigger move-search-trigger" data-action="toggle-move-search-picker" aria-labelledby="move-search-collection-label" aria-haspopup="listbox" aria-controls="move-search-options" aria-expanded="false"><span class="collection-choice">${icon("folder")}<span>Choose a collection…</span></span>${icon("chevron", "picker-chevron")}</button><div class="collection-options" id="move-search-options" role="listbox" hidden>${options}<button type="button" class="collection-option" data-select-move-collection="__none__" role="option" aria-selected="false">${icon("folder")}<span>No collection</span></button></div></div><div class="field-hint">Bookmarks already in the destination will be left unchanged.</div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button id="move-search-submit" class="btn btn-primary" type="submit" disabled>${icon("folder")}Move ${count} ${count === 1 ? "bookmark" : "bookmarks"}</button></div></form></div></div>`;
}

function tagRenameModalHtml(): string {
  const selected = snapshot.tags[0];
  const options = snapshot.tags.map((tag, index) => `<button type="button" class="collection-option ${index === 0 ? "selected" : ""}" data-select-rename-tag="${escapeHtml(tag.name)}" role="option" aria-selected="${index === 0}">${icon("tag")}<span>${escapeHtml(tag.name)}</span><span class="tag-rename-count">${tag.count}</span>${index === 0 ? icon("check") : ""}</button>`).join("");
  return `<div class="backdrop"><div class="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="tag-rename-title" data-modal-panel>
    <div class="modal-head"><div><h2 id="tag-rename-title">Rename tag</h2><p>Update a tag everywhere it appears in your bookmarks.</p></div><button class="close-btn" data-action="close-modal" aria-label="Close tag rename">${icon("close")}</button></div>
    <form id="tag-rename-form" class="modal-body">
      ${selected ? `<div class="field"><label id="tag-rename-existing-label">Existing tag</label>
        <div class="tag-rename-picker">
          <input type="hidden" id="tag-rename-existing" name="oldName" value="${escapeHtml(selected.name)}" />
          <button type="button" class="collection-trigger tag-rename-trigger" data-action="toggle-tag-rename-picker" aria-labelledby="tag-rename-existing-label" aria-haspopup="listbox" aria-controls="tag-rename-list" aria-expanded="false"><span class="collection-choice">${icon("tag")}<span>${escapeHtml(selected.name)}</span></span>${icon("chevron", "picker-chevron")}</button>
          <div class="collection-options tag-rename-options" id="tag-rename-options" hidden>
            <div class="tag-rename-search">${icon("search")}<input id="tag-rename-search" type="search" placeholder="Search tags…" autocomplete="off" aria-label="Search existing tags" /></div>
            <div class="tag-rename-list" id="tag-rename-list" role="listbox">${options}</div>
            <div class="tag-rename-empty" id="tag-rename-empty" hidden>No matching tags</div>
          </div>
        </div>
      </div>
      <div class="field tag-rename-new-name"><label for="tag-rename-name">New tag name</label><input id="tag-rename-name" class="input" name="newName" placeholder="New tag name" autocomplete="off" required /></div>
      <div id="tag-rename-status" class="fetch-status">The new name will be normalized and duplicate tags will be combined.</div>` : `<div class="empty-form-state">Add a tag to a bookmark before renaming tags.</div>`}
      <div class="modal-actions"><div></div><div class="actions-right"><button type="button" class="btn" data-action="close-modal">Cancel</button><button id="rename-tag-button" class="btn btn-primary" type="submit" ${selected ? "" : "disabled"}>${icon("check")}Done</button></div></div>
    </form>
  </div></div>`;
}

function settingsModalHtml(): string {
  const configured = security.passwordConfigured;
  const securityBusy = securityOperation !== null;
  const tabButton = (tab: SettingsTab, label: string, iconName: string) =>
    `<button type="button" class="settings-tab ${settingsTab === tab ? "active" : ""}" role="tab" aria-selected="${settingsTab === tab}" data-action="settings-tab" data-tab="${tab}">${icon(iconName)}<span>${label}</span></button>`;
  const importerLabel = csvImporter === "native" ? "Shelf CSV" : csvImporter === "raindrop" ? "Raindrop.io" : "Choose a source";
  const importFormat = csvImporter === "native"
    ? `<div class="import-format"><strong>Accepted format</strong><span>Shelf CSV or another <code>.csv</code> with a <code>url</code>, <code>link</code>, or <code>uri</code> column. Shelf also recognizes title, description, tags, collection, notes, image, favorite, archive, timestamps, and visit count fields.</span></div>`
    : csvImporter === "raindrop"
      ? `<div class="import-format"><strong>Accepted format</strong><span>A Raindrop.io <code>.csv</code> export with title, excerpt, URL, created time, and favorite columns. Notes, tags, and cover images are imported when present; highlights and unknown columns are ignored.</span></div>`
      : "";
  const validationIssues = csvImportValidation?.errors.slice(0, 8).map((issue) => `<li><strong>${issue.row ? `Row ${issue.row}` : "File"}</strong><span>${escapeHtml(issue.message)}</span></li>`).join("") ?? "";
  const validationPanel = csvImportValidation ? `<div class="import-validation ${csvImportValidation.errorCount ? "has-errors" : "is-valid"}" role="status">
      <div class="import-validation-summary">${icon(csvImportValidation.errorCount ? "close" : "check")}<div><strong>${csvImportValidation.errorCount ? `${csvImportValidation.errorCount} ${csvImportValidation.errorCount === 1 ? "error" : "errors"} found` : "Ready to import"}</strong><span>${csvImportValidation.validRows} valid of ${csvImportValidation.totalRows} rows${csvImportValidation.invalidRows ? ` · ${csvImportValidation.invalidRows} will be skipped` : ""}</span></div></div>
      ${validationIssues ? `<ul class="import-errors">${validationIssues}</ul>` : ""}
      ${csvImportValidation.errorCount > csvImportValidation.errors.slice(0, 8).length ? `<div class="field-hint">Showing the first 8 errors.</div>` : ""}
      <div class="import-validation-actions"><button type="button" class="btn" data-action="cancel-csv-import" ${csvImportBusy ? "disabled" : ""}>Stop import</button>${csvImportValidation.validRows > 0 ? `<button type="button" class="btn btn-primary" data-action="continue-csv-import" ${csvImportBusy ? "disabled" : ""}>${csvImportBusy ? `<span class="spinner spinner-light"></span>Importing…` : `${icon("upload")}Import ${csvImportValidation.validRows} valid rows`}</button>` : ""}</div>
    </div>` : "";
  const importControls = csvImporter ? `<div class="import-source-details">${importFormat}${validationPanel || `<button type="button" class="btn btn-primary import-file-button" data-action="choose-csv-import" ${csvImportBusy ? "disabled" : ""}>${csvImportBusy ? `<span class="spinner spinner-light"></span>Validating…` : `${icon("upload")}Import ${escapeHtml(importerLabel)} CSV`}</button>`}</div>` : "";

  const scaleIndex = INTERFACE_SCALE_LEVELS.indexOf(interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const shortcutKey = platform === "macos" ? "Command" : "Ctrl";
  const appearancePanel = `<section class="settings-panel" role="tabpanel" aria-label="Appearance">
    <div class="storage-heading">${icon("sliders")}<div><strong>Interface scale</strong><span>Make all text, controls, and bookmark cards larger on HiDPI displays.</span></div></div>
    <div class="interface-scale-setting">
      <div><strong>Scale</strong><span>${shortcutKey} +/− to adjust · ${shortcutKey} 0 to reset</span></div>
      <div class="interface-scale-control" role="group" aria-label="Interface scale">
        <button type="button" class="btn btn-icon" data-action="interface-scale-decrease" aria-label="Decrease interface scale" title="Decrease interface scale" ${scaleIndex <= 0 ? "disabled" : ""}>${icon("minus")}</button>
        <output id="interface-scale-value" aria-live="polite">${Math.round(interfaceScale * 100)}%</output>
        <button type="button" class="btn btn-icon" data-action="interface-scale-increase" aria-label="Increase interface scale" title="Increase interface scale" ${scaleIndex >= INTERFACE_SCALE_LEVELS.length - 1 ? "disabled" : ""}>${icon("plus")}</button>
        <button type="button" class="btn" data-action="interface-scale-reset" ${interfaceScale === DEFAULT_INTERFACE_SCALE ? "disabled" : ""}>Reset</button>
      </div>
    </div>
    <div class="modal-actions"><div class="field-hint">Saved on this device and restored when Shelf starts.</div><button class="btn" data-action="close-modal">Done</button></div>
  </section>`;

  const securityPanel = `<section class="settings-panel" role="tabpanel" aria-label="App lock">
    <form id="security-form">
      <div class="storage-heading">${icon("lock")}<div><strong>${configured ? "App lock is on" : "Protect Shelf with an app lock"}</strong><span>${configured ? "Shelf requires your password after it locks." : "Add a password to keep the app private when you step away."}</span></div></div>
      ${configured ? `<div class="field"><label for="security-current-password">Current password</label><input id="security-current-password" class="input" name="currentPassword" type="password" autocomplete="current-password" required /></div>` : ""}
      <div class="field" style="margin-top:14px"><label for="security-new-password">${configured ? "New password" : "Password"}</label><input id="security-new-password" class="input" name="newPassword" type="password" autocomplete="new-password" ${configured ? "" : "required"} minlength="8" /><div class="field-hint">${configured ? "Leave blank to keep your current password." : "Use at least 8 characters."}</div></div>
      <div class="field" style="margin-top:14px"><label for="security-confirm-password">${configured ? "Confirm new password" : "Confirm password"}</label><input id="security-confirm-password" class="input" name="confirmPassword" type="password" autocomplete="new-password" ${configured ? "" : "required"} minlength="8" /></div>
      <div class="field" style="margin-top:14px"><label for="security-timeout">Lock after inactivity</label><div class="timeout-input"><input id="security-timeout" class="input" name="timeoutMinutes" type="number" min="1" max="1440" step="1" value="${escapeHtml(security.timeoutMinutes)}" required /><span>minutes</span></div><div class="field-hint">Keyboard, clicks, scrolling, and touch count as activity.</div></div>
      <div id="security-status" class="fetch-status" aria-live="polite">${securityBusy ? `<span class="spinner"></span>Saving app-lock settings…` : ""}</div>
      <div class="modal-actions security-actions"><div class="actions-left">${configured ? `<button type="button" class="btn btn-ghost btn-danger" data-action="remove-password" ${securityBusy ? "disabled" : ""}>${icon("trash")}Remove app lock</button>` : ""}</div><div class="actions-right">${configured ? `<button type="button" class="btn" data-action="lock-now" ${locking || securityBusy ? "disabled" : ""}>${icon("lock")}Lock now</button>` : ""}<button type="submit" class="btn btn-primary" id="save-security-button" ${securityBusy ? "disabled" : ""}>${icon("check")}${configured ? "Save app lock" : "Enable app lock"}</button></div></div>
    </form>
  </section>`;

  const storagePanel = `<section class="settings-panel" role="tabpanel" aria-label="Data storage">
    <form id="storage-form" class="storage-form">
      <div class="storage-heading">${icon("folder")}<div><strong>Library storage</strong><span>Choose where Shelf keeps its SQLite database and saved page folders.</span></div></div>
      <div class="field"><label for="storage-directory">Folder</label><div class="storage-folder-row"><input id="storage-directory" class="input" name="directory" value="${escapeHtml(snapshot.dataDirectory)}" readonly /><button type="button" class="btn" data-action="choose-storage-directory">Choose…</button></div></div>
      <div class="field" style="margin-top:14px"><label for="storage-file-name">File name</label><input id="storage-file-name" class="input" name="fileName" value="${escapeHtml(snapshot.dataFileName)}" placeholder="shelf.sqlite3" /><div class="field-hint">A .sqlite3 extension is added automatically. Changing this copies your current library and uses the new database from then on.</div></div>
      <button id="save-storage-button" type="submit" class="btn storage-save-button">${icon("check")}Save storage location</button>
      <div id="storage-status" class="fetch-status"></div>
    </form>
    <div class="modal-actions"><div class="field-hint">${snapshot.bookmarks.length} bookmarks · ${snapshot.collections.length} collections · format v${snapshot.version}<br/>Archives: ${escapeHtml(snapshot.archiveDirectory)}</div><button class="btn" data-action="close-modal">Done</button></div>
  </section>`;

  const transferPanel = `<section class="settings-panel" role="tabpanel" aria-label="Import and export">
    <div class="storage-heading">${icon("upload")}<div><strong>Import bookmarks</strong><span>Validate a CSV from Shelf or another supported service before changing your library.</span></div></div>
    <div class="field"><label id="import-source-label">Import from</label><div class="collection-picker import-source-picker">
      <button type="button" class="collection-trigger" data-action="toggle-importer-picker" aria-labelledby="import-source-label" aria-haspopup="listbox" aria-expanded="false"><span class="collection-choice">${icon("download")}<span>${escapeHtml(importerLabel)}</span></span>${icon("chevron", "picker-chevron")}</button>
      <div class="collection-options" id="import-source-options" role="listbox" hidden>
        <button type="button" class="collection-option ${csvImporter === "native" ? "selected" : ""}" data-importer="native"><span>Shelf CSV</span>${csvImporter === "native" ? icon("check") : ""}</button>
        <button type="button" class="collection-option ${csvImporter === "raindrop" ? "selected" : ""}" data-importer="raindrop"><span>Raindrop.io</span>${csvImporter === "raindrop" ? icon("check") : ""}</button>
      </div>
    </div></div>
    ${importControls}
    <div class="export-row"><div><strong>Export Shelf CSV</strong><span>Save a portable copy with bookmark metadata and organization.</span></div><button class="btn" data-action="export">${icon("download")}Export CSV</button></div>
    <div class="modal-actions"><div class="field-hint">${snapshot.bookmarks.length} bookmarks available to export</div><button class="btn" data-action="close-modal">Done</button></div>
  </section>`;

  const apiPanel = `<section class="settings-panel" role="tabpanel" aria-label="API server">
    <form id="api-server-form">
      <div class="storage-heading">${icon("server")}<div><strong>HTTP API server</strong><span>Connect scripts and other tools to the same Shelf library.</span></div></div>
      <label class="offline-copy-toggle api-enable-toggle" for="api-server-enabled"><span><strong>Enable API server</strong><small>${apiServer.running ? "Running now" : apiServer.enabled ? "Configured, but not running" : "Off by default"}</small></span><input id="api-server-enabled" type="checkbox" name="enabled" role="switch" ${apiServer.enabled ? "checked" : ""} ${apiServerSaving ? "disabled" : ""}/><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span></label>
      <div class="api-address-grid">
        <div class="field"><label for="api-server-interface">Bind interface</label><input id="api-server-interface" class="input" name="interface" value="${escapeHtml(apiServer.interface)}" placeholder="localhost" required /><div class="field-hint">Use localhost for access from this computer only.</div></div>
        <div class="field"><label for="api-server-port">Port</label><input id="api-server-port" class="input" name="port" type="number" min="1" max="65535" step="1" value="${escapeHtml(apiServer.port)}" required /></div>
      </div>
      <div class="api-endpoint"><span class="api-status-dot ${apiServer.running ? "running" : ""}"></span><div><strong>${apiServer.running ? "Listening at" : "Endpoint"}</strong><code>${escapeHtml(apiServer.url)}/api/v1</code></div></div>
      <div class="api-warning">${icon("lock")}<span>The API has no authentication. Keep it on <strong>localhost</strong> unless you trust every device and user on the network. Shelf's app lock still blocks library operations while locked.</span></div>
      <div id="api-server-status" class="fetch-status ${apiServer.error ? "error" : ""}" aria-live="polite">${apiServerSaving ? `<span class="spinner"></span>Applying API server settings…` : escapeHtml(apiServer.error || "")}</div>
      <div class="modal-actions"><div class="field-hint">JSON over HTTP · API version v1</div><button id="save-api-server-button" type="submit" class="btn btn-primary" ${apiServerSaving ? "disabled" : ""}>${icon("check")}Save API settings</button></div>
    </form>
  </section>`;

  const miscPanel = `<section class="settings-panel" role="tabpanel" aria-label="Miscellaneous">
    <form id="misc-form">
      <div class="storage-heading">${icon("sliders")}<div><strong>Page fetching</strong><span>Control how Shelf downloads pages when it extracts details and saves copies.</span></div></div>
      <div class="misc-fetch-grid">
        <div class="field"><label for="misc-max-metadata">Maximum page size</label><input id="misc-max-metadata" class="input" name="maxMetadataMb" type="number" min="1" max="100" step="1" value="${escapeHtml(String(Math.round(miscellaneous.maxMetadataBytes / 1_000_000)))}" required /><div class="field-hint">Between 1 and 100 MB. Larger pages are rejected when fetching details.</div></div>
        <div class="field"><label for="misc-timeout">Request timeout</label><div class="timeout-input"><input id="misc-timeout" class="input" name="timeoutSecs" type="number" min="5" max="600" step="1" value="${escapeHtml(String(miscellaneous.requestTimeoutSecs))}" required /><span>seconds</span></div><div class="field-hint">Between 5 and 600 seconds.</div></div>
      </div>
      <div id="misc-status" class="fetch-status" aria-live="polite">${miscSaving ? `<span class="spinner"></span>Saving fetching settings…` : ""}</div>
      <div class="modal-actions"><div class="field-hint">Applies to metadata extraction, saved copies, and API fetches. Default: 10 MB · 30 seconds.</div><button id="save-misc-button" type="submit" class="btn btn-primary" ${miscSaving ? "disabled" : ""}>${icon("check")}Save fetching settings</button></div>
    </form>
  </section>`;

  return `<div class="backdrop"><div class="modal modal-small settings-modal" data-modal-panel><div class="modal-head"><div><h2>Settings</h2><p>Configure Shelf to fit the way you work.</p></div><button class="close-btn" data-action="close-modal">${icon("close")}</button></div>
    <div class="settings-tabs" role="tablist" aria-label="Settings sections">${tabButton("appearance", "Appearance", "sliders")}${tabButton("security", "App lock", "lock")}${tabButton("api", "API", "server")}${tabButton("storage", "Storage", "folder")}${tabButton("transfer", "Import / export", "upload")}${tabButton("misc", "Miscellaneous", "sliders")}</div>
    <div class="modal-body settings-body">${settingsTab === "appearance" ? appearancePanel : settingsTab === "security" ? securityPanel : settingsTab === "api" ? apiPanel : settingsTab === "storage" ? storagePanel : settingsTab === "transfer" ? transferPanel : miscPanel}</div>
  </div></div>`;
}

function archiveModalHtml(): string {
  const title = modal?.title || "Saved HTML";
  return `<div class="backdrop archive-viewer-backdrop"><section class="modal archive-viewer-modal" role="dialog" aria-modal="true" aria-labelledby="archive-viewer-title" data-modal-panel>
    <div class="modal-head"><div><h2 id="archive-viewer-title">${escapeHtml(title)}</h2><p>Saved raw HTML rendered inside Shelf</p></div><div class="modal-head-actions"><button class="btn archive-export-btn" data-action="export-archive" data-id="${escapeHtml(modal?.id)}" title="Export saved copy">${icon("download")}<span>Export</span></button><button class="close-btn" data-action="close-modal" aria-label="Close saved HTML">${icon("close")}</button></div></div>
    <div class="archive-viewer-body"><iframe id="archive-viewer-frame" class="archive-viewer-frame" sandbox="" title="${escapeHtml(title)}"></iframe></div>
  </section></div>`;
}

function modalHtml(): string {
  if (modal?.kind === "bookmark-details") return bookmarkDetailsModalHtml();
  if (modal?.kind === "bookmark") return bookmarkModalHtml();
  if (modal?.kind === "collection") return collectionModalHtml();
  if (modal?.kind === "saved-query") return savedQueryModalHtml();
  if (modal?.kind === "tag-rename") return tagRenameModalHtml();
  if (modal?.kind === "move-search") return moveSearchModalHtml();
  if (modal?.kind === "archive") return archiveModalHtml();
  if (modal?.kind === "share") return shareModalHtml();
  return settingsModalHtml();
}

function filterTagRenameOptions(rawQuery: string): void {
  const query = rawQuery.trim().replace(/^#+/, "").toLocaleLowerCase();
  let visibleCount = 0;
  document.querySelectorAll<HTMLElement>("[data-select-rename-tag]").forEach((option) => {
    const name = option.dataset.selectRenameTag?.toLocaleLowerCase() ?? "";
    const visible = !query || name.includes(query);
    option.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  const empty = document.querySelector<HTMLElement>("#tag-rename-empty");
  if (empty) empty.hidden = visibleCount > 0;
}

function toast(title: string, message: string, error = false): void {
  let stack = document.querySelector<HTMLDivElement>("#toast-stack");
  if (!stack) {
    document.body.insertAdjacentHTML("beforeend", `<div class="toast-stack" id="toast-stack"></div>`);
    stack = document.querySelector<HTMLDivElement>("#toast-stack");
  }
  const item = document.createElement("div");
  item.className = `toast ${error ? "error" : ""}`;
  item.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
  stack?.append(item);
  setTimeout(() => item.remove(), 3900);
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something unexpected happened";
}

function syncInterfaceScaleControls(): void {
  const currentIndex = INTERFACE_SCALE_LEVELS.indexOf(interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const value = document.querySelector<HTMLOutputElement>("#interface-scale-value");
  const decrease = document.querySelector<HTMLButtonElement>("[data-action='interface-scale-decrease']");
  const increase = document.querySelector<HTMLButtonElement>("[data-action='interface-scale-increase']");
  const reset = document.querySelector<HTMLButtonElement>("[data-action='interface-scale-reset']");
  if (value) value.textContent = `${Math.round(interfaceScale * 100)}%`;
  if (decrease) decrease.disabled = currentIndex <= 0;
  if (increase) increase.disabled = currentIndex >= INTERFACE_SCALE_LEVELS.length - 1;
  if (reset) reset.disabled = interfaceScale === DEFAULT_INTERFACE_SCALE;
}

async function setInterfaceScale(scale: number, announce = true): Promise<void> {
  if (!INTERFACE_SCALE_LEVELS.includes(scale as typeof INTERFACE_SCALE_LEVELS[number])) return;
  try {
    await appWebview.setZoom(scale);
    interfaceScale = scale;
    localStorage.setItem("shelf-interface-scale", String(scale));
    syncInterfaceScaleControls();
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => bookmarkVirtualizer?.refresh()));
    if (announce) toast("Interface scale updated", `${Math.round(scale * 100)}%`);
  } catch (error) {
    if (announce) toast("Could not change interface scale", errorMessage(error), true);
  }
}

async function stepInterfaceScale(direction: -1 | 1): Promise<void> {
  const currentIndex = INTERFACE_SCALE_LEVELS.indexOf(interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const nextIndex = Math.max(0, Math.min(INTERFACE_SCALE_LEVELS.length - 1, currentIndex + direction));
  if (nextIndex === currentIndex) return;
  await setInterfaceScale(INTERFACE_SCALE_LEVELS[nextIndex]);
}

async function refreshSnapshot(): Promise<void> {
  const generation = sessionGeneration;
  const nextSnapshot = await invoke<AppSnapshot>("get_snapshot");
  if (!acceptSnapshot(nextSnapshot, generation)) return;
  loading = false;
  render();
  if (snapshot.pendingArchives.length) void processPendingArchives();
}

async function refreshSnapshotAfterApiChange(): Promise<void> {
  if (locked || loading) return;
  const generation = sessionGeneration;
  const snapshotBeforeRefresh = snapshot;
  const nextSnapshot = await invoke<AppSnapshot>("get_snapshot");
  if (snapshot !== snapshotBeforeRefresh) return;
  if (!acceptSnapshot(nextSnapshot, generation)) return;
  if (!modal) render(document.activeElement?.id === "global-search");
  if (snapshot.pendingArchives.length) void processPendingArchives();
}

function scheduleApiSnapshotRefresh(): void {
  if (apiRefreshTimer !== undefined) window.clearTimeout(apiRefreshTimer);
  apiRefreshTimer = window.setTimeout(() => {
    apiRefreshTimer = undefined;
    void refreshSnapshotAfterApiChange().catch((error) => {
      if (!locked) console.error("Could not refresh Shelf after an API change", error);
    });
  }, API_REFRESH_DELAY_MS);
}

async function installApiChangeListener(): Promise<void> {
  try {
    await listen(API_LIBRARY_CHANGED_EVENT, scheduleApiSnapshotRefresh);
  } catch {
    // The browser preview does not expose native Tauri events.
  }
}

async function initializeShelf(): Promise<void> {
  [security, apiServer, miscellaneous] = await Promise.all([
    invoke<SecurityStatus>("get_security_status"),
    invoke<ApiServerStatus>("get_api_server_status"),
    invoke<MiscellaneousStatus>("get_miscellaneous_status"),
  ]);
  locked = security.passwordConfigured && security.locked;
  loading = false;
  if (locked) {
    render();
    setTimeout(() => document.querySelector<HTMLInputElement>("#unlock-password")?.focus(), 0);
    return;
  }
  await refreshSnapshot();
  if (security.passwordConfigured) {
    lastInteractionAt = Date.now();
    scheduleInactivityLock();
  }
}

async function processPendingArchives(completion?: { id: string; mode: ArchiveMode }): Promise<void> {
  const generation = sessionGeneration;
  try {
    const nextSnapshot = await invoke<AppSnapshot>("process_pending_archives");
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    if (!modal) render();
    if (completion && !snapshot.pendingArchives.some((item) => item.id === completion.id)) {
      const bookmark = snapshot.bookmarks.find((item) => item.id === completion.id);
      toast("Saved copy ready", `${bookmark?.title || "Bookmark"} · ${archiveModeLabel(completion.mode)}`);
    }
  } catch (error) {
    if (completion) toast("Could not save copy in background", errorMessage(error), true);
  }
}

function activeTags(): string[] {
  const editor = document.querySelector<HTMLElement>("#tag-editor");
  try { return JSON.parse(editor?.dataset.tags ?? "[]") as string[]; } catch { return []; }
}

function setActiveTags(tags: string[]): void {
  const editor = document.querySelector<HTMLElement>("#tag-editor");
  const selected = document.querySelector<HTMLElement>("#selected-tags");
  if (editor) editor.dataset.tags = JSON.stringify(tags);
  if (selected) selected.innerHTML = tags.map(selectedTagHtml).join("");
}

function addTag(raw: string): void {
  const tag = raw.trim().replace(/^#/, "").toLocaleLowerCase();
  if (!tag) return;
  const tags = activeTags();
  if (!tags.includes(tag)) tags.push(tag);
  setActiveTags(tags);
  const input = document.querySelector<HTMLInputElement>("#tag-input");
  if (input) input.value = "";
  showTagSuggestions("");
}

function showTagSuggestions(query: string): void {
  const holder = document.querySelector<HTMLElement>("#tag-suggestions");
  if (!holder) return;
  const current = activeTags();
  const suggestions = snapshot.tags
    .filter((tag) => !current.includes(tag.name) && (!query || fuzzyPartScore(tag.name, query) > 0))
    .slice(0, 7);
  const create = query.trim() && !current.includes(query.trim().toLowerCase()) && !snapshot.tags.some((tag) => tag.name === query.trim().toLowerCase());
  holder.innerHTML = suggestions.length || create ? `<div class="tag-suggestions">${suggestions.map((tag, index) => `<button type="button" class="${index === 0 ? "active" : ""}" data-add-tag="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}<span>${tag.count}</span></button>`).join("")}${create ? `<button type="button" data-add-tag="${escapeHtml(query)}">Create “${escapeHtml(query)}”<span>↵</span></button>` : ""}</div>` : "";
}

function hideTagSuggestions(): void {
  const holder = document.querySelector<HTMLElement>("#tag-suggestions");
  if (holder) holder.innerHTML = "";
}

function tagSuggestionsOpen(): boolean {
  return Boolean(document.querySelector<HTMLElement>("#tag-suggestions > .tag-suggestions"));
}

async function fetchMetadata(): Promise<void> {
  const url = document.querySelector<HTMLInputElement>("#bookmark-url")?.value.trim();
  const button = document.querySelector<HTMLButtonElement>('[data-action="fetch-metadata"]');
  const status = document.querySelector<HTMLElement>("#fetch-status");
  if (!url) { document.querySelector<HTMLInputElement>("#bookmark-url")?.focus(); return; }
  if (button) button.disabled = true;
  if (status) { status.className = "fetch-status"; status.innerHTML = `<span class="spinner"></span>Reading the page…`; }
  try {
    const metadata = await invoke<MetadataPreview>("fetch_metadata", { rawUrl: url });
    const values: Record<string, string | undefined> = {
      url: metadata.url, title: metadata.title, description: metadata.description,
      imageUrl: metadata.imageUrl, faviconUrl: metadata.faviconUrl, siteName: metadata.siteName,
      author: metadata.author, publishedAt: metadata.publishedAt,
    };
    for (const [name, value] of Object.entries(values)) {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
      if (field && value) field.value = value;
    }
    const preview = document.querySelector<HTMLElement>("#metadata-preview");
    if (preview) preview.innerHTML = previewHtml(metadata);
    if (status) { status.className = "fetch-status success"; status.innerHTML = `${icon("check")}Details found — adjust anything before saving.`; }
  } catch (error) {
    if (status) { status.className = "fetch-status error"; status.textContent = errorMessage(error); }
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveBookmark(form: HTMLFormElement): Promise<void> {
  const generation = sessionGeneration;
  const data = new FormData(form);
  const draft: BookmarkDraft = {
    id: String(data.get("id") || "") || undefined,
    url: String(data.get("url") || ""),
    title: String(data.get("title") || "") || undefined,
    description: String(data.get("description") || "") || undefined,
    imageUrl: String(data.get("imageUrl") || "") || undefined,
    faviconUrl: String(data.get("faviconUrl") || "") || undefined,
    siteName: String(data.get("siteName") || "") || undefined,
    author: String(data.get("author") || "") || undefined,
    publishedAt: String(data.get("publishedAt") || "") || undefined,
    tags: activeTags(),
    collectionId: String(data.get("collectionId") || "") || undefined,
    favorite: data.get("favorite") === "on",
    archived: data.get("archived") === "on",
    notes: String(data.get("notes") || "") || undefined,
    archiveMode: data.get("saveOfflineCopy") === "on" ? "html" : "none",
  };
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = document.querySelector<HTMLElement>("#fetch-status");
  if (submit) {
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner spinner-light"></span>Saving…`;
  }
  try {
    if (status) {
      status.className = "fetch-status";
      status.innerHTML = `<span class="spinner"></span>Writing bookmark to your library…`;
    }
    const existingIds = new Set(snapshot.bookmarks.map((bookmark) => bookmark.id));
    const nextSnapshot = await invoke<AppSnapshot>("save_bookmark", { draft });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    const saved = draft.id
      ? snapshot.bookmarks.find((bookmark) => bookmark.id === draft.id)
      : snapshot.bookmarks.find((bookmark) => !existingIds.has(bookmark.id));
    const shouldEnrich = Boolean(!draft.id && !draft.title?.trim() && saved);
    modal = null;
    render();
    const bookmarkLabel = saved?.title || draft.title || draft.url;
    if (draft.archiveMode === "none") {
      toast(draft.id ? "Bookmark updated" : "Added to Shelf", bookmarkLabel);
    } else {
      toast(draft.id ? "Bookmark updated" : "Added to Shelf", `${bookmarkLabel} · ${archiveModeLabel(draft.archiveMode)} will be saved in the background`);
    }
    if (saved) void completeBackgroundArchive(saved.id, draft, shouldEnrich, saved.updatedAt);
  } catch (error) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = errorMessage(error);
    }
    toast("Could not save bookmark", errorMessage(error), true);
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = `${icon("check")}Save bookmark`;
    }
  }
}

async function completeBackgroundArchive(id: string, draft: BookmarkDraft, shouldEnrich: boolean, expectedUpdatedAt: string): Promise<void> {
  if (shouldEnrich) await enrichBookmark(id, draft, expectedUpdatedAt);
  if (draft.archiveMode === "none") return;
  if (snapshot.bookmarks.find((bookmark) => bookmark.id === id)?.archive.mode !== draft.archiveMode) return;
  await processPendingArchives({ id, mode: draft.archiveMode });
}

async function enrichBookmark(id: string, draft: BookmarkDraft, expectedUpdatedAt: string): Promise<void> {
  const generation = sessionGeneration;
  try {
    const current = snapshot.bookmarks.find((bookmark) => bookmark.id === id);
    if (current?.archive.mode !== draft.archiveMode || current?.updatedAt !== expectedUpdatedAt) return;
    const metadata = await invoke<MetadataPreview>("fetch_metadata", { rawUrl: draft.url });
    if (!sessionIsActive(generation)) return;
    const latest = snapshot.bookmarks.find((bookmark) => bookmark.id === id);
    if (latest?.archive.mode !== draft.archiveMode || latest?.updatedAt !== expectedUpdatedAt) return;
    const nextSnapshot = await invoke<AppSnapshot>("save_bookmark", {
      draft: {
        ...draft,
        id,
        url: metadata.url,
        title: metadata.title,
        description: draft.description || metadata.description,
        imageUrl: draft.imageUrl || metadata.imageUrl,
        faviconUrl: draft.faviconUrl || metadata.faviconUrl,
        siteName: draft.siteName || metadata.siteName,
        author: draft.author || metadata.author,
        publishedAt: draft.publishedAt || metadata.publishedAt,
      },
    });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    if (!modal) render();
  } catch {
    // Some sites block metadata clients; the bookmark has already been saved safely.
  }
}

async function saveStorage(form: HTMLFormElement): Promise<void> {
  const generation = sessionGeneration;
  const data = new FormData(form);
  const directory = String(data.get("directory") || "");
  const fileName = String(data.get("fileName") || "");
  const button = document.querySelector<HTMLButtonElement>("#save-storage-button");
  const status = document.querySelector<HTMLElement>("#storage-status");
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>Saving…`;
  }
  try {
    try {
      const nextSnapshot = await invoke<AppSnapshot>("configure_storage", { directory, fileName, overwrite: false });
      if (!acceptSnapshot(nextSnapshot, generation)) return;
    } catch (error) {
      const message = errorMessage(error);
      if (!message.startsWith("STORAGE_FILE_EXISTS:")) throw error;
      const shouldReplace = await confirm(message.replace("STORAGE_FILE_EXISTS:", ""), { title: "Replace storage file?", kind: "warning" });
      if (!shouldReplace) return;
      const nextSnapshot = await invoke<AppSnapshot>("configure_storage", { directory, fileName, overwrite: true });
      if (!acceptSnapshot(nextSnapshot, generation)) return;
    }
    if (status) {
      status.className = "fetch-status success";
      status.innerHTML = `${icon("check")}Shelf is now saving to ${escapeHtml(snapshot.dataPath)}`;
    }
    const fileNameInput = document.querySelector<HTMLInputElement>("#storage-file-name");
    if (fileNameInput) fileNameInput.value = snapshot.dataFileName;
    toast("Storage location updated", snapshot.dataPath);
  } catch (error) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = errorMessage(error);
    }
    toast("Could not update storage", errorMessage(error), true);
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon("check")}Save storage location`;
    }
  }
}

async function saveApiServer(form: HTMLFormElement): Promise<void> {
  if (apiServerSaving) return;
  const data = new FormData(form);
  const enabled = data.get("enabled") === "on";
  const interfaceName = String(data.get("interface") || "").trim();
  const port = Number(data.get("port"));
  const status = document.querySelector<HTMLElement>("#api-server-status");

  if (!interfaceName) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "Enter an interface or host name.";
    }
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "Choose a port between 1 and 65,535.";
    }
    return;
  }

  apiServerSaving = true;
  render();
  try {
    apiServer = await invoke<ApiServerStatus>("configure_api_server", {
      enabled,
      interface: interfaceName,
      port,
    });
    apiServerSaving = false;
    render();
    toast(
      apiServer.running ? "API server enabled" : "API server disabled",
      apiServer.running ? `Listening at ${apiServer.url}` : "Shelf is no longer accepting HTTP API requests.",
    );
  } catch (error) {
    apiServerSaving = false;
    const message = errorMessage(error);
    const currentStatus = await invoke<ApiServerStatus>("get_api_server_status").catch(() => apiServer);
    apiServer = { ...currentStatus, error: message };
    render();
  }
}

async function saveMisc(form: HTMLFormElement): Promise<void> {
  if (miscSaving) return;
  const data = new FormData(form);
  const maxMetadataMb = Number(data.get("maxMetadataMb"));
  const timeoutSecs = Number(data.get("timeoutSecs"));
  const status = document.querySelector<HTMLElement>("#misc-status");

  if (!Number.isInteger(maxMetadataMb) || maxMetadataMb < 1 || maxMetadataMb > 100) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "Choose a maximum page size between 1 and 100 MB.";
    }
    return;
  }
  if (!Number.isInteger(timeoutSecs) || timeoutSecs < 5 || timeoutSecs > 600) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "Choose a request timeout between 5 and 600 seconds.";
    }
    return;
  }

  miscSaving = true;
  render();
  try {
    miscellaneous = await invoke<MiscellaneousStatus>("configure_miscellaneous", {
      maxMetadataMb,
      timeoutSecs,
    });
    miscSaving = false;
    render();
    toast("Fetching settings saved", `Pages up to ${miscellaneous.maxMetadataBytes / 1_000_000} MB with a ${miscellaneous.requestTimeoutSecs}-second timeout.`);
  } catch (error) {
    miscSaving = false;
    const message = errorMessage(error);
    render();
    const nextStatus = document.querySelector<HTMLElement>("#misc-status");
    if (nextStatus) {
      nextStatus.className = "fetch-status error";
      nextStatus.textContent = message;
    }
  }
}

async function saveSecurity(form: HTMLFormElement): Promise<void> {
  if (securityOperation) return;
  const generation = sessionGeneration;
  const data = new FormData(form);
  const currentValue = String(data.get("currentPassword") || "");
  const currentPassword = currentValue || undefined;
  const newPassword = String(data.get("newPassword") || "");
  const confirmPassword = String(data.get("confirmPassword") || "");
  const timeoutMinutes = Number(data.get("timeoutMinutes"));
  const button = document.querySelector<HTMLButtonElement>("#save-security-button");
  const status = document.querySelector<HTMLElement>("#security-status");

  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "Choose a timeout between 1 and 1,440 minutes.";
    }
    return;
  }
  if (!security.passwordConfigured && newPassword.length < 8) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "Use a password with at least 8 characters.";
    }
    return;
  }
  if (newPassword && newPassword !== confirmPassword) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "The new passwords do not match.";
    }
    return;
  }
  const operationLabel = "Saving app-lock settings…";
  securityOperation = "updating";
  clearInactivityTimer();
  setSecurityFormBusy(true);
  if (button) {
    button.innerHTML = `<span class="spinner"></span>${operationLabel}`;
  }
  if (status) {
    status.className = "fetch-status";
    status.innerHTML = `<span class="spinner"></span>${operationLabel}`;
  }
  try {
    const nextSecurity = await invoke<SecurityStatus>("configure_security", {
      currentPassword,
      newPassword: newPassword || undefined,
      timeoutMinutes,
      removePassword: false,
    });
    if (!sessionIsActive(generation)) {
      securityOperation = null;
      return;
    }
    security = nextSecurity;
    locked = security.locked;
    securityOperation = null;
    lastInteractionAt = Date.now();
    scheduleInactivityLock();
    render();
    toast(security.passwordConfigured ? "App lock enabled" : "App-lock settings saved", security.passwordConfigured ? "Shelf will lock after inactivity." : "Shelf remains unlocked until you add a password.");
  } catch (error) {
    securityOperation = null;
    setSecurityFormBusy(false);
    if (status) {
      status.className = "fetch-status error";
      status.textContent = errorMessage(error);
    }
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon("check")}${security.passwordConfigured ? "Save app lock" : "Enable app lock"}`;
    }
    lastInteractionAt = Date.now();
    scheduleInactivityLock();
    if (!modal) render();
  }
}

async function removePassword(): Promise<void> {
  if (!security.passwordConfigured || securityOperation) return;
  const generation = sessionGeneration;
  const currentPassword = document.querySelector<HTMLInputElement>("#security-current-password")?.value || "";
  const status = document.querySelector<HTMLElement>("#security-status");
  if (!currentPassword) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = "Enter your current Shelf password first.";
    }
    return;
  }
  if (!await confirm("Remove the password and disable Shelf's app lock?", { title: "Remove app lock", kind: "warning" })) return;
  securityOperation = "updating";
  clearInactivityTimer();
  setSecurityFormBusy(true);
  if (status) {
    status.className = "fetch-status";
    status.innerHTML = `<span class="spinner"></span>Removing app lock…`;
  }
  try {
    const nextSecurity = await invoke<SecurityStatus>("configure_security", {
      currentPassword,
      newPassword: undefined,
      timeoutMinutes: security.timeoutMinutes,
      removePassword: true,
    });
    if (!sessionIsActive(generation)) {
      securityOperation = null;
      return;
    }
    security = nextSecurity;
    locked = false;
    securityOperation = null;
    clearInactivityTimer();
    lastInteractionAt = Date.now();
    render();
    toast("App lock removed", "Shelf will no longer ask for a password.");
  } catch (error) {
    securityOperation = null;
    setSecurityFormBusy(false);
    if (status) {
      status.className = "fetch-status error";
      status.textContent = errorMessage(error);
    }
    lastInteractionAt = Date.now();
    scheduleInactivityLock();
    if (!modal) render();
  }
}

async function saveCollection(form: HTMLFormElement): Promise<void> {
  const generation = sessionGeneration;
  const data = new FormData(form);
  const draft = { id: String(data.get("id") || "") || undefined, name: String(data.get("name") || ""), color: String(data.get("color") || "#e46f4b") };
  try {
    const nextSnapshot = await invoke<AppSnapshot>("save_collection", { draft });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    modal = null;
    render();
    toast("Collection saved", draft.name);
  } catch (error) { toast("Could not save collection", errorMessage(error), true); }
}

function activateSavedQuery(savedQuery: SavedQuery): void {
  clearSearchQuery();
  searchInput = savedQuery.query;
  filters = {
    ...filters,
    query: savedQuery.query,
    scope: "saved-query",
    scopeId: savedQuery.id,
    addedFrom: "",
    addedTo: "",
    domains: [],
    hasSavedCopy: false,
    favoritesOnly: false,
    neverOpened: false,
    hasNotes: false,
    hasNoTags: false,
  };
  scheduleArchiveSearch(savedQuery.query);
  requestVirtualReset();
}

function clearSearchQuery(): void {
  if (searchInputTimer) window.clearTimeout(searchInputTimer);
  searchInputTimer = undefined;
  searchInput = "";
  filters = { ...filters, query: "" };
  scheduleArchiveSearch("");
}

async function saveSavedQuery(form: HTMLFormElement): Promise<void> {
  const generation = sessionGeneration;
  const data = new FormData(form);
  const draft = {
    id: String(data.get("id") || "") || undefined,
    name: String(data.get("name") || ""),
    query: String(data.get("query") || ""),
  };
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = document.querySelector<HTMLElement>("#saved-query-status");
  if (submit) {
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner spinner-light"></span>Saving…`;
  }
  try {
    const existingIds = new Set(snapshot.savedQueries.map((savedQuery) => savedQuery.id));
    const nextSnapshot = await invoke<AppSnapshot>("save_saved_query", { draft });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    const savedQuery = draft.id
      ? snapshot.savedQueries.find((item) => item.id === draft.id)
      : snapshot.savedQueries.find((item) => !existingIds.has(item.id));
    if (savedQuery) activateSavedQuery(savedQuery);
    modal = null;
    render();
    toast(draft.id ? "Saved query updated" : "Query saved", savedQuery?.name ?? draft.name);
  } catch (error) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = errorMessage(error);
    }
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = `${icon("check")}Save query`;
    }
  }
}

async function deleteSavedQuery(id: string): Promise<void> {
  const generation = sessionGeneration;
  const item = snapshot.savedQueries.find((savedQuery) => savedQuery.id === id);
  if (!item) return;
  if (!await confirm(`Delete saved query “${item.name}”?`, { title: "Delete saved query", kind: "warning" })) return;
  try {
    const nextSnapshot = await invoke<AppSnapshot>("delete_saved_query", { id });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    if (filters.scope === "saved-query" && filters.scopeId === id) {
      searchInput = "";
      clearFilterState();
      scheduleArchiveSearch("");
      requestVirtualReset();
    }
    modal = null;
    render();
    toast("Saved query deleted", item.name);
  } catch (error) {
    toast("Could not delete saved query", errorMessage(error), true);
  }
}

async function openBookmark(id: string): Promise<void> {
  const generation = sessionGeneration;
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  try {
    await openUrl(bookmark.url);
    const nextSnapshot = await invoke<AppSnapshot>("record_bookmark_open", { id });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    render();
  } catch (error) { toast("Could not open bookmark", errorMessage(error), true); }
}

async function openShareBookmark(id: string): Promise<void> {
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  closeBookmarkMenu();
  modal = { kind: "share", id };
  render();
  try {
    const qrDataUrl = await QRCode.toDataURL(bookmark.url, { width: 280, margin: 2, errorCorrectionLevel: "M" });
    if (modal?.kind !== "share" || modal.id !== id) return;
    modal = { ...modal, qrDataUrl };
    render();
  } catch (error) {
    if (modal?.kind !== "share" || modal.id !== id) return;
    modal = { ...modal, qrError: true };
    render();
    toast("Could not create QR code", errorMessage(error), true);
  }
}

function bookmarkShareDetails(bookmark: Bookmark): string {
  const collection = collectionFor(bookmark);
  return [
    bookmark.title,
    bookmark.url,
    bookmark.description ? `Description: ${bookmark.description}` : "",
    bookmark.tags.length ? `Tags: ${bookmark.tags.map((tag) => `#${tag}`).join(", ")}` : "",
    collection ? `Collection: ${collection.name}` : "",
    bookmark.notes ? `Notes: ${bookmark.notes}` : "",
  ].filter(Boolean).join("\n");
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the document copy path for webviews without Clipboard API permission.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

async function copyBookmark(id: string, details: boolean): Promise<void> {
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  try {
    await writeClipboard(details ? bookmarkShareDetails(bookmark) : bookmark.url);
    toast(details ? "Details copied" : "Link copied", bookmark.title);
  } catch (error) {
    toast("Could not copy bookmark", errorMessage(error), true);
  }
}

async function openArchiveCopy(id: string): Promise<void> {
  const generation = sessionGeneration;
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  try {
    const copy = await invoke<SavedHtmlCopy>("get_archive_html", { id });
    if (!sessionIsActive(generation)) return;
    modal = { kind: "archive", id, title: bookmark.title, html: copy.html, baseUrl: copy.baseUrl };
    closeBookmarkMenu();
    render();
  } catch (error) { toast("Could not render saved copy", errorMessage(error), true); }
}

function savedCopyExportName(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const name = cleaned || "saved-copy";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `saved-${name}.html` : `${name}.html`;
}

async function exportArchiveCopy(id: string): Promise<void> {
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  const path = await save({
    title: "Export saved HTML copy",
    defaultPath: savedCopyExportName(bookmark.title),
    filters: [{ name: "HTML files", extensions: ["html", "htm"] }],
  });
  if (!path) return;
  try {
    await invoke("export_archive_html", { id, path });
    toast("Saved copy exported", `${bookmark.title} · HTML file ready.`);
  } catch (error) { toast("Could not export saved copy", errorMessage(error), true); }
}

async function refreshArchive(id: string): Promise<void> {
  const generation = sessionGeneration;
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark || bookmark.archive.mode === "none") return;
  closeBookmarkMenu();
  render();
  toast("Refreshing saved copy", `${bookmark.title} · ${archiveModeLabel(bookmark.archive.mode)}`);
  try {
    const nextSnapshot = await invoke<AppSnapshot>("capture_archive", { id, mode: bookmark.archive.mode });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    render();
    toast("Saved copy refreshed", bookmark.title);
  } catch (error) { toast("Could not refresh saved copy", errorMessage(error), true); }
}

async function refreshMetadata(id: string): Promise<void> {
  const generation = sessionGeneration;
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  closeBookmarkMenu();
  render();
  toast("Refreshing metadata", bookmark.title);
  try {
    const nextSnapshot = await invoke<AppSnapshot>("refresh_metadata", { id });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    const refreshed = snapshot.bookmarks.find((item) => item.id === id);
    render();
    toast("Metadata refreshed", refreshed?.title || bookmark.title);
  } catch (error) { toast("Could not refresh metadata", errorMessage(error), true); }
}

async function saveOfflineCopy(id: string): Promise<void> {
  const generation = sessionGeneration;
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark || hasSavedCopy(bookmark) || pendingArchiveFor(bookmark)) return;
  const draft: BookmarkDraft = {
    id: bookmark.id,
    url: bookmark.url,
    title: bookmark.title,
    description: bookmark.description,
    imageUrl: bookmark.imageUrl,
    faviconUrl: bookmark.faviconUrl,
    siteName: bookmark.siteName,
    author: bookmark.author,
    publishedAt: bookmark.publishedAt,
    tags: bookmark.tags,
    collectionId: bookmark.collectionId,
    favorite: bookmark.favorite,
    archived: bookmark.archived,
    notes: bookmark.notes,
    archiveMode: "html",
  };
  closeBookmarkMenu();
  render();
  toast("Saving offline copy", bookmark.title);
  try {
    const nextSnapshot = await invoke<AppSnapshot>("save_bookmark", { draft });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    render();
    void processPendingArchives({ id, mode: "html" });
  } catch (error) { toast("Could not save offline copy", errorMessage(error), true); }
}

function scheduleArchiveSearch(query: string): void {
  archiveSearchScores.clear();
  if (archiveSearchTimer) window.clearTimeout(archiveSearchTimer);
  const request = ++archiveSearchRequest;
  const generation = sessionGeneration;
  const terms = searchTerms(parseSearchQuery(query));
  if (!terms.length) return;
  archiveSearchTimer = window.setTimeout(() => {
    void invoke<ArchiveTermMatch[]>("search_archive_terms", { terms }).then((matches) => {
      if (!sessionIsActive(generation) || request !== archiveSearchRequest || filters.query !== query) return;
      const scores = new Map<string, Map<string, number>>();
      for (const match of matches) {
        const bookmarkScores = scores.get(match.id) ?? new Map<string, number>();
        bookmarkScores.set(match.term, match.score);
        scores.set(match.id, bookmarkScores);
      }
      archiveSearchScores = scores;
      requestVirtualReset();
      render(true);
    }).catch(() => {
      // Metadata search remains available when an archive is unreadable.
    });
  }, 0);
}

function scheduleSearch(query: string): void {
  if (searchInputTimer) window.clearTimeout(searchInputTimer);
  searchInputTimer = window.setTimeout(() => {
    searchInputTimer = undefined;
    if (filters.query === query) return;
    if (filters.scope === "saved-query") {
      filters = { ...filters, query, scope: "all", scopeId: undefined };
    } else {
      filters.query = query;
    }
    scheduleArchiveSearch(query);
    requestVirtualReset();
    render(true);
  }, 250);
}

async function toggleStatus(id: string, type: "favorite" | "archive"): Promise<void> {
  const generation = sessionGeneration;
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  try {
    const nextSnapshot = await invoke<AppSnapshot>("update_bookmark_status", {
      id,
      favorite: type === "favorite" ? !bookmark.favorite : null,
      archived: type === "archive" ? !bookmark.archived : null,
    });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    closeBookmarkMenu();
    render();
  } catch (error) { toast("Could not update bookmark", errorMessage(error), true); }
}

async function deleteBookmark(id: string): Promise<void> {
  const generation = sessionGeneration;
  const bookmark = snapshot.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  if (!await confirm(`Delete “${bookmark.title}”? This cannot be undone.`, { title: "Delete bookmark", kind: "warning" })) return;
  try {
    const nextSnapshot = await invoke<AppSnapshot>("delete_bookmark", { id });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    modal = null; closeBookmarkMenu(); render(); toast("Bookmark deleted", bookmark.title);
  } catch (error) { toast("Could not delete bookmark", errorMessage(error), true); }
}

async function deleteCollection(id: string): Promise<void> {
  const generation = sessionGeneration;
  const item = snapshot.collections.find((collection) => collection.id === id);
  if (!item) return;
  if (!await confirm(`Delete “${item.name}”? Its bookmarks will remain in your library.`, { title: "Delete collection", kind: "warning" })) return;
  try {
    const nextSnapshot = await invoke<AppSnapshot>("delete_collection", { id });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    if (filters.scope === "collection" && filters.scopeId === id) {
      filters = { ...filters, scope: "all", scopeId: undefined };
      requestVirtualReset();
    }
    modal = null; render(); toast("Collection deleted", item.name);
  } catch (error) { toast("Could not delete collection", errorMessage(error), true); }
}

async function renameTag(form: HTMLFormElement): Promise<void> {
  const generation = sessionGeneration;
  const data = new FormData(form);
  const oldName = String(data.get("oldName") || "");
  const newName = String(data.get("newName") || "");
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = document.querySelector<HTMLElement>("#tag-rename-status");
  if (submit) {
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner spinner-light"></span>Renaming…`;
  }
  try {
    const nextSnapshot = await invoke<AppSnapshot>("rename_tag", { oldName, newName });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    const renamedTag = newName.trim().replace(/^#+/, "").toLocaleLowerCase();
    if (filters.scope === "tag" && filters.scopeId === oldName) {
      filters = { ...filters, scopeId: renamedTag };
      requestVirtualReset();
    }
    modal = null;
    render();
    toast("Tag renamed", `#${oldName} is now #${renamedTag}`);
  } catch (error) {
    if (status) {
      status.className = "fetch-status error";
      status.textContent = errorMessage(error);
    }
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = `${icon("check")}Done`;
    }
  }
}

async function chooseCsvImport(): Promise<void> {
  if (!csvImporter || csvImportBusy) return;
  const generation = sessionGeneration;
  const sourceLabel = csvImporter === "raindrop" ? "Raindrop.io" : "Shelf";
  const path = await open({ title: `Import ${sourceLabel} bookmarks`, multiple: false, directory: false, filters: [{ name: "CSV files", extensions: ["csv"] }] });
  if (!path) return;
  csvImportPath = path;
  csvImportValidation = null;
  csvImportBusy = true;
  render();
  try {
    const validation = await invoke<CsvImportValidation>("validate_csv_import", { path, importer: csvImporter });
    if (generation !== sessionGeneration) return;
    csvImportValidation = validation;
    if (validation.errorCount === 0) {
      csvImportBusy = false;
      await commitCsvImport(false);
    }
  } catch (error) {
    toast("Could not validate CSV", errorMessage(error), true);
  } finally {
    csvImportBusy = false;
    if (generation === sessionGeneration && modal?.kind === "settings") render();
  }
}

async function commitCsvImport(skipInvalid: boolean): Promise<void> {
  if (!csvImporter || !csvImportPath || csvImportBusy) return;
  const generation = sessionGeneration;
  csvImportBusy = true;
  render();
  try {
    const report = await invoke<ImportReport>("import_csv", { path: csvImportPath, importer: csvImporter, skipInvalid });
    const nextSnapshot = await invoke<AppSnapshot>("get_snapshot");
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    csvImportPath = "";
    csvImportValidation = null;
    render();
    toast("Import complete", `${report.imported} added, ${report.updated} updated${report.skipped ? `, ${report.skipped} skipped` : ""}.`);
  } catch (error) {
    toast("Could not import CSV", errorMessage(error), true);
  } finally {
    csvImportBusy = false;
    if (generation === sessionGeneration && modal?.kind === "settings") render();
  }
}

async function exportCsv(): Promise<void> {
  const defaultName = `shelf-bookmarks-${new Date().toISOString().slice(0, 10)}.csv`;
  const path = await save({ title: "Export Shelf bookmarks", defaultPath: defaultName, filters: [{ name: "CSV files", extensions: ["csv"] }] });
  if (!path) return;
  try {
    const count = await invoke<number>("export_csv", { path });
    toast("Export complete", `${count} bookmarks saved to CSV.`);
  } catch (error) { toast("Could not export CSV", errorMessage(error), true); }
}

async function exportSearchResults(): Promise<void> {
  if (!filters.query.trim()) return;
  const bookmarks = visibleBookmarks();
  if (!bookmarks.length) return;
  const defaultName = `shelf-search-results-${new Date().toISOString().slice(0, 10)}.csv`;
  const path = await save({ title: "Export Shelf search results", defaultPath: defaultName, filters: [{ name: "CSV files", extensions: ["csv"] }] });
  if (!path) return;
  try {
    const count = await invoke<number>("export_csv_selection", { path, bookmarkIds: bookmarks.map((bookmark) => bookmark.id) });
    toast("Search results exported", `${count} ${count === 1 ? "bookmark" : "bookmarks"} saved to CSV.`);
  } catch (error) { toast("Could not export search results", errorMessage(error), true); }
}

async function moveSearchResults(form: HTMLFormElement): Promise<void> {
  if (modal?.kind !== "move-search" || !modal.ids?.length) return;
  const generation = sessionGeneration;
  const bookmarkIds = [...modal.ids];
  const value = String(new FormData(form).get("collectionId") || "");
  if (!value) return;
  const collectionId = value === "__none__" ? undefined : value;
  const destination = collectionId
    ? snapshot.collections.find((collection) => collection.id === collectionId)
    : undefined;
  if (collectionId && !destination) {
    toast("Could not move search results", "That collection no longer exists.", true);
    return;
  }
  const movedCount = bookmarkIds.filter((id) => snapshot.bookmarks.find((bookmark) => bookmark.id === id)?.collectionId !== collectionId).length;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) {
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner spinner-light"></span>Moving…`;
  }
  try {
    const nextSnapshot = await invoke<AppSnapshot>("move_bookmarks_to_collection", { bookmarkIds, collectionId: collectionId ?? null });
    if (!acceptSnapshot(nextSnapshot, generation)) return;
    modal = null;
    render();
    const destinationLabel = destination?.name ?? "No collection";
    toast(movedCount ? "Search results moved" : "No changes needed", movedCount ? `${movedCount} ${movedCount === 1 ? "bookmark" : "bookmarks"} moved to ${destinationLabel}.` : `All results are already in ${destinationLabel}.`);
  } catch (error) {
    toast("Could not move search results", errorMessage(error), true);
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = `${icon("folder")}Move ${bookmarkIds.length} ${bookmarkIds.length === 1 ? "bookmark" : "bookmarks"}`;
    }
  }
}

function selectNavigationItem(nav: HTMLElement): void {
  if (nav.dataset.nav === "saved-query") {
    const savedQuery = snapshot.savedQueries.find((item) => item.id === nav.dataset.scopeId);
    if (!savedQuery) return;
    activateSavedQuery(savedQuery);
  } else {
    clearSearchQuery();
    filters = { ...filters, scope: nav.dataset.nav as Scope, scopeId: nav.dataset.scopeId };
    requestVirtualReset();
  }
  closeBookmarkMenu();
  root.querySelectorAll<HTMLElement>("[data-nav]").forEach((item) => {
    item.classList.toggle("active", item === nav);
  });
  renderedSidebarHtml = sidebarHtml();
  render();
}

function toggleBookmarkMenu(id: string): void {
  const nextMenuId = openMenuId === id ? null : id;
  root.querySelectorAll<HTMLElement>(".card-menu").forEach((menu) => {
    menu.querySelector(":scope > .context-menu")?.remove();
    menu.querySelector<HTMLElement>(":scope > [data-action=\"menu\"]")?.setAttribute("aria-expanded", "false");
    menu.closest(".bookmark-card")?.classList.remove("menu-open");
  });
  openMenuId = nextMenuId;
  if (nextMenuId) {
    const bookmark = snapshot.bookmarks.find((item) => item.id === nextMenuId);
    const trigger = root.querySelector<HTMLElement>(`[data-action="menu"][data-id="${CSS.escape(nextMenuId)}"]`);
    if (bookmark && trigger) {
      trigger.setAttribute("aria-expanded", "true");
      trigger.closest(".bookmark-card")?.classList.add("menu-open");
      trigger.parentElement?.insertAdjacentHTML("beforeend", contextMenuHtml(bookmark));
    }
  }
  renderedContentHtml = contentHtml();
}

function closeBookmarkMenu(): void {
  openMenuId = null;
  root.querySelectorAll<HTMLElement>(".card-menu").forEach((menu) => {
    menu.querySelector(":scope > .context-menu")?.remove();
    menu.querySelector<HTMLElement>(":scope > [data-action=\"menu\"]")?.setAttribute("aria-expanded", "false");
    menu.closest(".bookmark-card")?.classList.remove("menu-open");
  });
}

root.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const windowAction = target.closest<HTMLElement>("[data-window-action]")?.dataset.windowAction;
  if (windowAction) {
    event.stopPropagation();
    await handleWindowAction(windowAction);
    return;
  }
  if (tagSuggestionsOpen() && !target.closest("#tag-editor")) {
    hideTagSuggestions();
    if (target.classList.contains("backdrop")) return;
  }
  if (target.classList.contains("backdrop")) { modal = null; render(); return; }
  const collectionOptions = document.querySelector<HTMLElement>("#collection-options");
  if (collectionOptions && !target.closest(".collection-picker")) collectionOptions.hidden = true;
  const moveSearchOptions = document.querySelector<HTMLElement>("#move-search-options");
  if (moveSearchOptions && !target.closest(".move-search-picker")) {
    moveSearchOptions.hidden = true;
    document.querySelector<HTMLElement>(".move-search-trigger")?.setAttribute("aria-expanded", "false");
  }
  const sortOptionsMenu = document.querySelector<HTMLElement>("#sort-options");
  if (sortOptionsMenu && !target.closest(".sort-picker")) sortOptionsMenu.hidden = true;
  const addedFilterOptions = document.querySelector<HTMLElement>("#added-filter-options");
  if (addedFilterOptions && !target.closest(".added-filter-picker")) {
    addedFilterOpen = false;
    addedFilterOptions.hidden = true;
    document.querySelector<HTMLElement>("[data-action=\"toggle-added-filter\"]")?.setAttribute("aria-expanded", "false");
  }
  const domainFilterOptions = document.querySelector<HTMLElement>("#domain-filter-options");
  if (domainFilterOptions && !target.closest(".domain-filter-picker")) {
    domainFilterOpen = false;
    domainFilterQuery = "";
    domainFilterOptions.hidden = true;
    document.querySelector<HTMLElement>("[data-action=\"toggle-domain-filter\"]")?.setAttribute("aria-expanded", "false");
  }
  const importerOptions = document.querySelector<HTMLElement>("#import-source-options");
  if (importerOptions && !target.closest(".import-source-picker")) importerOptions.hidden = true;
  const tagRenameOptions = document.querySelector<HTMLElement>("#tag-rename-options");
  if (tagRenameOptions && !target.closest(".tag-rename-picker")) {
    tagRenameOptions.hidden = true;
    document.querySelector<HTMLElement>(".tag-rename-trigger")?.setAttribute("aria-expanded", "false");
  }
  const nav = target.closest<HTMLElement>("[data-nav]");
  if (nav) { selectNavigationItem(nav); return; }
  const tag = target.closest<HTMLElement>("[data-tag]");
  if (tag) { filters = { ...filters, scope: "tag", scopeId: tag.dataset.tag }; requestVirtualReset(); render(); return; }
  const view = target.closest<HTMLElement>("[data-view]");
  if (view) { filters.view = view.dataset.view as ViewMode; localStorage.setItem("shelf-view", filters.view); requestVirtualReset(); render(); return; }
  const sort = target.closest<HTMLElement>("[data-sort]");
  if (sort) { filters.sort = sort.dataset.sort as SortMode; requestVirtualReset(); render(); return; }
  const filter = target.closest<HTMLElement>("[data-filter]");
  if (filter) {
    switch (filter.dataset.filter) {
      case "saved-copy": filters.hasSavedCopy = !filters.hasSavedCopy; break;
      case "favorite": filters.favoritesOnly = !filters.favoritesOnly; break;
      case "never-opened": filters.neverOpened = !filters.neverOpened; break;
      case "notes": filters.hasNotes = !filters.hasNotes; break;
      case "no-tags": filters.hasNoTags = !filters.hasNoTags; break;
    }
    requestVirtualReset();
    render();
    return;
  }
  const removeTag = target.closest<HTMLElement>("[data-remove-tag]");
  if (removeTag) { setActiveTags(activeTags().filter((item) => item !== removeTag.dataset.removeTag)); return; }
  const addTagButton = target.closest<HTMLElement>("[data-add-tag]");
  if (addTagButton) { addTag(addTagButton.dataset.addTag ?? ""); return; }
  const selectedMoveCollection = target.closest<HTMLElement>("[data-select-move-collection]");
  if (selectedMoveCollection) {
    const id = selectedMoveCollection.dataset.selectMoveCollection ?? "";
    const item = snapshot.collections.find((collection) => collection.id === id);
    const input = document.querySelector<HTMLInputElement>("#move-search-collection");
    const choice = document.querySelector<HTMLElement>(".move-search-trigger .collection-choice");
    const options = document.querySelector<HTMLElement>("#move-search-options");
    const trigger = document.querySelector<HTMLElement>(".move-search-trigger");
    if (input) input.value = id;
    if (choice) choice.innerHTML = item ? `<span class="collection-dot" style="background:${escapeHtml(item.color)}"></span><span>${escapeHtml(item.name)}</span>` : `${icon("folder")}<span>No collection</span>`;
    document.querySelectorAll<HTMLElement>("[data-select-move-collection]").forEach((option) => {
      const selected = option.dataset.selectMoveCollection === id;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
      option.querySelector(":scope > .icon:last-child")?.remove();
    });
    selectedMoveCollection.insertAdjacentHTML("beforeend", icon("check"));
    if (options) options.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    const submit = document.querySelector<HTMLButtonElement>("#move-search-submit");
    if (submit) submit.disabled = false;
    return;
  }
  const selectedCollection = target.closest<HTMLElement>("[data-select-collection]");
  if (selectedCollection) {
    const id = selectedCollection.dataset.selectCollection ?? "";
    const item = snapshot.collections.find((collection) => collection.id === id);
    const input = document.querySelector<HTMLInputElement>("#bookmark-collection");
    const triggerChoice = document.querySelector<HTMLElement>(".collection-trigger .collection-choice");
    const options = document.querySelector<HTMLElement>("#collection-options");
    const trigger = document.querySelector<HTMLElement>(".collection-trigger");
    if (input) input.value = id;
    if (triggerChoice) triggerChoice.innerHTML = item ? `<span class="collection-dot" style="background:${escapeHtml(item.color)}"></span><span>${escapeHtml(item.name)}</span>` : `${icon("folder")}<span>No collection</span>`;
    document.querySelectorAll(".collection-option").forEach((option) => {
      option.classList.toggle("selected", (option as HTMLElement).dataset.selectCollection === id);
      option.querySelector(".icon:last-child")?.remove();
    });
    selectedCollection.insertAdjacentHTML("beforeend", icon("check"));
    if (options) options.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    return;
  }
  const selectedImporter = target.closest<HTMLElement>("[data-importer]");
  if (selectedImporter) {
    csvImporter = selectedImporter.dataset.importer === "raindrop" ? "raindrop" : "native";
    csvImportPath = "";
    csvImportValidation = null;
    render();
    return;
  }
  const selectedRenameTag = target.closest<HTMLElement>("[data-select-rename-tag]");
  if (selectedRenameTag) {
    const name = selectedRenameTag.dataset.selectRenameTag ?? "";
    const input = document.querySelector<HTMLInputElement>("#tag-rename-existing");
    const choice = document.querySelector<HTMLElement>(".tag-rename-trigger .collection-choice");
    const options = document.querySelector<HTMLElement>("#tag-rename-options");
    const trigger = document.querySelector<HTMLElement>(".tag-rename-trigger");
    if (input) input.value = name;
    if (choice) choice.innerHTML = `${icon("tag")}<span>${escapeHtml(name)}</span>`;
    document.querySelectorAll<HTMLElement>("[data-select-rename-tag]").forEach((option) => {
      const selected = option.dataset.selectRenameTag === name;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
      option.querySelector(":scope > .icon:last-child")?.remove();
    });
    selectedRenameTag.insertAdjacentHTML("beforeend", icon("check"));
    if (options) options.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    document.querySelector<HTMLInputElement>("#tag-rename-name")?.focus();
    return;
  }
  const color = target.closest<HTMLElement>("[data-color]");
  if (color) { const input = document.querySelector<HTMLInputElement>("#collection-color"); if (input) input.value = color.dataset.color ?? ""; document.querySelectorAll(".color-swatch").forEach((item) => item.classList.toggle("active", item === color)); return; }
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  const actionElement = target.closest<HTMLElement>("[data-action]");
  const id = actionElement?.dataset.id ?? "";
  switch (action) {
    case "new-bookmark": modal = { kind: "bookmark" }; render(); break;
    case "view-bookmark": modal = { kind: "bookmark-details", id }; closeBookmarkMenu(); render(); break;
    case "edit-bookmark": modal = { kind: "bookmark", id }; closeBookmarkMenu(); render(); break;
    case "new-collection": modal = { kind: "collection" }; render(); break;
    case "edit-collection": modal = { kind: "collection", id }; render(); break;
    case "new-saved-query": modal = { kind: "saved-query" }; render(); break;
    case "edit-saved-query": modal = { kind: "saved-query", id }; render(); break;
    case "move-search": {
      const ids = visibleBookmarks().map((bookmark) => bookmark.id);
      if (filters.query.trim() && ids.length && snapshot.collections.length) {
        modal = { kind: "move-search", ids };
        render();
      }
      break;
    }
    case "rename-tag": modal = { kind: "tag-rename" }; render(); break;
    case "settings": settingsTab = "appearance"; modal = { kind: "settings" }; render(); break;
    case "settings-tab": {
      const tab = actionElement?.dataset.tab;
      settingsTab = tab === "appearance" || tab === "api" || tab === "storage" || tab === "transfer" || tab === "misc" ? tab : "security";
      render();
      break;
    }
    case "interface-scale-decrease": await stepInterfaceScale(-1); break;
    case "interface-scale-increase": await stepInterfaceScale(1); break;
    case "interface-scale-reset": await setInterfaceScale(DEFAULT_INTERFACE_SCALE); break;
    case "close-modal": modal = null; render(); break;
    case "remove-password": await removePassword(); break;
    case "lock-now": modal = null; render(); await lockShelf(); break;
    case "fetch-metadata": await fetchMetadata(); break;
    case "toggle-collection-picker": {
      const options = document.querySelector<HTMLElement>("#collection-options");
      if (options) {
        options.hidden = !options.hidden;
        actionElement?.setAttribute("aria-expanded", String(!options.hidden));
      }
      break;
    }
    case "toggle-move-search-picker": {
      const options = document.querySelector<HTMLElement>("#move-search-options");
      if (options) {
        options.hidden = !options.hidden;
        actionElement?.setAttribute("aria-expanded", String(!options.hidden));
      }
      break;
    }
    case "toggle-tag-rename-picker": {
      const options = document.querySelector<HTMLElement>("#tag-rename-options");
      if (options) {
        options.hidden = !options.hidden;
        actionElement?.setAttribute("aria-expanded", String(!options.hidden));
        if (!options.hidden) {
          const search = document.querySelector<HTMLInputElement>("#tag-rename-search");
          if (search) search.value = "";
          filterTagRenameOptions("");
          setTimeout(() => search?.focus(), 0);
        }
      }
      break;
    }
    case "toggle-sort-picker": {
      const options = document.querySelector<HTMLElement>("#sort-options");
      if (options) {
        options.hidden = !options.hidden;
        actionElement?.setAttribute("aria-expanded", String(!options.hidden));
      }
      break;
    }
    case "toggle-added-filter":
      addedFilterOpen = !addedFilterOpen;
      domainFilterOpen = false;
      domainFilterQuery = "";
      render();
      break;
    case "toggle-domain-filter": {
      const opening = !domainFilterOpen;
      domainFilterOpen = opening;
      if (!opening) domainFilterQuery = "";
      addedFilterOpen = false;
      render();
      if (opening) setTimeout(() => document.querySelector<HTMLInputElement>("#domain-filter-search")?.focus(), 0);
      break;
    }
    case "clear-added-filter":
      filters.addedFrom = "";
      filters.addedTo = "";
      requestVirtualReset();
      render();
      break;
    case "clear-domain-filter":
      filters.domains = [];
      requestVirtualReset();
      render();
      if (domainFilterOpen) setTimeout(() => document.querySelector<HTMLInputElement>("#domain-filter-search")?.focus(), 0);
      break;
    case "toggle-importer-picker": {
      const options = document.querySelector<HTMLElement>("#import-source-options");
      if (options) {
        options.hidden = !options.hidden;
        actionElement?.setAttribute("aria-expanded", String(!options.hidden));
      }
      break;
    }
    case "choose-storage-directory": {
      const directory = await open({ title: "Choose Shelf storage folder", directory: true, multiple: false, defaultPath: snapshot.dataDirectory });
      if (typeof directory === "string") {
        const input = document.querySelector<HTMLInputElement>("#storage-directory");
        if (input) input.value = directory;
      }
      break;
    }
    case "open-bookmark": await openBookmark(id); break;
    case "share-bookmark": await openShareBookmark(id); break;
    case "copy-bookmark-url": await copyBookmark(id, false); break;
    case "copy-bookmark-details": await copyBookmark(id, true); break;
    case "open-archive": await openArchiveCopy(id); break;
    case "export-archive": await exportArchiveCopy(id); break;
    case "refresh-archive": await refreshArchive(id); break;
    case "refresh-metadata": await refreshMetadata(id); break;
    case "save-offline-copy": await saveOfflineCopy(id); break;
    case "favorite": event.stopPropagation(); await toggleStatus(id, "favorite"); break;
    case "archive": await toggleStatus(id, "archive"); break;
    case "delete-bookmark": await deleteBookmark(id); break;
    case "delete-collection": await deleteCollection(id); break;
    case "delete-saved-query": await deleteSavedQuery(id); break;
    case "menu": toggleBookmarkMenu(id); break;
    case "clear-filters":
      if (searchInputTimer) window.clearTimeout(searchInputTimer);
      searchInputTimer = undefined;
      searchInput = "";
      clearFilterState();
      scheduleArchiveSearch("");
      requestVirtualReset();
      render();
      break;
    case "choose-csv-import": await chooseCsvImport(); break;
    case "continue-csv-import": await commitCsvImport(true); break;
    case "cancel-csv-import": csvImportPath = ""; csvImportValidation = null; render(); break;
    case "export": await exportCsv(); break;
    case "export-search": await exportSearchResults(); break;
  }
});

root.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "global-search") {
    searchInput = target.value;
    closeBookmarkMenu();
    scheduleSearch(searchInput);
    renderedTopbarHtml = topbarHtml();
  }
  if (target.id === "tag-input") showTagSuggestions(target.value);
  if (target.id === "tag-rename-search") filterTagRenameOptions(target.value);
  if (target.id === "domain-filter-search") filterDomainOptions(target.value);
});

root.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "added-from-filter") {
    filters.addedFrom = target.value;
    if (filters.addedTo && filters.addedFrom > filters.addedTo) filters.addedTo = filters.addedFrom;
    requestVirtualReset();
    render();
    return;
  }
  if (target.id === "added-to-filter") {
    filters.addedTo = target.value;
    if (filters.addedFrom && filters.addedTo < filters.addedFrom) filters.addedFrom = filters.addedTo;
    requestVirtualReset();
    render();
    return;
  }
  if (target.matches("[data-domain-filter]")) {
    const domain = target.value;
    filters.domains = target.checked
      ? [...new Set([...filters.domains, domain])]
      : filters.domains.filter((item) => item !== domain);
    requestVirtualReset();
    render();
    if (domainFilterOpen) setTimeout(() => document.querySelector<HTMLInputElement>("#domain-filter-search")?.focus(), 0);
  }
});

root.addEventListener("keydown", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "tag-input" && (event.key === "Enter" || event.key === ",")) { event.preventDefault(); addTag(target.value); }
  if (target.id === "tag-rename-search" && event.key === "Enter") {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>("[data-select-rename-tag]:not([hidden])")?.click();
  }
  if (target.id === "tag-rename-search" && event.key === "ArrowDown") {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>("[data-select-rename-tag]:not([hidden])")?.focus();
  }
  if (target.matches(".bookmark-card[data-action=\"view-bookmark\"]") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    target.click();
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      void stepInterfaceScale(1);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      void stepInterfaceScale(-1);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      void setInterfaceScale(DEFAULT_INTERFACE_SCALE);
      return;
    }
  }
  if (event.key === "Escape") {
    const target = event.target as HTMLElement;
    if (tagSuggestionsOpen()) {
      event.preventDefault();
      event.stopPropagation();
      hideTagSuggestions();
      return;
    }
    if (target.closest("#tag-editor")) {
      event.preventDefault();
      event.stopPropagation();
      hideTagSuggestions();
      return;
    }
    if (modal || openMenuId) {
      event.preventDefault();
      event.stopPropagation();
      modal = null;
      closeBookmarkMenu();
      render();
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); document.querySelector<HTMLInputElement>("#global-search")?.focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); modal = { kind: "bookmark" }; render(); }
}, true);

for (const eventName of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  document.addEventListener(eventName, noteInteraction, { capture: true, passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void enforceInactivityLock();
});

void installWindowCloseGuard();
void installWindowChromeSync();
void (async () => {
  await setInterfaceScale(interfaceScale, false);
  await installApiChangeListener();
  await initializeShelf();
})().catch((error) => {
  loading = false;
  render();
  toast("Could not open Shelf", errorMessage(error), true);
});
