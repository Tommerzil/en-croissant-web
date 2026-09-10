use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use en_croissant::chess::{kill_engine, kill_engines};

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

/// End games that have not seen a command within `idle`, releasing the engines they
/// hold. A game spawns its own pair of engines, kept by the `GameManager` and not in
/// `engine_processes`, so `spawn_reaper` above never sees them; nothing else removes a
/// game either, so without this a user who opens a few games and walks away leaves an
/// engine process per engine per game id running until the server exits.
pub fn spawn_game_reaper(app: App, idle: Duration, tick: Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tick).await;
            // Shared with the engine killers: `abort_game` awaits the game's write lock
            // and each engine's mutex, and the sweep below holds no map guard across
            // those awaits -- the ids are snapshotted first, which drops the DashMap
            // shard read locks. See `App::reap_lock`.
            let _g = app.reap_lock.lock().await;
            let now = Instant::now();
            let stale: Vec<String> = app
                .games_last_seen
                .iter()
                .filter(|e| now.duration_since(*e.value()) > idle)
                .map(|e| e.key().clone())
                .collect();
            for game_id in stale {
                log::info!("reaping abandoned game {game_id}");
                // The teardown the abort_game command already uses: shut the game loop
                // down and quit both engines. A game that has gone already -- aborted,
                // or replaced by a restart under the same id -- is a no-op.
                if let Err(e) = app.ctx.state.game_manager.abort_game(&game_id).await {
                    log::warn!("abort_game failed: {e}");
                }
                app.games_last_seen.remove(&game_id);
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
