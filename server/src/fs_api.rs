use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, RequestExt, Router};
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

/// Build a `Content-Disposition` header value that never panics.
///
/// `HeaderValue` rejects control characters and non-visible-ASCII bytes, so the raw filename can
/// never be interpolated: we emit an ASCII-safe `filename=` fallback plus the RFC 5987
/// `filename*=UTF-8''<percent-encoded>` form, and degrade to a bare `attachment` on any error.
fn content_disposition(name: &str) -> header::HeaderValue {
    // ASCII fallback: keep only printable ASCII, drop quotes and backslashes.
    let ascii: String = name
        .chars()
        .filter(|c| matches!(c, ' '..='~') && *c != '"' && *c != '\\')
        .collect();
    let ascii = if ascii.trim().is_empty() { "download".to_string() } else { ascii };

    // RFC 5987 / percent-encoding: anything outside the unreserved set becomes %XX.
    let mut enc = String::with_capacity(name.len());
    for b in name.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => enc.push(*b as char),
            _ => enc.push_str(&format!("%{b:02X}")),
        }
    }

    let v = format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{enc}");
    header::HeaderValue::from_str(&v).unwrap_or_else(|_| header::HeaderValue::from_static("attachment"))
}

async fn file_response(path: &std::path::Path, attachment: bool) -> Result<Response, ApiError> {
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((StatusCode::NOT_FOUND, "not found").into_response())
        }
        Err(e) => return Err(e.into()),
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let stream = tokio_util::io::ReaderStream::new(file);
    let mut resp = (
        [(header::CONTENT_TYPE, mime.essence_str().to_string())],
        Body::from_stream(stream),
    )
        .into_response();
    if attachment {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        resp.headers_mut()
            .insert(header::CONTENT_DISPOSITION, content_disposition(&name));
    }
    Ok(resp)
}

async fn read(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<Response, ApiError> {
    file_response(&resolve(&app.ctx.data_dir, &q.path)?, false).await
}

async fn download(State(app): State<App>, Query(q): Query<PathQuery>) -> Result<Response, ApiError> {
    file_response(&resolve(&app.ctx.data_dir, &q.path)?, true).await
}

async fn write(State(app): State<App>, Query(q): Query<WriteQuery>, req: Request) -> Result<StatusCode, ApiError> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let p = resolve(&app.ctx.data_dir, &q.path)?;
    if let Some(parent) = p.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut f = if q.append == Some(1) {
        tokio::fs::OpenOptions::new().create(true).append(true).open(&p).await?
    } else {
        tokio::fs::File::create(&p).await?
    };
    // `Body` as an extractor ignores DefaultBodyLimit; into_limited_body() re-applies it.
    let mut stream = req.into_limited_body().into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError(e.to_string()))?;
        f.write_all(&chunk).await?;
    }
    f.flush().await?;
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
