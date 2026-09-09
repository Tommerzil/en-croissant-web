use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;

use crate::app::{ApiError, App};
use crate::paths::resolve;

#[derive(Deserialize)]
pub struct PathQuery {
    path: String,
}

#[derive(Deserialize)]
pub struct WriteQuery {
    path: String,
    /// `append=1` opens the file in append mode (used by the month-by-month chess.com import).
    append: Option<u8>,
}

#[derive(Deserialize)]
pub struct FromTo {
    from: String,
    to: String,
}

async fn list(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<Json<serde_json::Value>, ApiError> {
    let dir = resolve(&app.ctx.data_dir, &q.path)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        out.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "isDirectory": ft.is_dir(),
            "isFile": ft.is_file(),
            "isSymlink": ft.is_symlink(),
        }));
    }
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(Json(serde_json::Value::Array(out)))
}

async fn stat(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<Json<serde_json::Value>, ApiError> {
    let p = resolve(&app.ctx.data_dir, &q.path)?;
    Ok(Json(match std::fs::metadata(&p) {
        Ok(m) => serde_json::json!({
            "exists": true,
            "isDirectory": m.is_dir(),
            "isFile": m.is_file(),
            "size": m.len(),
            "modifiedMs": m.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64).unwrap_or(0),
        }),
        Err(_) => serde_json::json!({ "exists": false, "isDirectory": false, "isFile": false, "size": 0, "modifiedMs": 0 }),
    }))
}

fn file_response(path: &std::path::Path, attachment: bool) -> Result<Response, ApiError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((StatusCode::NOT_FOUND, "not found").into_response())
        }
        Err(e) => return Err(e.into()),
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut resp = (
        [(header::CONTENT_TYPE, mime.essence_str().to_string())],
        bytes,
    )
        .into_response();
    if attachment {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        resp.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", name.replace('"', "")).parse().unwrap(),
        );
    }
    Ok(resp)
}

async fn read(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<Response, ApiError> {
    file_response(&resolve(&app.ctx.data_dir, &q.path)?, false)
}

async fn download(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<Response, ApiError> {
    file_response(&resolve(&app.ctx.data_dir, &q.path)?, true)
}

async fn write(State(app): State<App>, Query(q): Query<WriteQuery>, body: Bytes) -> Result<StatusCode, ApiError> {
    use std::io::Write;
    let p = resolve(&app.ctx.data_dir, &q.path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if q.append == Some(1) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p)?;
        f.write_all(&body)?;
    } else {
        std::fs::write(&p, &body)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn mkdir(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<StatusCode, ApiError> {
    std::fs::create_dir_all(resolve(&app.ctx.data_dir, &q.path)?)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rename(State(app): State<App>, Json(b): Json<FromTo>) -> Result<StatusCode, ApiError> {
    std::fs::rename(resolve(&app.ctx.data_dir, &b.from)?, resolve(&app.ctx.data_dir, &b.to)?)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn copy(State(app): State<App>, Json(b): Json<FromTo>) -> Result<StatusCode, ApiError> {
    std::fs::copy(resolve(&app.ctx.data_dir, &b.from)?, resolve(&app.ctx.data_dir, &b.to)?)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<StatusCode, ApiError> {
    let p = resolve(&app.ctx.data_dir, &q.path)?;
    if p == app.ctx.data_dir {
        return Err(ApiError("refusing to remove data root".into()));
    }
    match std::fs::metadata(&p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p)?,
        Ok(_) => std::fs::remove_file(&p)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/fs/list", get(list))
        .route("/api/fs/stat", get(stat))
        .route("/api/fs/read", get(read))
        .route("/api/fs/download", get(download))
        // Uploads (.db3 files, full PGN imports) are far above axum's 2 MiB default.
        .route("/api/fs/write", put(write).layer(DefaultBodyLimit::max(512 * 1024 * 1024)))
        .route("/api/fs/mkdir", post(mkdir))
        .route("/api/fs/rename", post(rename))
        .route("/api/fs/copy", post(copy))
        .route("/api/fs", delete(remove))
}
