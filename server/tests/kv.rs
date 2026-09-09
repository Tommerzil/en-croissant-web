mod common;

#[tokio::test]
async fn kv_roundtrip_and_persistence() {
    let s = common::spawn().await;
    let c = reqwest::Client::new();
    let r = c.put(format!("{}/api/kv/piece-set", s.base_url)).body("\"alpha\"").send().await.unwrap();
    assert_eq!(r.status(), 204);
    let r = c.post(format!("{}/api/kv/tabs", s.base_url)).body("[]").send().await.unwrap();
    assert_eq!(r.status(), 204);

    let all: serde_json::Value = c.get(format!("{}/api/kv", s.base_url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(all["piece-set"], "\"alpha\"");
    assert_eq!(all["tabs"], "[]");

    let r = c.delete(format!("{}/api/kv/tabs", s.base_url)).send().await.unwrap();
    assert_eq!(r.status(), 204);
    let all: serde_json::Value = c.get(format!("{}/api/kv", s.base_url)).send().await.unwrap().json().await.unwrap();
    assert!(all.get("tabs").is_none());

    assert!(s.data_dir.path().join("settings.db3").exists());
}

#[tokio::test]
async fn kv_accepts_a_large_value() {
    // Upstream keeps whole game trees in per-tab storage, which is far above
    // axum's 2 MiB default body limit.
    let s = common::spawn().await;
    let c = reqwest::Client::new();
    let big = "x".repeat(4 * 1024 * 1024);
    let r = c.put(format!("{}/api/kv/tab-content", s.base_url)).body(big.clone()).send().await.unwrap();
    assert_eq!(r.status(), 204);

    let all: serde_json::Value = c.get(format!("{}/api/kv", s.base_url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(all["tab-content"].as_str().unwrap().len(), 4 * 1024 * 1024);
    assert_eq!(all["tab-content"].as_str().unwrap(), big);
}
