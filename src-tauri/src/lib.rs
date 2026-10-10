use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::Utc;
use rand_core::OsRng;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, USER_AGENT};
use rusqlite::{params, Connection};
use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, State,
    WebviewWindow,
};
use url::Url;
use uuid::Uuid;

mod api;

const DATA_VERSION: u32 = 4;
const DATABASE_SCHEMA_VERSION: i64 = 1;
const SECURITY_VERSION: u32 = 1;
const DEFAULT_TIMEOUT_MINUTES: u32 = 15;
const MAX_TIMEOUT_MINUTES: u32 = 1_440;
const MIN_PASSWORD_LENGTH: usize = 8;
const MAX_PASSWORD_LENGTH: usize = 1_024;
const BYTES_PER_MB: usize = 1_000_000;
const MISC_PREFERENCE_VERSION: u32 = 1;
pub const DEFAULT_MAX_METADATA_MB: usize = 10;
pub const MIN_MAX_METADATA_MB: usize = 1;
pub const MAX_MAX_METADATA_MB: usize = 100;
pub const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 30;
pub const MIN_REQUEST_TIMEOUT_SECS: u64 = 5;
pub const MAX_REQUEST_TIMEOUT_SECS: u64 = 600;
const DEFAULT_MAX_METADATA_BYTES: usize = DEFAULT_MAX_METADATA_MB * BYTES_PER_MB;
const MAX_ARCHIVE_BYTES: usize = 50 * BYTES_PER_MB;
const URL_RESOLVE_TIMEOUT_SECS: u64 = 10;
const MAX_SEARCH_TEXT_BYTES: usize = 25 * BYTES_PER_MB;
const API_LIBRARY_CHANGED_EVENT: &str = "shelf://api-library-changed";
const PAGE_RATE_LIMIT_RETRY_DELAY: Duration = Duration::from_secs(1);

