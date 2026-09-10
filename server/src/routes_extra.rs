use std::path::Path;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use sysinfo::SystemExt;

use crate::app::{ApiError, ApiResult, App};
use crate::paths::{resolve, resolve_engine};

/// Hand-written because `options.reference_db` is a client path nested inside a struct,
/// which the generator cannot jail. The engine argument is jailed like everywhere else.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeGameArgs {
    pub id: String,
    pub engine: String,
    pub go_mode: en_croissant::engine::GoMode,
    pub options: en_croissant::chess::AnalysisOptions,
    pub uci_options: Vec<en_croissant::engine::EngineOption>,
}

async fn analyze_game(State(app): State<App>, Json(mut args): Json<AnalyzeGameArgs>) -> ApiResult {
    // Jail the nested path first so the test below exercises it even with a bogus engine.
    if let Some(db) = args.options.reference_db.take() {
        args.options.reference_db = Some(resolve(&app.ctx.data_dir, &db.to_string_lossy())?);
    }
    let engine = resolve_engine(&app.ctx.data_dir, &args.engine)?
        .to_string_lossy()
        .into_owned();
    let out = en_croissant::chess::analyze_game(
        args.id,
        engine,
        args.go_mode,
        args.options,
        args.uci_options,
        &app.ctx.state,
        app.ctx.clone(),
    )
    .await?;
    Ok(Json(serde_json::to_value(out)?))
}

/// Hand-written because `GameConfig` nests client paths the generator cannot jail:
/// an engine binary inside each of `white`/`black`, and the opening book. The engines
/// are the ones that get executed, so they go through `resolve_engine` exactly like
/// `get_best_moves`; the book is only read, so plain `resolve` is enough.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartGameArgs {
    pub game_id: String,
    pub config: en_croissant::game::GameConfig,
}

fn jail_player(data_dir: &Path, player: &mut en_croissant::game::PlayerConfig) -> Result<(), ApiError> {
    if let en_croissant::game::PlayerConfig::Engine { path, .. } = player {
        *path = resolve_engine(data_dir, path)?.to_string_lossy().into_owned();
    }
    Ok(())
}

async fn start_game(State(app): State<App>, Json(mut args): Json<StartGameArgs>) -> ApiResult {
    // The generated game routes do this too (see GAME_PARAMS in gen_routes.py): a game
    // nobody plays after starting it still has to be reapable. Registering an id whose
    // start then fails costs one no-op abort when the reaper next sweeps.
    app.touch_game(&args.game_id);
    // Jail every nested path before the command runs, so a rejected black engine
    // cannot leave a white engine already spawned.
    jail_player(&app.ctx.data_dir, &mut args.config.white)?;
    jail_player(&app.ctx.data_dir, &mut args.config.black)?;
    if let Some(book) = args.config.opening_book.as_mut() {
        book.path = resolve(&app.ctx.data_dir, &book.path)?
            .to_string_lossy()
            .into_owned();
    }
    let out = en_croissant::game::start_game(
        args.game_id,
        args.config,
        app.ctx.clone(),
        &app.ctx.state,
    )
    .await?;
    Ok(Json(serde_json::to_value(out)?))
}

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
        .route("/api/cmd/analyze_game", post(analyze_game))
        .route("/api/cmd/start_game", post(start_game))
        .route("/api/cmd/close_splashscreen", post(close_splashscreen))
        .route("/api/cmd/memory_size", post(memory_size))
        .route("/api/cmd/is_bmi2_compatible", post(is_bmi2_compatible))
}
