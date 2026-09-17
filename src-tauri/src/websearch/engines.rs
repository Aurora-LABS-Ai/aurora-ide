//! Search back ends, and the order they are asked in.
//!
//! Both back ends are DuckDuckGo's no-JavaScript endpoints. They are separate
//! because they fail separately: they are served by different hosts, return
//! different markup, and in practice do not go down together. Asking the
//! second when the first returns nothing is what turns "the tool is broken
//! today" into a result the user never notices was a fallback.
//!
//! ## Why `lite` is asked first
//!
//! `lite.duckduckgo.com` puts the real destination in the `href`.
//! `html.duckduckgo.com` wraps every link in its own click tracker
//! (`//duckduckgo.com/l/?uddg=<escaped url>`), which has to be unwrapped —
//! and an unwrapper is a thing that can silently start returning tracker URLs
//! to the model the day the parameter is renamed. Preferring the endpoint that
//! needs no unwrapping means the fragile path is the one used least.
//!
//! ## On parsing someone else's HTML
//!
//! These selectors describe markup we do not control, so the interesting
//! failure is not an error, it is zero results that read like "the web has
//! nothing about this". Every engine here reports *why* it returned nothing,
//! and [`search`] passes those reasons up, so a layout change announces itself
//! instead of looking like an unpopular query.

use dom_query::Document as Dom;

use super::types::{EngineAttempt, SearchHit, SearchOutcome};
use super::{http, WebError};

const LITE_URL: &str = "https://lite.duckduckgo.com/lite/";
const HTML_URL: &str = "https://html.duckduckgo.com/html/";
/// The full site, for the browser rung. The scriptless hosts above are
/// separate deployments; this is the one a person uses.
const BROWSER_URL: &str = "https://duckduckgo.com/";

/// What the app renders one result as, and what the browser waits for before
/// reading the page.
const RESULT_SELECTOR: &str = "[data-testid='result']";

pub const ENGINE_LITE: &str = "duckduckgo-lite";
pub const ENGINE_HTML: &str = "duckduckgo-html";
pub const ENGINE_BROWSER: &str = "duckduckgo-browser";

/// Which catalogue a search is asking.
///
/// Not a fallback order — a choice. The open web and the scholarly catalogues
/// answer different questions, and one cannot stand in for the other: a
/// question about nginx has no answer in arXiv, and a question about protein
/// folding has a better one in PubMed than on a blog. See
/// [`super::scholar`] for why these never chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchSource {
    /// The open web, through the ladder in this file.
    #[default]
    Web,
    /// arXiv, OpenAlex, Semantic Scholar and PubMed Central together.
    Scholar,
    /// Images from Wikimedia Commons, including source pages and attribution.
    Images,
}

impl SearchSource {
    /// Read the caller's label. Anything unrecognised is the web, because a
    /// typo must not silently turn a web search into a literature search.
    pub fn parse(label: &str) -> Self {
        match label.trim().to_ascii_lowercase().as_str() {
            "scholar" | "papers" | "academic" => SearchSource::Scholar,
            "images" => SearchSource::Images,
            _ => SearchSource::Web,
        }
    }
}

/// How a search should be run.
#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub limit: usize,
    /// DuckDuckGo region code, e.g. `uk-en`, `de-de`.
    pub region: Option<String>,
    pub safe_search: SafeSearch,
    pub source: SearchSource,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            limit: 10,
            region: None,
            safe_search: SafeSearch::Moderate,
            source: SearchSource::Web,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SafeSearch {
    Off,
    #[default]
    Moderate,
    Strict,
}

impl SafeSearch {
    /// DuckDuckGo's `kp` parameter.
    fn param(self) -> &'static str {
        match self {
            SafeSearch::Off => "-2",
            SafeSearch::Moderate => "-1",
            SafeSearch::Strict => "1",
        }
    }

    pub fn parse(label: &str) -> Self {
        match label.to_ascii_uppercase().as_str() {
            "OFF" => SafeSearch::Off,
            "STRICT" => SafeSearch::Strict,
            _ => SafeSearch::Moderate,
        }
    }
}

