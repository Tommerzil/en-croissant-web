#![allow(dead_code)]
use std::net::SocketAddr;

use chess_server::{build_app, build_router, App, Config};
use tempfile::TempDir;

pub struct TestServer {
    pub base_url: String,
    pub ws_url: String,
    pub data_dir: TempDir,
    pub app: App,
}

pub async fn spawn() -> TestServer {
    let data_dir = TempDir::new().unwrap();
    let web_dir = data_dir.path().join("web");
    std::fs::create_dir_all(&web_dir).unwrap();
    std::fs::write(web_dir.join("index.html"), "<!doctype html><title>test</title>").unwrap();
    let config = Config {
        data_dir: data_dir.path().to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        web_dir,
        sound_dir: data_dir.path().join("sound"),
    };
    let app = build_app(&config).expect("build_app");
    let router = build_router(app.clone(), &config);
    let listener = tokio::net::TcpListener::bind(config.bind).await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    TestServer {
        base_url: format!("http://{addr}"),
        ws_url: format!("ws://{addr}/ws/events"),
        data_dir,
        app,
    }
}

pub async fn cmd(server: &TestServer, name: &str, args: serde_json::Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{}/api/cmd/{name}", server.base_url))
        .json(&args)
        .send()
        .await
        .unwrap()
}