// Keep page requests shaped like a normal desktop browser navigation. This
// client is shared by metadata fetching and saved-copy capture.
#[cfg(target_os = "macos")]
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[cfg(target_os = "windows")]
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[cfg(target_os = "linux")]
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BROWSER_ACCEPT: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
const BROWSER_ACCEPT_LANGUAGE: &str = "en-US,en;q=0.9";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveMode {
    #[default]
    None,
    Html,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    #[serde(default)]
    pub mode: ArchiveMode,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub html_available: bool,
    #[serde(default)]
    pub text_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    pub site_name: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub domain: String,
    pub tags: Vec<String>,
    pub collection_id: Option<String>,
    pub favorite: bool,
    pub archived: bool,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
    pub open_count: u32,
    #[serde(default)]
    pub archive: ArchiveInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub query: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AppData {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    bookmarks: Vec<Bookmark>,
    #[serde(default)]
    collections: Vec<Collection>,
    #[serde(default)]
    saved_queries: Vec<SavedQuery>,
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            version: DATA_VERSION,
            bookmarks: Vec::new(),
            collections: Vec::new(),
            saved_queries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecurityPreference {
    #[serde(default = "default_security_version")]
    version: u32,
    #[serde(default = "default_timeout_minutes")]
    timeout_minutes: u32,
    #[serde(default)]
    password_hash: Option<String>,
}

impl Default for SecurityPreference {
    fn default() -> Self {
        Self {
            version: SECURITY_VERSION,
            timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
            password_hash: None,
        }
    }
}

impl SecurityPreference {
    fn password_configured(&self) -> bool {
        self.password_hash.is_some()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub password_configured: bool,
    pub timeout_minutes: u32,
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    pub name: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingArchive {
    pub id: String,
    pub mode: ArchiveMode,
    pub queued_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub version: u32,
    pub bookmarks: Vec<Bookmark>,
    pub collections: Vec<Collection>,
    pub saved_queries: Vec<SavedQuery>,
    pub tags: Vec<TagSummary>,
    pub data_path: String,
    pub data_directory: String,
    pub data_file_name: String,
    pub archive_directory: String,
    pub pending_archives: Vec<PendingArchive>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedHtmlCopy {
    pub html: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataPreview {
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    pub site_name: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub domain: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDraft {
    pub id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    pub site_name: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub collection_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub archived: bool,
    pub notes: Option<String>,
    #[serde(default)]
    pub archive_mode: ArchiveMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub updated: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CsvImporter {
    Native,
    Raindrop,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportIssue {
    pub row: Option<usize>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportValidation {
    pub total_rows: usize,
    pub valid_rows: usize,
    pub invalid_rows: usize,
    pub error_count: usize,
    pub errors: Vec<CsvImportIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub id: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTermMatch {
    pub id: String,
    pub term: String,
    pub score: f32,
}

#[derive(Clone)]
struct AppState {
    data: Arc<Mutex<AppData>>,
    persisted_data: Arc<Mutex<AppData>>,
    data_path: Arc<Mutex<PathBuf>>,
    config_path: PathBuf,
    security_path: PathBuf,
    security: Arc<Mutex<SecurityPreference>>,
    miscellaneous_path: PathBuf,
    miscellaneous: Arc<Mutex<MiscellaneousPreference>>,
    locked: Arc<Mutex<bool>>,
    security_io: Arc<Mutex<()>>,
    pending_archives: Arc<Mutex<Vec<PendingArchive>>>,
    pending_path: PathBuf,
    archive_io: Arc<Mutex<()>>,
    archive_worker_running: Arc<Mutex<bool>>,
    api_server: api::ApiServerManager,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl AppState {
    fn load(default_data_path: PathBuf, config_path: PathBuf) -> Result<Self, String> {
        let data_path = load_storage_preference(&config_path).unwrap_or(default_data_path);
        let security_path = config_path.with_file_name("security-preference.json");
        let security = load_security_preference(&security_path);
        let miscellaneous_path = config_path.with_file_name("miscellaneous-preference.json");
        let miscellaneous = load_miscellaneous_preference(&miscellaneous_path);
        let pending_path = config_path.with_file_name("pending-archives.json");
        let api_path = config_path.with_file_name("api-server-preference.json");
        let data = load_database(&data_path)?;
        let pending_archives = if pending_path.exists() {
            match fs::read_to_string(&pending_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Vec<PendingArchive>>(&raw).ok())
            {
                Some(parsed) => parsed,
                None => {
                    eprintln!(
                        "Shelf pending archive state was not valid JSON; starting with an empty queue"
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        Ok(Self {
            persisted_data: Arc::new(Mutex::new(data.clone())),
            data: Arc::new(Mutex::new(data)),
            data_path: Arc::new(Mutex::new(data_path)),
            config_path,
            security_path,
            locked: Arc::new(Mutex::new(security.password_configured())),
            security: Arc::new(Mutex::new(security)),
            miscellaneous_path,
            miscellaneous: Arc::new(Mutex::new(miscellaneous)),
            security_io: Arc::new(Mutex::new(())),
            pending_archives: Arc::new(Mutex::new(pending_archives)),
            pending_path,
            archive_io: Arc::new(Mutex::new(())),
            archive_worker_running: Arc::new(Mutex::new(false)),
            api_server: api::ApiServerManager::load(api_path),
            app_handle: Arc::new(Mutex::new(None)),
        })
    }

    fn attach_app_handle(&self, app_handle: AppHandle) -> Result<(), String> {
        *self
            .app_handle
            .lock()
            .map_err(|_| "Shelf app handle lock was poisoned".to_string())? = Some(app_handle);
        Ok(())
    }

    fn notify_api_library_changed(&self) {
        let app_handle = self
            .app_handle
            .lock()
            .ok()
            .and_then(|handle| handle.clone());
        if let Some(app_handle) = app_handle {
            if let Err(error) = app_handle.emit(API_LIBRARY_CHANGED_EVENT, ()) {
                eprintln!("Shelf could not notify the UI about an API change: {error}");
            }
        }
    }

    fn snapshot(&self) -> Result<AppSnapshot, String> {
        let data = self.data_guard()?;
        self.snapshot_from(&data)
    }

    fn persist(&self, data: &AppData) -> Result<(), String> {
        let path = self
            .data_path
            .lock()
            .map_err(|_| "Shelf storage path lock was poisoned".to_string())?;
        let mut persisted_data = self
            .persisted_data
            .lock()
            .map_err(|_| "Shelf persisted data lock was poisoned".to_string())?;
        persist_data_changes(&path, &persisted_data, data)?;
        *persisted_data = data.clone();
        Ok(())
    }

    fn snapshot_from(&self, data: &AppData) -> Result<AppSnapshot, String> {
        let path = self
            .data_path
            .lock()
            .map_err(|_| "Shelf storage path lock was poisoned".to_string())?;
        let pending_archives = self
            .pending_archives
            .lock()
            .map_err(|_| "Shelf pending archive lock was poisoned".to_string())?
            .clone();
        Ok(snapshot_from_data(data, &path, pending_archives))
    }

    fn security_preference(&self) -> Result<SecurityPreference, String> {
        self.security
            .lock()
            .map_err(|_| "Shelf security lock was poisoned".to_string())
            .map(|security| security.clone())
    }

    fn miscellaneous_preference(&self) -> Result<MiscellaneousPreference, String> {
        self.miscellaneous
            .lock()
            .map_err(|_| "Shelf network settings lock was poisoned".to_string())
            .map(|miscellaneous| miscellaneous.clone())
    }

    fn set_miscellaneous_preference(
        &self,
        preference: MiscellaneousPreference,
    ) -> Result<(), String> {
        *self
            .miscellaneous
            .lock()
            .map_err(|_| "Shelf network settings lock was poisoned".to_string())? = preference;
        Ok(())
    }

    fn miscellaneous_status(&self) -> Result<MiscellaneousStatus, String> {
        let preference = self.miscellaneous_preference()?;
        Ok(MiscellaneousStatus {
            max_metadata_bytes: preference.max_metadata_bytes,
            request_timeout_secs: preference.request_timeout_secs,
        })
    }

    fn security_status(&self) -> Result<SecurityStatus, String> {
        let security = self.security_preference()?;
        let locked = *self
            .locked
            .lock()
            .map_err(|_| "Shelf app lock was poisoned".to_string())?;
        Ok(SecurityStatus {
            password_configured: security.password_configured(),
            timeout_minutes: normalize_timeout_minutes(security.timeout_minutes),
            locked,
        })
    }

    fn data_guard(&self) -> Result<std::sync::MutexGuard<'_, AppData>, String> {
        if *self
            .locked
            .lock()
            .map_err(|_| "Shelf app lock was poisoned".to_string())?
        {
            return Err("Shelf is locked".to_string());
        }
        lock_data(&self.data)
    }

    fn set_security_state(&self, security: SecurityPreference, locked: bool) -> Result<(), String> {
        {
            let mut current = self
                .security
                .lock()
                .map_err(|_| "Shelf security lock was poisoned".to_string())?;
            *current = security;
        }
        *self
            .locked
            .lock()
            .map_err(|_| "Shelf app lock was poisoned".to_string())? = locked;
        Ok(())
    }

    fn archive_guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.archive_io
            .lock()
            .map_err(|_| "Shelf archive lock was poisoned".to_string())
    }

    fn lock(&self) -> Result<SecurityStatus, String> {
        let _security_io = self
            .security_io
            .lock()
            .map_err(|_| "Shelf security operation lock was poisoned".to_string())?;
        let security = self.security_preference()?;
        if !security.password_configured() {
            return Ok(SecurityStatus {
                password_configured: false,
                timeout_minutes: normalize_timeout_minutes(security.timeout_minutes),
                locked: false,
            });
        }
        *self
            .locked
            .lock()
            .map_err(|_| "Shelf app lock was poisoned".to_string())? = true;
        self.security_status()
    }

    fn pending_snapshot(&self) -> Result<Vec<PendingArchive>, String> {
        self.pending_archives
            .lock()
            .map_err(|_| "Shelf pending archive lock was poisoned".to_string())
            .map(|pending| pending.clone())
    }

    fn persist_pending(&self, pending: &[PendingArchive]) -> Result<(), String> {
        persist_json(&self.pending_path, pending)
    }

    fn queue_pending_archive(&self, id: &str, mode: ArchiveMode) -> Result<String, String> {
        let mut pending = self
            .pending_archives
            .lock()
            .map_err(|_| "Shelf pending archive lock was poisoned".to_string())?;
        let queued_at = now();
        pending.retain(|item| item.id != id);
        pending.push(PendingArchive {
            id: id.to_string(),
            mode,
            queued_at: queued_at.clone(),
        });
        self.persist_pending(&pending)?;
        Ok(queued_at)
    }

    fn remove_pending_archive(
        &self,
        id: &str,
        mode: Option<&ArchiveMode>,
        queued_at: Option<&str>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_archives
            .lock()
            .map_err(|_| "Shelf pending archive lock was poisoned".to_string())?;
        let before = pending.len();
        pending.retain(|item| {
            if item.id != id {
                return true;
            }
            if mode.is_some_and(|requested| &item.mode != requested) {
                return true;
            }
            queued_at.is_some_and(|requested| item.queued_at != requested)
        });
        if pending.len() != before {
            self.persist_pending(&pending)?;
        }
        Ok(())
    }

    fn try_start_archive_worker(&self) -> Result<bool, String> {
        let mut running = self
            .archive_worker_running
            .lock()
            .map_err(|_| "Shelf archive worker lock was poisoned".to_string())?;
        if *running {
            return Ok(false);
        }
        *running = true;
        Ok(true)
    }

    fn finish_archive_worker(&self) -> Result<(), String> {
        let mut running = self
            .archive_worker_running
            .lock()
            .map_err(|_| "Shelf archive worker lock was poisoned".to_string())?;
        *running = false;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoragePreference {
    data_path: PathBuf,
}

fn load_storage_preference(path: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<StoragePreference>(&raw)
        .ok()
        .map(|preference| preference.data_path)
}

fn load_security_preference(path: &Path) -> SecurityPreference {
    let Some(raw) = fs::read_to_string(path).ok() else {
        return SecurityPreference::default();
    };
    let Ok(mut preference) = serde_json::from_str::<SecurityPreference>(&raw) else {
        eprintln!("Shelf security settings were not valid JSON; using the defaults");
        return SecurityPreference::default();
    };
    preference.version = SECURITY_VERSION;
    preference.timeout_minutes = normalize_timeout_minutes(preference.timeout_minutes);
    preference
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiscellaneousPreference {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_max_metadata_bytes")]
    pub max_metadata_bytes: usize,
    #[serde(default = "default_request_timeout_secs")]
    pub request_timeout_secs: u64,
}

fn default_max_metadata_bytes() -> usize {
    DEFAULT_MAX_METADATA_BYTES
}

fn default_request_timeout_secs() -> u64 {
    DEFAULT_REQUEST_TIMEOUT_SECS
}

impl Default for MiscellaneousPreference {
    fn default() -> Self {
        Self {
            version: MISC_PREFERENCE_VERSION,
            max_metadata_bytes: DEFAULT_MAX_METADATA_BYTES,
            request_timeout_secs: DEFAULT_REQUEST_TIMEOUT_SECS,
        }
    }
}

impl MiscellaneousPreference {
    fn normalized(mut self) -> Self {
        self.version = MISC_PREFERENCE_VERSION;
        self.max_metadata_bytes = if self.max_metadata_bytes == 0 {
            DEFAULT_MAX_METADATA_BYTES
        } else {
            self.max_metadata_bytes.clamp(
                MIN_MAX_METADATA_MB * BYTES_PER_MB,
                MAX_MAX_METADATA_MB * BYTES_PER_MB,
            )
        };
        self.request_timeout_secs = if self.request_timeout_secs == 0 {
            DEFAULT_REQUEST_TIMEOUT_SECS
        } else {
            self
                .request_timeout_secs
                .clamp(MIN_REQUEST_TIMEOUT_SECS, MAX_REQUEST_TIMEOUT_SECS)
        };
        self
    }
}

fn load_miscellaneous_preference(path: &Path) -> MiscellaneousPreference {
    let Some(raw) = fs::read_to_string(path).ok() else {
        return MiscellaneousPreference::default();
    };
    let Ok(preference) = serde_json::from_str::<MiscellaneousPreference>(&raw) else {
        eprintln!("Shelf miscellaneous settings were not valid JSON; using the defaults");
        return MiscellaneousPreference::default();
    };
    preference.normalized()
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiscellaneousStatus {
    pub max_metadata_bytes: usize,
    pub request_timeout_secs: u64,
}

fn sqlite_error(context: &str, error: rusqlite::Error) -> String {
    format!("{context}: {error}")
}

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create Shelf data folder: {error}"))?;
    }
    let existed = path.exists();
    let connection = Connection::open(path)
        .map_err(|error| sqlite_error("Could not open the Shelf database", error))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| sqlite_error("Could not configure the Shelf database", error))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| sqlite_error("Could not enable Shelf database integrity checks", error))?;

    let schema_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| sqlite_error("Could not inspect the Shelf database schema", error))?;
    if schema_version == 0 && !existed {
        if let Err(error) = initialize_database(&connection) {
            drop(connection);
            let _ = fs::remove_file(path);
            return Err(error);
        }
    } else if schema_version != DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "This is not a supported Shelf database (schema version {schema_version})"
        ));
    }
    Ok(connection)
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE app_metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE collections (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL COLLATE NOCASE UNIQUE,
               color TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE bookmarks (
               id TEXT PRIMARY KEY,
               url TEXT NOT NULL UNIQUE,
               title TEXT NOT NULL,
               description TEXT,
               image_url TEXT,
               favicon_url TEXT,
               site_name TEXT,
               author TEXT,
               published_at TEXT,
               domain TEXT NOT NULL,
               collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
               favorite INTEGER NOT NULL CHECK (favorite IN (0, 1)),
               archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
               notes TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               last_opened_at TEXT,
               open_count INTEGER NOT NULL CHECK (open_count >= 0),
               archive_mode TEXT NOT NULL CHECK (archive_mode IN ('none', 'html')),
               archive_folder TEXT,
               archive_updated_at TEXT
             );
             CREATE TABLE bookmark_tags (
               bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
               position INTEGER NOT NULL CHECK (position >= 0),
               tag TEXT NOT NULL,
               PRIMARY KEY (bookmark_id, tag),
               UNIQUE (bookmark_id, position)
             );
             CREATE INDEX bookmark_tags_tag_idx ON bookmark_tags(tag);
             CREATE TABLE saved_queries (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL COLLATE NOCASE UNIQUE,
               query TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             INSERT INTO app_metadata(key, value) VALUES ('data_version', '4');
             PRAGMA user_version = 1;
             COMMIT;",
        )
        .map_err(|error| sqlite_error("Could not initialize the Shelf database", error))
}

fn archive_mode_from_database(value: String) -> Result<ArchiveMode, rusqlite::Error> {
    match value.as_str() {
        "none" => Ok(ArchiveMode::None),
        "html" => Ok(ArchiveMode::Html),
        _ => Err(rusqlite::Error::InvalidColumnType(
            0,
            "archive_mode".to_string(),
            rusqlite::types::Type::Text,
        )),
    }
}

fn archive_mode_for_database(mode: &ArchiveMode) -> &'static str {
    match mode {
        ArchiveMode::None => "none",
        ArchiveMode::Html => "html",
    }
}

fn load_database(path: &Path) -> Result<AppData, String> {
    let connection = open_database(path)?;
    let mut collections = Vec::new();
    {
        let mut statement = connection
            .prepare("SELECT id, name, color, created_at FROM collections ORDER BY created_at, id")
            .map_err(|error| sqlite_error("Could not read Shelf collections", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|error| sqlite_error("Could not read Shelf collections", error))?;
        for row in rows {
            collections.push(
                row.map_err(|error| sqlite_error("Could not decode a Shelf collection", error))?,
            );
        }
    }

    let mut tags_by_bookmark: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut statement = connection
            .prepare("SELECT bookmark_id, tag FROM bookmark_tags ORDER BY bookmark_id, position")
            .map_err(|error| sqlite_error("Could not read Shelf tags", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| sqlite_error("Could not read Shelf tags", error))?;
        for row in rows {
            let (bookmark_id, tag) =
                row.map_err(|error| sqlite_error("Could not decode a Shelf tag", error))?;
            tags_by_bookmark.entry(bookmark_id).or_default().push(tag);
        }
    }

    let mut bookmarks = Vec::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT id, url, title, description, image_url, favicon_url, site_name, author,
                        published_at, domain, collection_id, favorite, archived, notes, created_at,
                        updated_at, last_opened_at, open_count, archive_mode, archive_folder,
                        archive_updated_at
                 FROM bookmarks ORDER BY created_at, id",
            )
            .map_err(|error| sqlite_error("Could not read Shelf bookmarks", error))?;
        let rows = statement
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let open_count: i64 = row.get(17)?;
                let open_count = u32::try_from(open_count)
                    .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(17, open_count))?;
                Ok(Bookmark {
                    tags: tags_by_bookmark.remove(&id).unwrap_or_default(),
                    id,
                    url: row.get(1)?,
                    title: row.get(2)?,
                    description: row.get(3)?,
                    image_url: row.get(4)?,
                    favicon_url: row.get(5)?,
                    site_name: row.get(6)?,
                    author: row.get(7)?,
                    published_at: row.get(8)?,
                    domain: row.get(9)?,
                    collection_id: row.get(10)?,
                    favorite: row.get(11)?,
                    archived: row.get(12)?,
                    notes: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                    last_opened_at: row.get(16)?,
                    open_count,
                    archive: ArchiveInfo {
                        mode: archive_mode_from_database(row.get(18)?)?,
                        folder: row.get(19)?,
                        updated_at: row.get(20)?,
                        ..ArchiveInfo::default()
                    },
                })
            })
            .map_err(|error| sqlite_error("Could not read Shelf bookmarks", error))?;
        for row in rows {
            bookmarks.push(
                row.map_err(|error| sqlite_error("Could not decode a Shelf bookmark", error))?,
            );
        }
    }

    let mut saved_queries = Vec::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT id, name, query, created_at, updated_at
                 FROM saved_queries ORDER BY created_at, id",
            )
            .map_err(|error| sqlite_error("Could not read Shelf saved queries", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok(SavedQuery {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    query: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|error| sqlite_error("Could not read Shelf saved queries", error))?;
        for row in rows {
            saved_queries.push(
                row.map_err(|error| sqlite_error("Could not decode a Shelf saved query", error))?,
            );
        }
    }

    Ok(AppData {
        version: DATA_VERSION,
        bookmarks,
        collections,
        saved_queries,
    })
}

fn default_security_version() -> u32 {
    SECURITY_VERSION
}

fn default_timeout_minutes() -> u32 {
    DEFAULT_TIMEOUT_MINUTES
}

fn normalize_timeout_minutes(value: u32) -> u32 {
    if value == 0 {
        DEFAULT_TIMEOUT_MINUTES
    } else {
        value.clamp(1, MAX_TIMEOUT_MINUTES)
    }
}

fn validate_password(password: &str) -> Result<(), String> {
    let length = password.chars().count();
    if length < MIN_PASSWORD_LENGTH {
        return Err(format!(
            "Use a password with at least {MIN_PASSWORD_LENGTH} characters"
        ));
    }
    if length > MAX_PASSWORD_LENGTH {
        return Err("That password is longer than Shelf can use".to_string());
    }
    Ok(())
}

fn create_security_preference(
    password: &str,
    timeout_minutes: u32,
) -> Result<SecurityPreference, String> {
    validate_password(password)?;
    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| format!("Could not secure the Shelf password: {error}"))?
        .to_string();
    Ok(SecurityPreference {
        version: SECURITY_VERSION,
        timeout_minutes: normalize_timeout_minutes(timeout_minutes),
        password_hash: Some(password_hash),
    })
}

fn verify_password(preference: &SecurityPreference, password: &str) -> Result<(), String> {
    let encoded = preference
        .password_hash
        .as_deref()
        .ok_or_else(|| "Shelf password settings are incomplete".to_string())
        .and_then(|value| {
            PasswordHash::new(value).map_err(|_| "Shelf password settings are invalid".to_string())
        })?;
    Argon2::default()
        .verify_password(password.as_bytes(), &encoded)
        .map_err(|_| "That password is not correct".to_string())
}

fn default_version() -> u32 {
    DATA_VERSION
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn lock_data(data: &Mutex<AppData>) -> Result<std::sync::MutexGuard<'_, AppData>, String> {
    data.lock()
        .map_err(|_| "Shelf data lock was poisoned".to_string())
}

fn archive_root_for_path(data_path: &Path) -> PathBuf {
    data_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("archives")
}

fn is_safe_archive_folder(folder: &str) -> bool {
    !folder.is_empty()
        && folder != "."
        && folder != ".."
        && !folder.starts_with('.')
        && !folder.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
                )
        })
        && Path::new(folder).components().count() == 1
}

fn archive_directory_for(state: &AppState, id: &str) -> Result<(Bookmark, PathBuf), String> {
    let bookmark = {
        let data = state.data_guard()?;
        data.bookmarks
            .iter()
            .find(|bookmark| bookmark.id == id)
            .cloned()
            .ok_or_else(|| "That bookmark no longer exists".to_string())?
    };
    let folder = bookmark
        .archive
        .folder
        .as_deref()
        .filter(|folder| is_safe_archive_folder(folder))
        .ok_or_else(|| "This bookmark has no saved copy yet".to_string())?;
    let data_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
        .clone();
    let directory = archive_root_for_path(&data_path).join(folder);
    let _archive_io = state.archive_guard()?;
    if !directory.join("page.html").is_file() {
        return Err("The saved HTML copy is not available".to_string());
    }
    Ok((bookmark, directory))
}

fn filesystem_safe_component(value: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
            result.push(character);
            separator = false;
        } else if character.is_whitespace() || !character.is_ascii() {
            if !separator {
                result.push('-');
                separator = true;
            }
        } else if !separator {
            result.push('-');
            separator = true;
        }
        if result.len() >= 72 {
            break;
        }
    }
    let cleaned =
        result.trim_matches(|character| character == '-' || character == '.' || character == ' ');
    let mut result = if cleaned.is_empty() {
        "page".to_string()
    } else {
        cleaned.to_string()
    };
    let reserved = matches!(
        result.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
    ) || (result.len() == 4
        && matches!(result[..3].to_ascii_uppercase().as_str(), "COM" | "LPT")
        && result.as_bytes()[3].is_ascii_digit());
    if reserved {
        result.insert_str(0, "page-");
    }
    result
}

fn stable_url_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn archive_folder_name(bookmark: &Bookmark) -> String {
    let label = if bookmark.title.trim().is_empty() {
        &bookmark.url
    } else {
        &bookmark.title
    };
    format!(
        "{}-{:012x}",
        filesystem_safe_component(label),
        stable_url_hash(&bookmark.url) & 0xffff_ffff_ffff
    )
}

fn write_binary_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the archive folder: {error}"))?;
    }
    let temporary = path.with_file_name(format!(".shelf-file-{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = File::create(&temporary)
            .map_err(|error| format!("Could not write the saved page copy: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Could not write the saved page copy: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not flush the saved page copy: {error}"))?;
        drop(file);
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("Could not replace the saved page copy: {error}"))?;
        }
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not finalize the saved page copy: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_archive_bytes(directory: &Path, filename: &str, bytes: &[u8]) -> Result<(), String> {
    write_binary_atomically(&directory.join(filename), bytes)
}