/// Run a search, falling back through the back ends until one answers.
///
/// Returns an error only when *every* back end failed. A back end that
/// answered with an empty list is a failure for this purpose — an empty list
/// from one endpoint and ten results from the other is the normal shape of a
/// blocked request, and returning the empty one would be reporting a block as
/// an answer.
///
/// The rungs are ordered by what they cost, and the browser is last for that
/// reason alone: it is a page load in a real engine against two HTTP requests.
/// It is also the only rung that can pass a challenge page, so it is the one
/// that decides whether "blocked today" is a failure the user sees.
pub async fn search(
    query: &str,
    opts: &SearchOptions,
    browser: Option<&dyn super::PageSource>,
) -> Result<SearchOutcome, WebError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(WebError::EmptyQuery);
    }

    let mut fallbacks: Vec<EngineAttempt> = Vec::new();

    for engine in [ENGINE_LITE, ENGINE_HTML] {
        // Await only the current rung. Awaiting both in the array initializer
        // sends the fallback request even when the first engine succeeds.
        let attempt = if engine == ENGINE_LITE {
            run_lite(query, opts).await
        } else {
            run_html(query, opts).await
        };
        match attempt {
            Ok(hits) if !hits.is_empty() => {
                let hits: Vec<SearchHit> = hits.into_iter().take(opts.limit).collect();
                return Ok(SearchOutcome {
                    query: query.to_string(),
                    engine,
                    count: hits.len(),
                    results: hits,
                    fallbacks,
                });
            }
            Ok(_) => fallbacks.push(EngineAttempt {
                engine,
                reason: "answered with no results — either the query has none, or the \
                         endpoint served a challenge page instead of results"
                    .to_string(),
            }),
            Err(e) => fallbacks.push(EngineAttempt {
                engine,
                reason: e.to_string(),
            }),
        }
    }

    // Both no-JavaScript endpoints declined. The full site is a different
    // thing entirely — it runs its scripts, keeps its cookies and is driven by
    // a real engine — so a challenge that stopped the two above is one this
    // can answer.
    if let Some(browser) = browser {
        match run_browser(query, opts, browser).await {
            Ok(hits) if !hits.is_empty() => {
                let hits: Vec<SearchHit> = hits.into_iter().take(opts.limit).collect();
                return Ok(SearchOutcome {
                    query: query.to_string(),
                    engine: ENGINE_BROWSER,
                    count: hits.len(),
                    results: hits,
                    fallbacks,
                });
            }
            Ok(_) => fallbacks.push(EngineAttempt {
                engine: ENGINE_BROWSER,
                reason: "the results page loaded but held no results in the shape this \
                         parser knows — the site has probably changed"
                    .to_string(),
            }),
            Err(e) => fallbacks.push(EngineAttempt {
                engine: ENGINE_BROWSER,
                reason: e.to_string(),
            }),
        }
    } else {
        fallbacks.push(EngineAttempt {
            engine: ENGINE_BROWSER,
            reason: "not tried — no browser is available to this caller".to_string(),
        });
    }

    Err(WebError::NoEngineAnswered {
        query: query.to_string(),
        attempts: fallbacks,
    })
}

/// The full DuckDuckGo site, read out of a real browser.
///
/// A separate parser from [`run_html`] because it is a separate page: the
/// scriptless endpoints render `div.result` from a template, and the app
/// renders `[data-testid=…]` from its own components. Reusing one selector set
/// for both would make a change to either look like the web going quiet.
async fn run_browser(
    query: &str,
    opts: &SearchOptions,
    browser: &dyn super::PageSource,
) -> Result<Vec<SearchHit>, WebError> {
    let mut url = format!(
        "{BROWSER_URL}?q={}&kp={}",
        urlencode(query),
        opts.safe_search.param()
    );
    if let Some(region) = opts.region.as_deref() {
        url.push_str(&format!("&kl={}", urlencode(region)));
    }

    let html = browser
        .rendered_html(&url, RESULT_SELECTOR)
        .await
        .map_err(|detail| WebError::Transport {
            url: url.clone(),
            detail,
        })?;

    Ok(parse_browser_results(&html))
}

