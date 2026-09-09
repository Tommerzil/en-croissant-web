pub mod app;
pub mod engines;
pub mod fs_api;
pub mod kv;
pub mod paths;
pub mod routes_extra;
pub mod routes_gen;
pub mod static_files;
pub mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use en_croissant::ctx::ServerCtx;
use en_croissant::AppState;

pub use app::App;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: PathBuf,
    pub bind: SocketAddr,
    pub web_dir: PathBuf,
    pub sound_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let data_dir = std::env::var_os("CHESS_DATA_DIR")
            .map(PathBuf::from)
            .ok_or("CHESS_DATA_DIR is required")?;
        let bind = std::env::var("CHESS_BIND")
            .unwrap_or_else(|_| "0.0.0.0:8090".into())
            .parse()
            .map_err(|e| format!("CHESS_BIND: {e}"))?;
        let web_dir = std::env::var_os("CHESS_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or("./dist".into());
        let sound_dir = std::env::var_os("CHESS_SOUND_DIR")
            .map(PathBuf::from)
            .unwrap_or("../sound".into());
        Ok(Self {
            data_dir,
            bind,
            web_dir,
            sound_dir,
        })
    }
}

pub fn build_app(config: &Config) -> App {
    std::fs::create_dir_all(config.data_dir.join("db")).expect("create data dir");
    std::fs::create_dir_all(config.data_dir.join("engines")).expect("create engines dir");
    let (ctx, _rx) = ServerCtx::new(Arc::new(AppState::default()), config.data_dir.clone());
    let app = App::new(ctx);
    engines::spawn_reaper(app.clone(), engines::IDLE_LIMIT, Duration::from_secs(30));
    app
}

pub fn build_router(app: App, config: &Config) -> Router {
    Router::new()
        .merge(fs_api::router())
        .merge(kv::router())
        .merge(routes_extra::router())
        .merge(routes_gen::router())
        .merge(ws::router())
        .merge(static_files::router(&config.web_dir, &config.sound_dir))
        .with_state(app)
}
