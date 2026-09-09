mod common;

use reqwest::Client;

#[tokio::test]
async fn write_list_read_stat_delete() {
    let s = common::spawn().await;
    let c = Client::new();
    let u = |p: &str| format!("{}{p}", s.base_url);

    let r = c.put(u("/api/fs/write?path=/documents/x/notes.pgn")).body("1. e4 *").send().await.unwrap();
    assert_eq!(r.status(), 204);

    let r = c.get(u("/api/fs/list?path=/documents/x")).send().await.unwrap();
    let entries: Vec<serde_json::Value> = r.json().await.unwrap();
    assert_eq!(entries[0]["name"], "notes.pgn");
    assert_eq!(entries[0]["isFile"], true);

    let r = c.get(u("/api/fs/read?path=/documents/x/notes.pgn")).send().await.unwrap();
    assert_eq!(r.text().await.unwrap(), "1. e4 *");

    let r = c.get(u("/api/fs/stat?path=/documents/x/notes.pgn")).send().await.unwrap();
    let st: serde_json::Value = r.json().await.unwrap();
    assert_eq!(st["exists"], true);
    assert_eq!(st["size"], 7);

    let r = c.get(u("/api/fs/download?path=/documents/x/notes.pgn")).send().await.unwrap();
    assert!(r.headers()["content-disposition"].to_str().unwrap().contains("notes.pgn"));

    let r = c.put(u("/api/fs/write?path=/documents/x/notes.pgn&append=1")).body("\n1. d4 *").send().await.unwrap();
    assert_eq!(r.status(), 204);
    let r = c.get(u("/api/fs/read?path=/documents/x/notes.pgn")).send().await.unwrap();
    assert_eq!(r.text().await.unwrap(), "1. e4 *\n1. d4 *");

    let big = vec![b'x'; 5 * 1024 * 1024];
    let r = c.put(u("/api/fs/write?path=/documents/x/big.bin")).body(big).send().await.unwrap();
    assert_eq!(r.status(), 204, "5 MiB upload must clear the body limit");

    let r = c.post(u("/api/fs/rename")).json(&serde_json::json!({"from": "/documents/x/notes.pgn", "to": "/documents/x/n2.pgn"})).send().await.unwrap();
    assert_eq!(r.status(), 204);

    let r = c.delete(u("/api/fs?path=/documents/x")).send().await.unwrap();
    assert_eq!(r.status(), 204);
    let r = c.get(u("/api/fs/stat?path=/documents/x")).send().await.unwrap();
    assert_eq!(r.json::<serde_json::Value>().await.unwrap()["exists"], false);
}

#[tokio::test]
async fn traversal_is_rejected() {
    let s = common::spawn().await;
    let r = reqwest::get(format!("{}/api/fs/read?path=../Cargo.toml", s.base_url)).await.unwrap();
    assert_eq!(r.status(), 500);
}

#[tokio::test]
async fn read_missing_is_404() {
    let s = common::spawn().await;
    let r = reqwest::get(format!("{}/api/fs/read?path=/nope", s.base_url)).await.unwrap();
    assert_eq!(r.status(), 404);
}

#[tokio::test]
async fn download_non_ascii_filename_uses_rfc5987() {
    let s = common::spawn().await;
    let c = Client::new();
    let u = |p: &str| format!("{}{p}", s.base_url);

    let r = c
        .put(u("/api/fs/write?path=/documents/x/partie_%C3%A9checs.pgn"))
        .body("1. e4 *")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);

    let r = c.get(u("/api/fs/download?path=/documents/x/partie_%C3%A9checs.pgn")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let cd = r.headers()["content-disposition"].to_str().unwrap().to_string();
    assert!(cd.contains("filename*=UTF-8''partie_%C3%A9checs.pgn"), "got {cd}");
}

#[tokio::test]
async fn download_filename_with_quote_and_newline_does_not_panic() {
    let s = common::spawn().await;
    let c = Client::new();
    let u = |p: &str| format!("{}{p}", s.base_url);

    // filename: a"b\nc.pgn
    let path = "/documents/x/a%22b%0Ac.pgn";
    let r = c.put(u(&format!("/api/fs/write?path={path}"))).body("1. e4 *").send().await.unwrap();
    assert_eq!(r.status(), 204);

    let r = c.get(u(&format!("/api/fs/download?path={path}"))).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let cd = r.headers()["content-disposition"].to_str().unwrap().to_string();
    assert!(cd.starts_with("attachment"), "got {cd}");
    assert!(!cd.contains('\n'));
    assert!(cd.contains("filename*=UTF-8''a%22b%0Ac.pgn"), "got {cd}");
}