/// Pull results out of the rendered app.
///
/// Its own function so the markup can be tested against a fixture. The reason
/// that matters here more than anywhere else: this parser only ever runs when
/// the other two have already failed, so a break in it is invisible until the
/// day the search was going to fail anyway — and then it looks like the web
/// went quiet rather than like a selector that moved.
fn parse_browser_results(html: &str) -> Vec<SearchHit> {
    let dom = Dom::from(html);
    let mut hits: Vec<SearchHit> = Vec::new();
    for block in dom.select(RESULT_SELECTOR).iter() {
        let anchor = block.select("a[data-testid='result-title-a']");
        if !anchor.exists() {
            continue;
        }
        let Some(href) = anchor.attr("href") else {
            continue;
        };
        // The app links straight out, but it has used a redirector before and
        // may again — the same unwrapper handles both and returns nothing
        // rather than a tracker URL.
        let Some(url) = unwrap_redirect(&href) else {
            continue;
        };
        let title = clean(&anchor.text());
        if title.is_empty() {
            continue;
        }
        let snippet = block.select("[data-testid='result-snippet']");
        let display = block.select("[data-testid='result-extras-url-link']");
        hits.push(SearchHit {
            image: None,
            rank: hits.len() + 1,
            title,
            url,
            display_url: display
                .exists()
                .then(|| clean(&display.text()))
                .filter(|s| !s.is_empty()),
            snippet: snippet
                .exists()
                .then(|| clean(&snippet.text()))
                .filter(|s| !s.is_empty()),
        });
    }
    hits
}

/// `lite.duckduckgo.com` — a flat table, one `<tr>` per part of a result.
///
/// The rows are siblings rather than nested, so a result is assembled by
/// walking rows in order: a row holding `a.result-link` opens a new hit, and
/// the rows after it contribute the snippet and the display URL until the next
/// link row. Zipping three separate selector results by index would be shorter
/// and wrong, because a result with no snippet shifts every later pairing by
/// one and silently attaches each summary to the wrong title.
async fn run_lite(query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, WebError> {
    let mut form: Vec<(&str, &str)> = vec![("q", query), ("kp", opts.safe_search.param())];
    if let Some(region) = opts.region.as_deref() {
        form.push(("kl", region));
    }

    let response = http::post_form_within(LITE_URL, &form, http::SEARCH_TIMEOUT).await?;
    let dom = Dom::from(response.text().as_str());

    let mut hits: Vec<SearchHit> = Vec::new();
    for row in dom.select("tr").iter() {
        let link = row.select("a.result-link");
        if link.exists() {
            let url = link.attr("href").map(|h| h.to_string()).unwrap_or_default();
            let title = clean(&link.text());
            if url.is_empty() || !url.starts_with("http") {
                continue;
            }
            hits.push(SearchHit {
                image: None,
                rank: hits.len() + 1,
                title,
                url,
                display_url: None,
                snippet: None,
            });
            continue;
        }

        let Some(current) = hits.last_mut() else {
            continue;
        };
        let snippet = row.select("td.result-snippet");
        if snippet.exists() && current.snippet.is_none() {
            let text = clean(&snippet.text());
            if !text.is_empty() {
                current.snippet = Some(text);
            }
            continue;
        }
        let display = row.select("span.link-text");
        if display.exists() && current.display_url.is_none() {
            let text = clean(&display.text());
            if !text.is_empty() {
                current.display_url = Some(text);
            }
        }
    }

    Ok(hits)
}

/// `html.duckduckgo.com` — each result is one self-contained `div.result`.
///
/// Sponsored results carry `result--ad` and are dropped: they are not what was
/// searched for, and a reader has no way to tell an ad from an answer once it
/// is a title and a URL in a list.
async fn run_html(query: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>, WebError> {
    let mut url = format!(
        "{HTML_URL}?q={}&kp={}",
        urlencode(query),
        opts.safe_search.param()
    );
    if let Some(region) = opts.region.as_deref() {
        url.push_str(&format!("&kl={}", urlencode(region)));
    }

    let response = http::get_within(&url, http::SEARCH_TIMEOUT).await?;
    let dom = Dom::from(response.text().as_str());

    let mut hits: Vec<SearchHit> = Vec::new();
    for block in dom.select("div.result").iter() {
        let class = block
            .attr("class")
            .map(|c| c.to_string())
            .unwrap_or_default();
        if class.contains("result--ad") || class.contains("result--sponsored") {
            continue;
        }

        let anchor = block.select("a.result__a");
        if !anchor.exists() {
            continue;
        }
        let title = clean(&anchor.text());
        let Some(href) = anchor.attr("href") else {
            continue;
        };
        let Some(url) = unwrap_redirect(&href) else {
            continue;
        };

        let snippet = block.select("a.result__snippet");
        let display = block.select("a.result__url");

        hits.push(SearchHit {
            image: None,
            rank: hits.len() + 1,
            title,
            url,
            display_url: display
                .exists()
                .then(|| clean(&display.text()))
                .filter(|s| !s.is_empty()),
            snippet: snippet
                .exists()
                .then(|| clean(&snippet.text()))
                .filter(|s| !s.is_empty()),
        });
    }

    Ok(hits)
}

/// Pull the real destination out of a DuckDuckGo click-tracking link.
///
/// A tracker link looks like `//duckduckgo.com/l/?uddg=<escaped>&rut=<hash>`.
/// Returns `None` when the href is a tracker whose payload cannot be read,
/// rather than handing the tracker URL back as if it were the result — that
/// would send the reader to a redirector and record the wrong source.
fn unwrap_redirect(href: &str) -> Option<String> {
    let absolute = if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        href.to_string()
    };

    if !absolute.contains("/l/?") && !absolute.contains("uddg=") {
        return absolute.starts_with("http").then_some(absolute);
    }

    let query = absolute.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("uddg=") {
            let decoded = urldecode(value);
            if decoded.starts_with("http") {
                return Some(decoded);
            }
        }
    }
    None
}