fn read_archive_bytes(directory: &Path, filename: &str) -> Result<Option<Vec<u8>>, String> {
    let path = directory.join(filename);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Could not read the saved page copy: {error}"))?;
    Ok(Some(bytes))
}

fn archive_info_for(bookmark: &Bookmark, data_path: &Path) -> ArchiveInfo {
    let mut info = bookmark.archive.clone();
    info.html_available = false;
    info.text_available = false;
    if info.mode == ArchiveMode::None {
        return info;
    }
    let Some(folder) = info
        .folder
        .as_deref()
        .filter(|folder| is_safe_archive_folder(folder))
    else {
        return info;
    };
    let directory = archive_root_for_path(data_path).join(folder);
    info.html_available = directory.join("page.html").is_file();
    info.text_available = directory.join("content.txt").is_file();
    info
}

fn remove_archive_folder(data_path: &Path, folder: Option<&str>) -> Result<(), String> {
    let Some(folder) = folder.filter(|folder| is_safe_archive_folder(folder)) else {
        return Ok(());
    };
    let directory = archive_root_for_path(data_path).join(folder);
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("Could not remove the saved page copy: {error}"))?;
    }
    Ok(())
}

fn copy_directory_contents(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create the archive destination: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read the archive folder: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect an archive folder: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_contents(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Could not copy an archived file: {error}"))?;
        }
    }
    Ok(())
}

fn copy_archives_for_storage_change(previous_path: &Path, new_path: &Path) -> Result<(), String> {
    let source = archive_root_for_path(previous_path);
    let destination = archive_root_for_path(new_path);
    if source == destination || !source.is_dir() {
        return Ok(());
    }
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err(
            "Choose a storage location outside the current archive folder (and vice versa)"
                .to_string(),
        );
    }
    fs::create_dir_all(&destination)
        .map_err(|error| format!("Could not create the new archive folder: {error}"))?;
    for entry in fs::read_dir(&source)
        .map_err(|error| format!("Could not read the existing archive folder: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect an existing archive: {error}"))?;
        let folder = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_dir() && is_safe_archive_folder(&folder) {
            copy_directory_contents(&entry.path(), &destination.join(folder))?;
        }
    }
    Ok(())
}

fn snapshot_from_data(
    data: &AppData,
    data_path: &Path,
    pending_archives: Vec<PendingArchive>,
) -> AppSnapshot {
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    for bookmark in &data.bookmarks {
        for tag in &bookmark.tags {
            *tag_counts.entry(tag.clone()).or_default() += 1;
        }
    }

    let mut tags: Vec<TagSummary> = tag_counts
        .into_iter()
        .map(|(name, count)| TagSummary { name, count })
        .collect();
    tags.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });

    let mut bookmarks = data.bookmarks.clone();
    for bookmark in &mut bookmarks {
        bookmark.archive = archive_info_for(bookmark, data_path);
    }

    AppSnapshot {
        version: data.version,
        bookmarks,
        collections: data.collections.clone(),
        saved_queries: data.saved_queries.clone(),
        tags,
        data_path: data_path.to_string_lossy().to_string(),
        data_directory: data_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_string_lossy()
            .to_string(),
        data_file_name: data_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        archive_directory: archive_root_for_path(data_path)
            .to_string_lossy()
            .to_string(),
        pending_archives,
    }
}

fn persist_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create Shelf data folder: {error}"))?;
    }
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Could not encode Shelf data: {error}"))?;
    let temporary_path = path.with_extension("tmp");
    let mut file = File::create(&temporary_path)
        .map_err(|error| format!("Could not write Shelf data: {error}"))?;
    file.write_all(serialized.as_bytes())
        .map_err(|error| format!("Could not write Shelf data: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush Shelf data: {error}"))?;
    drop(file);

    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("Could not replace Shelf data: {error}"))?;
    }

    fs::rename(&temporary_path, path)
        .map_err(|error| format!("Could not finalize Shelf data: {error}"))
}

fn upsert_collection(
    transaction: &rusqlite::Transaction<'_>,
    collection: &Collection,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO collections(id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, color = excluded.color, created_at = excluded.created_at",
            params![
                collection.id,
                collection.name,
                collection.color,
                collection.created_at
            ],
        )
        .map_err(|error| sqlite_error("Could not save a Shelf collection", error))?;
    Ok(())
}

fn upsert_bookmark(
    transaction: &rusqlite::Transaction<'_>,
    bookmark: &Bookmark,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO bookmarks(
               id, url, title, description, image_url, favicon_url, site_name, author,
               published_at, domain, collection_id, favorite, archived, notes, created_at,
               updated_at, last_opened_at, open_count, archive_mode, archive_folder,
               archive_updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
               ?16, ?17, ?18, ?19, ?20, ?21
             )
             ON CONFLICT(id) DO UPDATE SET
               url = excluded.url, title = excluded.title, description = excluded.description,
               image_url = excluded.image_url, favicon_url = excluded.favicon_url,
               site_name = excluded.site_name, author = excluded.author,
               published_at = excluded.published_at, domain = excluded.domain,
               collection_id = excluded.collection_id, favorite = excluded.favorite,
               archived = excluded.archived, notes = excluded.notes,
               created_at = excluded.created_at, updated_at = excluded.updated_at,
               last_opened_at = excluded.last_opened_at, open_count = excluded.open_count,
               archive_mode = excluded.archive_mode, archive_folder = excluded.archive_folder,
               archive_updated_at = excluded.archive_updated_at",
            params![
                bookmark.id,
                bookmark.url,
                bookmark.title,
                bookmark.description,
                bookmark.image_url,
                bookmark.favicon_url,
                bookmark.site_name,
                bookmark.author,
                bookmark.published_at,
                bookmark.domain,
                bookmark.collection_id,
                if bookmark.favorite { 1 } else { 0 },
                if bookmark.archived { 1 } else { 0 },
                bookmark.notes,
                bookmark.created_at,
                bookmark.updated_at,
                bookmark.last_opened_at,
                i64::from(bookmark.open_count),
                archive_mode_for_database(&bookmark.archive.mode),
                bookmark.archive.folder,
                bookmark.archive.updated_at,
            ],
        )
        .map_err(|error| sqlite_error("Could not save a Shelf bookmark", error))?;
    Ok(())
}

fn replace_bookmark_tags(
    transaction: &rusqlite::Transaction<'_>,
    bookmark: &Bookmark,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM bookmark_tags WHERE bookmark_id = ?1",
            params![bookmark.id],
        )
        .map_err(|error| sqlite_error("Could not update Shelf bookmark tags", error))?;
    for (position, tag) in bookmark.tags.iter().enumerate() {
        let position = i64::try_from(position)
            .map_err(|_| "A bookmark has too many tags to store".to_string())?;
        transaction
            .execute(
                "INSERT INTO bookmark_tags(bookmark_id, position, tag) VALUES (?1, ?2, ?3)",
                params![bookmark.id, position, tag],
            )
            .map_err(|error| sqlite_error("Could not save a Shelf bookmark tag", error))?;
    }
    Ok(())
}

fn upsert_saved_query(
    transaction: &rusqlite::Transaction<'_>,
    saved_query: &SavedQuery,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO saved_queries(id, name, query, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, query = excluded.query,
               created_at = excluded.created_at, updated_at = excluded.updated_at",
            params![
                saved_query.id,
                saved_query.name,
                saved_query.query,
                saved_query.created_at,
                saved_query.updated_at
            ],
        )
        .map_err(|error| sqlite_error("Could not save a Shelf saved query", error))?;
    Ok(())
}

fn persist_data_changes(path: &Path, previous: &AppData, data: &AppData) -> Result<(), String> {
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| sqlite_error("Could not start a Shelf database transaction", error))?;
    let previous_collections: HashMap<&str, &Collection> = previous
        .collections
        .iter()
        .map(|collection| (collection.id.as_str(), collection))
        .collect();
    let collections: HashMap<&str, &Collection> = data
        .collections
        .iter()
        .map(|collection| (collection.id.as_str(), collection))
        .collect();
    for collection in &data.collections {
        if previous_collections.get(collection.id.as_str()).copied() != Some(collection) {
            upsert_collection(&transaction, collection)?;
        }
    }

    let previous_bookmarks: HashMap<&str, &Bookmark> = previous
        .bookmarks
        .iter()
        .map(|bookmark| (bookmark.id.as_str(), bookmark))
        .collect();
    let bookmarks: HashMap<&str, &Bookmark> = data
        .bookmarks
        .iter()
        .map(|bookmark| (bookmark.id.as_str(), bookmark))
        .collect();
    for bookmark in &data.bookmarks {
        let previous_bookmark = previous_bookmarks.get(bookmark.id.as_str()).copied();
        if previous_bookmark != Some(bookmark) {
            upsert_bookmark(&transaction, bookmark)?;
        }
        if previous_bookmark.map(|item| &item.tags) != Some(&bookmark.tags) {
            replace_bookmark_tags(&transaction, bookmark)?;
        }
    }
    for id in previous_bookmarks.keys() {
        if !bookmarks.contains_key(id) {
            transaction
                .execute("DELETE FROM bookmarks WHERE id = ?1", params![id])
                .map_err(|error| sqlite_error("Could not delete a Shelf bookmark", error))?;
        }
    }
    for id in previous_collections.keys() {
        if !collections.contains_key(id) {
            transaction
                .execute("DELETE FROM collections WHERE id = ?1", params![id])
                .map_err(|error| sqlite_error("Could not delete a Shelf collection", error))?;
        }
    }

    let previous_saved_queries: HashMap<&str, &SavedQuery> = previous
        .saved_queries
        .iter()
        .map(|saved_query| (saved_query.id.as_str(), saved_query))
        .collect();
    let saved_queries: HashSet<&str> = data
        .saved_queries
        .iter()
        .map(|saved_query| saved_query.id.as_str())
        .collect();
    for saved_query in &data.saved_queries {
        if previous_saved_queries.get(saved_query.id.as_str()).copied() != Some(saved_query) {
            upsert_saved_query(&transaction, saved_query)?;
        }
    }
    for id in previous_saved_queries.keys() {
        if !saved_queries.contains(id) {
            transaction
                .execute("DELETE FROM saved_queries WHERE id = ?1", params![id])
                .map_err(|error| sqlite_error("Could not delete a Shelf saved query", error))?;
        }
    }
    transaction
        .execute(
            "INSERT INTO app_metadata(key, value) VALUES ('data_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![DATA_VERSION.to_string()],
        )
        .map_err(|error| sqlite_error("Could not save Shelf database metadata", error))?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit the Shelf database update", error))
}

fn persist_data(path: &Path, data: &AppData) -> Result<(), String> {
    persist_data_changes(path, &AppData::default(), data)
}

fn replace_database(path: &Path, data: &AppData) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Choose a storage file inside a folder".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Shelf data folder: {error}"))?;
    let temporary = parent.join(format!(".shelf-database-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        persist_data(&temporary, data)?;
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("Could not replace the Shelf database: {error}"))?;
        }
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not finalize the Shelf database: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let cleaned = value.trim().to_string();
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    })
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#').to_lowercase();
        if !tag.is_empty() && !normalized.iter().any(|existing| existing == &tag) {
            normalized.push(tag);
        }
    }
    normalized
}

fn normalize_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("A URL is required".to_string());
    }

    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed.contains("://") {
        return Err("Only http and https URLs are supported".to_string());
    } else {
        format!("https://{trimmed}")
    };
    let mut parsed =
        Url::parse(&candidate).map_err(|_| "That URL does not look valid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Only http and https URLs are supported".to_string());
    }
    parsed.set_fragment(None);
    Ok(parsed)
}

fn domain_for(url: &Url) -> String {
    url.host_str()
        .unwrap_or("unknown site")
        .trim_start_matches("www.")
        .to_string()
}

fn fallback_title(url: &Url) -> String {
    domain_for(url)
}

fn apply_draft(
    bookmark: &mut Bookmark,
    draft: &BookmarkDraft,
    url: &Url,
    collections: &[Collection],
) {
    let title = draft
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_title(url));
    let collection_id = draft.collection_id.as_ref().and_then(|id| {
        collections
            .iter()
            .find(|collection| collection.id == *id)
            .map(|_| id.clone())
    });

    bookmark.url = url.to_string();
    bookmark.title = clean_text(&title);
    bookmark.description =
        clean_optional(draft.description.clone()).map(|value| clean_text(&value));
    bookmark.image_url = clean_optional(draft.image_url.clone());
    bookmark.favicon_url = clean_optional(draft.favicon_url.clone());
    bookmark.site_name = clean_optional(draft.site_name.clone());
    bookmark.author = clean_optional(draft.author.clone());
    bookmark.published_at = clean_optional(draft.published_at.clone());
    bookmark.domain = domain_for(url);
    bookmark.tags = normalize_tags(&draft.tags);
    bookmark.collection_id = collection_id;
    bookmark.favorite = draft.favorite;
    bookmark.archived = draft.archived;
    bookmark.notes = clean_optional(draft.notes.clone());
    if draft.archive_mode == ArchiveMode::None {
        bookmark.archive = ArchiveInfo::default();
    } else {
        bookmark.archive.mode = draft.archive_mode.clone();
    }
    bookmark.updated_at = now();
}

fn new_bookmark(draft: &BookmarkDraft, url: &Url, collections: &[Collection]) -> Bookmark {
    let timestamp = now();
    let mut bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        url: url.to_string(),
        title: fallback_title(url),
        description: None,
        image_url: None,
        favicon_url: None,
        site_name: None,
        author: None,
        published_at: None,
        domain: domain_for(url),
        tags: Vec::new(),
        collection_id: None,
        favorite: false,
        archived: false,
        notes: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        last_opened_at: None,
        open_count: 0,
        archive: ArchiveInfo::default(),
    };
    apply_draft(&mut bookmark, draft, url, collections);
    bookmark
}

