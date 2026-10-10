# Shelf feature catalog

Shelf is a local-first desktop bookmark library for collecting, organizing, searching, and preserving useful pages. It is built with Tauri 2, Rust, TypeScript, and Vite, and runs without a hosted service or cloud account.

## Bookmark management

- **Create bookmarks** — Add a bookmark from an HTTP or HTTPS URL, then supply or retrieve its title, description, artwork, site details, tags, collection, notes, and saved-copy preference.

- **Edit bookmark details** — Update a bookmark's URL and all editable metadata after creation. Shelf keeps the same bookmark identity while applying validation and persisting the revised record.

- **Inspect bookmark information** — Bookmark cards expose the page title, description or note, domain, cover image, favicon, tags, collection, saved-copy state, and relevant actions.

- **Delete bookmarks** — Permanently remove a bookmark from the library. Any queued archive work and saved-copy files associated with the bookmark are removed as part of the same operation.

- **URL normalization and validation** — Shelf accepts only HTTP and HTTPS URLs, adds a usable scheme where appropriate, removes URL fragments, and rejects unsupported or invalid addresses.

- **Duplicate prevention** — Normalized URLs are checked before saving so the same page is not accidentally added to the library more than once.

- **Rich bookmark metadata** — Each bookmark can retain a title, description, URL, domain, cover image, favicon, site name, author, publication date, personal notes, tags, collection, and creation/update timestamps.

- **Open in the default browser** — Live pages open through the operating system's configured browser rather than inside a custom, app-specific browser.

- **Visit tracking** — Opening a bookmark increments its visit count and records when it was last opened, enabling frequency-based sorting and useful activity retention in exports.

- **Favorites** — Mark important bookmarks as favorites from their card controls and browse or combine the Favorites scope with other filters.

- **Archive state** — Move bookmarks out of the active library view without deleting them, browse them in a dedicated Archive scope, and restore them later.

## Metadata retrieval

- **On-demand metadata extraction** — Shelf extracts page content only when metadata is requested during creation or refresh. Ordinary browsing and library startup do not require network access; saves make a bounded request to resolve redirects.

- **Broad metadata extraction** — The fetcher reads Open Graph, Twitter Card, standard HTML metadata, document titles, favicons, authors, publication dates, descriptions, images, and site names.

- **Short-link expansion** — HTTP redirects, including services such as bit.ly and t.co, are resolved before a bookmark is saved so destination URLs participate in duplicate detection. If resolution is unavailable, Shelf preserves its local-first behavior and saves the normalized input URL.

- **Redirect-aware metadata** — Metadata requests follow redirects within a fixed limit, and relative image or favicon URLs are resolved against the final page address.

- **Metadata preview before saving** — A URL can be fetched and its extracted details shown in the bookmark form, allowing the user to review or adjust the result before committing it.

- **Metadata refresh** — Re-fetch an existing bookmark's page details from its current URL without recreating the bookmark or losing its organizational fields.

- **Bounded network requests** — Page requests allow at most five redirects, use a configurable request timeout (default 30 seconds, 5–600 seconds), and cap metadata responses at a configurable maximum page size (default 10 MB, 1–100 MB) to avoid unbounded downloads; both limits are set from the Miscellaneous settings tab.

- **Rate-limit retry** — Metadata and saved-page requests retry once after a one-second delay when the remote server responds with HTTP 429.

- **Browser-shaped HTTP client** — Requests use practical browser-like headers and a Rustls-backed HTTPS client for compatibility without an OpenSSL runtime dependency.

## Search

- **Search across all bookmark metadata** — Search covers titles, descriptions, URLs, domains, tags, collection names, authors, site names, and personal notes.

- **Weighted relevance ranking** — Matches in important fields such as the title and tags receive more weight, so the most likely result rises above weaker matches.

- **Fuzzy matching** — Search tolerates small typos and non-contiguous character matches instead of requiring every term to appear as an exact substring.

