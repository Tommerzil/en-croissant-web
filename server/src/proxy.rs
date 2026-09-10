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

/// Allowlisted upstream hosts, each paired with whether the proxy will forward
/// an incoming `Authorization` header to it.
///
/// That flag is a credential's blast radius, so it lives in the same table as
/// the host to keep the two facts from drifting apart. The proxy cannot tell
/// which service a bearer token belongs to: without the flag, a request for
/// `https://api.chess.com/...` that happened to carry a Lichess token would
/// hand that token to chess.com. Lichess is the only allowlisted operator whose
/// API takes a bearer token, and only its account-scoped hosts need one --
/// `tablebase.lichess.org` is wholly public (`security: []` in Lichess's own
/// OpenAPI spec, against `OAuth2` on all three opening-explorer endpoints) --
/// so those two alone get it.
///
/// Every entry must be a host the frontend actually calls: an allowlisted host
/// is somewhere a request, and possibly a bearer token, can be sent. Lichess
/// also answers on the legacy `explorer.lichess.ovh` / `tablebase.lichess.ovh`
/// aliases (same CNAME targets, `bookd`/`bwrdd.lichess.ovh`), but the frontend
/// and the spec both use `.org`, so the aliases are deliberately absent.
const ALLOWED_HOSTS: &[(&str, bool)] = &[
    ("api.chess.com", false),
    ("www.chess.com", false),
    ("lichess.org", true),
    ("explorer.lichess.org", true),
    ("tablebase.lichess.org", false),
    ("www.chessdb.cn", false),
];

const USER_AGENT: &str = "en-croissant-web (+https://github.com/Tommerzil/en-croissant-web)";

/// The allowlist entry for `url`, or `None` if the proxy will not fetch it.
fn allowed_host(url: &str) -> Option<&'static (&'static str, bool)> {
    let u = reqwest::Url::parse(url).ok()?;
    if u.scheme() != "https"
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return None;
    }
    let host = u.host_str()?;
    ALLOWED_HOSTS.iter().find(|(h, _)| *h == host)
}

pub fn is_allowed(url: &str) -> bool {
    allowed_host(url).is_some()
}

/// Whether an incoming `Authorization` header may be forwarded to `url`.
///
/// Always false for a URL the proxy would refuse outright, so this cannot widen
/// the allowlist.
pub fn forwards_authorization(url: &str) -> bool {
    allowed_host(url).is_some_and(|(_, auth)| *auth)
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

/// Builds the upstream request, forwarding only the headers the proxy is
/// willing to pass on. Caller must have checked `is_allowed(url)` first.
///
/// `Authorization` is scoped to the hosts marked in `ALLOWED_HOSTS`, and only
/// the *initial* URL is checked. That is sufficient: reqwest's redirect layer
/// runs `remove_sensitive_headers` on every hop, which drops `Authorization`
/// (and `Cookie`) as soon as the host or port changes, so the header can only
/// ever ride a same-host redirect. A redirect that crosses from a Lichess host
/// to another allowlisted host therefore arrives there anonymous.
pub fn build_upstream(url: &str, incoming: &HeaderMap) -> reqwest::RequestBuilder {
    let mut req = client().get(url);
    if let Some(accept) = incoming.get(header::ACCEPT) {
        req = req.header(header::ACCEPT, accept);
    }
    if forwards_authorization(url) {
        if let Some(auth) = incoming.get(header::AUTHORIZATION) {
            // Marking the value sensitive keeps the token out of any `{:?}` of
            // the request or its headers: `HeaderValue`'s Debug then prints
            // `Sensitive` rather than the credential.
            let mut auth = auth.clone();
            auth.set_sensitive(true);
            req = req.header(header::AUTHORIZATION, auth);
        }
    }
    req
}

async fn forward(Query(q): Query<ProxyQuery>, headers: HeaderMap) -> Response {
    if !is_allowed(&q.url) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    match build_upstream(&q.url, &headers).send().await {
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
            // `reqwest::Error`'s Display carries the upstream URL but never a
            // request header, and the body below is a fixed string, so neither
            // the log nor the 502 can echo a forwarded token back out.
            log::warn!("proxy upstream request failed: {e}");
            (StatusCode::BAD_GATEWAY, "upstream request failed").into_response()
        }
    }
}

pub fn router() -> Router<App> {
    Router::new().route("/api/proxy", get(forward))
}
