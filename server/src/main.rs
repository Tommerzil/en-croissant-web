use chess_server::{build_app, build_router, Config};

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(2);
        }
    };
    let app = build_app(&config);
    let router = build_router(app, &config);
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .expect("bind");
    log::info!(
        "chess-server listening on {} (data {})",
        config.bind,
        config.data_dir.display()
    );
    axum::serve(listener, router).await.expect("serve");
}