- **Debounced input** — Shelf waits briefly after typing stops before filtering and sorting the library, keeping the search box responsive even with thousands of bookmarks.

- **Implicit AND searches** — Adjacent terms must all match by default, so `rust wasm` behaves like `rust AND wasm`.

- **Boolean operators** — Use case-insensitive `AND` and `OR` operators to require all terms or accept alternatives, with `AND` evaluated before `OR`.

- **Parenthesized expressions** — Parentheses can group and nest Boolean expressions, such as `rust AND (web OR wasm)`, for more precise searches.

- **Excluded terms** — Prefix a term with `-` to omit matching bookmarks, including matches in saved-page text; for example, `rust -wasm`.

- **Tag terms** — Prefix a query term with `#` to target bookmark tags while retaining fuzzy matching, for example `#research`.

- **Saved-copy full-text search** — Visible text extracted from locally saved HTML participates in search, including Boolean expressions whose terms span metadata and saved-page content.

- **Saved queries** — Store a validated query under a unique name, then select it later to rerun the normal metadata and saved-page search against the latest library state.

- **Search shortcut and inline help** — Focus the global search field with Command/Ctrl+K. A faint one-line example beneath the field documents the Boolean syntax without crowding the toolbar.

- **Superseded-result protection** — Slow saved-copy searches are discarded when a newer query or app session replaces them, preventing stale results from flashing into the interface.

## Sharing

- **QR code sharing** — Generate a scannable QR code for any bookmark directly from its actions menu.

- **Clipboard sharing** — Copy only the resolved link or a readable block containing the title, URL, description, tags, collection, and notes.

## Organization and filtering

- **Multiple tags per bookmark** — Add as many tags as needed; Shelf normalizes, deduplicates, and stores them as reusable organizational labels.

- **Tag autocomplete** — Existing tags are suggested while editing a bookmark, reducing spelling variations and making the tag system easier to reuse consistently.

- **Tag navigation and counts** — Browse a dedicated view for any tag and see how many active bookmarks currently use each tag in the sidebar.

- **Tag renaming** — Find an existing tag with a searchable picker, rename it from the sidebar, and update every bookmark that uses it, merging duplicates when the destination tag already exists.

- **Collections** — Group bookmarks into named collections, with one collection assignment available per bookmark.

- **Collection colors** — Give each collection a custom color that appears throughout the interface as a compact visual identifier.

- **Collection management** — Create, rename, recolor, and delete collections. Deleting a collection safely detaches its bookmarks instead of deleting them.

- **Bulk collection moves** — While a search is active, move the exact matching result set—including active scope and filter constraints—to another collection in one operation.

- **Saved Copies scope** — Show only bookmarks whose local HTML and extracted searchable text are currently available on disk.

- **Always-visible filter row** — Narrow the current scope by an inclusive date-added range, one or more domains through a searchable multi-select, saved-copy availability, favorite status, never-opened status, notes, or missing tags. Every criterion can be combined with search, collection, tag, archive, or saved-copy views.

- **Clear filters** — Reset search and active filters in one action to return to the complete active library.

## Sorting and library views

- **Newest and oldest sorting** — Order bookmarks by creation date in either direction.

- **Alphabetical title sorting** — Sort by bookmark title for predictable A–Z browsing.

- **Website sorting** — Group results alphabetically by their normalized domain.

- **Most-visited sorting** — Rank bookmarks using their open count, with the most recently opened item used to resolve equal counts.

- **Relevance-aware sorting** — While searching, relevance score takes priority; the selected standard sort order provides stable ordering among similarly scored results.

- **Grid view** — Browse bookmarks as responsive visual cards with covers, metadata, labels, and quick actions.

- **List view** — Switch to a denser horizontal layout when scanning titles and metadata is more useful than large artwork.

- **Remembered view preference** — The selected grid or list view is stored locally and restored on the next launch.

- **Virtualized large libraries** — Shelf renders only the rows near the visible viewport and recycles card elements as the user scrolls, avoiding a full DOM node tree for thousands of bookmarks.

