//! Cross-site request rejection, based on the `Sec-Fetch-Site` fetch-metadata header.
//!
//! The service has no authentication of its own: it is reachable only over the
//! tailnet, behind a Caddy reverse proxy, and the app talks to it same-origin.
//! That leaves one hole a firewall cannot close. `POST /api/kv/{key}` (added so
//! `navigator.sendBeacon` can flush settings at pagehide) and `POST
//! /api/fs/mkdir` accept `content-type: text/plain`, which makes them CORS
//! *simple requests*: no preflight, so any page the user happens to open in a
//! browser that can route to this host could silently write settings keys (open
//! tabs, tab game trees, the engine list). `/api/cmd/*` rejects `text/plain`
//! with 415 and `/api/fs/write` is PUT-only, so those already force a preflight.
//!
//! Every modern browser stamps `Sec-Fetch-Site` on every request it makes, so
//! rejecting `cross-site` closes that hole for the whole router at once,
//! including any endpoint added later. Requests with no such header — curl, the
//! test harness, any non-browser client — pass through untouched: this is
//! defence in depth for a service whose only real network control is the
//! tailnet, not an authentication scheme.
//!
//! One exemption, from the standard fetch-metadata resource isolation policy: a
//! top-level navigation. Clicking a link to the app from any other site — a
//! chat message, a mail, the Tailscale admin console — is a cross-site request,
//! and without the carve-out the user would get a JSON error instead of the app.
//! It is narrowed to GET/HEAD, because a cross-site
//! `<form method=post action=/api/kv/x>` submission is *also* mode `navigate`
//! and is exactly the hole this guard closes; and `object`/`embed` destinations
//! are excluded, being the only navigate-mode fetches whose response the
//! embedding page can pull into its own document.
//!
//! Two known limits, both deliberate. Browsers only send fetch-metadata headers
//! to potentially-trustworthy origins, so a plain-HTTP request straight to the
//! tailnet IP carries no header and is waved through; the guard bites when the
//! app is reached over Caddy's TLS, which is how it is meant to be used. And
//! `same-site` passes, so another host under the same tailnet DNS suffix is not
//! covered — that is the same trust boundary as the tailnet itself.

use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

fn header_is(req: &Request, name: &str, value: &[u8]) -> bool {
    req.headers().get(name).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(value))
}

/// A top-level navigation that cannot hand its response back to the initiator.
fn is_safe_navigation(req: &Request) -> bool {
    if !header_is(req, "sec-fetch-mode", b"navigate") {
        return false;
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return false;
    }
    !header_is(req, "sec-fetch-dest", b"object") && !header_is(req, "sec-fetch-dest", b"embed")
}

pub async fn reject_cross_site(req: Request, next: Next) -> Response {
    if header_is(&req, "sec-fetch-site", b"cross-site") && !is_safe_navigation(&req) {
        // A JSON string body, like the rest of the API's errors.
        return (StatusCode::FORBIDDEN, Json("cross-site request rejected")).into_response();
    }
    next.run(req).await
}
