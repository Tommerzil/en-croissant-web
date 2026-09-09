use std::path::Path;

use axum::http::StatusCode;
use axum::routing::any;
use axum::{Json, Router};
use tower_http::services::{ServeDir, ServeFile};

use crate::app::App;

async fn not_found() -> (StatusCode, Json<&'static str>) {
    (StatusCode::NOT_FOUND, Json("not found"))
}

/// `/resources/sound/*` serves the repo's sound directory; everything else that is
/// not an API route falls back to the SPA's index.html so router URLs deep-link.
pub fn router(web_dir: &Path, sound_dir: &Path) -> Router<App> {
    let index = ServeFile::new(web_dir.join("index.html"));
    Router::new()
        .nest_service("/resources/sound", ServeDir::new(sound_dir))
        // Unknown API/WS paths must 404, never fall through to index.html. Real
        // routes are merged before this router, so only unmatched paths land here.
        .route("/api", any(not_found))
        .route("/api/{*rest}", any(not_found))
        .route("/ws", any(not_found))
        .route("/ws/{*rest}", any(not_found))
        // `.fallback` keeps the fallback's own 200; `.not_found_service` would force 404.
        .fallback_service(ServeDir::new(web_dir).fallback(index))
}
