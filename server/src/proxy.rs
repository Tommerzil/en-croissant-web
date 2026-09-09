use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use crate::app::App;

const ALLOWED_HOSTS: &[&str] = &[
    "api.chess.com",
    "www.chess.com",
    "lichess.org",
    "explorer.lichess.ovh",
    "tablebase.lichess.ovh",
];

const USER_AGENT: &str = "en-croissant-web (+https://github.com/Tommerzil/en-croissant-web)";

pub fn is_allowed(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(u) => {
            u.scheme() == "https"
                && u.host_str()
                    .map(|h| ALLOWED_HOSTS.contains(&h))
                    .unwrap_or(false)
        }
        Err(_) => false,
    }
}

#[derive(Deserialize)]
pub struct ProxyQuery {
    url: String,
}

async fn forward(Query(q): Query<ProxyQuery>, headers: HeaderMap) -> Response {
    if !is_allowed(&q.url) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    let client = reqwest::Client::new();
    let mut req = client.get(&q.url).header(header::USER_AGENT, USER_AGENT);
    if let Some(accept) = headers.get(header::ACCEPT) {
        req = req.header(header::ACCEPT, accept);
    }
    match req.send().await {
        Ok(upstream) => {
            let status =
                StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut resp = Response::builder().status(status);
            if let Some(ct) = upstream.headers().get(header::CONTENT_TYPE) {
                resp = resp.header(header::CONTENT_TYPE, ct);
            }
            resp.body(Body::from_stream(upstream.bytes_stream())).unwrap()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    }
}

pub fn router() -> Router<App> {
    Router::new().route("/api/proxy", get(forward))
}
