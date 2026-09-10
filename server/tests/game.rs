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

/// Drain the socket until `window` elapses, counting this game's clock ticks.
async fn count_clock_events(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    game_id: &str,
    window: Duration,
) -> usize {
    let deadline = tokio::time::Instant::now() + window;
    let mut n = 0;
    while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, ws.next()).await {
        if let Message::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            if v["event"] == "clock-update-event" && v["payload"]["gameId"] == game_id {
                n += 1;
            }
        }
    }
    n
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

/// A game with no time control has no clock to tick: it must sit idle instead of
/// broadcasting an empty clock ten times a second for as long as the server runs.
/// A game that does have a clock must still tick.
#[tokio::test]
async fn untimed_game_does_not_tick_while_a_timed_one_does() {
    let s = common::spawn().await;
    let (mut ws, _) = connect_async(&s.ws_url).await.unwrap();

    // Two humans: nothing moves, so every frame in the window came from the ticker.
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "untimed",
            "config": game_config(human_player(), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let ticks = count_clock_events(&mut ws, "untimed", Duration::from_millis(700)).await;
    assert_eq!(ticks, 0, "an untimed game must not tick");

    let mut config = game_config(human_player(), human_player());
    config["whiteTimeControl"] = serde_json::json!({ "initialTime": 60000, "increment": 0 });
    config["blackTimeControl"] = serde_json::json!({ "initialTime": 60000, "increment": 0 });
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({ "gameId": "timed", "config": config }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    // 100 ms ticker, so ~7 in the window; assert only that it is clearly ticking.
    let ticks = count_clock_events(&mut ws, "timed", Duration::from_millis(700)).await;
    assert!(ticks >= 3, "a timed game must still tick, got {ticks}");

    for id in ["untimed", "timed"] {
        common::cmd(&s, "abort_game", serde_json::json!({ "gameId": id })).await;
    }
}

/// Initial moves can finish a game before its loop starts (here, fool's mate). The
/// loop has no clock tick to notice that, so it has to check up front and stop.
#[tokio::test]
async fn game_finished_by_its_initial_moves_reads_back_as_finished() {
    let s = common::spawn().await;
    let engine = install_stub(&s);
    let mut config = game_config(engine_player(&engine), human_player());
    config["initialMoves"] = serde_json::json!(["f2f3", "e7e5", "g2g4", "d8h4"]);

    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({ "gameId": "mated", "config": config }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let state: serde_json::Value = r.json().await.unwrap();
    assert_eq!(state["status"]["finished"]["result"]["type"], "blackWins");

    // The loop stopped instead of asking the engine to move in a mated position, and
    // quit it on the way out -- without the up-front check it would park there, with
    // the engine alive, for as long as the server ran.
    let r = common::cmd(&s, "get_game_state", serde_json::json!({ "gameId": "mated" })).await;
    let state: serde_json::Value = r.json().await.unwrap();
    assert_eq!(state["ply"], 4);
    let mut released = false;
    for _ in 0..60 {
        if stub_processes(&s) == 0 {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(released, "engine still running for a game that was over before its loop");
    common::cmd(&s, "abort_game", serde_json::json!({ "gameId": "mated" })).await;
}

/// Live processes started from this test's data dir. A game's engines are not in
/// `engine_processes`, so this is the only way to see whether they are really gone.
/// Zombies are skipped: an exited child stays listed until tokio reaps it.
fn stub_processes(s: &common::TestServer) -> usize {
    use sysinfo::{ProcessExt, SystemExt};
    let needle = s
        .data_dir
        .path()
        .join("engines/stub.sh")
        .to_string_lossy()
        .into_owned();
    let mut sys = sysinfo::System::new();
    sys.refresh_processes();
    sys.processes()
        .values()
        .filter(|p| p.status() != sysinfo::ProcessStatus::Zombie)
        .filter(|p| p.cmd().iter().any(|arg| arg.contains(&needle)))
        .count()
}

/// A game nobody comes back to holds its engines for the life of the server: they are
/// not in `engine_processes`, so the engine reaper cannot see them, and only
/// `abort_game` or a restart under the same id ever removes a game. The game reaper is
/// what ends it. Tests shorten the idle limit rather than waiting ten minutes.
#[tokio::test]
async fn idle_game_is_reaped_and_its_engines_released() {
    let s = common::spawn().await;
    let engine = install_stub(&s);

    // Engine versus human: white moves once, then the game sits waiting for a player
    // who never comes back, with a live engine process behind it.
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "abandoned",
            "config": game_config(engine_player(&engine), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    assert_eq!(stub_processes(&s), 1, "the game's engine should be running");

    chess_server::engines::spawn_game_reaper(
        s.app.clone(),
        Duration::from_millis(200),
        Duration::from_millis(50),
    );

    // Watched from outside: any command naming the game would touch it and keep it
    // alive, so wait on the reaper's own bookkeeping and on the engine process.
    let mut reaped = false;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if !s.app.games_last_seen.contains_key("abandoned") {
            reaped = true;
            break;
        }
    }
    assert!(reaped, "idle game was not reaped");

    // The engine the game held is gone with it.
    let mut released = false;
    for _ in 0..60 {
        if stub_processes(&s) == 0 {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(released, "game engine still running after the game was reaped");

    // And the game itself was torn down, not just forgotten by the reaper.
    let r = common::cmd(&s, "get_game_state", serde_json::json!({ "gameId": "abandoned" })).await;
    assert_eq!(r.status(), 500, "the reaped game should be gone from the manager");
}

/// A game being played is not idle: every command it answers keeps it alive.
#[tokio::test]
async fn a_game_that_keeps_answering_commands_is_not_reaped() {
    let s = common::spawn().await;
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "active",
            "config": game_config(human_player(), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());

    chess_server::engines::spawn_game_reaper(
        s.app.clone(),
        Duration::from_millis(300),
        Duration::from_millis(50),
    );
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let r = common::cmd(&s, "get_game_state", serde_json::json!({ "gameId": "active" })).await;
        assert_eq!(r.status(), 200, "a game answering commands must not be reaped");
    }
    common::cmd(&s, "abort_game", serde_json::json!({ "gameId": "active" })).await;
}
