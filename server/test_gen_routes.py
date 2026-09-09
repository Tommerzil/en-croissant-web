import textwrap
import unittest

import gen_routes as g

SAMPLE = textwrap.dedent('''
    #[cfg_attr(feature = "tauri", tauri::command)]
    #[cfg_attr(feature = "tauri", specta::specta)]
    pub async fn get_best_moves(
        id: String,
        engine: String,
        tab: String,
        go_mode: GoMode,
        options: EngineOptions,
        app: AppCtx,
        state: AppStateRef<'_>,
    ) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
        todo!()
    }

    #[cfg_attr(feature = "tauri", tauri::command)]
    #[cfg_attr(feature = "tauri", specta::specta)]
    pub fn clear_games(state: AppStateRef<'_>) {
        todo!()
    }

    #[cfg_attr(feature = "tauri", tauri::command)]
    #[cfg_attr(feature = "tauri", specta::specta)]
    pub fn get_opening_from_fen(fen: &str) -> Result<String, Error> {
        todo!()
    }

    #[cfg_attr(feature = "tauri", tauri::command)]
    #[cfg_attr(feature = "tauri", specta::specta)]
    pub async fn convert_pgn(
        files: Vec<PathBuf>,
        db_path: PathBuf,
        timestamp: Option<i32>,
        app: AppCtx,
        title: String,
        description: Option<String>,
        state: AppStateRef<'_>,
    ) -> Result<(), Error> {
        todo!()
    }

    #[cfg_attr(feature = "tauri", tauri::command)]
    #[cfg_attr(feature = "tauri", specta::specta)]
    pub async fn analyze_game(
        id: String,
        engine: String,
        go_mode: GoMode,
        options: AnalysisOptions,
        uci_options: Vec<EngineOption>,
        state: AppStateRef<'_>,
        app: AppCtx,
    ) -> Result<Vec<MoveAnalysis>, Error> {
        todo!()
    }
''')


class GenRoutesTest(unittest.TestCase):
    def setUp(self):
        self.cmds = g.parse_commands(SAMPLE, module="chess")

    def names(self):
        return [c.name for c in self.cmds]

    def test_finds_all_commands(self):
        # analyze_game is in SKIP_FNS (hand-written handler: its options carry a nested path).
        self.assertEqual(self.names(), ["get_best_moves", "clear_games", "get_opening_from_fen", "convert_pgn"])

    def test_async_and_result_detection(self):
        by = {c.name: c for c in self.cmds}
        self.assertTrue(by["get_best_moves"].is_async)
        self.assertTrue(by["get_best_moves"].returns_result)
        self.assertFalse(by["clear_games"].is_async)
        self.assertFalse(by["clear_games"].returns_result)
        self.assertTrue(by["get_opening_from_fen"].returns_result)

    def test_params_keep_order_and_kinds(self):
        by = {c.name: c for c in self.cmds}
        kinds = [(p.name, p.kind) for p in by["get_best_moves"].params]
        self.assertEqual(kinds, [
            ("id", "plain"), ("engine", "engine_string"), ("tab", "plain"),
            ("go_mode", "plain"), ("options", "plain"), ("app", "ctx"), ("state", "state"),
        ])
        kinds = [(p.name, p.kind) for p in by["convert_pgn"].params]
        self.assertEqual(kinds[:3], [("files", "paths"), ("db_path", "path"), ("timestamp", "plain")])
        self.assertEqual([p.kind for p in by["get_opening_from_fen"].params], ["str_ref"])

    def test_render_handler_shape(self):
        by = {c.name: c for c in self.cmds}
        src = g.render_command(by["get_best_moves"])
        self.assertIn('#[serde(rename_all = "camelCase")]', src)
        self.assertIn("pub struct GetBestMovesArgs", src)
        self.assertIn("pub go_mode: GoMode", src)
        self.assertIn("app.touch_tab(&args.tab);", src)
        self.assertIn("resolve_engine(&app.ctx.data_dir, &args.engine)?", src)
        self.assertIn("en_croissant::chess::get_best_moves(", src)
        # get_best_moves runs for the engine's lifetime: it is detached with a short grace wait.
        self.assertIn("tokio::spawn(async move", src)
        self.assertIn("tokio::time::timeout(", src)

        src = g.render_command(by["clear_games"])
        self.assertNotIn(".await", src)
        self.assertIn("serde_json::Value::Null", src)

        src = g.render_command(by["get_opening_from_fen"])
        self.assertIn("&args.fen", src)

    def test_router_lists_every_route(self):
        src = g.render_router(self.cmds)
        for n in self.names():
            self.assertIn(f'.route("/api/cmd/{n}", post({n}))', src)


if __name__ == "__main__":
    unittest.main()