#[tauri::command]
fn get_security_status(state: State<'_, AppState>) -> Result<SecurityStatus, String> {
    state.security_status()
}

#[tauri::command]
async fn unlock_app(state: State<'_, AppState>, password: String) -> Result<AppSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || unlock_app_inner(&state, password))
        .await
        .map_err(|error| format!("Could not unlock Shelf: {error}"))?
}

fn unlock_app_inner(state: &AppState, password: String) -> Result<AppSnapshot, String> {
    let _security_io = state
        .security_io
        .lock()
        .map_err(|_| "Shelf security operation lock was poisoned".to_string())?;
    let preference = state.security_preference()?;
    if !preference.password_configured() {
        return state.snapshot();
    }
    verify_password(&preference, &password)?;
    state.set_security_state(preference, false)?;
    state.snapshot()
}

#[tauri::command]
async fn lock_app(state: State<'_, AppState>) -> Result<SecurityStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.lock())
        .await
        .map_err(|error| format!("Could not lock Shelf: {error}"))?
}

#[tauri::command]
async fn configure_security(
    state: State<'_, AppState>,
    current_password: Option<String>,
    new_password: Option<String>,
    timeout_minutes: u32,
    remove_password: bool,
) -> Result<SecurityStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        configure_security_inner(
            &state,
            current_password,
            new_password,
            timeout_minutes,
            remove_password,
        )
    })
    .await
    .map_err(|error| format!("Could not update Shelf security: {error}"))?
}

fn configure_security_inner(
    state: &AppState,
    current_password: Option<String>,
    new_password: Option<String>,
    timeout_minutes: u32,
    remove_password: bool,
) -> Result<SecurityStatus, String> {
    let _security_io = state
        .security_io
        .lock()
        .map_err(|_| "Shelf security operation lock was poisoned".to_string())?;
    if !(1..=MAX_TIMEOUT_MINUTES).contains(&timeout_minutes) {
        return Err(format!(
            "Choose a timeout between 1 and {MAX_TIMEOUT_MINUTES} minutes"
        ));
    }

    let current_preference = state.security_preference()?;
    let was_configured = current_preference.password_configured();
    if was_configured {
        if state.security_status()?.locked {
            return Err("Shelf is locked".to_string());
        }
        let supplied = current_password
            .as_deref()
            .ok_or_else(|| "Enter your current Shelf password".to_string())?;
        verify_password(&current_preference, supplied)?;
    }

    let target_preference = if remove_password {
        if !was_configured {
            return Err("Shelf does not have a password to remove".to_string());
        }
        SecurityPreference {
            version: SECURITY_VERSION,
            timeout_minutes,
            ..SecurityPreference::default()
        }
    } else if let Some(password) = new_password.as_deref() {
        create_security_preference(password, timeout_minutes)?
    } else {
        let mut preference = current_preference.clone();
        preference.version = SECURITY_VERSION;
        preference.timeout_minutes = timeout_minutes;
        preference
    };
    persist_json(&state.security_path, &target_preference)?;
    state.set_security_state(target_preference, false)?;
    state.security_status()
}

#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
async fn save_bookmark(
    state: State<'_, AppState>,
    mut draft: BookmarkDraft,
) -> Result<AppSnapshot, String> {
    prepare_draft_url_for_save(&state, &mut draft).await?;
    save_bookmark_inner(&state, draft)
}

fn save_bookmark_inner(state: &AppState, draft: BookmarkDraft) -> Result<AppSnapshot, String> {
    let url = normalize_url(&draft.url)?;
    let mut data = state.data_guard()?;
    let collections = data.collections.clone();
    let requested_id = draft.id.as_deref();
    let previous_archive_folder = requested_id.and_then(|id| {
        data.bookmarks
            .iter()
            .find(|bookmark| bookmark.id == id)
            .and_then(|bookmark| bookmark.archive.folder.clone())
    });
    let duplicate_id = data
        .bookmarks
        .iter()
        .find(|bookmark| {
            bookmark.url == url.to_string() && Some(bookmark.id.as_str()) != requested_id
        })
        .map(|bookmark| bookmark.id.clone());
    if duplicate_id.is_some() {
        return Err("That URL is already on your Shelf".to_string());
    }
    let bookmark_id = if let Some(target_id) = requested_id {
        let bookmark = data
            .bookmarks
            .iter_mut()
            .find(|bookmark| bookmark.id == target_id)
            .ok_or_else(|| "That bookmark no longer exists".to_string())?;
        apply_draft(bookmark, &draft, &url, &collections);
        target_id.to_string()
    } else {
        let bookmark = new_bookmark(&draft, &url, &collections);
        let bookmark_id = bookmark.id.clone();
        data.bookmarks.push(bookmark);
        bookmark_id
    };

    state.persist(&data)?;
    if draft.archive_mode == ArchiveMode::None {
        let data_path = state
            .data_path
            .lock()
            .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
            .clone();
        let _archive_io = state.archive_guard()?;
        remove_archive_folder(&data_path, previous_archive_folder.as_deref())?;
        state.remove_pending_archive(&bookmark_id, None, None)?;
    } else {
        state.queue_pending_archive(&bookmark_id, draft.archive_mode.clone())?;
    }
    state.snapshot_from(&data)
}

