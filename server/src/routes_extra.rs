use axum::routing::{get, post};
use axum::{Json, Router};
use sysinfo::SystemExt;

use crate::app::{ApiResult, App};

/// The desktop app awaits this at startup; on web it is a no-op.
async fn close_splashscreen() -> ApiResult {
    Ok(Json(serde_json::Value::Null))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn memory_size() -> ApiResult {
    let total_bytes = sysinfo::System::new_all().total_memory();
    let mib = (total_bytes / 1024 / 1024) as u32;
    Ok(Json(serde_json::json!(mib)))
}

async fn is_bmi2_compatible() -> ApiResult {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    let ok = std::is_x86_feature_detected!("bmi2");
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    let ok = false;
    Ok(Json(serde_json::json!(ok)))
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/cmd/close_splashscreen", post(close_splashscreen))
        .route("/api/cmd/memory_size", post(memory_size))
        .route("/api/cmd/is_bmi2_compatible", post(is_bmi2_compatible))
}