- **Lazy and resilient images** — Cover images and favicons load lazily, validate their source schemes, and fall back gracefully when a remote asset is missing or fails to load.

- **Purpose-built empty states** — Empty libraries and empty filtered results provide distinct explanations and direct actions to add a bookmark or clear filters.

## Saved copies and offline reading

- **Optional HTML capture** — Save a page's raw HTML for offline access either while creating/editing a bookmark or later from its actions menu.

- **Background capture queue** — Bookmark changes return promptly while requested saved copies are queued and processed in the background.

- **Durable pending jobs** — Unfinished work is stored in `pending-archives.json` and resumed on a future app session rather than being silently forgotten after interruption.

- **Visible capture status** — Bookmark cards and action menus show whether an HTML copy is saved, currently being captured, or being refreshed.

- **Saved-copy refresh** — Fetch the page again to replace an existing local copy while preserving the bookmark and its chosen archive mode.

- **Saved-copy removal** — Delete local archive files and disable capture for a bookmark without deleting the bookmark itself.

- **In-app offline viewer** — Open saved HTML directly inside Shelf. Untrusted content is rendered in a sandboxed iframe with the original URL supplied as its base for relative resources.

- **Saved HTML export** — Export an individual captured page through a native save dialog or, through the API, to an explicit path on the host computer.

- **Searchable extracted text** — Alongside `page.html`, Shelf stores cleaned visible text in `content.txt`, allowing saved pages to be found even when their bookmark metadata lacks the query terms.

- **Capture manifest** — Each saved-copy folder includes a JSON manifest describing the capture, in addition to its HTML and extracted text.

- **Predictable archive layout** — Saved copies live in filesystem-safe per-bookmark folders under an `archives/` directory beside the active library file.

- **Download and indexing limits** — Raw saved pages are capped at 50 MB and extracted searchable text at 25 MB, protecting memory, disk, and search workloads from oversized pages.

- **Race-safe archive operations** — Capture, refresh, read, export, move, and removal operations are serialized where needed so concurrent jobs cannot replace or delete the same files unpredictably.

- **Pending-work close warning** — Shelf asks for confirmation before the desktop window closes while saved-copy jobs are still unfinished.

## Notes and personal context

- **Personal notes** — Attach personal free-form notes to any bookmark and edit them independently of metadata supplied by the page.

- **Notes in cards and search** — Notes can supply a card's fallback description, participate in fuzzy search, and be isolated with the “Has notes” filter.

- **Portable note data** — Notes round-trip through Shelf's native CSV format alongside bookmark metadata and organization fields.

## Data storage and reliability

- **Local-first ownership** — The active library is a standard SQLite database on the user's computer; Shelf does not require a remote database, account, or synchronization service.

- **Immediate persistence** — Successful library mutations are written before their updated snapshot is returned, keeping in-memory state and the durable file aligned.

- **Transactional library writes** — Bookmark, tag, collection, and saved-query changes are reconciled in one SQLite transaction with foreign-key integrity enabled.

- **Versioned data format** — The library includes a schema version so intentional format changes can be recognized explicitly.

- **Normalized storage** — Bookmarks, ordered tag assignments, collections, and saved queries use normalized tables suitable for inspection, backups, and future reconciliation work.

- **Custom storage location** — Choose an absolute directory and portable `.sqlite3` filename from Settings rather than being restricted to the operating system's default app-data directory.

- **Complete storage migration** — Moving storage copies both the current library and its sibling `archives/` directory so records and saved pages remain together.

- **Overwrite protection** — Selecting an existing target file requires explicit confirmation before Shelf replaces it.

- **Path validation** — Storage filenames cannot contain path separators or collide with Shelf's own preference files, and API-provided filesystem paths are validated before use.

- **Separate preferences** — Storage, security, pending archives, and API server preferences remain outside the selectable bookmark library, preventing operational settings from leaking into portable data.

