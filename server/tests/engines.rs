mod common;

use std::time::Duration;

use futures_util::StreamExt;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

fn install_stub(s: &common::TestServer) -> String {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub_engine.sh");
    let dst = s.data_dir.path().join("engines/stub.sh");
    std::fs::copy(&src, &dst).unwrap();
    "/engines/stub.sh".to_string()
}

fn best_moves_args(engine: &str, tab: &str) -> serde_json::Value {
    serde_json::json!({
        "id": engine, "engine": engine, "tab": tab,
        "goMode": { "t": "Depth", "c": 1 },
        "options": {
            "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "moves": [],
            "extraOptions": [ { "name": "MultiPV", "value": "1" }, { "name": "Threads", "value": "1" }, { "name": "Hash", "value": "16" } ]
        }
    })
}

#[tokio::test]
async fn get_best_moves_streams_best_moves_payload() {
    let s = common::spawn().await;
    let engine = install_stub(&s);
    let (mut ws, _) = connect_async(&s.ws_url).await.unwrap();

    // The command is detached server-side; the HTTP call returns within the grace period.
    let r = common::cmd(&s, "get_best_moves", best_moves_args(&engine, "tab1")).await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next()).await.expect("event before deadline").unwrap().unwrap();
        if let Message::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["event"] == "best-moves-payload" {
                assert_eq!(v["payload"]["tab"], "tab1");
                break;
            }
        }
    }
    wait_for_engines(&s, 1).await;
}

/// The engine map is filled by the detached task after the UCI handshake, so tests poll.
async fn wait_for_engines(s: &common::TestServer, n: usize) {
    for _ in 0..40 {
        if s.app.ctx.state.engine_processes.len() == n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("expected {n} engine(s), found {}", s.app.ctx.state.engine_processes.len());
}

#[tokio::test]
async fn engine_outside_engines_dir_is_refused() {
    let s = common::spawn().await;
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub_engine.sh"),
        s.data_dir.path().join("db/evil.sh"),
    )
    .unwrap();
    let r = common::cmd(&s, "get_best_moves", best_moves_args("/db/evil.sh", "t")).await;
    assert_eq!(r.status(), 500);
    assert_eq!(s.app.ctx.state.engine_processes.len(), 0);
}

#[tokio::test]
async fn idle_reaper_kills_stale_tabs() {
    let s = common::spawn().await;
    let engine = install_stub(&s);
    common::cmd(&s, "get_best_moves", best_moves_args(&engine, "idle")).await;
    wait_for_engines(&s, 1).await;

    chess_server::engines::spawn_reaper(s.app.clone(), Duration::from_millis(200), Duration::from_millis(50));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(s.app.ctx.state.engine_processes.len(), 0);
}

#[tokio::test]
async fn last_client_disconnect_kills_engines_after_grace() {
    let s = common::spawn().await;
    let engine = install_stub(&s);
    let (ws, _) = connect_async(&s.ws_url).await.unwrap();
    common::cmd(&s, "get_best_moves", best_moves_args(&engine, "t")).await;
    wait_for_engines(&s, 1).await;

    chess_server::engines::set_disconnect_grace_for_tests(Duration::from_millis(200));
    drop(ws);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(s.app.ctx.state.engine_processes.len(), 0);
}
