//! Aurora's web search and page fetch.
//!
//! Two jobs, both of which the agent reaches through the `auroro_websearch`
//! tool:
//!
//! * [`search`] asks a search engine and returns ranked results.
//! * [`fetch`] reads one URL and returns it as Markdown the model can use.
//!
//! ## The rule this module is built around
//!
//! **A tool result must never be larger than the runtime is willing to keep.**
//!
//! When a result exceeds the runtime's per-tool cap, the runtime compacts it,
//! and its last resort is to keep only the envelope — at which point a fetch
//! comes back as `{"success": true, "content": null}`: a success with nothing
//! in it, which reads to the model as "the page was blank". That is how this
//! module's predecessor failed, and no amount of better extraction would have
//! saved it, because the extraction was never the last thing to touch the
//! result.
//!
//! So a long page is not clipped, it is **paged**: [`fetch`] returns a window
//! of the document plus the offset that reads the next one, and the window is
//! sized to fit under the cap with room for the envelope. Nothing is lost, and
//! nothing is silently lost, which are different promises and both matter.
//!
//! ## Layout
//!
//! | file | job |
//! |---|---|
//! | [`http`] | one shared client, charset decoding, the size ceiling |
//! | [`engines`] | the search back ends and the order they are asked in |
//! | [`extract`] | response bytes to readable Markdown |
//! | [`types`] | what the two calls return |

mod cache;
pub mod engines;
mod extract;
mod http;
pub mod types;

use std::fmt;

pub use engines::{SafeSearch, SearchOptions};
pub use types::{Document, EngineAttempt, SearchOutcome};

/// Characters of page text returned when the caller does not say.
///
/// Around 7,500 tokens: enough for a whole documentation page in one call,
/// small enough that three fetches in a turn do not crowd out the conversation
/// they were meant to inform.
pub const DEFAULT_MAX_CHARS: usize = 30_000;

/// The largest window a caller may ask for.
///
/// Chosen against the tool's own output cap so that even a full window plus
/// the surrounding JSON stays under it. Raising this without raising that cap
/// puts the lossy compactor back in the path.
pub const MAX_MAX_CHARS: usize = 120_000;

/// How a fetch should be windowed.
#[derive(Debug, Clone)]
pub struct FetchOptions {
    /// Characters to return, clamped to [`MAX_MAX_CHARS`].
    pub max_chars: usize,
    /// Where in the document to start.
    pub offset: usize,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            max_chars: DEFAULT_MAX_CHARS,
            offset: 0,
        }
    }
}

/// Everything that can stop a web call, each naming what a caller should do
/// about it.
///
/// These messages go straight to the model. A message that does not
/// distinguish "the site is down" from "the URL is malformed" gets the same
/// wrong retry either way, so each variant says which it is.
#[derive(Debug, Clone)]
pub enum WebError {
    Setup(String),
    EmptyQuery,
    BadUrl {
        url: String,
        detail: String,
    },
    Timeout {
        url: String,
        seconds: u64,
    },
    Unreachable {
        url: String,
        detail: String,
    },
    TooManyRedirects {
        url: String,
        limit: usize,
    },
    Status {
        url: String,
        status: u16,
        reason: String,
    },
    Transport {
        url: String,
        detail: String,
    },
    NoEngineAnswered {
        query: String,
        attempts: Vec<EngineAttempt>,
    },
}

