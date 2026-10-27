//! Who may use a host: the token, the sign-in link and the cookie it sets,
//! and the `Host` check. Shared by the desktop app's browser host
//! (`web_host`) and `aurora serve`, so the two cannot drift on what lets a
//! request in.

use axum::body::Body;
use axum::http::{header, HeaderMap, Request};

/// The cookie a browser holds after opening the sign-in link.
pub const COOKIE: &str = "aurora_web";

/// A fresh random token, or `AURORA_WEB_TOKEN` when set (the dev proxy and
/// scripts use that to pin one).
pub fn new_token() -> String {
    std::env::var("AURORA_WEB_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
        .unwrap_or_else(|| format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()))
}

/// Write the token where the Vite dev proxy reads it (`vite.config.ts`).
pub fn write_token(token: &str) -> std::io::Result<()> {
    let dir = crate::paths::root().join("web");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("token"), token)
}

/// The request carries the token: as `Authorization: Bearer` (the dev proxy)
/// or as the sign-in cookie (a browser).
pub fn is_signed_in(headers: &HeaderMap, token: &[u8]) -> bool {
    let bearer_ok = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| constant_time_eq(value.as_bytes(), token));
    let cookie_ok = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .any(|(name, value)| name == COOKIE && constant_time_eq(value.as_bytes(), token));
    bearer_ok || cookie_ok
}

/// The `Set-Cookie` value a valid sign-in link answers with.
pub fn sign_in_cookie(token: &str) -> String {
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict")
}

/// A valid `?token=` on a page address: where to send the browser next (the
/// same address without the token).
pub fn sign_in(request: &Request<Body>, token: &[u8]) -> Option<String> {
    let uri = request.uri();
    let query = uri.query()?;
    let mut matched = false;
    let rest: Vec<&str> = query
        .split('&')
        .filter(|pair| match pair.split_once('=') {
            Some(("token", value)) => {
                matched = constant_time_eq(value.as_bytes(), token);
                false
            }
            _ => true,
        })
        .collect();
    matched.then(|| {
        if rest.is_empty() {
            uri.path().to_string()
        } else {
            format!("{}?{}", uri.path(), rest.join("&"))
        }
    })
}

/// `Host` names a loopback address on our port. Any page open in the user's
/// browser can reach a localhost port; this stops a DNS name that resolves to
/// 127.0.0.1 from riding the user's cookie (DNS rebinding).
pub fn is_loopback_host(value: &str, port: u16) -> bool {
    let value = value.trim().to_ascii_lowercase();
    ["127.0.0.1", "localhost"]
        .iter()
        .any(|name| value == *name || value == format!("{name}:{port}"))
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_hosts_on_our_port_pass() {
        assert!(is_loopback_host("127.0.0.1:3721", 3721));
        assert!(is_loopback_host("localhost:3721", 3721));
        assert!(is_loopback_host("LOCALHOST", 3721));
        // DNS rebinding: an attacker's name resolving to 127.0.0.1.
        assert!(!is_loopback_host("evil.example:3721", 3721));
        assert!(!is_loopback_host("127.0.0.1:9999", 3721));
        assert!(!is_loopback_host("127.0.0.1.evil.example", 3721));
    }

    fn request(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    #[test]
    fn a_sign_in_link_sends_the_browser_on_without_the_token() {
        let token = b"secret";
        assert_eq!(
            sign_in(&request("/agent-window?token=secret"), token).as_deref(),
            Some("/agent-window")
        );
        assert_eq!(
            sign_in(&request("/agent-window/p/e--repo?ws=x&token=secret"), token).as_deref(),
            Some("/agent-window/p/e--repo?ws=x")
        );
        assert_eq!(sign_in(&request("/agent-window?token=wrong"), token), None);
        assert_eq!(sign_in(&request("/agent-window"), token), None);
    }

    #[test]
    fn token_comparison_needs_the_whole_token() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(b"", b"abc"));
    }

    #[test]
    fn the_bearer_header_or_the_cookie_signs_a_request_in() {
        let mut headers = HeaderMap::new();
        assert!(!is_signed_in(&headers, b"secret"));
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert!(is_signed_in(&headers, b"secret"));
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=1; aurora_web=secret".parse().unwrap());
        assert!(is_signed_in(&headers, b"secret"));
        headers.insert(header::COOKIE, "aurora_web=other".parse().unwrap());
        assert!(!is_signed_in(&headers, b"secret"));
    }
}
