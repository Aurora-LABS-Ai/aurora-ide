//! Does anything answer at this URL?
//!
//! `WebviewWindow::navigate` returns `Ok(())` the instant the WebView accepts a
//! URL. It accepts every URL. When nothing is listening on the other end the
//! WebView loads its own error page, and that page is a real document with a
//! real `readyState`, so every downstream check reads as healthy. Aurora then
//! told the model `ok: true` for a dev server that was not running, the model
//! believed it, and a second navigate to the same dead address answered
//! `already_there: true` — Aurora citing its own earlier visit as evidence the
//! page was fine.
//!
//! The WebView cannot be asked why a load failed. An HTTP request can, it costs
//! about a millisecond against localhost, and a refused connection is not a
//! judgement call: nothing is listening.
//!
//! ## What counts as a failure
//!
//! Only the connection. A 404 or a 500 is a page that loaded, and debugging one
//! is a perfectly ordinary reason to open the browser — treating those as
//! failures would break the tool for the case it is most useful in. So the
//! status rides back in the result and the model decides. Connection refused,
//! DNS failure and no-answer-at-all are the three that mean "there is nothing
//! here", and those are reported as failures.
//!
//! A `401` is not a failure either, and that is not an oversight: this probe
//! carries none of the WebView's cookies, so a page the user is signed into
//! answers `401` here and loads perfectly in the panel. Only the transport
//! layer is trustworthy from outside the browser, which is exactly why only the
//! transport layer is judged.
//!
//! ## The cost
//!
//! One extra `GET` per navigate, so a page that counts visits counts this one
//! too. That is the price of the answer, and it is worth paying: the
//! alternative on the table was reading the WebView's error page out of the
//! DOM, which is a different document per platform and per Windows build, and
//! would go quietly wrong on someone else's machine rather than here.

use std::sync::OnceLock;
use std::time::Duration;

/// How long to wait for a first response.
///
/// A refusal from localhost comes back immediately; this ceiling only applies
/// to a host that accepts a connection and then says nothing. Short on purpose:
/// this probe runs before every navigate, so it is pure added latency in the
/// happy case, and five seconds of silence already tells you what you need.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reach {
    /// Not an `http(s)` URL, so there is nothing to probe and nothing to
    /// claim. `about:blank`, `file://` and `data:` all land here.
    Skipped,
    /// Something answered. The status may still be a 404 or a 500 — that is a
    /// page, and reporting it is the caller's job.
    Answered { status: u16 },
    /// Nothing answered. `reason` is written to be read by a person as much as
    /// by the model.
    Unreachable { reason: String },
}

impl Reach {
    #[must_use]
    pub fn is_unreachable(&self) -> bool {
        matches!(self, Self::Unreachable { .. })
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(PROBE_TIMEOUT)
            .connect_timeout(PROBE_TIMEOUT)
            // Report the first hop honestly instead of chasing a redirect and
            // describing somewhere the caller did not ask about.
            .redirect(reqwest::redirect::Policy::none())
            // A local dev server on https almost always has a self-signed
            // certificate. This probe reads a status line and nothing else —
            // no body, no credentials — so refusing to look would only
            // manufacture "unreachable" for a server that is running fine.
            .danger_accept_invalid_certs(true)
            .build()
            // A client with default settings still answers the question. An
            // unwrap here would turn a builder problem into a crash inside a
            // browser tool, which is the least useful place to find out.
            .unwrap_or_default()
    })
}

/// Ask the URL whether anything is home.
///
/// `GET` rather than `HEAD`: plenty of dev servers and SPA fallbacks answer
/// `405` to a HEAD, which would read as a broken app. The response body is
/// never awaited, so this costs the headers and nothing more.
pub async fn probe(url: &str) -> Reach {
    let lowered = url.trim().to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Reach::Skipped;
    }

    match client().get(url).send().await {
        Ok(response) => Reach::Answered {
            status: response.status().as_u16(),
        },
        Err(error) => Reach::Unreachable {
            reason: describe(url, &error),
        },
    }
}

/// Turn a transport error into a sentence that names the address.
///
/// The address is the whole point. "connection refused" on its own sends
/// someone hunting through their own code; "nothing is listening on
/// localhost:5173" tells them to start the dev server.
fn describe(url: &str, error: &reqwest::Error) -> String {
    let where_ = authority(url).unwrap_or_else(|| url.to_string());
    if error.is_timeout() {
        return format!(
            "{where_} accepted nothing within {}s",
            PROBE_TIMEOUT.as_secs()
        );
    }
    if error.is_connect() {
        // The source carries the useful half (refused / unknown host / no
        // route); the reqwest wrapper on its own only says "error sending
        // request", which describes Aurora rather than the server.
        let detail = std::error::Error::source(error)
            .map(ToString::to_string)
            .unwrap_or_else(|| error.to_string());
        return format!("nothing is listening on {where_} ({detail})");
    }
    format!("{where_} could not be reached ({error})")
}

/// `host:port` from a URL, without pulling in a URL parser for one field.
fn authority(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://")?.1;
    let end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..end];
    if authority.is_empty() {
        None
    } else {
        Some(authority.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_urls_are_probed() {
        for url in ["about:blank", "file:///c:/x.html", "data:text/html,hi"] {
            assert_eq!(
                futures::executor::block_on(probe(url)),
                Reach::Skipped,
                "{url}"
            );
        }
    }

    #[test]
    fn the_address_is_extracted_for_the_message() {
        assert_eq!(
            authority("http://localhost:5173/#sample").as_deref(),
            Some("localhost:5173")
        );
        assert_eq!(
            authority("https://example.com").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            authority("http://127.0.0.1:3000/a/b?c=1").as_deref(),
            Some("127.0.0.1:3000")
        );
        assert_eq!(authority("not a url"), None);
    }

    /// The failing case this whole module exists for. Port 1 is reserved and
    /// nothing binds it, so the refusal is immediate and does not depend on
    /// the network.
    #[tokio::test]
    async fn a_dead_port_is_reported_as_unreachable_with_its_address() {
        let reach = probe("http://127.0.0.1:1/").await;
        match reach {
            Reach::Unreachable { reason } => {
                assert!(reason.contains("127.0.0.1:1"), "{reason}");
            }
            other => panic!("expected unreachable, got {other:?}"),
        }
    }

    /// A 404 is a page. If this ever starts reading as a failure, the browser
    /// becomes useless for the thing people open it for.
    #[test]
    fn an_http_status_is_not_a_failure() {
        assert!(!Reach::Answered { status: 404 }.is_unreachable());
        assert!(!Reach::Answered { status: 500 }.is_unreachable());
        assert!(!Reach::Skipped.is_unreachable());
        assert!(Reach::Unreachable { reason: "x".into() }.is_unreachable());
    }
}