fn create_bookmarks_batch_inner(
    state: &AppState,
    mut drafts: Vec<BookmarkDraft>,
) -> Result<AppSnapshot, String> {
    let normalized_urls = drafts
        .iter()
        .enumerate()
        .map(|(index, draft)| {
            normalize_url(&draft.url).map_err(|error| format!("Bookmark {}: {error}", index + 1))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut data = state.data_guard()?;
    let mut next_data = data.clone();
    let collections = next_data.collections.clone();
    let mut known_urls = next_data
        .bookmarks
        .iter()
        .map(|bookmark| bookmark.url.clone())
        .collect::<HashSet<_>>();
    let mut bookmarks = Vec::with_capacity(drafts.len());
    let mut pending_archives = Vec::new();

    for (index, (draft, url)) in drafts.iter_mut().zip(normalized_urls.iter()).enumerate() {
        draft.id = None;
        if !known_urls.insert(url.to_string()) {
            return Err(format!(
                "Bookmark {}: that URL is already on your Shelf or duplicated in this batch",
                index + 1
            ));
        }
        let bookmark = new_bookmark(draft, url, &collections);
        if draft.archive_mode != ArchiveMode::None {
            pending_archives.push((bookmark.id.clone(), draft.archive_mode.clone()));
        }
        bookmarks.push(bookmark);
    }

    next_data.bookmarks.extend(bookmarks);
    state.persist(&next_data)?;
    *data = next_data;
    drop(data);
    for (id, mode) in pending_archives {
        state.queue_pending_archive(&id, mode)?;
    }
    state.snapshot()
}

#[tauri::command]
fn delete_bookmark(state: State<'_, AppState>, id: String) -> Result<AppSnapshot, String> {
    delete_bookmark_inner(&state, id)
}

fn delete_bookmark_inner(state: &AppState, id: String) -> Result<AppSnapshot, String> {
    let mut data = state.data_guard()?;
    let archive_folder = data
        .bookmarks
        .iter()
        .find(|bookmark| bookmark.id == id)
        .and_then(|bookmark| bookmark.archive.folder.clone());
    if !data.bookmarks.iter().any(|bookmark| bookmark.id == id) {
        return Err("That bookmark no longer exists".to_string());
    }
    let data_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
        .clone();
    let _archive_io = state.archive_guard()?;
    remove_archive_folder(&data_path, archive_folder.as_deref())?;
    data.bookmarks.retain(|bookmark| bookmark.id != id);
    state.persist(&data)?;
    state.remove_pending_archive(&id, None, None)?;
    state.snapshot_from(&data)
}

#[tauri::command]
fn update_bookmark_status(
    state: State<'_, AppState>,
    id: String,
    favorite: Option<bool>,
    archived: Option<bool>,
) -> Result<AppSnapshot, String> {
    update_bookmark_status_inner(&state, id, favorite, archived)
}

fn update_bookmark_status_inner(
    state: &AppState,
    id: String,
    favorite: Option<bool>,
    archived: Option<bool>,
) -> Result<AppSnapshot, String> {
    let mut data = state.data_guard()?;
    let bookmark = data
        .bookmarks
        .iter_mut()
        .find(|bookmark| bookmark.id == id)
        .ok_or_else(|| "That bookmark no longer exists".to_string())?;
    if let Some(favorite) = favorite {
        bookmark.favorite = favorite;
    }
    if let Some(archived) = archived {
        bookmark.archived = archived;
    }
    bookmark.updated_at = now();
    state.persist(&data)?;
    state.snapshot_from(&data)
}

#[tauri::command]
fn move_bookmarks_to_collection(
    state: State<'_, AppState>,
    bookmark_ids: Vec<String>,
    collection_id: Option<String>,
) -> Result<AppSnapshot, String> {
    move_bookmarks_to_collection_inner(&state, bookmark_ids, collection_id)
}

fn move_bookmarks_to_collection_inner(
    state: &AppState,
    bookmark_ids: Vec<String>,
    collection_id: Option<String>,
) -> Result<AppSnapshot, String> {
    if bookmark_ids.is_empty() {
        return Err("Choose at least one bookmark to move".to_string());
    }
    let mut data = state.data_guard()?;
    if let Some(collection_id) = collection_id.as_deref() {
        if !data
            .collections
            .iter()
            .any(|collection| collection.id == collection_id)
        {
            return Err("That collection no longer exists".to_string());
        }
    }
    let requested_ids: HashSet<&str> = bookmark_ids.iter().map(String::as_str).collect();
    if requested_ids.len() != bookmark_ids.len() {
        return Err("The bookmark selection contains duplicates".to_string());
    }
    if requested_ids
        .iter()
        .any(|id| !data.bookmarks.iter().any(|bookmark| bookmark.id == *id))
    {
        return Err("One or more search results no longer exist".to_string());
    }
    let updated_at = now();
    let mut changed = false;
    for bookmark in &mut data.bookmarks {
        if requested_ids.contains(bookmark.id.as_str()) && bookmark.collection_id != collection_id {
            bookmark.collection_id.clone_from(&collection_id);
            bookmark.updated_at.clone_from(&updated_at);
            changed = true;
        }
    }
    if changed {
        state.persist(&data)?;
    }
    state.snapshot_from(&data)
}

#[tauri::command]
fn record_bookmark_open(state: State<'_, AppState>, id: String) -> Result<AppSnapshot, String> {
    record_bookmark_open_inner(&state, id)
}

fn record_bookmark_open_inner(state: &AppState, id: String) -> Result<AppSnapshot, String> {
    let mut data = state.data_guard()?;
    let bookmark = data
        .bookmarks
        .iter_mut()
        .find(|bookmark| bookmark.id == id)
        .ok_or_else(|| "That bookmark no longer exists".to_string())?;
    bookmark.open_count = bookmark.open_count.saturating_add(1);
    bookmark.last_opened_at = Some(now());
    state.persist(&data)?;
    state.snapshot_from(&data)
}

struct FetchedPage {
    final_url: Url,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
enum PageFetchPurpose {
    Metadata,
    Archive,
}

impl PageFetchPurpose {
    fn max_bytes(self, settings: &MiscellaneousPreference) -> usize {
        match self {
            Self::Metadata => settings.max_metadata_bytes,
            Self::Archive => MAX_ARCHIVE_BYTES,
        }
    }

    fn too_large_message(self, limit_bytes: usize) -> String {
        let limit_mb = limit_bytes / BYTES_PER_MB;
        match self {
            Self::Metadata => format!(
                "The page is too large for metadata extraction (the limit is {limit_mb} MB)"
            ),
            Self::Archive => format!("The page is too large to save (the limit is {limit_mb} MB)"),
        }
    }
}

fn browser_request_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));
    headers.insert(ACCEPT, HeaderValue::from_static(BROWSER_ACCEPT));
    headers.insert(
        HeaderName::from_static("accept-language"),
        HeaderValue::from_static(BROWSER_ACCEPT_LANGUAGE),
    );
    headers.insert(
        HeaderName::from_static("upgrade-insecure-requests"),
        HeaderValue::from_static("1"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-dest"),
        HeaderValue::from_static("document"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-mode"),
        HeaderValue::from_static("navigate"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-site"),
        HeaderValue::from_static("none"),
    );
    headers.insert(
        HeaderName::from_static("sec-fetch-user"),
        HeaderValue::from_static("?1"),
    );
    headers
}

fn request_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .default_headers(browser_request_headers())
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("Could not prepare page request: {error}"))
}

async fn resolve_url_for_save(raw_url: &str) -> Result<Url, String> {
    let normalized = normalize_url(raw_url)?;
    let client = reqwest::Client::builder()
        .default_headers(browser_request_headers())
        .timeout(Duration::from_secs(URL_RESOLVE_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not prepare URL resolution: {error}"))?;
    let response = match client.get(normalized.clone()).send().await {
        Ok(response) => response,
        Err(_) => return Ok(normalized),
    };
    let mut resolved = response.url().clone();
    resolved.set_fragment(None);
    Ok(resolved)
}

async fn prepare_draft_url_for_save(
    state: &AppState,
    draft: &mut BookmarkDraft,
) -> Result<(), String> {
    let normalized = normalize_url(&draft.url)?;
    let should_resolve = if let Some(id) = draft.id.as_deref() {
        let data = state.data_guard()?;
        match data.bookmarks.iter().find(|bookmark| bookmark.id == id) {
            Some(bookmark) => bookmark.url != normalized.as_str(),
            None => true,
        }
    } else {
        true
    };
    draft.url = if should_resolve {
        resolve_url_for_save(normalized.as_str()).await?
    } else {
        normalized
    }
    .to_string();
    Ok(())
}

async fn fetch_page(
    settings: &MiscellaneousPreference,
    raw_url: &str,
    purpose: PageFetchPurpose,
) -> Result<FetchedPage, String> {
    let max_bytes = purpose.max_bytes(settings);
    let url = normalize_url(raw_url)?;
    let client = request_client(settings.request_timeout_secs)?;
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| friendly_network_error(&error))?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        tokio::time::sleep(PAGE_RATE_LIMIT_RETRY_DELAY).await;
        response = client
            .get(url)
            .send()
            .await
            .map_err(|error| friendly_network_error(&error))?;
    }
    if !response.status().is_success() {
        return Err(format!("The page returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(purpose.too_large_message(max_bytes));
    }
    let final_url = response.url().clone();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the page: {error}"))?
        .to_vec();
    if bytes.len() > max_bytes {
        return Err(purpose.too_large_message(max_bytes));
    }
    Ok(FetchedPage { final_url, bytes })
}

#[tauri::command]
async fn fetch_metadata(state: State<'_, AppState>, raw_url: String) -> Result<MetadataPreview, String> {
    fetch_metadata_inner(&state, &raw_url).await
}

async fn fetch_metadata_inner(state: &AppState, raw_url: &str) -> Result<MetadataPreview, String> {
    let settings = state.miscellaneous_preference()?;
    fetch_metadata_with_settings(&settings, raw_url).await
}

pub async fn fetch_metadata_with_settings(
    settings: &MiscellaneousPreference,
    raw_url: &str,
) -> Result<MetadataPreview, String> {
    let page = fetch_page(settings, raw_url, PageFetchPurpose::Metadata).await?;
    let html = String::from_utf8_lossy(&page.bytes);
    Ok(extract_metadata(&page.final_url, &html))
}

#[tauri::command]
fn get_miscellaneous_status(state: State<'_, AppState>) -> Result<MiscellaneousStatus, String> {
    state.miscellaneous_status()
}

#[tauri::command]
fn configure_miscellaneous(
    state: State<'_, AppState>,
    max_metadata_mb: u32,
    timeout_secs: u32,
) -> Result<MiscellaneousStatus, String> {
    configure_miscellaneous_inner(&state, max_metadata_mb, timeout_secs)
}

fn configure_miscellaneous_inner(
    state: &AppState,
    max_metadata_mb: u32,
    timeout_secs: u32,
) -> Result<MiscellaneousStatus, String> {
    let max_metadata_mb = usize::try_from(max_metadata_mb)
        .map_err(|_| "Choose a maximum page size between 1 and 100 MB".to_string())?;
    if !(MIN_MAX_METADATA_MB..=MAX_MAX_METADATA_MB).contains(&max_metadata_mb) {
        return Err(format!(
            "Choose a maximum page size between {MIN_MAX_METADATA_MB} and {MAX_MAX_METADATA_MB} MB"
        ));
    }
    let timeout_secs = u64::from(timeout_secs);
    if !(MIN_REQUEST_TIMEOUT_SECS..=MAX_REQUEST_TIMEOUT_SECS).contains(&timeout_secs) {
        return Err(format!(
            "Choose a request timeout between {MIN_REQUEST_TIMEOUT_SECS} and {MAX_REQUEST_TIMEOUT_SECS} seconds"
        ));
    }
    let preference = MiscellaneousPreference {
        version: MISC_PREFERENCE_VERSION,
        max_metadata_bytes: max_metadata_mb * BYTES_PER_MB,
        request_timeout_secs: timeout_secs,
    };
    persist_json(&state.miscellaneous_path, &preference)?;
    state.set_miscellaneous_preference(preference)?;
    state.miscellaneous_status()
}

#[tauri::command]
async fn refresh_metadata(state: State<'_, AppState>, id: String) -> Result<AppSnapshot, String> {
    refresh_metadata_inner(&state, id).await
}

async fn refresh_metadata_inner(state: &AppState, id: String) -> Result<AppSnapshot, String> {
    let (raw_url, expected_updated_at) = {
        let data = state.data_guard()?;
        let bookmark = data
            .bookmarks
            .iter()
            .find(|bookmark| bookmark.id == id)
            .ok_or_else(|| "That bookmark no longer exists".to_string())?;
        (bookmark.url.clone(), bookmark.updated_at.clone())
    };
    let metadata = fetch_metadata_inner(state, &raw_url).await?;
    let url = normalize_url(&metadata.url)?;
    let normalized_url = url.to_string();
    let mut data = state.data_guard()?;
    if data
        .bookmarks
        .iter()
        .any(|bookmark| bookmark.id != id && bookmark.url == normalized_url)
    {
        return Err("That refreshed URL is already on your Shelf".to_string());
    }
    let bookmark = data
        .bookmarks
        .iter_mut()
        .find(|bookmark| bookmark.id == id)
        .ok_or_else(|| "That bookmark no longer exists".to_string())?;
    if bookmark.url != raw_url || bookmark.updated_at != expected_updated_at {
        return Err("This bookmark changed while its metadata was being refreshed".to_string());
    }

    bookmark.url = normalized_url;
    bookmark.title = clean_text(&metadata.title);
    bookmark.description = clean_optional(metadata.description).map(|value| clean_text(&value));
    bookmark.image_url = clean_optional(metadata.image_url);
    bookmark.favicon_url = clean_optional(metadata.favicon_url);
    bookmark.site_name = clean_optional(metadata.site_name);
    bookmark.author = clean_optional(metadata.author);
    bookmark.published_at = clean_optional(metadata.published_at);
    bookmark.domain = domain_for(&url);
    bookmark.updated_at = now();
    state.persist(&data)?;
    state.snapshot_from(&data)
}

fn friendly_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The page took too long to respond".to_string()
    } else if error.is_redirect() {
        "The page redirected too many times".to_string()
    } else {
        format!("Could not fetch page details: {error}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

fn clamp_position(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn constrained_window_geometry(
    geometry: WindowGeometry,
    work_area: PhysicalRect<i32, u32>,
    center: bool,
) -> WindowGeometry {
    let width = geometry.size.width.min(work_area.size.width.max(1));
    let height = geometry.size.height.min(work_area.size.height.max(1));
    let work_left = i64::from(work_area.position.x);
    let work_top = i64::from(work_area.position.y);
    let work_right = work_left + i64::from(work_area.size.width);
    let work_bottom = work_top + i64::from(work_area.size.height);
    let max_left = work_right - i64::from(width);
    let max_top = work_bottom - i64::from(height);
    let x = if center {
        work_left + (i64::from(work_area.size.width) - i64::from(width)) / 2
    } else {
        i64::from(geometry.position.x).clamp(work_left, max_left)
    };
    let y = if center {
        work_top + (i64::from(work_area.size.height) - i64::from(height)) / 2
    } else {
        i64::from(geometry.position.y).clamp(work_top, max_top)
    };

    WindowGeometry {
        position: PhysicalPosition::new(clamp_position(x), clamp_position(y)),
        size: PhysicalSize::new(width, height),
    }
}

fn monitor_for_window<R: Runtime>(window: &WebviewWindow<R>) -> Option<tauri::Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| {
            window
                .available_monitors()
                .ok()
                .and_then(|monitors| monitors.into_iter().next())
        })
}

fn fit_initial_window_to_work_area<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(monitor) = monitor_for_window(window) else {
        return;
    };
    let work_area = *monitor.work_area();
    let Ok(inner_size) = window.inner_size() else {
        return;
    };
    let Ok(outer_size) = window.outer_size() else {
        return;
    };
    let horizontal_chrome = outer_size.width.saturating_sub(inner_size.width);
    let vertical_chrome = outer_size.height.saturating_sub(inner_size.height);
    let position = window
        .outer_position()
        .unwrap_or_else(|_| PhysicalPosition::new(work_area.position.x, work_area.position.y));
    let constrained = constrained_window_geometry(
        WindowGeometry {
            position,
            size: outer_size,
        },
        work_area,
        true,
    );
    let target_inner_size = PhysicalSize::new(
        constrained
            .size
            .width
            .saturating_sub(horizontal_chrome)
            .max(1),
        constrained
            .size
            .height
            .saturating_sub(vertical_chrome)
            .max(1),
    );
    if target_inner_size != inner_size {
        let _ = window.set_size(target_inner_size);
    }

    let Ok(final_outer_size) = window.outer_size() else {
        return;
    };
    let Ok(final_position) = window.outer_position() else {
        return;
    };
    let final_geometry = constrained_window_geometry(
        WindowGeometry {
            position: final_position,
            size: final_outer_size,
        },
        work_area,
        true,
    );
    if final_geometry.position != final_position {
        let _ = window.set_position(final_geometry.position);
    }
}

fn collect_visible_text(element: ElementRef<'_>, output: &mut String) {
    let tag_name = element.value().name();
    if matches!(
        tag_name,
        "script" | "style" | "noscript" | "template" | "svg"
    ) {
        return;
    }
    for child in element.children() {
        match child.value() {
            Node::Text(text) => {
                output.push_str(text.as_ref());
                output.push(' ');
            }
            Node::Element(_) => {
                if let Some(child_element) = ElementRef::wrap(child) {
                    collect_visible_text(child_element, output);
                }
            }
            _ => {}
        }
    }
}

fn limit_search_text(text: String) -> String {
    if text.len() <= MAX_SEARCH_TEXT_BYTES {
        return text;
    }
    text.chars().take(MAX_SEARCH_TEXT_BYTES / 2).collect()
}

fn html_search_text(html: &str) -> String {
    let document = Html::parse_document(html);
    let body_selector = Selector::parse("body").expect("body selector is valid");
    let mut raw = String::new();
    if let Some(body) = document.select(&body_selector).next() {
        collect_visible_text(body, &mut raw);
    } else {
        collect_visible_text(document.root_element(), &mut raw);
    }
    limit_search_text(clean_text(&raw))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    source_url: String,
    final_url: String,
    title: String,
    captured_at: String,
    mode: ArchiveMode,
}

fn write_archive_files(
    bookmark: &Bookmark,
    data_path: &Path,
    mode: &ArchiveMode,
    fetched: &FetchedPage,
) -> Result<String, String> {
    let root = archive_root_for_path(data_path);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the archive folder: {error}"))?;
    let folder = archive_folder_name(bookmark);
    let temporary = root.join(format!(".shelf-archive-{}", Uuid::new_v4()));
    fs::create_dir_all(&temporary)
        .map_err(|error| format!("Could not prepare the archive folder: {error}"))?;
    let result = (|| {
        let page = fetched;
        write_archive_bytes(&temporary, "page.html", &page.bytes)?;
        let content = html_search_text(&String::from_utf8_lossy(&page.bytes));
        write_archive_bytes(&temporary, "content.txt", content.as_bytes())?;
        let manifest = ArchiveManifest {
            source_url: bookmark.url.clone(),
            final_url: fetched.final_url.to_string(),
            title: bookmark.title.clone(),
            captured_at: now(),
            mode: mode.clone(),
        };
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("Could not encode the archive manifest: {error}"))?;
        write_archive_bytes(&temporary, "manifest.json", manifest_json.as_bytes())?;
        Ok::<(), String>(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }

    let target = root.join(&folder);
    let old_folder = bookmark.archive.folder.as_deref();
    if old_folder != Some(folder.as_str()) {
        remove_archive_folder(data_path, old_folder)?;
    }
    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("Could not replace the saved page copy: {error}"))?;
    }
    fs::rename(&temporary, &target)
        .map_err(|error| format!("Could not finalize the saved page copy: {error}"))?;
    Ok(folder)
}

async fn capture_archive_for_state(
    state: &AppState,
    id: String,
    mode: ArchiveMode,
    queued_at: Option<String>,
) -> Result<AppSnapshot, String> {
    let bookmark = {
        let data = state.data_guard()?;
        data.bookmarks
            .iter()
            .find(|bookmark| bookmark.id == id)
            .cloned()
            .ok_or_else(|| "That bookmark no longer exists".to_string())?
    };
    let data_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
        .clone();

    if mode == ArchiveMode::None {
        let mut data = state.data_guard()?;
        let _archive_io = state.archive_guard()?;
        remove_archive_folder(&data_path, bookmark.archive.folder.as_deref())?;
        let target = data
            .bookmarks
            .iter_mut()
            .find(|bookmark| bookmark.id == id)
            .ok_or_else(|| "That bookmark no longer exists".to_string())?;
        target.archive = ArchiveInfo::default();
        target.updated_at = now();
        state.persist(&data)?;
        state.remove_pending_archive(&id, None, None)?;
        return state.snapshot_from(&data);
    }

    let fetched = {
        let settings = state.miscellaneous_preference()?;
        fetch_page(&settings, &bookmark.url, PageFetchPurpose::Archive).await?
    };
    let data_check = state.data_guard()?;
    let _archive_io = state.archive_guard()?;
    let folder = write_archive_files(&bookmark, &data_path, &mode, &fetched)?;
    drop(_archive_io);
    drop(data_check);
    let mut data = state.data_guard()?;
    let Some(target) = data.bookmarks.iter_mut().find(|bookmark| bookmark.id == id) else {
        let _archive_io = state.archive_guard()?;
        remove_archive_folder(&data_path, Some(&folder))?;
        return Err("That bookmark no longer exists".to_string());
    };
    if target.archive.mode != mode
        || (queued_at.is_some()
            && !state.pending_snapshot()?.iter().any(|pending| {
                pending.id == id
                    && pending.mode == mode
                    && Some(pending.queued_at.as_str()) == queued_at.as_deref()
            }))
    {
        return state.snapshot_from(&data);
    }
    target.archive = ArchiveInfo {
        mode: mode.clone(),
        folder: Some(folder),
        updated_at: Some(now()),
        ..ArchiveInfo::default()
    };
    target.updated_at = now();
    state.persist(&data)?;
    state.remove_pending_archive(&id, Some(&mode), queued_at.as_deref())?;
    state.snapshot_from(&data)
}

#[tauri::command]
async fn capture_archive(
    state: State<'_, AppState>,
    id: String,
    mode: ArchiveMode,
) -> Result<AppSnapshot, String> {
    capture_archive_inner(&state, id, mode).await
}

async fn capture_archive_inner(
    state: &AppState,
    id: String,
    mode: ArchiveMode,
) -> Result<AppSnapshot, String> {
    if mode != ArchiveMode::None {
        let exists = {
            let data = state.data_guard()?;
            data.bookmarks.iter().any(|bookmark| bookmark.id == id)
        };
        if !exists {
            return Err("That bookmark no longer exists".to_string());
        }
        let queued_at = state.queue_pending_archive(&id, mode.clone())?;
        return capture_archive_for_state(state, id, mode, Some(queued_at)).await;
    }
    capture_archive_for_state(state, id, mode, None).await
}

#[tauri::command]
async fn process_pending_archives(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    process_pending_archives_inner(&state).await
}

async fn process_pending_archives_inner(state: &AppState) -> Result<AppSnapshot, String> {
    if !state.try_start_archive_worker()? {
        return state.snapshot();
    }

    let result: Result<AppSnapshot, String> = async {
        let mut attempted = Vec::<(String, String)>::new();
        loop {
            let pending = state
                .pending_snapshot()?
                .into_iter()
                .filter(|item| {
                    !attempted
                        .iter()
                        .any(|(id, queued_at)| id == &item.id && queued_at == &item.queued_at)
                })
                .collect::<Vec<_>>();
            if pending.is_empty() {
                break;
            }
            for pending in pending {
                let id = pending.id.clone();
                let mode = pending.mode.clone();
                attempted.push((id.clone(), pending.queued_at.clone()));
                if let Err(error) = capture_archive_for_state(
                    state,
                    id.clone(),
                    mode.clone(),
                    Some(pending.queued_at.clone()),
                )
                .await
                {
                    if error == "That bookmark no longer exists" {
                        state.remove_pending_archive(
                            &id,
                            Some(&mode),
                            Some(pending.queued_at.as_str()),
                        )?;
                    } else {
                        eprintln!("Could not finish pending saved copy for {id}: {error}");
                    }
                }
            }
        }
        state.snapshot()
    }
    .await;
    let finish_result = state.finish_archive_worker();
    match (result, finish_result) {
        (Ok(snapshot), Ok(())) => Ok(snapshot),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) | (Err(_), Err(error)) => Err(error),
    }
}

