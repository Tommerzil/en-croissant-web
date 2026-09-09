mod common;

#[test]
fn allowlist() {
    use chess_server::proxy::is_allowed;
    assert!(is_allowed("https://api.chess.com/pub/player/x/games/2024/01"));
    assert!(is_allowed("https://www.chess.com/callback/live/game/1"));
    assert!(is_allowed("https://explorer.lichess.ovh/masters?fen=x"));
    assert!(!is_allowed("https://evil.example/api.chess.com"));
    assert!(!is_allowed("http://api.chess.com/insecure"));
    assert!(!is_allowed("file:///etc/passwd"));
}

#[tokio::test]
async fn disallowed_host_is_403() {
    let s = common::spawn().await;
    let r = reqwest::get(format!("{}/api/proxy?url=https://example.com/", s.base_url)).await.unwrap();
    assert_eq!(r.status(), 403);
}
