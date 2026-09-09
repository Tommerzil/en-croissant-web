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
