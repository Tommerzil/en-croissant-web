mod common;

use std::time::Duration;

use futures_util::StreamExt;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// Same fixture the analysis-engine tests use: a shell script that answers the UCI
/// handshake and returns `bestmove e2e4` for any `go`.
fn install_stub(s: &common::TestServer) -> String {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub_engine.sh");
    let dst = s.data_dir.path().join("engines/stub.sh");
    std::fs::copy(&src, &dst).unwrap();
    "/engines/stub.sh".to_string()
}

fn engine_player(path: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "engine",
        "name": "Stub",
        "path": path,
        "options": [],
        "go": { "t": "Depth", "c": 1 },
    })
}

fn human_player() -> serde_json::Value {
    serde_json::json!({ "type": "human", "name": "Tester" })
}

fn game_config(white: serde_json::Value, black: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "white": white,
        "black": black,
        // No time control: the clock is off, so the engine's go mode is the one
        // configured above and the test does not race a ticking clock.
        "whiteTimeControl": null,
        "blackTimeControl": null,
        "initialFen": null,
        "initialMoves": [],
        "openingBook": null,
    })
}

/// End to end over HTTP: start a game whose white player is the stub engine, watch the
/// engine's move arrive on the event socket, then read the state back over the route.
#[tokio::test]
async fn start_game_runs_the_engine_and_state_reads_back() {
    let s = common::spawn().await;
    let engine = install_stub(&s);
    let (mut ws, _) = connect_async(&s.ws_url).await.unwrap();

    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "g1",
            "config": game_config(engine_player(&engine), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let state: serde_json::Value = r.json().await.unwrap();
    assert_eq!(state["gameId"], "g1");
    assert_eq!(state["status"], "playing");
    assert_eq!(state["turn"], "white");
    assert_eq!(state["ply"], 0);

    // White is the engine, so the game loop asks it for a move straight away.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next())
            .await
            .expect("game-move-event before deadline")
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["event"] == "game-move-event" {
                assert_eq!(v["payload"]["gameId"], "g1");
                assert_eq!(v["payload"]["moves"][0]["uci"], "e2e4");
                break;
            }
        }
    }

    let r = common::cmd(&s, "get_game_state", serde_json::json!({ "gameId": "g1" })).await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let state: serde_json::Value = r.json().await.unwrap();
    assert_eq!(state["status"], "playing");
    assert_eq!(state["ply"], 1);
    assert_eq!(state["turn"], "black");
    assert_eq!(state["moves"][0]["uci"], "e2e4");
    assert_eq!(state["moves"][0]["san"], "e4");

    // The engine belongs to the game, not to `engine_processes`, so nothing else
    // will reap it; quit it here so the stub does not outlive the test.
    let r = common::cmd(&s, "abort_game", serde_json::json!({ "gameId": "g1" })).await;
    assert_eq!(r.status(), 200);
}

/// A game engine is executed, so it goes through the same jail as an analysis engine:
/// a path outside `engines/` is refused, in either colour's slot, and no game is created.
#[tokio::test]
async fn engine_outside_engines_dir_is_refused() {
    let s = common::spawn().await;
    let engine = install_stub(&s);
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub_engine.sh"),
        s.data_dir.path().join("db/evil.sh"),
    )
    .unwrap();

    for (white, black) in [
        (engine_player("/db/evil.sh"), human_player()),
        (engine_player(&engine), engine_player("/db/evil.sh")),
    ] {
        let r = common::cmd(
            &s,
            "start_game",
            serde_json::json!({ "gameId": "evil", "config": game_config(white, black) }),
        )
        .await;
        assert_eq!(r.status(), 500);
        let msg = r.text().await.unwrap();
        assert!(
            msg.contains("engine must be under /engines"),
            "must fail on the engine jail: {msg}"
        );

        // The command never ran, so no game was registered under that id.
        let r = common::cmd(&s, "get_game_state", serde_json::json!({ "gameId": "evil" })).await;
        assert_eq!(r.status(), 500);
    }
}

/// `..` traversal out of the data dir is refused too, not just a sibling directory.
#[tokio::test]
async fn engine_path_traversal_is_refused() {
    let s = common::spawn().await;
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "esc",
            "config": game_config(engine_player("/engines/../../bin/sh"), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 500);
    let msg = r.text().await.unwrap();
    assert!(msg.contains("escapes data dir"), "{msg}");
}
