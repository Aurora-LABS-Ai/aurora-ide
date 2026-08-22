//! Turning whatever a URL served into text worth reading.
//!
//! ## What was wrong with the old extractor
//!
//! It collected every text node under `<body>` and joined them with spaces.
//! Three consequences, all of which showed up in real use:
//!
//! 1. `<script>` and `<style>` bodies are text nodes. Minified JavaScript went
//!    into the result as prose. On the page that prompted this rewrite, 6.5 KB
//!    of the 23 KB served was script, and all of it landed in the output.
//! 2. Structure was destroyed. Headings, list items, table cells and code
//!    blocks all became one run-on line, so a reader could not tell a heading
//!    from a caption, or where one list item ended.
//! 3. Because of (1) and (2) the result was far bigger than the page's actual
//!    content, and blew the cap on tool output — at which point the runtime
//!    dropped the body and returned success with nothing in it.
//!
//! ## What replaces it
//!
//! The Readability algorithm (the one behind Firefox's Reader View) scores the
//! document's elements and returns the article body as HTML. That HTML is then
//! converted to Markdown. Headings stay headings, code stays fenced, links keep
//! their targets, and navigation, scripts and footers are gone before the
//! conversion starts.
//!
//! When Readability finds no article — a link index, a dashboard, a very short
//! page — the whole body is converted instead and the result is labelled
//! [`DocumentKind::Page`], so a reader knows the navigation it is seeing is the
//! page's, not an extraction mistake.

use dom_query::Document as Dom;
use dom_smoothie::{Config, ParsePolicy, Readability, TextMode};
use htmd::options::{CodeBlockStyle, HeadingStyle, LinkStyle, Options};
use htmd::HtmlToMarkdown;

use super::http::Fetched;
use super::types::{Document, DocumentKind};

/// Below this many characters, a Readability result is treated as a miss.
///
/// The algorithm is content-scoring, not content-detection: on a page with no
/// article it still returns *something*, usually a stray sidebar. Converting
/// the whole page is more useful than confidently returning one paragraph of
/// menu links as "the article".
const MIN_ARTICLE_CHARS: usize = 200;

/// The least of a page's text that the tidiest extraction may keep before it
/// is judged to be deleting content rather than boilerplate.
///
/// Readability's cleaning passes drop elements that look like navigation:
/// dense with links, short on prose. Modern documentation pages are built out
/// of exactly that — a grid of cards, each a heading, a line, and a link — so
/// the tidiest setting throws the page away and returns the one paragraph that
/// happened to look like an article.
///
/// Measured on two real pages:
///
/// | page | tidiest | no cleaning |
/// |---|---|---|
/// | a card-grid documentation index | 159 chars | 1,655 chars |
/// | a chapter of the Rust book | 21,964 chars | 21,964 chars |
///
/// A well-built article is identical under every setting, so relaxing costs it
/// nothing. A card page loses nine tenths of itself. Half is the line between
/// "trimmed the furniture" and "deleted the room".
const RETAIN_RATIO: f32 = 0.5;

/// Reduce a response to a readable document. The body is not yet windowed —
/// [`Document::window`] does that once the caller's paging arguments are known.
pub fn document_from(requested_url: &str, response: &Fetched) -> Document {
    let content_type = response.content_type.clone();
    let mut note: Vec<String> = Vec::new();

    if response.bytes.is_empty() {
        return Document::unsupported(
            requested_url,
            content_type,
            "the server returned an empty body".to_string(),
        );
    }
    if response.size_capped {
        note.push(format!(
            "the download stopped at {} MiB, so this is the start of the page and not all of it",
            super::http::MAX_RESPONSE_BYTES / (1024 * 1024)
        ));
    }

    let kind_hint = classify(content_type.as_deref(), &response.bytes);

    let mut doc = match kind_hint {
        Route::Html => from_html(requested_url, response),
        Route::Json => from_json(requested_url, response),
        Route::Text => from_text(requested_url, response),
        Route::Unreadable(what) => {
            return Document::unsupported(
                requested_url,
                content_type,
                format!(
                    "{what} cannot be read as text. Nothing was extracted. \
                     Open it with the browser tools if you need to see it."
                ),
            );
        }
    };

    doc.content_type = content_type;
    if response.final_url != requested_url {
        doc.final_url = Some(response.final_url.clone());
    }
    if !note.is_empty() {
        doc.note = Some(match doc.note.take() {
            Some(existing) => format!("{existing}; {}", note.join("; ")),
            None => note.join("; "),
        });
    }
    doc
}