impl fmt::Display for WebError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WebError::Setup(detail) => {
                write!(f, "could not start the web client: {detail}")
            }
            WebError::EmptyQuery => write!(f, "the search query was empty"),
            WebError::BadUrl { url, detail } => {
                write!(f, "\"{url}\" is not a URL that can be fetched: {detail}")
            }
            WebError::Timeout { url, seconds } => {
                write!(f, "{url} did not respond within {seconds}s")
            }
            WebError::Unreachable { url, detail } => {
                write!(f, "could not connect to {url}: {detail}")
            }
            WebError::TooManyRedirects { url, limit } => {
                write!(
                    f,
                    "{url} redirected more than {limit} times without settling"
                )
            }
            WebError::Status {
                url,
                status,
                reason,
            } => {
                let hint = match status {
                    401 | 403 => " — the page needs a sign-in this tool does not have",
                    404 | 410 => " — the page is gone; check the URL or search for it",
                    429 => " — rate limited; wait before asking again",
                    500..=599 => " — the server is failing, not the request",
                    _ => "",
                };
                write!(f, "{url} returned {status} {reason}{hint}")
            }
            WebError::Transport { url, detail } => {
                write!(f, "the request to {url} failed: {detail}")
            }
            WebError::NoEngineAnswered { query, attempts } => {
                write!(f, "no search back end returned results for \"{query}\"")?;
                for attempt in attempts {
                    write!(f, "; {} said: {}", attempt.engine, attempt.reason)?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for WebError {}

/// Search the web.
pub async fn search(query: &str, opts: &SearchOptions) -> Result<SearchOutcome, WebError> {
    if let Some(hit) = cache::search_hit(query, opts) {
        return Ok(hit);
    }
    let outcome = engines::search(query, opts).await?;
    cache::store_search(query, opts, &outcome);
    Ok(outcome)
}

/// Fetch one URL and return it as readable text.
///
/// The document is cached whole and windowed per call, so paging through a
/// long page costs one network request rather than one per window.
pub async fn fetch(url: &str, opts: &FetchOptions) -> Result<Document, WebError> {
    let target = normalize_url(url)?;
    let max_chars = opts.max_chars.clamp(1, MAX_MAX_CHARS);

    if let Some(doc) = cache::document_hit(&target) {
        return Ok(window(doc, opts.offset, max_chars));
    }

    let response = http::get(&target).await?;
    let mut doc = extract::document_from(&target, &response);

    // The URL the caller asked for is what they will recognise in the result,
    // so a rewrite is reported rather than swapped in silently.
    if target != url {
        doc.url = url.to_string();
        doc.note = Some(match doc.note.take() {
            Some(existing) => format!("fetched {target} instead; {existing}"),
            None => format!("fetched {target} instead"),
        });
    }

    cache::store_document(&target, &doc);
    Ok(window(doc, opts.offset, max_chars))
}

fn window(doc: Document, offset: usize, max_chars: usize) -> Document {
    let body = doc.content.clone();
    doc.window(&body, offset, max_chars)
}

/// Put a caller's URL into the form that will actually be requested.
///
/// Three rewrites, each fixing something the model does routinely:
///
/// * A bare host (`docs.rs/serde`) gets a scheme. Models write URLs the way
///   people say them.
/// * `http://` becomes `https://`. Nearly every site redirects there anyway,
///   and doing it here means the first request is not sent in the clear.
/// * A GitHub file page becomes its raw URL. Asking for a `blob` link and
///   getting GitHub's application shell instead of the file is a daily
///   annoyance, and the raw host serves the file itself.
fn normalize_url(input: &str) -> Result<String, WebError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(WebError::BadUrl {
            url: input.to_string(),
            detail: "no URL was given".to_string(),
        });
    }

    let with_scheme = if trimmed.starts_with("http://") {
        format!("https://{}", &trimmed["http://".len()..])
    } else if trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed.contains("://") {
        let scheme = trimmed.split("://").next().unwrap_or("");
        return Err(WebError::BadUrl {
            url: input.to_string(),
            detail: format!("\"{scheme}\" is not a web address this tool can open"),
        });
    } else if trimmed.contains('.') && !trimmed.contains(' ') {
        format!("https://{trimmed}")
    } else {
        return Err(WebError::BadUrl {
            url: input.to_string(),
            detail: "it has no scheme and does not look like a host name".to_string(),
        });
    };

    Ok(github_raw(&with_scheme).unwrap_or(with_scheme))
}

