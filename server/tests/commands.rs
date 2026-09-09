mod common;

#[tokio::test]
async fn lex_pgn_roundtrip() {
    let s = common::spawn().await;
    // Move numbers are not tokens (only San/Header/Nag/Comment/Outcome are), so this
    // five-ply game is the shortest input that yields five tokens.
    let r = common::cmd(
        &s,
        "lex_pgn",
        serde_json::json!({ "pgn": "1. e4 e5 2. Nf3 Nc6 3. Bb5" }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let tokens: Vec<serde_json::Value> = r.json().await.unwrap();
    assert!(tokens.len() >= 5, "{tokens:?}");
}

#[tokio::test]
async fn errors_are_json_strings_with_500() {
    let s = common::spawn().await;
    let r = common::cmd(&s, "get_db_info", serde_json::json!({ "file": "/db/missing.db3" })).await;
    assert_eq!(r.status(), 500);
    let msg: String = r.json().await.unwrap();
    assert!(!msg.is_empty());
}

#[tokio::test]
async fn paths_are_jailed() {
    let s = common::spawn().await;
    let r = common::cmd(&s, "file_exists", serde_json::json!({ "path": "../../etc/passwd" })).await;
    assert_eq!(r.status(), 500);
    let r = common::cmd(&s, "file_exists", serde_json::json!({ "path": "/db" })).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<bool>().await.unwrap(), true);
}

#[tokio::test]
async fn convert_pgn_creates_database() {
    let s = common::spawn().await;
    std::fs::write(
        s.data_dir.path().join("db/one.pgn"),
        "[Event \"t\"]\n[White \"A\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n",
    )
    .unwrap();
    let r = common::cmd(
        &s,
        "convert_pgn",
        serde_json::json!({ "files": ["/db/one.pgn"], "dbPath": "/db/one.db3", "timestamp": null, "title": "one", "description": null }),
    )
    .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    let r = common::cmd(&s, "get_db_info", serde_json::json!({ "file": "/db/one.db3" })).await;
    assert_eq!(r.status(), 200);
    let info: serde_json::Value = r.json().await.unwrap();
    // DatabaseInfo has no serde rename, so the field is snake_case.
    assert_eq!(info["game_count"], 1, "{info}");
}

#[tokio::test]
async fn analyze_game_jails_reference_db() {
    let s = common::spawn().await;
    let r = common::cmd(
        &s,
        "analyze_game",
        serde_json::json!({
            "id": "a", "engine": "/engines/none", "goMode": { "t": "Depth", "c": 1 },
            "options": { "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "moves": [], "annotateNovelties": false, "referenceDb": "../../etc/x.db3", "reversed": false },
            "uciOptions": []
        }),
    )
    .await;
    assert_eq!(r.status(), 500);
    let msg: String = r.json().await.unwrap();
    assert!(msg.contains("escapes"), "must fail on the reference_db jail, not the engine: {msg}");
}
