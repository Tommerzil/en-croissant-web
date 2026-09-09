use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::Duration;

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
                && u.port().is_none()
                && u.username().is_empty()
                && u.password().is_none()
                && u.host_str()
                    .map(|h| ALLOWED_HOSTS.contains(&h))
                    .unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// Maximum number of redirect hops the proxy will follow.
const MAX_REDIRECTS: usize = 5;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Shared HTTP client. Every redirect hop is re-checked against the same
/// allowlist as the initial request, so an allowlisted host cannot bounce the
/// proxy to an arbitrary (or link-local, or plaintext) destination.
pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.stop()
            } else if is_allowed(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        reqwest::Client::builder()
            .redirect(policy)
            .timeout(Duration::from_secs(30))
            .user_agent(USER_AGENT)
            .build()
            .expect("failed to build proxy HTTP client")
    })
}

#[derive(Deserialize)]
pub struct ProxyQuery {
    url: String,
}

async fn forward(Query(q): Query<ProxyQuery>, headers: HeaderMap) -> Response {
    if !is_allowed(&q.url) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    let mut req = client().get(&q.url);
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
        Err(e) => {
            log::warn!("proxy upstream request failed: {e}");
            (StatusCode::BAD_GATEWAY, "upstream request failed").into_response()
        }
    }
}

pub fn router() -> Router<App> {
    Router::new().route("/api/proxy", get(forward))
}
