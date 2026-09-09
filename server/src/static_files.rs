use std::path::Path;

use axum::Router;
use tower_http::services::{ServeDir, ServeFile};

use crate::app::App;

/// `/resources/sound/*` serves the repo's sound directory; everything else that is
/// not an API route falls back to the SPA's index.html so router URLs deep-link.
pub fn router(web_dir: &Path, sound_dir: &Path) -> Router<App> {
    let index = ServeFile::new(web_dir.join("index.html"));
    Router::new()
        .nest_service("/resources/sound", ServeDir::new(sound_dir))
        // `.fallback` keeps the fallback's own 200; `.not_found_service` would force 404.
        .fallback_service(ServeDir::new(web_dir).fallback(index))
}