/// `github.com/o/r/blob/ref/path` to `raw.githubusercontent.com/o/r/ref/path`.
fn github_raw(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://github.com/")?;
    let (path, _fragment) = rest.split_once('#').unwrap_or((rest, ""));
    let (path, _query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 5 || parts[2] != "blob" {
        return None;
    }
    let (owner, repo, git_ref) = (parts[0], parts[1], parts[3]);
    let file = parts[4..].join("/");
    if file.is_empty() {
        return None;
    }
    Some(format!(
        "https://raw.githubusercontent.com/{owner}/{repo}/{git_ref}/{file}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_gets_a_scheme() {
        assert_eq!(
            normalize_url("docs.rs/serde").unwrap(),
            "https://docs.rs/serde"
        );
    }

    #[test]
    fn plain_http_is_upgraded() {
        assert_eq!(
            normalize_url("http://example.com/a").unwrap(),
            "https://example.com/a"
        );
    }

    #[test]
    fn a_github_file_page_is_fetched_as_the_file() {
        assert_eq!(
            normalize_url("https://github.com/rust-lang/rust/blob/master/README.md").unwrap(),
            "https://raw.githubusercontent.com/rust-lang/rust/master/README.md"
        );
        // Nested paths and a line-number fragment both survive the rewrite.
        assert_eq!(
            normalize_url("https://github.com/a/b/blob/main/src/lib/mod.rs#L42").unwrap(),
            "https://raw.githubusercontent.com/a/b/main/src/lib/mod.rs"
        );
    }

    #[test]
    fn other_github_pages_are_left_alone() {
        for url in [
            "https://github.com/rust-lang/rust",
            "https://github.com/rust-lang/rust/issues/1",
            "https://github.com/rust-lang/rust/tree/master/src",
        ] {
            assert_eq!(normalize_url(url).unwrap(), url, "{url}");
        }
    }

    #[test]
    fn a_non_web_scheme_is_refused_by_name() {
        let err = normalize_url("file:///C:/secrets.txt").unwrap_err();
        assert!(err.to_string().contains("file"), "{err}");
    }

    #[test]
    fn a_search_phrase_is_not_mistaken_for_a_url() {
        assert!(normalize_url("how do I use serde").is_err());
        assert!(normalize_url("   ").is_err());
    }

    /// The model retries differently for each of these, so each has to read
    /// differently.
    #[test]
    fn status_errors_say_what_to_do_about_them() {
        let gone = WebError::Status {
            url: "https://x.dev/a".into(),
            status: 404,
            reason: "Not Found".into(),
        };
        assert!(gone.to_string().contains("check the URL"), "{gone}");

        let limited = WebError::Status {
            url: "https://x.dev/a".into(),
            status: 429,
            reason: "Too Many Requests".into(),
        };
        assert!(limited.to_string().contains("wait before"), "{limited}");

        let broken = WebError::Status {
            url: "https://x.dev/a".into(),
            status: 503,
            reason: "Service Unavailable".into(),
        };
        assert!(broken.to_string().contains("server is failing"), "{broken}");
    }

    #[test]
    fn a_failed_search_names_every_back_end_it_tried() {
        let err = WebError::NoEngineAnswered {
            query: "x".into(),
            attempts: vec![
                EngineAttempt {
                    engine: "duckduckgo-lite",
                    reason: "timed out".into(),
                },
                EngineAttempt {
                    engine: "duckduckgo-html",
                    reason: "returned 403".into(),
                },
            ],
        };
        let text = err.to_string();
        assert!(text.contains("duckduckgo-lite"), "{text}");
        assert!(text.contains("duckduckgo-html"), "{text}");
        assert!(text.contains("timed out"), "{text}");
    }

    /// A window larger than the ceiling would put the result back over the
    /// runtime's cap, which is the failure this whole module is shaped around.
    #[test]
    fn a_window_request_cannot_exceed_the_ceiling() {
        let asked = FetchOptions {
            max_chars: 10_000_000,
            offset: 0,
        };
        assert_eq!(asked.max_chars.clamp(1, MAX_MAX_CHARS), MAX_MAX_CHARS);
    }
}

/// Tests that talk to the real internet.
///
/// Ignored by default: they are the only way to catch a search engine changing
/// its markup, and also the only tests that fail when the machine is offline.
/// Run them after touching selectors or extraction:
///
/// ```text
/// cargo test --lib websearch::live -- --ignored --nocapture
/// ```
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore = "hits the network"]
    async fn search_returns_ranked_results_with_real_urls() {
        let outcome = search("rust async trait object safety", &SearchOptions::default())
            .await
            .expect("search");

        println!("engine: {}", outcome.engine);
        for hit in &outcome.results {
            println!("  {}. {} — {}", hit.rank, hit.title, hit.url);
        }

        assert!(outcome.results.len() >= 5, "got {}", outcome.results.len());
        for hit in &outcome.results {
            assert!(hit.url.starts_with("https://"), "{}", hit.url);
            // A tracker URL leaking through would record the wrong source.
            assert!(!hit.url.contains("duckduckgo.com/l/"), "{}", hit.url);
            assert!(!hit.title.is_empty());
        }
        assert!(
            outcome.results.iter().any(|h| h.snippet.is_some()),
            "no result carried a snippet — the snippet selector has drifted"
        );
    }

    /// The exact page from the bug report. It has no `<main>` and no
    /// `<article>`, and 6.5 KB of its 23 KB is inline script — the shape that
    /// made the old extractor return script text and then lose everything to
    /// the runtime's compactor.
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn the_page_that_returned_nothing_now_returns_the_page() {
        let doc = fetch("https://aurorahelix.com/docs", &FetchOptions::default())
            .await
            .expect("fetch");

        println!(
            "kind={:?} chars={} note={:?}",
            doc.kind, doc.total_chars, doc.note
        );
        println!("--- content ---\n{}", doc.content);

        assert!(!doc.content.is_empty(), "the page came back empty again");
        assert!(doc.content.contains("Aurora"), "{}", doc.content);
        // The three things the old extractor got wrong.
        assert!(!doc.content.contains("<script"), "script markup leaked");
        assert!(!doc.content.contains("function "), "script source leaked");
        assert!(doc.content.contains('#'), "no headings survived");
    }

    /// A whole result must fit under the tool's cap without the runtime having
    /// to compact it, because the runtime's last resort is to drop the body.
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn a_fetch_result_fits_under_the_runtime_cap() {
        let doc = fetch(
            "https://doc.rust-lang.org/book/ch10-02-traits.html",
            &FetchOptions::default(),
        )
        .await
        .expect("fetch");
        let json = serde_json::to_string(&doc).unwrap();
        println!("serialized {} bytes, hasMore={}", json.len(), doc.has_more);
        assert!(json.len() < 512 * 1024, "{} bytes", json.len());
    }

    /// Paging has to reach the end of a long page without gaps or repeats.
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn paging_walks_a_long_page_end_to_end() {
        let url = "https://doc.rust-lang.org/book/ch10-02-traits.html";
        let mut offset = 0usize;
        let mut assembled = String::new();
        let mut windows = 0;

        loop {
            let doc = fetch(
                url,
                &FetchOptions {
                    max_chars: 2_000,
                    offset,
                },
            )
            .await
            .expect("fetch");

            assembled.push_str(&doc.content);
            windows += 1;
            match doc.next_offset {
                Some(next) if windows < 200 => offset = next,
                _ => break,
            }
        }

        let whole = fetch(
            url,
            &FetchOptions {
                max_chars: MAX_MAX_CHARS,
                offset: 0,
            },
        )
        .await
        .expect("fetch");
        println!(
            "{windows} windows, {} chars reassembled",
            assembled.chars().count()
        );
        assert!(windows > 1, "page was too short to test paging");
        assert_eq!(assembled, whole.content, "paging lost or repeated text");
    }

    /// The page from the bug report is a grid of linked cards, the shape the
    /// tidiest extraction mistakes for navigation. Every card has to arrive.
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn a_card_built_documentation_page_arrives_whole() {
        let doc = fetch("https://aurorahelix.com/docs", &FetchOptions::default())
            .await
            .expect("fetch");
        for expected in [
            "Install the VS Code Extension",
            "Sign in to Aurora",
            "Index your project",
            "BYOK",
        ] {
            assert!(
                doc.content.contains(expected),
                "lost {expected:?}:\n{}",
                doc.content
            );
        }
    }

    #[tokio::test]
    #[ignore = "hits the network"]
    async fn a_github_file_page_comes_back_as_the_file() {
        let doc = fetch(
            "https://github.com/rust-lang/rust/blob/master/README.md",
            &FetchOptions::default(),
        )
        .await
        .expect("fetch");
        println!(
            "note={:?}\n{}",
            doc.note,
            &doc.content[..doc.content.len().min(300)]
        );
        assert!(doc.content.contains("Rust"), "{}", doc.content);
        assert!(doc
            .note
            .unwrap_or_default()
            .contains("raw.githubusercontent"));
    }

    #[tokio::test]
    #[ignore = "hits the network"]
    async fn a_missing_page_says_so_instead_of_returning_nothing() {
        let err = fetch(
            "https://doc.rust-lang.org/this-page-does-not-exist-aurora",
            &FetchOptions::default(),
        )
        .await
        .expect_err("should fail");
        println!("{err}");
        assert!(err.to_string().contains("404"), "{err}");
    }
}