- **Platform-standard defaults** — Without customization, Shelf stores data in the operating system's local application-data directory on macOS, Windows, and Linux.

## CSV import and export

- **Guided importer selection** — Settings lets the user choose Shelf or Raindrop.io as the source and displays the expected format before opening the native file picker.

- **Preflight validation** — The complete CSV is parsed and validated before the library changes, with totals and row-level issues reported to the user.

- **All-or-valid-rows choice** — When errors exist, cancel without any mutation or continue with only valid rows; malformed input never has to become an all-or-nothing surprise.

- **Flexible Shelf CSV headers** — Native import recognizes common aliases such as `link`, `name`, `labels`, `folder`, and `starred`; only a URL column is required.

- **Automatic collection creation** — Collection names encountered during a native import are created as needed and connected to imported bookmarks.

- **Shelf round-tripping** — Native CSV import and export preserve metadata, tags, collections, favorites, archive state, notes, timestamps, open counts, and last-opened activity where available.

- **Raindrop.io import** — Map Raindrop titles, excerpts, covers, notes, tags, favorites, and creation times without performing automatic metadata network requests.

- **Safe handling of Raindrop extras** — Highlights and unknown export columns are intentionally ignored, allowing common Raindrop exports to import without unsupported data blocking the operation.

- **Duplicate-aware import reporting** — Import results distinguish imported, updated, and skipped records so the user can see exactly what changed.

- **Native CSV export** — Choose a host path with the operating system's save dialog and export the complete bookmark library in a portable tabular format.

- **Search-result CSV export** — While a search is active, export exactly the matching bookmarks in the same portable Shelf CSV format, including the current scope and filters.

## Privacy and app lock

- **Optional password lock** — Protect access to the running app with a password, or leave Shelf unlocked when local access control is unnecessary.

- **Argon2 password hashing** — Shelf stores a salted Argon2 password hash generated with a fresh random salt; it never persists the plaintext password.

- **Configurable inactivity timeout** — Automatically lock after 1 to 1,440 minutes without activity.

- **Broad activity detection** — Keyboard input, pointer actions, clicks, wheel scrolling, and touch interactions reset the inactivity timer.

- **Immediate manual lock** — Lock the app at once from the main toolbar without waiting for the inactivity timeout.

- **Protected configuration changes** — Changing or removing an existing password requires the current password rather than access to the already-unlocked settings screen alone.

- **Stale-session isolation** — Asynchronous frontend work is tied to the active unlocked session, so results started before a lock cannot update a later session.

- **Consistent API locking** — Protected HTTP API operations return `423 Locked` while the app is locked; health, lock status, lock, and unlock remain available for recovery and automation.

- **Honest security boundary** — App lock is in-application access control, not encryption. The SQLite library, CSV exports, and saved HTML remain plaintext on disk.

## HTTP/JSON API

- **Opt-in local server** — Enable the API from Settings when automation or another trusted local tool needs access; it is disabled by default and listens on `localhost:9876` by default.

- **Configurable listener** — Choose the bind interface and port, enable or disable the server at runtime, and see its current running state and URL in the desktop UI.

- **Persistent API settings** — The selected server configuration is stored separately and restored automatically on later launches.

- **Transactional rebinding** — If a new address cannot bind or its preference cannot be saved, Shelf attempts to restore the preceding working listener configuration.

- **Discovery and health endpoints** — Root and versioned discovery routes describe the service, while the health endpoint reports listener availability and lock state.

- **Snapshot and bookmark endpoints** — Read the entire snapshot; list bookmarks in bounded offset/limit pages with a total count; retrieve, create, replace, or delete records; change status flags; and record opens.

- **Atomic batch creation** — Create up to 1,000 bookmarks in one request; validation and mutation are atomic so a failed item does not leave a partially applied batch.

- **Batch metadata concurrency control** — Optional metadata fetching uses bounded parallel work rather than launching an unlimited number of remote requests.

