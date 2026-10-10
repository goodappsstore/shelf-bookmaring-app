use super::*;
use axum::{
    extract::{Path as AxumPath, Query, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::{
    net::TcpListener,
    sync::{oneshot, Semaphore},
    task::{JoinHandle, JoinSet},
};

const API_VERSION: &str = "v1";
const API_PREFERENCE_VERSION: u32 = 1;
const DEFAULT_INTERFACE: &str = "localhost";
const DEFAULT_PORT: u16 = 9876;
const DEFAULT_BOOKMARK_PAGE_LIMIT: usize = 100;
const MAX_BOOKMARK_PAGE_LIMIT: usize = 1_000;
const MAX_BATCH_BOOKMARKS: usize = 1_000;
const METADATA_FETCH_CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerPreference {
    #[serde(default = "default_api_preference_version")]
    pub version: u32,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_interface")]
    pub interface: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

impl Default for ApiServerPreference {
    fn default() -> Self {
        Self {
            version: API_PREFERENCE_VERSION,
            enabled: false,
            interface: default_interface(),
            port: DEFAULT_PORT,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerStatus {
    pub enabled: bool,
    pub interface: String,
    pub port: u16,
    pub running: bool,
    pub url: String,
    pub error: Option<String>,
}

struct RunningServer {
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

#[derive(Clone)]
pub struct ApiServerManager {
    preference_path: PathBuf,
    preference: Arc<Mutex<ApiServerPreference>>,
    runtime: Arc<tokio::sync::Mutex<Option<RunningServer>>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl ApiServerManager {
    pub fn load(preference_path: PathBuf) -> Self {
        let preference = fs::read_to_string(&preference_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ApiServerPreference>(&raw).ok())
            .and_then(|preference| validate_preference(preference).ok())
            .unwrap_or_default();
        Self {
            preference_path,
            preference: Arc::new(Mutex::new(preference)),
            runtime: Arc::new(tokio::sync::Mutex::new(None)),
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn preference(&self) -> Result<ApiServerPreference, String> {
        self.preference
            .lock()
            .map_err(|_| "Shelf API settings lock was poisoned".to_string())
            .map(|preference| preference.clone())
    }

    pub fn preference_path(&self) -> &Path {
        &self.preference_path
    }

    pub async fn status(&self) -> Result<ApiServerStatus, String> {
        let preference = self.preference()?;
        let mut runtime = self.runtime.lock().await;
        let stopped = runtime
            .as_ref()
            .is_some_and(|server| server.task.is_finished());
        if stopped {
            if let Some(server) = runtime.take() {
                let _ = server.task.await;
            }
            set_last_error(
                &self.last_error,
                Some("The API server stopped unexpectedly".to_string()),
            )?;
        }
        let running = runtime.is_some();
        drop(runtime);
        let error = self
            .last_error
            .lock()
            .map_err(|_| "Shelf API error lock was poisoned".to_string())?
            .clone();
        Ok(status_from(&preference, running, error))
    }

    pub async fn apply(
        &self,
        state: AppState,
        preference: ApiServerPreference,
    ) -> Result<ApiServerStatus, String> {
        let preference = validate_preference(preference)?;
        let previous = self.preference()?;
        let mut runtime = self.runtime.lock().await;
        stop_server(&mut runtime).await;

        let running = if preference.enabled {
            match bind_and_spawn(state.clone(), &preference).await {
                Ok(server) => {
                    *runtime = Some(server);
                    true
                }
                Err(error) => {
                    if previous.enabled {
                        if let Ok(server) = bind_and_spawn(state.clone(), &previous).await {
                            *runtime = Some(server);
                        }
                    }
                    set_last_error(&self.last_error, Some(error.clone()))?;
                    return Err(error);
                }
            }
        } else {
            false
        };

        if let Err(error) = persist_json(&self.preference_path, &preference) {
            stop_server(&mut runtime).await;
            if previous.enabled {
                if let Ok(server) = bind_and_spawn(state, &previous).await {
                    *runtime = Some(server);
                }
            }
            set_last_error(&self.last_error, Some(error.clone()))?;
            return Err(error);
        }
        *self
            .preference
            .lock()
            .map_err(|_| "Shelf API settings lock was poisoned".to_string())? = preference.clone();
        set_last_error(&self.last_error, None)?;
        Ok(status_from(&preference, running, None))
    }

    async fn start_saved(&self, state: AppState) {
        let Ok(preference) = self.preference() else {
            return;
        };
        if !preference.enabled {
            return;
        }
        let mut runtime = self.runtime.lock().await;
        match bind_and_spawn(state, &preference).await {
            Ok(server) => {
                *runtime = Some(server);
                let _ = set_last_error(&self.last_error, None);
            }
            Err(error) => {
                eprintln!("Shelf API server could not start: {error}");
                let _ = set_last_error(&self.last_error, Some(error));
            }
        }
    }
}

fn default_api_preference_version() -> u32 {
    API_PREFERENCE_VERSION
}

fn default_interface() -> String {
    DEFAULT_INTERFACE.to_string()
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn normalize_preference(mut preference: ApiServerPreference) -> ApiServerPreference {
    preference.version = API_PREFERENCE_VERSION;
    preference.interface = preference.interface.trim().to_string();
    if preference.interface.is_empty() {
        preference.interface = default_interface();
    }
    if preference.port == 0 {
        preference.port = DEFAULT_PORT;
    }
    preference
}

fn validate_preference(preference: ApiServerPreference) -> Result<ApiServerPreference, String> {
    if preference.port == 0 {
        return Err("Choose a port between 1 and 65535".to_string());
    }
    let preference = normalize_preference(preference);
    if preference.interface.chars().any(char::is_whitespace)
        || preference.interface.contains("//")
        || preference.interface.contains('/')
    {
        return Err(
            "Enter an interface or host name such as localhost, 127.0.0.1, or 0.0.0.0".to_string(),
        );
    }
    Ok(preference)
}

fn status_from(
    preference: &ApiServerPreference,
    running: bool,
    error: Option<String>,
) -> ApiServerStatus {
    let host = if preference.interface.contains(':') && !preference.interface.starts_with('[') {
        format!("[{}]", preference.interface)
    } else {
        preference.interface.clone()
    };
    ApiServerStatus {
        enabled: preference.enabled,
        interface: preference.interface.clone(),
        port: preference.port,
        running,
        url: format!("http://{host}:{}", preference.port),
        error,
    }
}

fn set_last_error(target: &Mutex<Option<String>>, value: Option<String>) -> Result<(), String> {
    *target
        .lock()
        .map_err(|_| "Shelf API error lock was poisoned".to_string())? = value;
    Ok(())
}

async fn stop_server(runtime: &mut Option<RunningServer>) {
    if let Some(server) = runtime.take() {
        let _ = server.shutdown.send(());
        let _ = server.task.await;
    }
}

async fn bind_and_spawn(
    state: AppState,
    preference: &ApiServerPreference,
) -> Result<RunningServer, String> {
    let listener = TcpListener::bind((preference.interface.as_str(), preference.port))
        .await
        .map_err(|error| {
            format!(
                "Could not bind the API server to {}:{}: {error}",
                preference.interface, preference.port
            )
        })?;
    let (shutdown, receiver) = oneshot::channel();
    let router = router(state);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await
        {
            eprintln!("Shelf API server stopped unexpectedly: {error}");
        }
    });
    Ok(RunningServer { shutdown, task })
}

pub async fn start_from_preference(state: AppState) {
    state.api_server.clone().start_saved(state).await;
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(reference))
        .route("/api/v1", get(reference))
        .route("/api/v1/health", get(health))
        .route("/api/v1/snapshot", get(snapshot))
        .route("/api/v1/bookmarks", get(bookmarks).post(create_bookmark))
        .route("/api/v1/bookmarks/batch", post(create_bookmarks_batch))
        .route(
            "/api/v1/bookmarks/:id",
            get(bookmark).put(replace_bookmark).delete(remove_bookmark),
        )
        .route("/api/v1/bookmarks/:id/status", patch(bookmark_status))
        .route("/api/v1/bookmarks/:id/opened", post(bookmark_opened))
        .route("/api/v1/metadata", post(metadata))
        .route(
            "/api/v1/bookmarks/:id/metadata",
            post(refresh_bookmark_metadata),
        )
        .route(
            "/api/v1/bookmarks/:id/archive",
            put(capture).delete(remove_archive),
        )
        .route("/api/v1/bookmarks/:id/archive/html", get(archive_html))
        .route("/api/v1/archives/search", get(archive_search))
        .route("/api/v1/archives/process-pending", post(process_pending))
        .route(
            "/api/v1/saved-queries",
            get(saved_queries).post(create_saved_query),
        )
        .route(
            "/api/v1/saved-queries/:id",
            put(replace_saved_query).delete(remove_saved_query),
        )
        .route(
            "/api/v1/collections",
            get(collections).post(create_collection),
        )
        .route(
            "/api/v1/collections/:id",
            put(replace_collection).delete(remove_collection),
        )
        .route(
            "/api/v1/security",
            get(security_status).put(configure_security),
        )
        .route("/api/v1/security/lock", post(lock))
        .route("/api/v1/security/unlock", post(unlock))
        .route("/api/v1/storage", put(configure_storage))
        .route("/api/v1/import/csv", post(import_csv))
        .route("/api/v1/export/csv", post(export_csv))
        .route("/api/v1/bookmarks/:id/archive/export", post(export_archive))
        .with_state(state)
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn from_message(message: String) -> Self {
        let status = if message == "Shelf is locked" {
            StatusCode::LOCKED
        } else if message.contains("no longer exists") || message.contains("not available") {
            StatusCode::NOT_FOUND
        } else if message.contains("already") || message.starts_with("STORAGE_FILE_EXISTS:") {
            StatusCode::CONFLICT
        } else if message.contains("Could not fetch") || message.contains("took too long") {
            StatusCode::BAD_GATEWAY
        } else {
            StatusCode::BAD_REQUEST
        };
        Self { status, message }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self::from_message(message)
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

async fn reference() -> Json<Value> {
    Json(json!({
        "name": "Shelf API",
        "version": API_VERSION,
        "basePath": "/api/v1",
        "note": "The API is unauthenticated and respects Shelf's app lock.",
        "resources": ["snapshot", "bookmarks", "metadata", "archives", "saved queries", "collections", "security", "storage", "CSV import/export"]
    }))
}

async fn health(AxumState(state): AxumState<AppState>) -> ApiResult<Value> {
    let security = state.security_status()?;
    Ok(Json(
        json!({ "status": "ok", "version": API_VERSION, "locked": security.locked }),
    ))
}

async fn snapshot(AxumState(state): AxumState<AppState>) -> ApiResult<AppSnapshot> {
    Ok(Json(state.snapshot()?))
}

#[derive(Debug, Deserialize)]
struct BookmarkListQuery {
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_bookmark_page_limit")]
    limit: usize,
}

fn default_bookmark_page_limit() -> usize {
    DEFAULT_BOOKMARK_PAGE_LIMIT
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkListResponse {
    bookmarks: Vec<Bookmark>,
    offset: usize,
    limit: usize,
    total: usize,
}

async fn bookmarks(
    AxumState(state): AxumState<AppState>,
    Query(query): Query<BookmarkListQuery>,
) -> ApiResult<BookmarkListResponse> {
    if query.limit == 0 || query.limit > MAX_BOOKMARK_PAGE_LIMIT {
        return Err(ApiError::from_message(format!(
            "Bookmark page limit must be between 1 and {MAX_BOOKMARK_PAGE_LIMIT}"
        )));
    }

    let (total, mut bookmarks) = {
        let data = state.data_guard()?;
        let total = data.bookmarks.len();
        let bookmarks = if query.offset >= total {
            Vec::new()
        } else {
            let end = query.offset.saturating_add(query.limit).min(total);
            data.bookmarks[query.offset..end].to_vec()
        };
        (total, bookmarks)
    };

    let data_path = state
        .data_path
        .lock()
        .map_err(|_| "Shelf storage path lock was poisoned".to_string())?
        .clone();
    for bookmark in &mut bookmarks {
        bookmark.archive = archive_info_for(bookmark, &data_path);
    }

    Ok(Json(BookmarkListResponse {
        bookmarks,
        offset: query.offset,
        limit: query.limit,
        total,
    }))
}

async fn bookmark(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Bookmark> {
    let bookmark = state
        .snapshot()?
        .bookmarks
        .into_iter()
        .find(|bookmark| bookmark.id == id)
        .ok_or_else(|| ApiError::from_message("That bookmark no longer exists".to_string()))?;
    Ok(Json(bookmark))
}

async fn create_bookmark(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<CreateBookmarkRequest>,
) -> ApiResult<AppSnapshot> {
    let mut draft = prepare_create_drafts(&state, vec![request])
        .await?
        .pop()
        .expect("one create request produces one draft");
    draft.id = None;
    let process_archive = draft.archive_mode != ArchiveMode::None;
    let snapshot = save_bookmark_inner(&state, draft)?;
    state.notify_api_library_changed();
    start_pending_archive_worker(state, process_archive);
    Ok(Json(snapshot))
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum MetadataBehavior {
    Override,
    #[default]
    AddNewOnly,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBookmarkRequest {
    #[serde(flatten)]
    draft: BookmarkDraft,
    #[serde(default)]
    fetch_metadata: bool,
    #[serde(default)]
    metadata_behavior: MetadataBehavior,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchCreateRequest {
    bookmarks: Vec<CreateBookmarkRequest>,
}

fn merge_fetched_metadata(
    mut draft: BookmarkDraft,
    metadata: MetadataPreview,
    behavior: MetadataBehavior,
) -> BookmarkDraft {
    // The final response URL is authoritative after redirects in both modes.
    draft.url = metadata.url;
    match behavior {
        MetadataBehavior::Override => {
            draft.title = Some(metadata.title);
            draft.description = metadata.description;
            draft.image_url = metadata.image_url;
            draft.favicon_url = metadata.favicon_url;
            draft.site_name = metadata.site_name;
            draft.author = metadata.author;
            draft.published_at = metadata.published_at;
        }
        MetadataBehavior::AddNewOnly => {
            if clean_optional(draft.title.clone()).is_none() {
                draft.title = Some(metadata.title);
            }
            if clean_optional(draft.description.clone()).is_none() {
                draft.description = metadata.description;
            }
            if clean_optional(draft.image_url.clone()).is_none() {
                draft.image_url = metadata.image_url;
            }
            if clean_optional(draft.favicon_url.clone()).is_none() {
                draft.favicon_url = metadata.favicon_url;
            }
            if clean_optional(draft.site_name.clone()).is_none() {
                draft.site_name = metadata.site_name;
            }
            if clean_optional(draft.author.clone()).is_none() {
                draft.author = metadata.author;
            }
            if clean_optional(draft.published_at.clone()).is_none() {
                draft.published_at = metadata.published_at;
            }
        }
    }
    draft
}

async fn prepare_create_drafts(
    state: &AppState,
    requests: Vec<CreateBookmarkRequest>,
) -> Result<Vec<BookmarkDraft>, ApiError> {
    let normalized_urls = requests
        .iter()
        .enumerate()
        .map(|(index, request)| {
            normalize_url(&request.draft.url)
                .map_err(|error| ApiError::from_message(format!("Bookmark {}: {error}", index + 1)))
                .map(|url| url.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    {
        let data = state.data_guard()?;
        let mut known_urls = data
            .bookmarks
            .iter()
            .map(|bookmark| bookmark.url.clone())
            .collect::<HashSet<_>>();
        for (index, url) in normalized_urls.iter().enumerate() {
            if !known_urls.insert(url.clone()) {
                return Err(ApiError::from_message(format!(
                    "Bookmark {}: that URL is already on your Shelf or duplicated in this batch",
                    index + 1
                )));
            }
        }
    }

    let mut prepared = vec![None; requests.len()];
    let fetch_settings = state.miscellaneous_preference()?;
    let semaphore = Arc::new(Semaphore::new(METADATA_FETCH_CONCURRENCY));
    let mut fetches = JoinSet::new();

    for (index, (request, normalized_url)) in requests.into_iter().zip(normalized_urls).enumerate()
    {
        let mut draft = request.draft;
        draft.url = normalized_url;
        if !request.fetch_metadata {
            let semaphore = semaphore.clone();
            fetches.spawn(async move {
                let _permit = semaphore
                    .acquire_owned()
                    .await
                    .map_err(|_| (index, "URL resolution queue was closed".to_string()))?;
                draft.url = resolve_url_for_save(&draft.url)
                    .await
                    .map_err(|error| (index, error))?
                    .to_string();
                Ok::<_, (usize, String)>((index, draft))
            });
            continue;
        }
        let semaphore = semaphore.clone();
        let fetch_settings = fetch_settings.clone();
        fetches.spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| (index, "Metadata fetch queue was closed".to_string()))?;
            let metadata = fetch_metadata_with_settings(&fetch_settings, &draft.url)
                .await
                .map_err(|error| (index, error))?;
            Ok::<_, (usize, String)>((
                index,
                merge_fetched_metadata(draft, metadata, request.metadata_behavior),
            ))
        });
    }

    while let Some(result) = fetches.join_next().await {
        let (index, draft) = result
            .map_err(|error| {
                ApiError::from_message(format!("Metadata fetch task failed: {error}"))
            })?
            .map_err(|(index, error)| {
                ApiError::from_message(format!(
                    "Bookmark {} metadata fetch failed: {error}",
                    index + 1
                ))
            })?;
        prepared[index] = Some(draft);
    }

    let prepared = prepared
        .into_iter()
        .map(|draft| draft.expect("every create request produces a draft"))
        .collect::<Vec<_>>();
    {
        let data = state.data_guard()?;
        let mut known_urls = data
            .bookmarks
            .iter()
            .map(|bookmark| bookmark.url.clone())
            .collect::<HashSet<_>>();
        for (index, draft) in prepared.iter().enumerate() {
            if !known_urls.insert(draft.url.clone()) {
                return Err(ApiError::from_message(format!(
                    "Bookmark {}: the resolved URL is already on your Shelf or duplicated in this batch",
                    index + 1
                )));
            }
        }
    }
    Ok(prepared)
}

fn validate_batch_size(size: usize) -> Result<(), ApiError> {
    if size == 0 {
        return Err(ApiError::from_message(
            "A batch must contain at least one bookmark".to_string(),
        ));
    }
    if size > MAX_BATCH_BOOKMARKS {
        return Err(ApiError::from_message(format!(
            "A batch cannot contain more than {MAX_BATCH_BOOKMARKS} bookmarks"
        )));
    }
    Ok(())
}

async fn create_bookmarks_batch(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<BatchCreateRequest>,
) -> ApiResult<AppSnapshot> {
    validate_batch_size(request.bookmarks.len())?;
    let drafts = prepare_create_drafts(&state, request.bookmarks).await?;
    let process_archives = drafts
        .iter()
        .any(|draft| draft.archive_mode != ArchiveMode::None);
    let snapshot = create_bookmarks_batch_inner(&state, drafts)?;
    state.notify_api_library_changed();
    start_pending_archive_worker(state, process_archives);
    Ok(Json(snapshot))
}

async fn replace_bookmark(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(mut draft): Json<BookmarkDraft>,
) -> ApiResult<AppSnapshot> {
    draft.id = Some(id);
    prepare_draft_url_for_save(&state, &mut draft).await?;
    let process_archive = draft.archive_mode != ArchiveMode::None;
    let snapshot = save_bookmark_inner(&state, draft)?;
    start_pending_archive_worker(state, process_archive);
    Ok(Json(snapshot))
}

fn start_pending_archive_worker(state: AppState, should_start: bool) {
    if should_start {
        tokio::spawn(async move {
            if let Err(error) = process_pending_archives_inner(&state).await {
                eprintln!("Shelf API background archive failed: {error}");
            }
        });
    }
}

async fn remove_bookmark(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(delete_bookmark_inner(&state, id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusUpdate {
    favorite: Option<bool>,
    archived: Option<bool>,
}

async fn bookmark_status(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(update): Json<StatusUpdate>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(update_bookmark_status_inner(
        &state,
        id,
        update.favorite,
        update.archived,
    )?))
}

async fn bookmark_opened(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(record_bookmark_open_inner(&state, id)?))
}

#[derive(Deserialize)]
struct UrlRequest {
    url: String,
}

async fn metadata(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<UrlRequest>,
) -> ApiResult<MetadataPreview> {
    Ok(Json(fetch_metadata_inner(&state, &request.url).await?))
}

async fn refresh_bookmark_metadata(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(refresh_metadata_inner(&state, id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRequest {
    #[serde(default = "default_html_mode")]
    mode: ArchiveMode,
}

fn default_html_mode() -> ArchiveMode {
    ArchiveMode::Html
}

async fn capture(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<ArchiveRequest>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(capture_archive_inner(&state, id, request.mode).await?))
}

async fn remove_archive(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(
        capture_archive_inner(&state, id, ArchiveMode::None).await?,
    ))
}

async fn archive_html(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<SavedHtmlCopy> {
    Ok(Json(get_archive_html_inner(&state, id)?))
}

async fn archive_search(
    AxumState(state): AxumState<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Vec<SearchMatch>> {
    Ok(Json(search_archives_inner(
        &state,
        query.get("q").cloned().unwrap_or_default(),
    )?))
}

async fn process_pending(AxumState(state): AxumState<AppState>) -> ApiResult<AppSnapshot> {
    Ok(Json(process_pending_archives_inner(&state).await?))
}

async fn saved_queries(AxumState(state): AxumState<AppState>) -> ApiResult<Vec<SavedQuery>> {
    Ok(Json(state.snapshot()?.saved_queries))
}

async fn create_saved_query(
    AxumState(state): AxumState<AppState>,
    Json(mut draft): Json<SavedQueryDraft>,
) -> ApiResult<AppSnapshot> {
    draft.id = None;
    let snapshot = save_saved_query_inner(&state, draft)?;
    state.notify_api_library_changed();
    Ok(Json(snapshot))
}

async fn replace_saved_query(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(mut draft): Json<SavedQueryDraft>,
) -> ApiResult<AppSnapshot> {
    draft.id = Some(id);
    let snapshot = save_saved_query_inner(&state, draft)?;
    state.notify_api_library_changed();
    Ok(Json(snapshot))
}

async fn remove_saved_query(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<AppSnapshot> {
    let snapshot = delete_saved_query_inner(&state, id)?;
    state.notify_api_library_changed();
    Ok(Json(snapshot))
}

async fn collections(AxumState(state): AxumState<AppState>) -> ApiResult<Vec<Collection>> {
    Ok(Json(state.snapshot()?.collections))
}

async fn create_collection(
    AxumState(state): AxumState<AppState>,
    Json(mut draft): Json<CollectionDraft>,
) -> ApiResult<AppSnapshot> {
    draft.id = None;
    Ok(Json(save_collection_inner(&state, draft)?))
}

async fn replace_collection(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(mut draft): Json<CollectionDraft>,
) -> ApiResult<AppSnapshot> {
    draft.id = Some(id);
    Ok(Json(save_collection_inner(&state, draft)?))
}

async fn remove_collection(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(delete_collection_inner(&state, id)?))
}

async fn security_status(AxumState(state): AxumState<AppState>) -> ApiResult<SecurityStatus> {
    Ok(Json(state.security_status()?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecurityRequest {
    current_password: Option<String>,
    new_password: Option<String>,
    timeout_minutes: u32,
    #[serde(default)]
    remove_password: bool,
}

async fn configure_security(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<SecurityRequest>,
) -> ApiResult<SecurityStatus> {
    Ok(Json(configure_security_inner(
        &state,
        request.current_password,
        request.new_password,
        request.timeout_minutes,
        request.remove_password,
    )?))
}

async fn lock(AxumState(state): AxumState<AppState>) -> ApiResult<SecurityStatus> {
    Ok(Json(state.lock()?))
}

#[derive(Deserialize)]
struct PasswordRequest {
    password: String,
}

async fn unlock(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<PasswordRequest>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(unlock_app_inner(&state, request.password)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageRequest {
    directory: String,
    file_name: String,
    #[serde(default)]
    overwrite: bool,
}

async fn configure_storage(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<StorageRequest>,
) -> ApiResult<AppSnapshot> {
    Ok(Json(configure_storage_inner(
        &state,
        request.directory,
        request.file_name,
        request.overwrite,
    )?))
}

#[derive(Deserialize)]
struct FileRequest {
    path: String,
}

async fn import_csv(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<FileRequest>,
) -> ApiResult<ImportReport> {
    Ok(Json(import_csv_inner(
        &state,
        request.path,
        CsvImporter::Native,
        true,
    )?))
}

async fn export_csv(
    AxumState(state): AxumState<AppState>,
    Json(request): Json<FileRequest>,
) -> ApiResult<Value> {
    Ok(Json(
        json!({ "exported": export_csv_inner(&state, request.path)? }),
    ))
}

async fn export_archive(
    AxumState(state): AxumState<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<FileRequest>,
) -> ApiResult<Value> {
    export_archive_html_inner(&state, id, request.path)?;
    Ok(Json(json!({ "exported": true })))
}

#[tauri::command]
pub async fn get_api_server_status(state: State<'_, AppState>) -> Result<ApiServerStatus, String> {
    state.api_server.status().await
}

#[tauri::command]
pub async fn configure_api_server(
    state: State<'_, AppState>,
    enabled: bool,
    interface: String,
    port: u16,
) -> Result<ApiServerStatus, String> {
    let app_state = state.inner().clone();
    state
        .api_server
        .apply(
            app_state,
            ApiServerPreference {
                version: API_PREFERENCE_VERSION,
                enabled,
                interface,
                port,
            },
        )
        .await
}
