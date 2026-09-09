mod common;

#[tokio::test]
async fn health_and_spa_fallback() {
    let s = common::spawn().await;
    let r = reqwest::get(format!("{}/api/health", s.base_url)).await.unwrap();
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["ok"], true);

    // A router URL that is not a file must get index.html, not 404.
    let r = reqwest::get(format!("{}/databases/whatever", s.base_url)).await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.text().await.unwrap().contains("<title>test</title>"));

    let r = common::cmd(&s, "memory_size", serde_json::json!({})).await;
    assert_eq!(r.status(), 200);
    assert!(r.json::<u32>().await.unwrap() > 0);
}