#[tauri::command]
fn get_archive_html(state: State<'_, AppState>, id: String) -> Result<SavedHtmlCopy, String> {
    get_archive_html_inner(&state, id)
}

fn get_archive_html_inner(state: &AppState, id: String) -> Result<SavedHtmlCopy, String> {
    let (bookmark, directory) = archive_directory_for(state, &id)?;
    let _archive_io = state.archive_guard()?;
    let html = read_archive_bytes(&directory, "page.html")?
        .ok_or_else(|| "The saved HTML copy is not available".to_string())
        .and_then(|bytes| {
            String::from_utf8(bytes)
                .map_err(|_| "The saved HTML copy is not valid HTML text".to_string())
        })?;
    let base_url = read_archive_bytes(&directory, "manifest.json")?
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|raw| serde_json::from_str::<ArchiveManifest>(&raw).ok())
        .map(|manifest| manifest.final_url)
        .unwrap_or(bookmark.url);
    Ok(SavedHtmlCopy { html, base_url })
}

#[tauri::command]
fn export_archive_html(state: State<'_, AppState>, id: String, path: String) -> Result<(), String> {
    export_archive_html_inner(&state, id, path)
}

fn export_archive_html_inner(state: &AppState, id: String, path: String) -> Result<(), String> {
    let (_, directory) = archive_directory_for(state, &id)?;
    let _archive_io = state.archive_guard()?;
    let html = read_archive_bytes(&directory, "page.html")?
        .ok_or_else(|| "The saved HTML copy is not available".to_string())?;
    fs::write(Path::new(&path), html)
        .map_err(|error| format!("Could not export the saved HTML copy: {error}"))?;
    Ok(())
}

fn read_archive_text(data_path: &Path, bookmark: &Bookmark) -> String {
    let Some(folder) = bookmark
        .archive
        .folder
        .as_deref()
        .filter(|folder| is_safe_archive_folder(folder))
    else {
        return String::new();
    };
    let directory = archive_root_for_path(data_path).join(folder);
    if let Ok(Some(bytes)) = read_archive_bytes(&directory, "content.txt") {
        let text = limit_search_text(String::from_utf8_lossy(&bytes).into_owned());
        if !text.trim().is_empty() {
            return text;
        }
    }
    if let Ok(Some(bytes)) = read_archive_bytes(&directory, "page.html") {
        return html_search_text(&String::from_utf8_lossy(&bytes));
    }
    String::new()
}

fn edit_distance(left: &str, right: &str) -> usize {
    let mut previous: Vec<usize> = (0..=right.chars().count()).collect();
    for (left_index, left_char) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_char) in right.chars().enumerate() {
            let cost = usize::from(left_char != right_char);
            current.push(
                (current[right_index] + 1)
                    .min(previous[right_index + 1] + 1)
                    .min(previous[right_index] + cost),
            );
        }
        previous = current;
    }
    previous[right.chars().count()]
}

fn fuzzy_word_score(word: &str, query: &str) -> f32 {
    if word == query {
        return 9.0;
    }
    if word.starts_with(query) {
        return 7.0;
    }
    if query.len() <= 64 && word.len() <= 64 {
        let distance = edit_distance(word, query);
        let threshold = (query.chars().count() / 4).max(1);
        if distance <= threshold {
            return 5.0 - distance as f32;
        }
    }
    let mut query_index = 0usize;
    let mut streak = 0usize;
    let mut score = 0.0;
    for character in word.chars() {
        if query.chars().nth(query_index) == Some(character) {
            query_index += 1;
            streak += 1;
            score += 1.0 + streak as f32 * 0.35;
            if query_index == query.chars().count() {
                return score / query.chars().count() as f32 * 3.0;
            }
        } else {
            streak = 0;
        }
    }
    0.0
}

fn archive_term_score(text: &str, words: &[&str], term: &str) -> f32 {
    if text.contains(term) {
        return 10.0;
    }
    words
        .iter()
        .map(|word| fuzzy_word_score(word, term))
        .fold(0.0, f32::max)
}

fn archive_search_score(text: &str, query: &str) -> f32 {
    let text = text.to_lowercase();
    let query_lower = query.to_lowercase();
    let terms: Vec<&str> = query_lower
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .collect();
    if terms.is_empty() {
        return 1.0;
    }
    let words: Vec<&str> = text.split_whitespace().take(250_000).collect();
    let mut score = 0.0;
    for term in terms {
        let term_score = archive_term_score(&text, &words, term);
        if term_score == 0.0 {
            return 0.0;
        }
        score += term_score;
    }
    score
}

#[tauri::command]
fn search_archives(state: State<'_, AppState>, query: String) -> Result<Vec<SearchMatch>, String> {
    search_archives_inner(&state, query)
}

fn search_archives_inner(state: &AppState, query: String) -> Result<Vec<SearchMatch>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let data_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
        .clone();
    let data = state.data_guard()?;
    let _archive_io = state.archive_guard()?;
    let mut matches = data
        .bookmarks
        .iter()
        .filter_map(|bookmark| {
            let text = read_archive_text(&data_path, bookmark);
            let score = archive_search_score(&text, &query);
            (score > 0.0).then(|| SearchMatch {
                id: bookmark.id.clone(),
                score,
            })
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| right.score.total_cmp(&left.score));
    Ok(matches)
}

#[tauri::command]
fn search_archive_terms(
    state: State<'_, AppState>,
    terms: Vec<String>,
) -> Result<Vec<ArchiveTermMatch>, String> {
    let mut normalized_terms = Vec::new();
    for term in terms {
        let normalized = term.trim().to_lowercase();
        if !normalized.is_empty() && !normalized_terms.contains(&normalized) {
            normalized_terms.push(normalized);
        }
    }
    if normalized_terms.is_empty() {
        return Ok(Vec::new());
    }

    let data_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
        .clone();
    let data = state.data_guard()?;
    let _archive_io = state.archive_guard()?;
    let mut matches = Vec::new();
    for bookmark in &data.bookmarks {
        let text = read_archive_text(&data_path, bookmark).to_lowercase();
        if text.is_empty() {
            continue;
        }
        let words: Vec<&str> = text.split_whitespace().take(250_000).collect();
        for term in &normalized_terms {
            let score = archive_term_score(&text, &words, term);
            if score > 0.0 {
                matches.push(ArchiveTermMatch {
                    id: bookmark.id.clone(),
                    term: term.clone(),
                    score,
                });
            }
        }
    }
    Ok(matches)
}

fn meta_value(document: &Html, keys: &[&str]) -> Option<String> {
    let selector = Selector::parse("meta").expect("meta selector is valid");
    for element in document.select(&selector) {
        let value = element.value();
        let key = value
            .attr("property")
            .or_else(|| value.attr("name"))
            .or_else(|| value.attr("itemprop"));
        let Some(key) = key else { continue };
        if keys
            .iter()
            .any(|candidate| key.eq_ignore_ascii_case(candidate))
        {
            if let Some(content) = value.attr("content") {
                let content = clean_text(content);
                if !content.is_empty() {
                    return Some(content);
                }
            }
        }
    }
    None
}

fn link_value(document: &Html, relation: &str, base: &Url) -> Option<String> {
    let selector = Selector::parse("link").expect("link selector is valid");
    for element in document.select(&selector) {
        let value = element.value();
        let rel = value.attr("rel").unwrap_or_default().to_lowercase();
        if rel.split_whitespace().any(|item| item == relation) {
            if let Some(href) = value.attr("href") {
                if let Ok(resolved) = base.join(href.trim()) {
                    return Some(resolved.to_string());
                }
            }
        }
    }
    None
}

fn resolve_url(value: Option<String>, base: &Url) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        if value.is_empty() {
            None
        } else {
            base.join(value).ok().map(|url| url.to_string())
        }
    })
}