enum Route {
    Html,
    Json,
    Text,
    /// Carries a human name for the format, for the message.
    Unreadable(String),
}

/// Decide how to read a body from its declared type, falling back to looking
/// at the bytes when the server declares nothing (or declares
/// `application/octet-stream`, which means "I don't know" more often than it
/// means "binary").
fn classify(content_type: Option<&str>, bytes: &[u8]) -> Route {
    let declared = content_type.unwrap_or("");

    match declared {
        "text/html" | "application/xhtml+xml" => return Route::Html,
        "application/json" | "text/json" => return Route::Json,
        "application/pdf" => {
            return Route::Unreadable("a PDF".to_string());
        }
        _ => {}
    }
    if declared.starts_with("image/") {
        return Route::Unreadable(format!("an image ({declared})"));
    }
    if declared.starts_with("audio/") || declared.starts_with("video/") {
        return Route::Unreadable(format!("a media file ({declared})"));
    }
    if declared.ends_with("+json") {
        return Route::Json;
    }
    if declared.starts_with("text/") || declared.ends_with("+xml") || declared == "application/xml"
    {
        return Route::Text;
    }
    if declared.starts_with("application/")
        && (declared.contains("javascript") || declared.contains("ecmascript"))
    {
        return Route::Text;
    }

    // Nothing usable was declared. Sniff.
    if bytes.starts_with(b"%PDF-") {
        return Route::Unreadable("a PDF".to_string());
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return Route::Unreadable("a zip archive".to_string());
    }
    if bytes.starts_with(b"\x89PNG") || bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Route::Unreadable("an image".to_string());
    }
    // A NUL byte in the first kilobyte means binary in every text format that
    // matters here.
    if bytes[..bytes.len().min(1024)].contains(&0) {
        return Route::Unreadable(format!(
            "a binary payload{}",
            content_type.map(|c| format!(" ({c})")).unwrap_or_default()
        ));
    }

    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    if head.contains("<!doctype html") || head.contains("<html") {
        Route::Html
    } else {
        Route::Text
    }
}

fn from_html(url: &str, response: &Fetched) -> Document {
    let html = response.text();

    // Readability wants an absolute URL so it can resolve the page's relative
    // links; without one, every `href="/docs"` in the output points nowhere.
    let base = response.final_url.as_str();

    if let Some(article) = best_article(&html, base) {
        let markdown = to_markdown(&article.content);
        if markdown.chars().count() >= MIN_ARTICLE_CHARS {
            return Document {
                url: url.to_string(),
                kind: DocumentKind::Article,
                title: non_empty(article.title),
                byline: article.byline.and_then(non_empty),
                site_name: article.site_name.and_then(non_empty),
                excerpt: article.excerpt.and_then(non_empty),
                published: article.published_time.and_then(non_empty),
                language: article.lang.and_then(non_empty),
                content: markdown,
                ..Document::default()
            };
        }
    }

    // No article worth the name. Convert the page, minus the parts that are
    // never content, and say so.
    let dom = Dom::from(html.as_str());
    let title = non_empty(dom.select("title").text().to_string());
    let language = dom
        .select("html")
        .attr("lang")
        .map(|l| l.to_string())
        .and_then(non_empty);
    let body = dom.select("body");
    let source = if body.exists() {
        body.html()
    } else {
        dom.html()
    };

    Document {
        url: url.to_string(),
        kind: DocumentKind::Page,
        title,
        language,
        content: to_markdown(&source),
        note: Some(
            "no article body was found on this page, so this is the whole page including its \
             navigation and footer"
                .to_string(),
        ),
        ..Document::default()
    }
}

