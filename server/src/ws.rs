use std::sync::atomic::Ordering;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;

use crate::app::App;

async fn upgrade(ws: WebSocketUpgrade, State(app): State<App>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, app))
}

async fn handle(socket: WebSocket, app: App) {
    app.clients.fetch_add(1, Ordering::SeqCst);
    let (mut tx, mut rx_client) = socket.split();
    let mut events = app.ctx.events.subscribe();

    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(envelope) => {
                    let text = match serde_json::to_string(&envelope) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if tx.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => log::warn!("ws client lagged, dropped {n} events"),
                Err(RecvError::Closed) => break,
            },
            incoming = rx_client.next() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {} // clients do not send anything we act on
            },
        }
    }

    app.clients.fetch_sub(1, Ordering::SeqCst);
    crate::engines::on_client_disconnect(app);
}

pub fn router() -> Router<App> {
    Router::new().route("/ws/events", get(upgrade))
}