/// Percent-decode, treating `+` as a space the way form encoding does.
fn urldecode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&input[i + 1..i + 3], 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                }
                Err(_) => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-encode everything outside the unreserved set, so a query with
/// spaces, `&`, or non-ASCII cannot alter the URL it is placed into.
fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Collapse the whitespace that indented markup leaves inside extracted text.
///
/// Result snippets arrive wrapped across lines and padded with the template's
/// own indentation; without this a one-line summary reads as a ragged block.
fn clean(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tracker_link_gives_up_its_destination() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Fasync%2Dtrait%2Flatest%2F\
                    &rut=cbd7029a388ae375";
        assert_eq!(
            unwrap_redirect(href).as_deref(),
            Some("https://docs.rs/async-trait/latest/")
        );
    }

    #[test]
    fn a_direct_link_is_left_alone() {
        assert_eq!(
            unwrap_redirect("https://example.com/a?b=c").as_deref(),
            Some("https://example.com/a?b=c")
        );
    }

    /// Handing the tracker URL back would record duckduckgo.com as the source
    /// of whatever the reader went on to quote.
    #[test]
    fn a_tracker_with_no_readable_destination_is_dropped() {
        assert_eq!(unwrap_redirect("//duckduckgo.com/l/?rut=abc"), None);
        assert_eq!(unwrap_redirect("/relative/path"), None);
    }

    #[test]
    fn a_query_cannot_smuggle_extra_url_parameters() {
        assert_eq!(urlencode("a&kl=evil b"), "a%26kl%3Devil+b");
        assert_eq!(urlencode("rust async"), "rust+async");
    }

    #[test]
    fn percent_decoding_round_trips_non_ascii() {
        assert_eq!(urldecode("caf%C3%A9+au+lait"), "café au lait");
        // A malformed escape is kept verbatim rather than swallowing the text
        // after it.
        assert_eq!(urldecode("100%zz"), "100%zz");
    }

    #[test]
    fn indented_markup_text_collapses_to_one_line() {
        assert_eq!(
            clean("  Type erasure for\n   async  methods \n"),
            "Type erasure for async methods"
        );
    }

    /// The lite endpoint's flat table: three rows make one result, and the
    /// second result has no snippet. Index-zipping would give result two the
    /// display URL of result one.
    #[test]
    fn the_lite_table_assembles_rows_into_whole_results() {
        let html = r#"<table>
            <tr><td><a href="https://a.example/one" class="result-link">First</a></td></tr>
            <tr><td class="result-snippet">About the first</td></tr>
            <tr><td><span class="link-text">a.example/one</span></td></tr>
            <tr><td><a href="https://b.example/two" class="result-link">Second</a></td></tr>
            <tr><td><span class="link-text">b.example/two</span></td></tr>
        </table>"#;
        let dom = Dom::from(html);
        let mut hits: Vec<SearchHit> = Vec::new();
        for row in dom.select("tr").iter() {
            let link = row.select("a.result-link");
            if link.exists() {
                hits.push(SearchHit {
                    image: None,
                    rank: hits.len() + 1,
                    title: clean(&link.text()),
                    url: link.attr("href").unwrap().to_string(),
                    display_url: None,
                    snippet: None,
                });
                continue;
            }
            let Some(current) = hits.last_mut() else {
                continue;
            };
            let snippet = row.select("td.result-snippet");
            if snippet.exists() && current.snippet.is_none() {
                current.snippet = Some(clean(&snippet.text()));
                continue;
            }
            let display = row.select("span.link-text");
            if display.exists() && current.display_url.is_none() {
                current.display_url = Some(clean(&display.text()));
            }
        }

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "First");
        assert_eq!(hits[0].snippet.as_deref(), Some("About the first"));
        assert_eq!(hits[0].display_url.as_deref(), Some("a.example/one"));
        assert_eq!(hits[1].title, "Second");
        assert_eq!(hits[1].snippet, None);
        assert_eq!(hits[1].display_url.as_deref(), Some("b.example/two"));
        assert_eq!(hits[1].rank, 2);
    }

    #[test]
    fn safe_search_labels_map_to_the_engine_parameter() {
        assert_eq!(SafeSearch::parse("off").param(), "-2");
        assert_eq!(SafeSearch::parse("STRICT").param(), "1");
        assert_eq!(SafeSearch::parse("anything else").param(), "-1");
    }

    /// A typo must not silently turn a web search into a literature search:
    /// the two answer different questions, and the reader is given no sign
    /// which one they got.
    #[test]
    fn only_a_recognised_label_selects_the_scholarly_catalogues() {
        assert_eq!(SearchSource::parse("scholar"), SearchSource::Scholar);
        assert_eq!(SearchSource::parse("  Papers "), SearchSource::Scholar);
        assert_eq!(SearchSource::parse("scholarly"), SearchSource::Web);
        assert_eq!(SearchSource::parse(""), SearchSource::Web);
    }

    /// The rendered app, as it comes back from the browser rung. A different
    /// page from the scriptless endpoints, so a different parser — and the one
    /// that only runs on a day the search would otherwise have failed.
    #[test]
    fn the_rendered_app_gives_up_its_results() {
        let html = r#"<div>
          <article data-testid="result">
            <a data-testid="result-title-a" href="https://docs.rs/tokio/latest/">Tokio docs</a>
            <span data-testid="result-extras-url-link">docs.rs/tokio/latest</span>
            <div data-testid="result-snippet">An asynchronous runtime for Rust.</div>
          </article>
          <article data-testid="result">
            <a data-testid="result-title-a" href="https://tokio.rs/">Tokio</a>
            <div data-testid="result-snippet">The home page.</div>
          </article>
        </div>"#;
        let hits = parse_browser_results(html);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Tokio docs");
        assert_eq!(hits[0].url, "https://docs.rs/tokio/latest/");
        assert_eq!(hits[0].display_url.as_deref(), Some("docs.rs/tokio/latest"));
        assert_eq!(hits[0].snippet.as_deref(), Some("An asynchronous runtime for Rust."));
        assert_eq!(hits[1].rank, 2);
        assert_eq!(hits[1].display_url, None);
    }

    /// The app has used a click tracker before and may again. Handing one back
    /// would record duckduckgo.com as the source of whatever gets quoted.
    #[test]
    fn a_tracked_link_in_the_app_is_unwrapped_or_dropped() {
        let html = r#"<div>
          <article data-testid="result">
            <a data-testid="result-title-a"
               href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2F&rut=x">Tokio</a>
          </article>
          <article data-testid="result">
            <a data-testid="result-title-a" href="//duckduckgo.com/l/?rut=x">Unreadable</a>
          </article>
        </div>"#;
        let hits = parse_browser_results(html);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://tokio.rs/");
    }

    /// A challenge page is a page with no results in it. It must come back
    /// empty so the ladder reports a failure, never as a successful search of
    /// a web that had nothing to say.
    #[test]
    fn a_page_with_no_results_yields_none() {
        assert!(parse_browser_results("<div><p>Verify you are human</p></div>").is_empty());
    }
}
