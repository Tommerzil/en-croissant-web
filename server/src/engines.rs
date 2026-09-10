use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use en_croissant::chess::{kill_engine, kill_engines};
use en_croissant::ctx::WebEvent;
use en_croissant::game::{GameEndReason, GameMoveEvent, GameOverEvent, GameResult, GameStatus};
use tokio::sync::broadcast::error::RecvError;

use crate::app::App;

pub const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);
pub const DISCONNECT_GRACE: Duration = Duration::from_secs(60);

static GRACE_OVERRIDE: OnceLock<Duration> = OnceLock::new();

/// Tests shorten the grace period; production never calls this.
pub fn set_disconnect_grace_for_tests(d: Duration) {
    let _ = GRACE_OVERRIDE.set(d);
}

fn grace() -> Duration {
    GRACE_OVERRIDE.get().copied().unwrap_or(DISCONNECT_GRACE)
}

/// Kill engines belonging to tabs that have not issued a command within `idle`.
pub fn spawn_reaper(app: App, idle: Duration, tick: Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tick).await;
            // Hold the reap lock for the whole sweep, snapshot included: see
            // `App::reap_lock`. `engine_processes.iter()` takes blocking shard
            // read-locks, so even the snapshot must not race a concurrent kill.
            let _g = app.reap_lock.lock().await;
            let now = Instant::now();
            // `engine_processes` is keyed by (tab, id); `kill_engine` rebuilds that
            // same key from the id it is given.
            let stale: Vec<(String, String)> = app
                .ctx
                .state
                .engine_processes
                .iter()
                .map(|e| e.key().clone())
                .filter(|(tab, _)| match app.last_seen.get(tab) {
                    Some(seen) => now.duration_since(*seen) > idle,
                    None => true,
                })
                .collect();
            for (tab, id) in stale {
                log::info!("reaping idle engine {id} for tab {tab}");
                if let Err(e) = kill_engine(id.clone(), tab.clone(), &app.ctx.state).await {
                    log::warn!("kill_engine failed: {e}");
                }
                app.ctx.state.engine_processes.remove(&(tab.clone(), id));
                app.last_seen.remove(&tab);
            }
        }
    });
}

/// End games that nobody is watching and nothing is happening in, releasing the engines
/// they hold. A game spawns its own pair of engines, kept by the `GameManager` and not
/// in `engine_processes`, so `spawn_reaper` above never sees them; nothing else removes
/// a game either, so without this a user who opens a few games and walks away leaves an
/// engine process per engine per game id running until the server exits.
///
/// "Abandoned" takes two things, not one. A stale timestamp alone is not enough: the
/// frontend fetches a game's state once and then listens for events, so an
/// engine-versus-engine game issues no command at all after `start_game`, and a human
/// thinking through a slow time control issues none either. Both are live games. So a
/// game is only reaped when there is no client attached *and* its stamp is stale --
/// and `spawn_game_activity_watcher` keeps the stamp fresh while moves are being
/// played, which is what makes the second half of that test mean anything.
pub fn spawn_game_reaper(app: App, idle: Duration, tick: Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tick).await;
            // Shared with the engine killers: `abort_game` awaits the game's write lock
            // and each engine's mutex, and the sweep below holds no map guard across
            // those awaits -- the ids are snapshotted first, which drops the DashMap
            // shard read locks. See `App::reap_lock`.
            let _g = app.reap_lock.lock().await;
            // A game with a browser attached is by definition not abandoned. When the
            // last socket closes, `on_client_disconnect` kills the analysis engines and
            // this sweep starts applying to games again.
            if app.clients.load(Ordering::SeqCst) > 0 {
                continue;
            }
            let now = Instant::now();
            let stale: Vec<String> = app
                .games_last_seen
                .iter()
                .filter(|e| now.duration_since(*e.value()) > idle)
                .map(|e| e.key().clone())
                .collect();
            for game_id in stale {
                log::info!("reaping abandoned game {game_id}");
                // Read the game before tearing it down: `abort_game` drops it, and the
                // client is owed a game-over event rather than a board that silently
                // freezes and errors on its next move. A game already finished has had
                // its event; one already gone has nothing to report.
                let ending = app
                    .ctx
                    .state
                    .game_manager
                    .get_game_state(&game_id)
                    .await
                    .ok()
                    .filter(|s| s.status == GameStatus::Playing);
                // The teardown the abort_game command already uses: shut the game loop
                // down and quit both engines. A game that has gone already -- aborted,
                // or replaced by a restart under the same id -- is a no-op.
                if let Err(e) = app.ctx.state.game_manager.abort_game(&game_id).await {
                    log::warn!("abort_game failed: {e}");
                }
                if let Some(state) = ending {
                    // The convention the game loop already uses when a game ends because
                    // one side stopped playing: whoever was to move forfeits.
                    let reason = GameEndReason::Abandonment;
                    let result = if state.turn == "white" {
                        GameResult::BlackWins { reason }
                    } else {
                        GameResult::WhiteWins { reason }
                    };
                    let _ = GameOverEvent {
                        game_id: game_id.clone(),
                        result,
                        moves: state.moves,
                    }
                    .emit(&app.ctx);
                }
                app.forget_game(&game_id);
            }
        }
    });
}

/// Refresh a game's idle stamp whenever the game itself plays a move, so a game that is
/// being played is never mistaken for one that was walked away from.
///
/// The HTTP handlers cannot carry this on their own: an engine-versus-engine game sends
/// no commands once it has started, and the frontend only ever fetches a game's state
/// once before switching to events. The server watches the game's own move events
/// rather than `game.rs` reaching into the server's map: those events already flow
/// through `ServerCtx::events` (`ws.rs` subscribes to the same broadcast), so the shared
/// game module keeps no knowledge of server bookkeeping, nothing is plumbed through
/// `AppCtx`, and the refresh is one DashMap write with no guard held across an await.
///
/// Only `game-move-event` counts as activity. A clocked game broadcasts
/// `clock-update-event` ten times a second whether or not anyone is playing it, so
/// counting those would make every timed game unreapable.
pub fn spawn_game_activity_watcher(app: App) {
    let mut events = app.ctx.events.subscribe();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(envelope) => {
                    if envelope.event != GameMoveEvent::NAME {
                        continue;
                    }
                    if let Some(id) = envelope.payload.get("gameId").and_then(|v| v.as_str()) {
                        // `refresh_game`, not `touch_game`: a game's first move event can
                        // beat `start_game`'s registration, and the no-op refresh that
                        // results is correct -- the insert follows a moment later. Making
                        // this insert would also let an event for an already-reaped game
                        // resurrect its entry.
                        app.refresh_game(id);
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    log::warn!("game activity watcher lagged, dropped {n} events");
                }
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Called by the WebSocket handler when a socket closes. If nobody reconnects
/// within the grace period, every engine is killed.
pub fn on_client_disconnect(app: App) {
    tokio::spawn(async move {
        tokio::time::sleep(grace()).await;
        // Taken before the `is_empty` probe, which is itself a blocking shard
        // read on `engine_processes`: see `App::reap_lock`.
        let _g = app.reap_lock.lock().await;
        if app.clients.load(Ordering::SeqCst) == 0 && !app.ctx.state.engine_processes.is_empty() {
            log::info!("no clients for {:?}, killing all engines", grace());
            // kill_engines matches tabs by prefix; the empty prefix matches all.
            if let Err(e) = kill_engines(String::new(), &app.ctx.state).await {
                log::warn!("kill_engines failed: {e}");
            }
            app.last_seen.clear();
        }
    });
}
