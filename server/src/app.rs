use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::time::Instant;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use dashmap::DashMap;
use en_croissant::ctx::ServerCtx;

#[derive(Clone)]
pub struct App {
    pub ctx: ServerCtx,
    /// Number of open /ws/events sockets.
    pub clients: Arc<AtomicUsize>,
    /// Last command that named a tab, keyed by tab id. Drives the idle reaper.
    pub last_seen: Arc<DashMap<String, Instant>>,
    /// Serializes the two background engine killers (the idle reaper and the
    /// post-disconnect sweep). Upstream `kill_engine` / `kill_engines` hold a
    /// DashMap shard guard on `engine_processes` across `process.kill().await`
    /// (`src-tauri/src/chess.rs`), so two killers touching the same shard
    /// concurrently can stall each other. Upstream is not ours to change; we
    /// keep the killers from interleaving instead.
    pub reap_lock: Arc<tokio::sync::Mutex<()>>,
}

impl App {
    pub fn new(ctx: ServerCtx) -> Self {
        Self {
            ctx,
            clients: Arc::new(AtomicUsize::new(0)),
            last_seen: Arc::new(DashMap::new()),
            reap_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn touch_tab(&self, tab: &str) {
        self.last_seen.insert(tab.to_string(), Instant::now());
    }
}

/// Errors become HTTP 500 with a JSON string body, matching what the generated
/// frontend bindings expect to receive as the thrown value.
#[derive(Debug)]
pub struct ApiError(pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(self.0)).into_response()
    }
}

impl From<en_croissant::error::Error> for ApiError {
    fn from(e: en_croissant::error::Error) -> Self {
        ApiError(e.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError(e.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError(e.to_string())
    }
}

pub type ApiResult = Result<Json<serde_json::Value>, ApiError>;
