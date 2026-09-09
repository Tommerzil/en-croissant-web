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
