mod common;

#[test]
fn allowlist() {
    use chess_server::proxy::is_allowed;
    assert!(is_allowed("https://api.chess.com/pub/player/x/games/2024/01"));
    assert!(is_allowed("https://www.chess.com/callback/live/game/1"));
    assert!(is_allowed("https://lichess.org/api/account"));
    // Every endpoint src/utils/lichess/api.tsx actually calls. The hostnames are
    // `.org`, matching Lichess's OpenAPI spec ("The hostname for these endpoints
    // is `explorer.lichess.org`" / "`tablebase.lichess.org`").
    assert!(is_allowed("https://explorer.lichess.org/masters?fen=x"));
    assert!(is_allowed("https://explorer.lichess.org/lichess?fen=x"));
    assert!(is_allowed("https://explorer.lichess.org/player?fen=x&player=y&color=white"));
    assert!(is_allowed("https://tablebase.lichess.org/standard?fen=x"));
    // Regression guard: `.ovh` is a legacy alias of the same backends that the
    // frontend never calls, so it is deliberately not allowlisted. These once
    // stood in for the `.org` names, which left the explorer and the tablebase
    // matching no proxy rule at all.
    assert!(!is_allowed("https://explorer.lichess.ovh/masters?fen=x"));
    assert!(!is_allowed("https://tablebase.lichess.ovh/standard?fen=x"));
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
    // `example.com` is refused before any network I/O; so is the `.ovh`
    // explorer alias, which is what the whole allowlist used to name.
    for url in ["https://example.com/", "https://explorer.lichess.ovh/masters?fen=x"] {
        let r = reqwest::get(format!("{}/api/proxy?url={url}", s.base_url)).await.unwrap();
        assert_eq!(r.status(), 403, "{url} should be refused");
    }
}

/// The `Authorization` flag on the allowlist: Lichess's account-scoped hosts
/// only. The proxy cannot tell which service a bearer token belongs to, so
/// anything else would let a chess.com URL carry a Lichess token to chess.com.
#[test]
fn authorization_scope() {
    use chess_server::proxy::forwards_authorization;
    assert!(forwards_authorization("https://lichess.org/api/account"));
    // All three opening-explorer endpoints are `security: - OAuth2: []` in
    // Lichess's spec, and each takes an optional token in api.tsx.
    assert!(forwards_authorization("https://explorer.lichess.org/masters?fen=x"));
    assert!(forwards_authorization("https://explorer.lichess.org/lichess?fen=x"));
    assert!(forwards_authorization("https://explorer.lichess.org/player?fen=x"));
    // Public endpoints of other operators: no credential has any business here.
    assert!(!forwards_authorization("https://api.chess.com/pub/player/x"));
    assert!(!forwards_authorization("https://www.chess.com/callback/live/game/1"));
    assert!(!forwards_authorization("https://www.chessdb.cn/cdb.php"));
    // Lichess-operated, but the tablebase API is wholly public (`security: []`).
    assert!(!forwards_authorization("https://tablebase.lichess.org/standard?fen=x"));
    // Not allowlisted at all, so no credential either -- including the `.ovh`
    // alias that used to stand in for the explorer host.
    assert!(!forwards_authorization("https://explorer.lichess.ovh/player?fen=x"));
    // A URL the proxy would refuse outright never forwards a credential either,
    // so the flag cannot widen the allowlist.
    assert!(!forwards_authorization("https://evil.example/"));
    assert!(!forwards_authorization("http://lichess.org/api/account"));
    assert!(!forwards_authorization("https://lichess.org@evil.example/"));
    assert!(!forwards_authorization("https://lichess.org:8443/api/account"));
}

/// What the proxy actually puts on the wire. `build_upstream` only assembles
/// the request -- `.build()` performs no I/O -- so this stays off the network.
fn upstream_headers(url: &str) -> reqwest::header::HeaderMap {
    use axum::http::{header, HeaderMap, HeaderValue};
    let mut incoming = HeaderMap::new();
    incoming.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    incoming.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer lip_secret"));
    chess_server::proxy::build_upstream(url, &incoming).build().unwrap().headers().clone()
}

#[test]
fn authorization_is_forwarded_to_lichess() {
    for url in [
        "https://lichess.org/api/account",
        "https://explorer.lichess.org/masters?fen=x",
        "https://explorer.lichess.org/lichess?fen=x",
        "https://explorer.lichess.org/player?fen=x&player=y&color=white",
    ] {
        let sent = upstream_headers(url);
        assert_eq!(
            sent.get(reqwest::header::AUTHORIZATION).map(|v| v.as_bytes()),
            Some(&b"Bearer lip_secret"[..]),
            "{url} should carry the token"
        );
        // Forwarded as a sensitive value, so a `{:?}` of the request cannot
        // print the token.
        assert!(sent.get(reqwest::header::AUTHORIZATION).unwrap().is_sensitive());
        // The pre-existing Accept passthrough still works.
        assert_eq!(
            sent.get(reqwest::header::ACCEPT).map(|v| v.as_bytes()),
            Some(&b"application/json"[..])
        );
    }
}

#[test]
fn authorization_is_dropped_for_other_hosts() {
    for url in [
        "https://api.chess.com/pub/player/x/games/archives",
        "https://www.chess.com/callback/live/game/1",
        "https://www.chessdb.cn/cdb.php?action=queryall&board=x&json=1",
        "https://tablebase.lichess.org/standard?fen=x",
    ] {
        let sent = upstream_headers(url);
        assert!(
            sent.get(reqwest::header::AUTHORIZATION).is_none(),
            "{url} must not receive the token"
        );
        // Dropping the credential must not drop the rest of the request.
        assert_eq!(
            sent.get(reqwest::header::ACCEPT).map(|v| v.as_bytes()),
            Some(&b"application/json"[..])
        );
    }
}

/// A request with no `Authorization` at all is unchanged.
#[test]
fn absent_authorization_adds_nothing() {
    use axum::http::HeaderMap;
    let sent = chess_server::proxy::build_upstream("https://lichess.org/api/account", &HeaderMap::new())
        .build()
        .unwrap()
        .headers()
        .clone();
    assert!(sent.get(reqwest::header::AUTHORIZATION).is_none());
    assert!(sent.get(reqwest::header::ACCEPT).is_none());
}
