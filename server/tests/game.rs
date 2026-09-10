mod common;

use std::sync::atomic::Ordering;
use std::time::Duration;

use en_croissant::game::GameStatus;
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

/// An engine that plays a real line instead of answering `e2e4` to everything, so an
/// engine-versus-engine game keeps going rather than ending on ply 2 with an illegal
/// move. Paces itself at roughly ten plies a second.
fn install_replay(s: &common::TestServer) -> String {
    let src =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/replay_engine.sh");
    let dst = s.data_dir.path().join("engines/replay.sh");
    std::fs::copy(&src, &dst).unwrap();
    "/engines/replay.sh".to_string()
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

/// A browser is attached, and the game sends nothing: no commands, no moves. This is a
/// human thinking through a slow time control, and the timestamps on their own would
/// call it abandoned after ten minutes and abort it with the clock still running.
/// Nothing here is observed over HTTP -- every game route refreshes the stamp, so a
/// polling assertion would keep the game alive by asking about it.
#[tokio::test]
async fn a_game_with_a_client_connected_is_not_reaped() {
    let s = common::spawn().await;
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "watched",
            "config": game_config(human_player(), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());

    // Held for the rest of the test: dropping the stream closes the socket.
    let (_ws, _) = connect_async(&s.ws_url).await.unwrap();
    // The upgrade callback runs after the handshake response, so the count lags the
    // connect; the reaper must not start before the client is registered.
    let mut connected = false;
    for _ in 0..100 {
        if s.app.clients.load(Ordering::SeqCst) == 1 {
            connected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(connected, "the event socket never registered");

    chess_server::engines::spawn_game_reaper(
        s.app.clone(),
        Duration::from_millis(200),
        Duration::from_millis(50),
    );
    tokio::time::sleep(Duration::from_millis(800)).await;

    assert!(
        s.app.games_last_seen.contains_key("watched"),
        "a game with a client attached must not be reaped"
    );
    assert!(
        s.app.ctx.state.game_manager.get_game_state("watched").await.is_ok(),
        "the watched game was torn down"
    );
    common::cmd(&s, "abort_game", serde_json::json!({ "gameId": "watched" })).await;
}

/// The other side of that gate. A game that has already ended is not being played by
/// anybody, so an open browser tab must not keep it -- and the controller holding its
/// engine children -- alive: the loop has told the engines to quit, but the children are
/// only reaped when the controller drops, and this sweep is the only thing that drops
/// it. A user playing several games in one sitting would otherwise pile up a defunct
/// process per engine until the last tab closed.
///
/// Human versus human and resigned over HTTP, so the game is finished at a known moment
/// with no engine to race. The proof that the leak is closed is the controller being
/// gone from the manager -- not a process count, since the engine child of a finished
/// game is a zombie by then and `stub_processes` filters those out.
#[tokio::test]
async fn a_finished_game_is_cleaned_up_even_with_a_client_connected() {
    let s = common::spawn().await;
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "resigned",
            "config": game_config(human_player(), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());

    let r = common::cmd(
        &s,
        "resign_game",
        serde_json::json!({ "gameId": "resigned", "color": "white" }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    assert_ne!(
        s.app.ctx.state.game_manager.get_game_state("resigned").await.unwrap().status,
        GameStatus::Playing,
        "the game should have finished"
    );

    // Subscribed after the resignation, so the real game-over event -- emitted inside
    // that handler, before it answered -- is not in this receiver. Anything that arrives
    // from here on is the reaper inventing a second, contradicting result.
    let mut events = s.app.ctx.events.subscribe();

    // Held for the rest of the test: dropping the stream closes the socket.
    let (_ws, _) = connect_async(&s.ws_url).await.unwrap();
    let mut connected = false;
    for _ in 0..100 {
        if s.app.clients.load(Ordering::SeqCst) == 1 {
            connected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(connected, "the event socket never registered");

    chess_server::engines::spawn_game_reaper(
        s.app.clone(),
        Duration::from_millis(200),
        Duration::from_millis(50),
    );

    let mut cleaned = false;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if !s.app.games_last_seen.contains_key("resigned") {
            cleaned = true;
            break;
        }
    }
    assert!(cleaned, "a finished game was not cleaned up while a client was connected");
    assert!(
        s.app.clients.load(Ordering::SeqCst) == 1,
        "the socket closed early; the gate was never under test"
    );
    assert!(
        s.app.ctx.state.game_manager.get_game_state("resigned").await.is_err(),
        "the finished game was forgotten but its controller, and its engines, were kept"
    );

    // Forgetting the stamp is the sweep's last step, so by now any event this game was
    // going to get is already in the channel.
    while let Ok(envelope) = events.try_recv() {
        assert!(
            !(envelope.event == "game-over-event" && envelope.payload["gameId"] == "resigned"),
            "a finished game was given a second game-over event: {}",
            envelope.payload
        );
    }
}

/// An engine-versus-engine game issues no commands at all after `start_game` -- the
/// frontend fetches the state once and then listens for events -- so the only thing
/// that can keep it alive is `spawn_game_activity_watcher` seeing its own moves. No
/// socket is opened, so the client gate cannot be what saves it either.
#[tokio::test]
async fn an_engine_versus_engine_game_making_moves_is_not_reaped() {
    let s = common::spawn().await;
    let engine = install_replay(&s);
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "selfplay",
            "config": game_config(engine_player(&engine), engine_player(&engine)),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());

    // Wait for the game to be under way before arming the reaper, so engine startup is
    // not mistaken for idleness. Read the manager directly: the HTTP route would touch
    // the stamp and hide what is being tested.
    let mut moving = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Ok(state) = s.app.ctx.state.game_manager.get_game_state("selfplay").await {
            if state.ply >= 2 {
                moving = true;
                break;
            }
        }
    }
    assert!(moving, "the engines never started playing");
    let ply_before = s
        .app
        .ctx
        .state
        .game_manager
        .get_game_state("selfplay")
        .await
        .unwrap()
        .ply;

    // Generous against the fixture's ~100 ms a ply: nine other engine-spawning tests
    // share this binary, and a shell `sleep` under load must not read as idleness. The
    // window is still only half the line, so the game cannot run out of moves either.
    chess_server::engines::spawn_game_reaper(
        s.app.clone(),
        Duration::from_millis(500),
        Duration::from_millis(50),
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;

    assert!(
        s.app.games_last_seen.contains_key("selfplay"),
        "a game that is still playing must not be reaped"
    );
    let state = s
        .app
        .ctx
        .state
        .game_manager
        .get_game_state("selfplay")
        .await
        .expect("the playing game was torn down");
    assert_eq!(
        state.status,
        GameStatus::Playing,
        "the fixture's line ran out; the window is longer than the line is"
    );
    assert!(
        state.ply > ply_before,
        "the game stopped moving: ply {} then {}",
        ply_before,
        state.ply
    );

    common::cmd(&s, "abort_game", serde_json::json!({ "gameId": "selfplay" })).await;
}

/// The reaper's teardown is announced. Without this the board just freezes and the
/// player finds out on their next move, which comes back as an error. Watched through
/// the broadcast rather than a WebSocket, because an open socket would (correctly) stop
/// the reaper from running at all.
#[tokio::test]
async fn a_reaped_game_announces_that_it_ended() {
    let s = common::spawn().await;
    let engine = install_stub(&s);
    let mut events = s.app.ctx.events.subscribe();
    let r = common::cmd(
        &s,
        "start_game",
        serde_json::json!({
            "gameId": "announced",
            "config": game_config(engine_player(&engine), human_player()),
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());

    // Which side forfeits depends on whose turn it is, so wait for the engine to have
    // played white's move before arming the reaper -- otherwise a slow engine start
    // decides the assertion. Read the manager directly: the HTTP route would touch the
    // stamp. That move refreshes the stamp through the activity watcher, and the idle
    // limit below expires it again a fifth of a second later.
    let mut moved = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Ok(state) = s.app.ctx.state.game_manager.get_game_state("announced").await {
            if state.ply >= 1 {
                moved = true;
                break;
            }
        }
    }
    assert!(moved, "the engine never played its move");

    chess_server::engines::spawn_game_reaper(
        s.app.clone(),
        Duration::from_millis(200),
        Duration::from_millis(50),
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut over = None;
    while let Ok(Ok(envelope)) = tokio::time::timeout_at(deadline, events.recv()).await {
        if envelope.event == "game-over-event" && envelope.payload["gameId"] == "announced" {
            over = Some(envelope.payload);
            break;
        }
    }
    let over = over.expect("no game-over-event for the reaped game");
    // White is the engine and moved first, so black is to move and forfeits.
    assert_eq!(over["result"]["type"], "whiteWins");
    assert_eq!(over["result"]["reason"], "abandonment");
}
