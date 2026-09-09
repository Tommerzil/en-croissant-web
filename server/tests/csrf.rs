mod common;

use reqwest::Client;

async fn kv_all(s: &common::TestServer) -> serde_json::Value {
    reqwest::get(format!("{}/api/kv", s.base_url)).await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn cross_site_state_changes_are_rejected() {
    let s = common::spawn().await;
    let c = Client::new();
    let url = format!("{}/api/kv/x", s.base_url);

    // The sendBeacon-shaped attack: a simple request, no preflight, from any page.
    let r = c
        .post(&url)
        .header("sec-fetch-site", "cross-site")
        .header("content-type", "text/plain")
        .body("pwned")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(r.json::<String>().await.unwrap(), "cross-site request rejected");
    assert!(kv_all(&s).await.get("x").is_none(), "the key must not have been written");

    // The app's own beacon and fetches are same-origin.
    let r = c.post(&url).header("sec-fetch-site", "same-origin").body("\"ok\"").send().await.unwrap();
    assert_eq!(r.status(), 204);
    assert_eq!(kv_all(&s).await["x"], "\"ok\"");

    // No header at all: curl, the test harness, any non-browser client.
    let r = c.post(&url).body("\"plain\"").send().await.unwrap();
    assert_eq!(r.status(), 204);
    assert_eq!(kv_all(&s).await["x"], "\"plain\"");
}

#[tokio::test]
async fn the_guard_covers_the_whole_router() {
    let s = common::spawn().await;
    let r = Client::new()
        .get(format!("{}/api/health", s.base_url))
        .header("sec-fetch-site", "cross-site")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
}

#[tokio::test]
async fn cross_site_navigations_still_reach_the_app() {
    // Clicking a link to the app from a chat message or the Tailscale console is
    // a cross-site request; the user must get the app, not a JSON error.
    let s = common::spawn().await;
    let c = Client::new();
    let nav = |r: reqwest::RequestBuilder| {
        r.header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
    };

    let r = nav(c.get(format!("{}/", s.base_url))).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.text().await.unwrap().contains("<title>test</title>"));

    // But a cross-site form post is mode `navigate` too, and is exactly the hole
    // this guard closes.
    let r = nav(c.post(format!("{}/api/kv/x", s.base_url)))
        .header("content-type", "text/plain")
        .body("pwned")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    assert!(kv_all(&s).await.get("x").is_none());
}