/// Pick the tidiest extraction that still keeps most of the page.
///
/// Cleaning is asked for first, because on a real article it costs nothing and
/// removes the share buttons and the comment form. It is only given up when it
/// can be shown to be deleting content, and it is shown against the page
/// itself: the uncleaned extraction is the yardstick, so the comparison is
/// "how much of this page survived" rather than a guess at what a page should
/// weigh.
///
/// Two or three parses instead of one. On a 55 KB page that is a few tens of
/// milliseconds against a network round trip measured in hundreds, and it is
/// the difference between a documentation index arriving whole and arriving as
/// one stray paragraph.
fn best_article(html: &str, base: &str) -> Option<dom_smoothie::Article> {
    let parse = |policy: ParsePolicy| -> Option<dom_smoothie::Article> {
        let cfg = Config {
            // Structure is handled by the Markdown conversion, so the
            // algorithm is asked for HTML rather than its own text rendering.
            text_mode: TextMode::Raw,
            ..Config::default()
        };
        Readability::new(html, Some(base), Some(cfg))
            .ok()?
            .parse_with_policy(policy)
            .ok()
    };

    let uncleaned = parse(ParsePolicy::Raw);
    let yardstick = uncleaned.as_ref().map_or(0, |a| a.text_content.len());
    let floor = (yardstick as f32 * RETAIN_RATIO) as usize;

    for policy in [ParsePolicy::Strict, ParsePolicy::Clean] {
        if let Some(article) = parse(policy) {
            if article.text_content.len() >= floor {
                return Some(article);
            }
        }
    }
    uncleaned
}

/// Convert article HTML to Markdown.
///
/// The skip list is the belt to Readability's braces. Readability usually
/// removes these already, but the whole-page path above has no such filter,
/// and script text reaching the output is exactly the failure this module was
/// written to end.
fn to_markdown(html: &str) -> String {
    let options = Options {
        heading_style: HeadingStyle::Atx,
        code_block_style: CodeBlockStyle::Fenced,
        link_style: LinkStyle::Inlined,
        ..Options::default()
    };

    let converter = HtmlToMarkdown::builder()
        .options(options)
        .skip_tags(vec![
            "script", "style", "noscript", "template", "svg", "canvas", "iframe", "form", "nav",
            "footer",
        ])
        .build();

    let markdown = converter.convert(html).unwrap_or_default();
    tidy(&markdown)
}

/// Collapse the runs of blank lines that dropped elements leave behind.
///
/// Removing a `<nav>` from between two sections leaves its surrounding blank
/// lines, and enough of those turn a short page into pages of whitespace that
/// cost context and say nothing.
fn tidy(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut blank_run = 0usize;
    for line in markdown.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(trimmed);
        out.push('\n');
    }
    out.trim().to_string()
}

fn from_json(url: &str, response: &Fetched) -> Document {
    let raw = response.text();
    // Re-indent so a minified API response is readable, but keep the original
    // when it does not parse — a JSON endpoint returning broken JSON is
    // something the reader needs to see verbatim, not a parse error instead.
    let content = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or(raw);

    Document {
        url: url.to_string(),
        kind: DocumentKind::Data,
        content,
        ..Document::default()
    }
}

fn from_text(url: &str, response: &Fetched) -> Document {
    Document {
        url: url.to_string(),
        kind: DocumentKind::Text,
        content: response.text(),
        ..Document::default()
    }
}