fn extract_metadata(url: &Url, html: &str) -> MetadataPreview {
    let document = Html::parse_document(html);
    let title_selector = Selector::parse("title").expect("title selector is valid");
    let document_title = document
        .select(&title_selector)
        .next()
        .map(|element| clean_text(&element.text().collect::<Vec<_>>().join(" ")))
        .filter(|title| !title.is_empty());
    let title = meta_value(&document, &["og:title", "twitter:title"])
        .or(document_title)
        .unwrap_or_else(|| fallback_title(url));
    let description = meta_value(
        &document,
        &["og:description", "twitter:description", "description"],
    )
    .map(|description| description.chars().take(500).collect());
    let image_url = resolve_url(
        meta_value(
            &document,
            &[
                "og:image",
                "og:image:url",
                "twitter:image",
                "twitter:image:src",
            ],
        ),
        url,
    );
    let favicon_url = link_value(&document, "icon", url)
        .or_else(|| link_value(&document, "shortcut", url))
        .or_else(|| link_value(&document, "apple-touch-icon", url));

    MetadataPreview {
        url: url.to_string(),
        title: title.chars().take(300).collect(),
        description,
        image_url,
        favicon_url,
        site_name: meta_value(&document, &["og:site_name"]),
        author: meta_value(&document, &["author", "article:author"]),
        published_at: meta_value(
            &document,
            &["article:published_time", "datePublished", "date"],
        ),
        domain: domain_for(url),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SavedQueryDraft {
    id: Option<String>,
    name: String,
    query: String,
}

fn tokenize_saved_query(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in query.chars() {
        if character.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else if matches!(character, '(' | ')') {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            tokens.push(character.to_string());
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn validate_saved_query_syntax(query: &str) -> Result<(), String> {
    let tokens = tokenize_saved_query(query);
    if tokens.is_empty() {
        return Err("A search query is required".to_string());
    }
    let mut depth = 0usize;
    let mut expecting_term = true;
    for token in tokens {
        let operator = token.eq_ignore_ascii_case("AND") || token.eq_ignore_ascii_case("OR");
        match token.as_str() {
            "(" => {
                depth += 1;
                expecting_term = true;
            }
            ")" => {
                if depth == 0 || expecting_term {
                    return Err("The saved query has mismatched parentheses".to_string());
                }
                depth -= 1;
                expecting_term = false;
            }
            _ if operator => {
                if expecting_term {
                    return Err(format!(
                        "The saved query has an unexpected {token} operator"
                    ));
                }
                expecting_term = true;
            }
            _ => {
                let value = token.strip_prefix('-').unwrap_or(&token);
                let value = value.strip_prefix('#').unwrap_or(value);
                if value.is_empty() {
                    return Err("The saved query contains an empty search term".to_string());
                }
                expecting_term = false;
            }
        }
    }
    if depth != 0 {
        return Err("The saved query has mismatched parentheses".to_string());
    }
    if expecting_term {
        return Err("The saved query cannot end with an operator".to_string());
    }
    Ok(())
}

#[tauri::command]
fn save_saved_query(
    state: State<'_, AppState>,
    draft: SavedQueryDraft,
) -> Result<AppSnapshot, String> {
    save_saved_query_inner(&state, draft)
}

fn save_saved_query_inner(state: &AppState, draft: SavedQueryDraft) -> Result<AppSnapshot, String> {
    let name = clean_text(draft.name.trim());
    if name.is_empty() {
        return Err("A saved query name is required".to_string());
    }
    if name.chars().count() > 100 {
        return Err("The saved query name is too long".to_string());
    }
    let query = draft.query.trim().to_string();
    if query.chars().count() > 2_000 {
        return Err("The saved query is too long".to_string());
    }
    validate_saved_query_syntax(&query)?;

    let mut data = state.data_guard()?;
    if data.saved_queries.iter().any(|saved_query| {
        saved_query.name.eq_ignore_ascii_case(&name)
            && Some(saved_query.id.as_str()) != draft.id.as_deref()
    }) {
        return Err("A saved query with that name already exists".to_string());
    }
    let updated_at = now();
    if let Some(id) = draft.id {
        let saved_query = data
            .saved_queries
            .iter_mut()
            .find(|saved_query| saved_query.id == id)
            .ok_or_else(|| "That saved query no longer exists".to_string())?;
        saved_query.name = name;
        saved_query.query = query;
        saved_query.updated_at = updated_at;
    } else {
        data.saved_queries.push(SavedQuery {
            id: Uuid::new_v4().to_string(),
            name,
            query,
            created_at: updated_at.clone(),
            updated_at,
        });
    }
    state.persist(&data)?;
    state.snapshot_from(&data)
}

#[tauri::command]
fn delete_saved_query(state: State<'_, AppState>, id: String) -> Result<AppSnapshot, String> {
    delete_saved_query_inner(&state, id)
}

fn delete_saved_query_inner(state: &AppState, id: String) -> Result<AppSnapshot, String> {
    let mut data = state.data_guard()?;
    let before = data.saved_queries.len();
    data.saved_queries
        .retain(|saved_query| saved_query.id != id);
    if data.saved_queries.len() == before {
        return Err("That saved query no longer exists".to_string());
    }
    state.persist(&data)?;
    state.snapshot_from(&data)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CollectionDraft {
    id: Option<String>,
    name: String,
    #[serde(default)]
    color: String,
}

#[tauri::command]
fn save_collection(
    state: State<'_, AppState>,
    draft: CollectionDraft,
) -> Result<AppSnapshot, String> {
    save_collection_inner(&state, draft)
}

fn save_collection_inner(state: &AppState, draft: CollectionDraft) -> Result<AppSnapshot, String> {
    let name = clean_text(draft.name.trim());
    if name.is_empty() {
        return Err("A collection name is required".to_string());
    }
    let mut data = state.data_guard()?;
    let duplicate = data.collections.iter().any(|collection| {
        collection.name.eq_ignore_ascii_case(&name)
            && Some(collection.id.as_str()) != draft.id.as_deref()
    });
    if duplicate {
        return Err("A collection with that name already exists".to_string());
    }
    let color = if draft.color.trim().is_empty() {
        "#e87752".to_string()
    } else {
        draft.color.trim().to_string()
    };

    if let Some(id) = draft.id {
        let collection = data
            .collections
            .iter_mut()
            .find(|collection| collection.id == id)
            .ok_or_else(|| "That collection no longer exists".to_string())?;
        collection.name = name;
        collection.color = color;
    } else {
        data.collections.push(Collection {
            id: Uuid::new_v4().to_string(),
            name,
            color,
            created_at: now(),
        });
    }
    state.persist(&data)?;
    state.snapshot_from(&data)
}

#[tauri::command]
fn delete_collection(state: State<'_, AppState>, id: String) -> Result<AppSnapshot, String> {
    delete_collection_inner(&state, id)
}

fn delete_collection_inner(state: &AppState, id: String) -> Result<AppSnapshot, String> {
    let mut data = state.data_guard()?;
    let before = data.collections.len();
    data.collections.retain(|collection| collection.id != id);
    if data.collections.len() == before {
        return Err("That collection no longer exists".to_string());
    }
    for bookmark in &mut data.bookmarks {
        if bookmark.collection_id.as_deref() == Some(id.as_str()) {
            bookmark.collection_id = None;
            bookmark.updated_at = now();
        }
    }
    state.persist(&data)?;
    state.snapshot_from(&data)
}

#[tauri::command]
fn rename_tag(
    state: State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<AppSnapshot, String> {
    rename_tag_inner(&state, old_name, new_name)
}

fn rename_tag_inner(
    state: &AppState,
    old_name: String,
    new_name: String,
) -> Result<AppSnapshot, String> {
    let old_name = normalize_tags(&[old_name])
        .into_iter()
        .next()
        .ok_or_else(|| "Choose a tag to rename".to_string())?;
    let new_name = normalize_tags(&[new_name])
        .into_iter()
        .next()
        .ok_or_else(|| "A new tag name is required".to_string())?;
    if old_name == new_name {
        return Err("Choose a different tag name".to_string());
    }

    let mut data = state.data_guard()?;
    if !data
        .bookmarks
        .iter()
        .any(|bookmark| bookmark.tags.iter().any(|tag| tag == &old_name))
    {
        return Err("That tag no longer exists".to_string());
    }

    let updated_at = now();
    for bookmark in &mut data.bookmarks {
        if bookmark.tags.iter().any(|tag| tag == &old_name) {
            let renamed = bookmark
                .tags
                .iter()
                .map(|tag| {
                    if tag == &old_name {
                        new_name.clone()
                    } else {
                        tag.clone()
                    }
                })
                .collect::<Vec<_>>();
            bookmark.tags = normalize_tags(&renamed);
            bookmark.updated_at = updated_at.clone();
        }
    }
    state.persist(&data)?;
    state.snapshot_from(&data)
}

#[tauri::command]
fn configure_storage(
    state: State<'_, AppState>,
    directory: String,
    file_name: String,
    overwrite: bool,
) -> Result<AppSnapshot, String> {
    configure_storage_inner(&state, directory, file_name, overwrite)
}

fn configure_storage_inner(
    state: &AppState,
    directory: String,
    file_name: String,
    overwrite: bool,
) -> Result<AppSnapshot, String> {
    let directory = PathBuf::from(directory.trim());
    if !directory.is_absolute() {
        return Err("Choose an absolute folder for Shelf data".to_string());
    }

    let mut file_name = file_name.trim().to_string();
    if file_name.is_empty() {
        return Err("A storage file name is required".to_string());
    }
    if file_name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
            )
    }) || matches!(file_name.as_str(), "." | "..")
    {
        return Err("The storage file name contains characters that are not portable".to_string());
    }
    if !Path::new(&file_name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sqlite3"))
    {
        file_name.push_str(".sqlite3");
    }

    let new_path = directory.join(file_name);
    if new_path == state.config_path
        || new_path == state.security_path
        || new_path == state.pending_path
        || new_path == state.api_server.preference_path()
    {
        return Err("Choose a different file name for Shelf storage".to_string());
    }
    let previous_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
        .clone();
    if new_path != previous_path && new_path.exists() && !overwrite {
        return Err(format!(
            "STORAGE_FILE_EXISTS:{} already exists. Replace it with the current Shelf library?",
            new_path.to_string_lossy()
        ));
    }
    let data = state.data_guard()?;
    let _archive_io = state.archive_guard()?;
    copy_archives_for_storage_change(&previous_path, &new_path)?;
    replace_database(&new_path, &data)?;
    persist_json(
        &state.config_path,
        &StoragePreference {
            data_path: new_path.clone(),
        },
    )?;
    let mut current_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?;
    *current_path = new_path.clone();
    let pending_archives = state.pending_snapshot()?;
    Ok(snapshot_from_data(&data, &new_path, pending_archives))
}

fn record_value<'a>(
    headers: &'a csv::StringRecord,
    record: &'a csv::StringRecord,
    names: &[&str],
) -> String {
    for name in names {
        if let Some(index) = headers.iter().position(|header| {
            header
                .trim()
                .trim_start_matches('\u{feff}')
                .eq_ignore_ascii_case(name)
        }) {
            return record.get(index).unwrap_or_default().trim().to_string();
        }
    }
    String::new()
}

fn parse_tags(value: &str) -> Vec<String> {
    let separator = if value.contains('|') { '|' } else { ',' };
    normalize_tags(
        &value
            .split(separator)
            .map(str::to_string)
            .collect::<Vec<_>>(),
    )
}

fn find_collection_id(data: &AppData, name: &str) -> Option<String> {
    data.collections
        .iter()
        .find(|collection| collection.name.eq_ignore_ascii_case(name.trim()))
        .map(|collection| collection.id.clone())
}

const MAX_CSV_IMPORT_ERRORS: usize = 100;

#[derive(Debug)]
struct ParsedCsvRow {
    imported_id: Option<String>,
    url: Url,
    title: String,
    description: Option<String>,
    image_url: Option<String>,
    favicon_url: Option<String>,
    site_name: Option<String>,
    author: Option<String>,
    published_at: Option<String>,
    tags: Vec<String>,
    collection_name: Option<String>,
    favorite: bool,
    archived: bool,
    notes: Option<String>,
    created_at: String,
    updated_at: String,
    last_opened_at: Option<String>,
    open_count: u32,
    restore_activity: bool,
}

struct ParsedCsvImport {
    rows: Vec<ParsedCsvRow>,
    validation: CsvImportValidation,
    fatal: bool,
}

fn timestamp_is_before(left: &str, right: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(left),
        chrono::DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left < right,
        _ => left < right,
    }
}

fn merge_csv_rows(existing: &mut ParsedCsvRow, incoming: ParsedCsvRow) {
    for tag in incoming.tags {
        if !existing.tags.contains(&tag) {
            existing.tags.push(tag);
        }
    }
    if let Some(incoming_notes) = incoming.notes {
        match existing.notes.as_mut() {
            Some(notes) if !notes.split("\n\n").any(|note| note == incoming_notes) => {
                notes.push_str("\n\n");
                notes.push_str(&incoming_notes);
            }
            None => existing.notes = Some(incoming_notes),
            _ => {}
        }
    }
    if existing.title.is_empty() {
        existing.title = incoming.title;
    }
    if existing.description.is_none() {
        existing.description = incoming.description;
    }
    if existing.image_url.is_none() {
        existing.image_url = incoming.image_url;
    }
    if existing.favicon_url.is_none() {
        existing.favicon_url = incoming.favicon_url;
    }
    if existing.site_name.is_none() {
        existing.site_name = incoming.site_name;
    }
    if existing.author.is_none() {
        existing.author = incoming.author;
    }
    if existing.published_at.is_none() {
        existing.published_at = incoming.published_at;
    }
    if existing.collection_name.is_none() {
        existing.collection_name = incoming.collection_name;
    }
    existing.favorite |= incoming.favorite;
    existing.archived |= incoming.archived;
    if timestamp_is_before(&incoming.created_at, &existing.created_at) {
        existing.created_at = incoming.created_at;
    }
    if timestamp_is_before(&existing.updated_at, &incoming.updated_at) {
        existing.updated_at = incoming.updated_at;
    }
    if let Some(incoming_last_opened) = incoming.last_opened_at {
        let replace = match existing.last_opened_at.as_deref() {
            Some(current) => timestamp_is_before(current, &incoming_last_opened),
            None => true,
        };
        if replace {
            existing.last_opened_at = Some(incoming_last_opened);
        }
    }
    existing.open_count = existing.open_count.max(incoming.open_count);
    existing.restore_activity |= incoming.restore_activity;
}

fn has_header(headers: &csv::StringRecord, names: &[&str]) -> bool {
    headers.iter().any(|header| {
        let header = header.trim().trim_start_matches('\u{feff}');
        names.iter().any(|name| header.eq_ignore_ascii_case(name))
    })
}

fn add_csv_issue(
    validation: &mut CsvImportValidation,
    row: Option<usize>,
    message: impl Into<String>,
) {
    validation.error_count += 1;
    if validation.errors.len() < MAX_CSV_IMPORT_ERRORS {
        validation.errors.push(CsvImportIssue {
            row,
            message: message.into(),
        });
    }
}

fn optional_timestamp(value: String, field: &str) -> Result<Option<String>, String> {
    let value = clean_optional(Some(value));
    if let Some(value) = value.as_deref() {
        chrono::DateTime::parse_from_rfc3339(value)
            .map_err(|_| format!("{field} must be an RFC 3339 timestamp"))?;
    }
    Ok(value)
}

fn optional_bool(value: String, field: &str) -> Result<bool, String> {
    if value.is_empty() {
        return Ok(false);
    }
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "y" | "on" => Ok(true),
        "false" | "0" | "no" | "n" | "off" => Ok(false),
        _ => Err(format!("{field} must be true or false")),
    }
}

fn validate_csv_headers(
    headers: &csv::StringRecord,
    importer: CsvImporter,
    validation: &mut CsvImportValidation,
) -> bool {
    let mut valid = true;
    let required: &[(&[&str], &str)] = match importer {
        CsvImporter::Native => &[(&["url", "link", "uri"], "a URL column (url, link, or uri)")],
        CsvImporter::Raindrop => &[
            (&["url"], "url"),
            (&["title"], "title"),
            (&["excerpt"], "excerpt"),
            (&["created"], "created"),
            (&["favorite"], "favorite"),
        ],
    };
    for (aliases, label) in required {
        if !has_header(headers, aliases) {
            valid = false;
            add_csv_issue(validation, None, format!("Missing required {label} column"));
        }
    }
    valid
}

fn parse_csv_import(path: &str, importer: CsvImporter) -> Result<ParsedCsvImport, String> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_path(path)
        .map_err(|error| format!("Could not open CSV file: {error}"))?;
    let headers = reader
        .headers()
        .map_err(|error| format!("Could not read CSV headers: {error}"))?
        .clone();
    let mut validation = CsvImportValidation {
        total_rows: 0,
        valid_rows: 0,
        invalid_rows: 0,
        error_count: 0,
        errors: Vec::new(),
    };
    if !validate_csv_headers(&headers, importer, &mut validation) {
        return Ok(ParsedCsvImport {
            rows: Vec::new(),
            validation,
            fatal: true,
        });
    }

    let mut rows = Vec::new();
    let mut row_by_url = HashMap::<String, usize>::new();
    for (index, result) in reader.records().enumerate() {
        let row_number = index + 2;
        validation.total_rows += 1;
        let record = match result {
            Ok(record) => record,
            Err(error) => {
                validation.invalid_rows += 1;
                add_csv_issue(
                    &mut validation,
                    Some(row_number),
                    format!("Malformed CSV record: {error}"),
                );
                continue;
            }
        };
        let raw_url = record_value(&headers, &record, &["url", "link", "uri"]);
        let url = match normalize_url(&raw_url) {
            Ok(url) => url,
            Err(error) => {
                validation.invalid_rows += 1;
                add_csv_issue(&mut validation, Some(row_number), error);
                continue;
            }
        };
        let result: Result<ParsedCsvRow, String> = (|| {
            let (description_names, image_names, created_names, updated_names) = match importer {
                CsvImporter::Native => (
                    &["description", "summary"][..],
                    &["image_url", "image", "thumbnail"][..],
                    &["created_at", "created"][..],
                    &["updated_at", "updated"][..],
                ),
                CsvImporter::Raindrop => (
                    &["excerpt"][..],
                    &["cover"][..],
                    &["created"][..],
                    &["created"][..],
                ),
            };
            let created_at = optional_timestamp(
                record_value(&headers, &record, created_names),
                "Created time",
            )?
            .unwrap_or_else(now);
            let updated_at = optional_timestamp(
                record_value(&headers, &record, updated_names),
                "Updated time",
            )?
            .unwrap_or_else(|| created_at.clone());
            let last_opened_at = match importer {
                CsvImporter::Native => optional_timestamp(
                    record_value(&headers, &record, &["last_opened_at", "last_opened"]),
                    "Last-opened time",
                )?,
                CsvImporter::Raindrop => None,
            };
            let open_count = match importer {
                CsvImporter::Native => {
                    let value = record_value(&headers, &record, &["open_count", "visits"]);
                    if value.is_empty() {
                        0
                    } else {
                        value.parse::<u32>().map_err(|_| {
                            "Open count must be a non-negative whole number".to_string()
                        })?
                    }
                }
                CsvImporter::Raindrop => 0,
            };
            Ok(ParsedCsvRow {
                imported_id: match importer {
                    CsvImporter::Native => {
                        clean_optional(Some(record_value(&headers, &record, &["id"])))
                    }
                    CsvImporter::Raindrop => None,
                },
                url,
                title: record_value(&headers, &record, &["title", "name"]),
                description: clean_optional(Some(record_value(
                    &headers,
                    &record,
                    description_names,
                )))
                .map(|value| clean_text(&value)),
                image_url: clean_optional(Some(record_value(&headers, &record, image_names))),
                favicon_url: clean_optional(Some(record_value(
                    &headers,
                    &record,
                    &["favicon_url", "favicon", "icon"],
                ))),
                site_name: clean_optional(Some(record_value(
                    &headers,
                    &record,
                    &["site_name", "site"],
                ))),
                author: clean_optional(Some(record_value(
                    &headers,
                    &record,
                    &["author", "creator"],
                ))),
                published_at: clean_optional(Some(record_value(
                    &headers,
                    &record,
                    &["published_at", "published", "date"],
                ))),
                tags: parse_tags(&record_value(
                    &headers,
                    &record,
                    &["tags", "labels", "keywords"],
                )),
                collection_name: clean_optional(Some(record_value(
                    &headers,
                    &record,
                    &["collection", "folder", "group"],
                ))),
                favorite: optional_bool(
                    record_value(&headers, &record, &["favorite", "favourite", "starred"]),
                    "Favorite",
                )?,
                archived: optional_bool(
                    record_value(&headers, &record, &["archived", "archive"]),
                    "Archived",
                )?,
                notes: clean_optional(Some(record_value(&headers, &record, &["notes", "note"]))),
                created_at,
                updated_at,
                last_opened_at,
                open_count,
                restore_activity: matches!(importer, CsvImporter::Native)
                    && has_header(
                        &headers,
                        &["last_opened_at", "last_opened", "open_count", "visits"],
                    ),
            })
        })();
        match result {
            Ok(row) => {
                validation.valid_rows += 1;
                let url = row.url.to_string();
                if let Some(index) = row_by_url.get(&url).copied() {
                    merge_csv_rows(&mut rows[index], row);
                } else {
                    row_by_url.insert(url, rows.len());
                    rows.push(row);
                }
            }
            Err(error) => {
                validation.invalid_rows += 1;
                add_csv_issue(&mut validation, Some(row_number), error);
            }
        }
    }
    if validation.total_rows == 0 {
        add_csv_issue(
            &mut validation,
            None,
            "The CSV file does not contain any bookmark rows",
        );
    }
    Ok(ParsedCsvImport {
        rows,
        validation,
        fatal: false,
    })
}

#[tauri::command]
fn validate_csv_import(
    state: State<'_, AppState>,
    path: String,
    importer: CsvImporter,
) -> Result<CsvImportValidation, String> {
    drop(state.data_guard()?);
    Ok(parse_csv_import(&path, importer)?.validation)
}

#[tauri::command]
fn import_csv(
    state: State<'_, AppState>,
    path: String,
    importer: CsvImporter,
    skip_invalid: bool,
) -> Result<ImportReport, String> {
    import_csv_inner(&state, path, importer, skip_invalid)
}

fn import_csv_inner(
    state: &AppState,
    path: String,
    importer: CsvImporter,
    skip_invalid: bool,
) -> Result<ImportReport, String> {
    let parsed = parse_csv_import(&path, importer)?;
    if parsed.fatal {
        let message = parsed
            .validation
            .errors
            .first()
            .map(|issue| issue.message.as_str())
            .unwrap_or("The CSV format is not supported");
        return Err(message.to_string());
    }
    if parsed.validation.error_count > 0 && !skip_invalid {
        return Err("CSV_VALIDATION_REQUIRED:Some rows are invalid. Review the validation results before importing.".to_string());
    }
    if parsed.rows.is_empty() {
        return Err("No valid bookmark rows were found in the CSV file".to_string());
    }
    let mut data = state.data_guard()?;
    let mut report = ImportReport {
        imported: 0,
        updated: 0,
        skipped: parsed.validation.invalid_rows,
    };

    for row in parsed.rows {
        let url_string = row.url.to_string();
        let collection_id = if row.collection_name.is_none() {
            None
        } else if let Some(id) =
            find_collection_id(&data, row.collection_name.as_deref().unwrap_or_default())
        {
            Some(id)
        } else {
            let id = Uuid::new_v4().to_string();
            data.collections.push(Collection {
                id: id.clone(),
                name: row.collection_name.clone().unwrap_or_default(),
                color: "#e87752".to_string(),
                created_at: now(),
            });
            Some(id)
        };

        if let Some(bookmark) = data
            .bookmarks
            .iter_mut()
            .find(|bookmark| bookmark.url == url_string)
        {
            bookmark.title = if row.title.is_empty() {
                bookmark.title.clone()
            } else {
                clean_text(&row.title)
            };
            bookmark.description = row.description;
            bookmark.image_url = row.image_url;
            bookmark.favicon_url = row.favicon_url;
            bookmark.site_name = row.site_name;
            bookmark.author = row.author;
            bookmark.published_at = row.published_at;
            bookmark.domain = domain_for(&row.url);
            bookmark.tags = row.tags;
            bookmark.collection_id = collection_id;
            bookmark.favorite = row.favorite;
            bookmark.archived = row.archived;
            bookmark.notes = row.notes;
            bookmark.updated_at = row.updated_at;
            if row.restore_activity {
                bookmark.last_opened_at = row.last_opened_at;
                bookmark.open_count = row.open_count;
            }
            report.updated += 1;
        } else {
            let id = row
                .imported_id
                .filter(|imported_id| {
                    !data
                        .bookmarks
                        .iter()
                        .any(|bookmark| bookmark.id == *imported_id)
                })
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            data.bookmarks.push(Bookmark {
                id,
                url: url_string,
                title: if row.title.is_empty() {
                    fallback_title(&row.url)
                } else {
                    clean_text(&row.title)
                },
                description: row.description,
                image_url: row.image_url,
                favicon_url: row.favicon_url,
                site_name: row.site_name,
                author: row.author,
                published_at: row.published_at,
                domain: domain_for(&row.url),
                tags: row.tags,
                collection_id,
                favorite: row.favorite,
                archived: row.archived,
                notes: row.notes,
                created_at: row.created_at,
                updated_at: row.updated_at,
                last_opened_at: row.last_opened_at,
                open_count: row.open_count,
                archive: ArchiveInfo::default(),
            });
            report.imported += 1;
        }
    }

    if report.imported > 0 || report.updated > 0 {
        state.persist(&data)?;
    }
    Ok(report)
}

#[derive(Debug, Serialize)]
struct CsvExportRow {
    id: String,
    url: String,
    title: String,
    description: String,
    image_url: String,
    favicon_url: String,
    site_name: String,
    author: String,
    published_at: String,
    domain: String,
    tags: String,
    collection: String,
    favorite: bool,
    archived: bool,
    notes: String,
    created_at: String,
    updated_at: String,
    last_opened_at: String,
    open_count: u32,
}

#[tauri::command]
fn export_csv(state: State<'_, AppState>, path: String) -> Result<usize, String> {
    export_csv_inner(&state, path)
}

fn export_csv_inner(state: &AppState, path: String) -> Result<usize, String> {
    export_csv_bookmarks(state, path, None)
}

#[tauri::command]
fn export_csv_selection(
    state: State<'_, AppState>,
    path: String,
    bookmark_ids: Vec<String>,
) -> Result<usize, String> {
    export_csv_bookmarks(&state, path, Some(&bookmark_ids))
}

fn export_csv_bookmarks(
    state: &AppState,
    path: String,
    bookmark_ids: Option<&[String]>,
) -> Result<usize, String> {
    let data = state.data_guard()?;
    let collection_names: HashMap<String, String> = data
        .collections
        .iter()
        .map(|collection| (collection.id.clone(), collection.name.clone()))
        .collect();
    let bookmarks: Vec<&Bookmark> = if let Some(bookmark_ids) = bookmark_ids {
        let bookmarks_by_id: HashMap<&str, &Bookmark> = data
            .bookmarks
            .iter()
            .map(|bookmark| (bookmark.id.as_str(), bookmark))
            .collect();
        bookmark_ids
            .iter()
            .filter_map(|id| bookmarks_by_id.get(id.as_str()).copied())
            .collect()
    } else {
        data.bookmarks.iter().collect()
    };
    let file =
        File::create(&path).map_err(|error| format!("Could not create CSV file: {error}"))?;
    let mut writer = csv::Writer::from_writer(file);
    for bookmark in &bookmarks {
        writer
            .serialize(CsvExportRow {
                id: bookmark.id.clone(),
                url: bookmark.url.clone(),
                title: bookmark.title.clone(),
                description: bookmark.description.clone().unwrap_or_default(),
                image_url: bookmark.image_url.clone().unwrap_or_default(),
                favicon_url: bookmark.favicon_url.clone().unwrap_or_default(),
                site_name: bookmark.site_name.clone().unwrap_or_default(),
                author: bookmark.author.clone().unwrap_or_default(),
                published_at: bookmark.published_at.clone().unwrap_or_default(),
                domain: bookmark.domain.clone(),
                tags: bookmark.tags.join("|"),
                collection: bookmark
                    .collection_id
                    .as_ref()
                    .and_then(|id| collection_names.get(id))
                    .cloned()
                    .unwrap_or_default(),
                favorite: bookmark.favorite,
                archived: bookmark.archived,
                notes: bookmark.notes.clone().unwrap_or_default(),
                created_at: bookmark.created_at.clone(),
                updated_at: bookmark.updated_at.clone(),
                last_opened_at: bookmark.last_opened_at.clone().unwrap_or_default(),
                open_count: bookmark.open_count,
            })
            .map_err(|error| format!("Could not write CSV row: {error}"))?;
    }
    writer
        .flush()
        .map_err(|error| format!("Could not finish CSV file: {error}"))?;
    Ok(bookmarks.len())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            let data_path = data_dir.join("shelf.sqlite3");
            let config_path = data_dir.join("storage-preference.json");
            let state = AppState::load(data_path, config_path).map_err(std::io::Error::other)?;
            state
                .attach_app_handle(app.handle().clone())
                .map_err(std::io::Error::other)?;
            app.manage(state.clone());
            tauri::async_runtime::block_on(api::start_from_preference(state));
            if let Some(window) = app.get_webview_window("main") {
                fit_initial_window_to_work_area(&window);
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_security_status,
            unlock_app,
            lock_app,
            configure_security,
            get_snapshot,
            save_bookmark,
            delete_bookmark,
            update_bookmark_status,
            move_bookmarks_to_collection,
            record_bookmark_open,
            fetch_metadata,
            refresh_metadata,
            get_miscellaneous_status,
            configure_miscellaneous,
            capture_archive,
            process_pending_archives,
            get_archive_html,
            export_archive_html,
            search_archives,
            search_archive_terms,
            save_saved_query,
            delete_saved_query,
            save_collection,
            delete_collection,
            rename_tag,
            configure_storage,
            validate_csv_import,
            import_csv,
            export_csv,
            export_csv_selection,
            api::get_api_server_status,
            api::configure_api_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shelf application");
}