- **Metadata merge modes** — `add-new-only` fills blank metadata without replacing supplied values, while `override` makes fetched page metadata authoritative; organization and saved-copy choices remain caller-controlled.

- **Metadata-only endpoint** — Fetch a URL's metadata without adding it to the library, or refresh metadata for an existing bookmark by ID.

- **Saved-copy endpoints** — Capture, refresh, remove, retrieve, export, search, and process pending saved copies through the same archive rules used by the desktop UI.

- **Collection endpoints** — List, create, replace, and delete collections, with deletion detaching affected bookmarks rather than removing them.

- **Security endpoints** — Read lock status, enable/update/remove password protection, lock immediately, and unlock with a password.

- **Storage and CSV endpoints** — Move the active library, import a host-side CSV, and export CSV to a host path available to the Shelf process.

- **Shared domain behavior** — Desktop commands and HTTP handlers reuse the same Rust validation, persistence, locking, collection, bookmark, archive, storage, and CSV operations.

- **Live desktop synchronization** — API-created bookmarks notify an open Shelf window; rapid bursts are coalesced before the UI refreshes its snapshot.

- **Structured errors** — API failures use JSON error responses and deliberate HTTP statuses, including `423 Locked` for operations blocked by app lock.

- **Stable JSON conventions** — API v1 uses camelCase fields, RFC 3339 UTC timestamps, UUID identifiers, explicit `null` optionals, and complete snapshots for most mutations.

- **Documented API contract** — [API.md](API.md) provides the endpoint index, schemas, request and response examples, error behavior, security notes, and operational details.

- **Trusted-network security model** — The API intentionally has no authentication, TLS, or browser CORS. Non-local binding should be used only where every reachable user and device is trusted.

## Desktop interface and accessibility

- **Custom desktop title bar** — Shelf provides drag behavior and native minimize, maximize/restore, and close controls in a consistent custom chrome.

- **Title-bar gestures** — Double-click the title bar to maximize or restore the window using familiar desktop behavior.

- **Monitor-aware startup** — Shelf fits and centers its initial window within the active display's work area, while native window management handles maximize, display movement, and DPI changes.

- **Responsive layout** — The library adapts its navigation, forms, toolbar, cards, and settings panels for narrower desktop windows.

- **Native dialogs** — File, folder, import, and export choices use operating-system dialogs rather than custom path inputs wherever possible.

- **Accessible controls** — Interactive elements include descriptive labels, titles, expanded-state information, status regions, and keyboard-capable controls.

- **Reduced-motion support** — Nonessential progress animation is disabled when the operating system requests reduced motion.

- **Offline interface assets** — Fonts, icons, styles, and application UI ship locally, with no remote UI framework or font dependency required to use the library.

## Cross-platform packaging and releases

- **macOS, Windows, and Linux support** — Application code uses Tauri abstractions for paths, windows, dialogs, and URL opening instead of platform-specific shell commands.

- **Intel and ARM64 builds** — Release automation produces native packages for macOS, Linux, and Windows across x86_64 and ARM64 targets.

- **Native installers** — Tauri generates the appropriate installer or application bundle for each supported operating system, including MSI packages and non-elevated per-user NSIS setup installers on Windows.

- **All-target release gate** — GitHub Actions publishes a release only after all six platform/architecture jobs succeed; failed runs retain a draft for inspection and reruns.

- **Offline-friendly runtime** — Core library organization, browsing, notes, saved-copy reading, import/export, and local search remain useful without an internet connection; only remote metadata and capture operations require network access.

## Current boundaries

- **No cloud synchronization** — Shelf does not currently provide accounts, hosted backup, multi-device sync, or collaborative sharing; users control and back up their local files.

- **No encryption at rest** — App lock restricts access through Shelf but does not encrypt the library, archives, preferences, or exports.

- **Desktop-focused distribution** — The maintained release workflow targets macOS, Windows, and Linux desktop systems.

- **Trusted API environments only** — The optional HTTP server is designed for localhost or explicitly trusted networks, not direct exposure to the public internet.
