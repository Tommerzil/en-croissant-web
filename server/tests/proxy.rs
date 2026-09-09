mod common;

#[test]
fn allowlist() {
    use chess_server::proxy::is_allowed;
    assert!(is_allowed("https://api.chess.com/pub/player/x/games/2024/01"));
    assert!(is_allowed("https://www.chess.com/callback/live/game/1"));
    assert!(is_allowed("https://explorer.lichess.ovh/masters?fen=x"));
    // chessdb cloud evaluation (analysis board).
    assert!(is_allowed("https://www.chessdb.cn/cdb.php?action=queryall&board=x&json=1"));
    // The allowlist is exact: the bare apex is not the same host as www.
    assert!(!is_allowed("https://chessdb.cn/cdb.php"));
    assert!(!is_allowed("https://evil.example/api.chess.com"));
    assert!(!is_allowed("http://api.chess.com/insecure"));
    assert!(!is_allowed("file:///etc/passwd"));
    // Non-default port is rejected.
    assert!(!is_allowed("https://api.chess.com:8443/x"));
    // Userinfo trick: the real host is evil.example.
    assert!(!is_allowed("https://api.chess.com@evil.example/"));
    // Url lowercases the host, so this normalises to an allowed host.
    assert_eq!(
        reqwest::Url::parse("https://API.CHESS.COM/x").unwrap().host_str(),
        Some("api.chess.com")
    );
    assert!(is_allowed("https://API.CHESS.COM/x"));
}

#[test]
fn client_is_shared() {
    use chess_server::proxy::client;
    let a = client() as *const reqwest::Client;
    let b = client() as *const reqwest::Client;
    assert_eq!(a, b);
}

#[tokio::test]
async fn disallowed_host_is_403() {
    let s = common::spawn().await;
    let r = reqwest::get(format!("{}/api/proxy?url=https://example.com/", s.base_url)).await.unwrap();
    assert_eq!(r.status(), 403);
}