fn non_empty(s: String) -> Option<String> {
    let trimmed = s.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fetched(body: &str, content_type: &str) -> Fetched {
        Fetched {
            final_url: "https://example.com/page".to_string(),
            content_type: Some(content_type.to_string()),
            content_type_full: Some(content_type.to_string()),
            bytes: body.as_bytes().to_vec(),
            size_capped: false,
        }
    }

    /// The shape of the page that produced the original bug report: no
    /// `<main>`, no `<article>`, and several kilobytes of inline script.
    fn page_with_scripts() -> String {
        let prose = "Aurora keeps your workspace indexed so the agent can answer questions \
                     about code it has never opened in this conversation. ";
        format!(
            r#"<!doctype html><html lang="en"><head><title>Aurora Documentation</title>
            <script>var _t={{a:1}};function boot(){{for(var i=0;i<1e3;i++){{track(i)}}}}</script>
            <style>.x{{color:red}}</style></head>
            <body>
              <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
              <div class="content">
                <h1>Quick start</h1>
                <p>{prose}{prose}{prose}</p>
                <h2>Install</h2>
                <ul><li>Download the extension</li><li>Sign in</li></ul>
                <pre><code>aurora --init</code></pre>
              </div>
              <footer>Contact support</footer>
              <script>window.analytics.push(['track','pageview','docs'])</script>
            </body></html>"#
        )
    }

    /// The headline regression: script bodies were being handed to the model
    /// as if they were page text.
    #[test]
    fn script_and_style_bodies_never_reach_the_output() {
        let doc = document_from(
            "https://example.com/page",
            &fetched(&page_with_scripts(), "text/html"),
        );
        assert!(!doc.content.contains("window.analytics"), "{}", doc.content);
        assert!(!doc.content.contains("function boot"), "{}", doc.content);
        assert!(!doc.content.contains("color:red"), "{}", doc.content);
    }

    /// The other half of the regression: everything arrived as one line, so a
    /// heading was indistinguishable from body text.
    #[test]
    fn structure_survives_as_markdown() {
        let doc = document_from(
            "https://example.com/page",
            &fetched(&page_with_scripts(), "text/html"),
        );
        assert!(doc.content.contains("# Quick start"), "{}", doc.content);
        assert!(doc.content.contains("## Install"), "{}", doc.content);
        assert!(
            doc.content.contains("Download the extension"),
            "{}",
            doc.content
        );
        assert!(doc.content.contains("aurora --init"), "{}", doc.content);
    }

    #[test]
    fn the_page_title_is_read_from_the_document() {
        let doc = document_from(
            "https://example.com/page",
            &fetched(&page_with_scripts(), "text/html"),
        );
        assert_eq!(doc.title.as_deref(), Some("Aurora Documentation"));
    }

    /// A page with no article body is still returned, but labelled, so the
    /// reader knows the menus it can see are the page's own.
    #[test]
    fn a_page_with_no_article_is_returned_and_labelled() {
        let html = r#"<!doctype html><html><head><title>Links</title></head>
            <body><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></body></html>"#;
        let doc = document_from("https://example.com/", &fetched(html, "text/html"));
        assert_eq!(doc.kind, DocumentKind::Page);
        assert!(doc.note.unwrap().contains("no article body"));
        assert!(doc.content.contains("[A](/a)") || doc.content.contains("A"));
    }

    #[test]
    fn a_redirect_is_reported_rather_than_hidden() {
        let mut response = fetched("<html><body><p>hi</p></body></html>", "text/html");
        response.final_url = "https://example.com/moved".to_string();
        let doc = document_from("https://example.com/old", &response);
        assert_eq!(doc.final_url.as_deref(), Some("https://example.com/moved"));
    }

    #[test]
    fn json_is_reindented_and_labelled_as_data() {
        let doc = document_from(
            "https://api.example.com/v1",
            &fetched(r#"{"a":1,"b":[2,3]}"#, "application/json"),
        );
        assert_eq!(doc.kind, DocumentKind::Data);
        assert!(doc.content.contains("\"a\": 1"), "{}", doc.content);
    }

    #[test]
    fn broken_json_is_handed_over_verbatim() {
        let doc = document_from(
            "https://api.example.com/v1",
            &fetched("{not json", "application/json"),
        );
        assert_eq!(doc.content, "{not json");
    }

    #[test]
    fn plain_text_is_passed_straight_through() {
        let doc = document_from(
            "https://example.com/robots.txt",
            &fetched("User-agent: *\nDisallow: /x\n", "text/plain"),
        );
        assert_eq!(doc.kind, DocumentKind::Text);
        assert!(doc.content.contains("Disallow: /x"));
    }

    /// Silence would read as "the page was empty". The reader is told what the
    /// thing is and what to do instead.
    #[test]
    fn an_unreadable_format_says_what_it_is_and_what_to_do() {
        let doc = document_from(
            "https://example.com/spec.pdf",
            &fetched("%PDF-1.7 ...", "application/pdf"),
        );
        assert_eq!(doc.kind, DocumentKind::Unsupported);
        let note = doc.note.unwrap();
        assert!(note.contains("PDF"), "{note}");
        assert!(note.contains("browser tools"), "{note}");
        assert!(doc.content.is_empty());
    }

    #[test]
    fn an_undeclared_body_is_routed_by_its_bytes() {
        let mut png = fetched("", "");
        png.content_type = None;
        png.content_type_full = None;
        png.bytes = b"\x89PNG\r\n\x1a\n\x00\x00".to_vec();
        let doc = document_from("https://example.com/x", &png);
        assert_eq!(doc.kind, DocumentKind::Unsupported);
        assert!(doc.note.unwrap().contains("image"));
    }

    #[test]
    fn an_empty_body_is_named_as_empty() {
        let mut response = fetched("", "text/html");
        response.bytes.clear();
        let doc = document_from("https://example.com/x", &response);
        assert_eq!(doc.kind, DocumentKind::Unsupported);
        assert!(doc.note.unwrap().contains("empty body"));
    }

    #[test]
    fn a_capped_download_admits_it_is_partial() {
        let mut response = fetched(&page_with_scripts(), "text/html");
        response.size_capped = true;
        let doc = document_from("https://example.com/page", &response);
        assert!(doc.note.unwrap().contains("not all of it"));
    }

    #[test]
    fn runs_of_blank_lines_are_collapsed() {
        assert_eq!(tidy("a\n\n\n\n\nb\n\n"), "a\n\nb");
    }

    /// A documentation index built from linked cards. Readability's cleaning
    /// passes score this as navigation — dense with links, short on prose —
    /// and on the real page this is modelled on they kept 159 characters of
    /// 1,655. Every card's text has to survive.
    fn card_grid_page() -> String {
        let cards = [
            (
                "Install the extension",
                "Download the .vsix file and install it from the command palette",
                "/download",
            ),
            (
                "Sign in",
                "Open the command palette and enter the token from your dashboard",
                "/dashboard/settings",
            ),
            (
                "Index your project",
                "Build the search index so the agent can answer questions about code",
                "/dashboard",
            ),
            (
                "Bring your own keys",
                "Use your own provider keys for Anthropic, OpenAI and others",
                "/settings",
            ),
        ]
        .iter()
        .map(|(title, body, href)| {
            format!(r#"<a class="card" href="{href}"><h3>{title}</h3><p>{body}</p></a>"#)
        })
        .collect::<String>();

        format!(
            r#"<!doctype html><html lang="en"><head><title>Docs</title></head><body>
              <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
              <h1>Documentation</h1>
              <p>Everything you need to get the most out of the product.</p>
              <h2>Quick start</h2>
              <div class="grid">{cards}</div>
            </body></html>"#
        )
    }

    #[test]
    fn a_page_built_from_cards_keeps_every_card() {
        let doc = document_from(
            "https://example.com/docs",
            &fetched(&card_grid_page(), "text/html"),
        );
        for expected in [
            "Install the extension",
            "Download the .vsix file",
            "Sign in",
            "Index your project",
            "Bring your own keys",
            "Anthropic, OpenAI",
        ] {
            assert!(
                doc.content.contains(expected),
                "lost {expected:?}:\n{}",
                doc.content
            );
        }
    }

    /// The other side of the trade: relaxing the cleaning must not start
    /// dragging navigation and footers into ordinary articles.
    #[test]
    fn an_ordinary_article_is_unchanged_by_the_relaxed_path() {
        let prose = "The trait defines shared behaviour across types, and a generic bound \
                     names the behaviour a type must have. ";
        let html = format!(
            r#"<!doctype html><html><head><title>Traits</title></head><body>
              <nav><a href="/prev">Previous chapter</a><a href="/next">Next chapter</a></nav>
              <article><h1>Traits</h1><p>{prose}{prose}{prose}{prose}</p>
              <h2>Bounds</h2><p>{prose}{prose}{prose}</p></article>
              <footer>Copyright the authors</footer>
            </body></html>"#
        );
        let doc = document_from("https://example.com/traits", &fetched(&html, "text/html"));
        assert_eq!(doc.kind, DocumentKind::Article);
        // The article's own `h1` is lifted into `title` rather than repeated
        // at the top of the body, which is what Readability does and what the
        // card needs: a heading and a body, not the heading twice.
        assert_eq!(doc.title.as_deref(), Some("Traits"));
        assert!(doc.content.contains("## Bounds"), "{}", doc.content);
        assert!(doc.content.contains("generic bound"), "{}", doc.content);
        assert!(
            !doc.content.contains("Previous chapter"),
            "nav leaked:\n{}",
            doc.content
        );
        assert!(
            !doc.content.contains("Copyright"),
            "footer leaked:\n{}",
            doc.content
        );
    }
}
