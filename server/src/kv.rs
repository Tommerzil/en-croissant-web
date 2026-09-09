use std::path::Path;

use axum::extract::{DefaultBodyLimit, Path as UrlPath, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use rusqlite::{params, Connection};

use crate::app::{ApiError, App};

fn open(data_dir: &Path) -> Result<Connection, ApiError> {
    let conn = Connection::open(data_dir.join("settings.db3")).map_err(|e| ApiError(e.to_string()))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
    .map_err(|e| ApiError(e.to_string()))?;
    Ok(conn)
}

async fn get_all(State(app): State<App>) -> Result<Json<serde_json::Value>, ApiError> {
    let conn = open(&app.ctx.data_dir)?;
    let mut stmt = conn.prepare("SELECT key, value FROM kv").map_err(|e| ApiError(e.to_string()))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| ApiError(e.to_string()))?;
    let mut map = serde_json::Map::new();
    for row in rows {
        let (k, v) = row.map_err(|e| ApiError(e.to_string()))?;
        map.insert(k, serde_json::Value::String(v));
    }
    Ok(Json(serde_json::Value::Object(map)))
}

async fn set(State(app): State<App>, UrlPath(key): UrlPath<String>, body: String) -> Result<StatusCode, ApiError> {
    let conn = open(&app.ctx.data_dir)?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, body],
    )
    .map_err(|e| ApiError(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove(State(app): State<App>, UrlPath(key): UrlPath<String>) -> Result<StatusCode, ApiError> {
    let conn = open(&app.ctx.data_dir)?;
    conn.execute("DELETE FROM kv WHERE key = ?1", params![key]).map_err(|e| ApiError(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/kv", get(get_all))
        // Upstream keeps whole game trees in per-tab storage, well above axum's 2 MiB default.
        .route(
            "/api/kv/{key}",
            put(set).post(set).delete(remove).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
}
