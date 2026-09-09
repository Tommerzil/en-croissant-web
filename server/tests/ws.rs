mod common;

use futures_util::StreamExt;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn emitted_events_reach_every_client() {
    let s = common::spawn().await;
    let (mut a, _) = connect_async(&s.ws_url).await.unwrap();
    let (mut b, _) = connect_async(&s.ws_url).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(s.app.clients.load(std::sync::atomic::Ordering::SeqCst), 2);

    s.app.ctx.emit("test-event", serde_json::json!({ "n": 7 })).unwrap();

    for sock in [&mut a, &mut b] {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(2), sock.next())
            .await
            .expect("timely")
            .expect("open")
            .unwrap();
        let Message::Text(text) = msg else { panic!("expected text frame") };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["event"], "test-event");
        assert_eq!(v["payload"]["n"], 7);
        assert!(v["id"].as_u64().is_some());
    }

    drop(a);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(s.app.clients.load(std::sync::atomic::Ordering::SeqCst), 1);
}
