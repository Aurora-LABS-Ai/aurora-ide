//! The shapes `search` and `fetch` return.
//!
//! Both are serialized straight into the tool result the model reads and the
//! card the user sees, so every field here is answering a question one of them
//! actually asks. Nothing is `Option` for tidiness: an absent field means the
//! page genuinely did not say, and the reader is allowed to conclude that.

use serde::{Deserialize, Serialize};

/// One entry on a results page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 1-based position as the engine ranked it. Kept explicitly rather than
    /// left to array order because the model quotes it back ("the third
    /// result"), and a later filter must not silently renumber the list.
    pub rank: usize,
    pub title: String,
    /// The real destination, already unwrapped from any engine redirect.
    pub url: String,
    /// The breadcrumb the engine printed under the title
    /// (`docs.rs/async-trait/latest/async_trait/`). Worth keeping separately
    /// from `url`: it is what tells a reader at a glance where a result leads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_url: Option<String>,
    /// The engine's own summary, with its `<b>` match highlighting stripped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// A finished search.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub query: String,
    /// Which back end answered. Named because the two DuckDuckGo endpoints
    /// return different result quality, and "why is this list worse than last
    /// time" is otherwise unanswerable.
    pub engine: &'static str,
    pub results: Vec<SearchHit>,
    pub count: usize,
    /// Engines that were tried and did not answer, with the reason. Empty on
    /// a first-try success. This is the difference between "the web has
    /// nothing" and "our parser broke", and the model cannot tell them apart
    /// without it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fallbacks: Vec<EngineAttempt>,
}

/// One engine that was asked and could not answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineAttempt {
    pub engine: &'static str,
    pub reason: String,
}

/// What kind of thing was at the far end of a URL.
///
/// The model chooses its next move from this: an `Article` can be read on, a
/// `Data` payload can be parsed, and `Unsupported` means stop asking and try
/// another route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentKind {
    /// An HTML page whose article body was found and converted to Markdown.
    Article,
    /// An HTML page with no article body — the whole page was converted
    /// instead, so it carries navigation and footers the reader must ignore.
    Page,
    /// Plain text, Markdown, source code, CSV: served as-is.
    Text,
    /// JSON or XML, served as-is (JSON is re-indented).
    Data,
    /// Something this tool cannot turn into text. `content` is empty and
    /// `note` says why.
    Unsupported,
}

/// A fetched page, already reduced to text the model can read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// The URL as asked for.
    pub url: String,
    /// Where the request actually landed. Present only when it differs from
    /// `url` — a silent redirect is how a reader ends up quoting a login page
    /// as if it were the documentation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub kind: DocumentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// The `Content-Type` the server sent, minus its parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// The readable body. Markdown for HTML; the payload verbatim otherwise.
    pub content: String,

    // --- Paging -----------------------------------------------------------
    //
    // A long page is handed over in windows rather than clipped, because the
    // reader has to be able to get the rest. Clipping answers "here is some of
    // it" and stops; paging answers "here is this part, ask for the next".
    /// Length of the whole document, in characters, before this window.
    pub total_chars: usize,
    /// Length of `content`.
    pub returned_chars: usize,
    /// Where this window starts in the whole document.
    pub offset: usize,
    /// True when there is more after this window.
    pub has_more: bool,
    /// The `offset` that reads the next window. Present only with `has_more`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,

    /// Anything the reader must know that the fields above cannot say: a
    /// rewritten URL, an unreadable content type, a truncated download.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Document {
    /// Cut `body` down to the window starting at `offset`, and fill in the
    /// paging fields to describe what was left out.
    ///
    /// Windows are cut on character boundaries, never bytes, so a multi-byte
    /// character can never be split across two windows and come back as two
    /// pieces of mojibake.
    pub fn window(mut self, body: &str, offset: usize, max_chars: usize) -> Self {
        let total: Vec<char> = body.chars().collect();
        let total_chars = total.len();
        let start = offset.min(total_chars);
        let end = start.saturating_add(max_chars).min(total_chars);

        self.content = total[start..end].iter().collect();
        self.total_chars = total_chars;
        self.returned_chars = end - start;
        self.offset = start;
        self.has_more = end < total_chars;
        self.next_offset = self.has_more.then_some(end);
        self
    }

    /// A document that could not be read, carrying the reason instead of a
    /// body. Deliberately not an `Err`: the request itself succeeded, and the
    /// reader needs the content type and size to decide what to do next.
    pub fn unsupported(url: &str, content_type: Option<String>, note: String) -> Self {
        Self {
            url: url.to_string(),
            final_url: None,
            kind: DocumentKind::Unsupported,
            title: None,
            byline: None,
            site_name: None,
            excerpt: None,
            published: None,
            language: None,
            content_type,
            content: String::new(),
            total_chars: 0,
            returned_chars: 0,
            offset: 0,
            has_more: false,
            next_offset: None,
            note: Some(note),
        }
    }
}

impl Default for Document {
    fn default() -> Self {
        Self {
            url: String::new(),
            final_url: None,
            kind: DocumentKind::Page,
            title: None,
            byline: None,
            site_name: None,
            excerpt: None,
            published: None,
            language: None,
            content_type: None,
            content: String::new(),
            total_chars: 0,
            returned_chars: 0,
            offset: 0,
            has_more: false,
            next_offset: None,
            note: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Document {
        Document::default()
    }

    #[test]
    fn a_short_body_is_one_whole_window() {
        let d = doc().window("hello", 0, 100);
        assert_eq!(d.content, "hello");
        assert_eq!(d.total_chars, 5);
        assert_eq!(d.returned_chars, 5);
        assert!(!d.has_more);
        assert_eq!(d.next_offset, None);
    }

    #[test]
    fn a_long_body_reports_where_to_continue() {
        let body = "abcdefghij";
        let first = doc().window(body, 0, 4);
        assert_eq!(first.content, "abcd");
        assert!(first.has_more);
        assert_eq!(first.next_offset, Some(4));

        let second = doc().window(body, 4, 4);
        assert_eq!(second.content, "efgh");
        assert_eq!(second.next_offset, Some(8));

        let last = doc().window(body, 8, 4);
        assert_eq!(last.content, "ij");
        assert!(!last.has_more);
        assert_eq!(last.next_offset, None);
    }

    /// A byte-based window would split these characters and hand back
    /// replacement characters at both seams.
    #[test]
    fn windows_never_split_a_multi_byte_character() {
        let body = "日本語のテキストです";
        let first = doc().window(body, 0, 3);
        assert_eq!(first.content, "日本語");
        let second = doc().window(body, 3, 3);
        assert_eq!(second.content, "のテキ");
        assert_eq!(first.total_chars, 10);
    }

    #[test]
    fn an_offset_past_the_end_returns_nothing_rather_than_panicking() {
        let d = doc().window("abc", 99, 10);
        assert_eq!(d.content, "");
        assert_eq!(d.offset, 3);
        assert!(!d.has_more);
    }

    /// `skip_serializing_if` on the optional fields is what keeps a fetch
    /// result small enough to never reach the runtime's lossy compactor.
    #[test]
    fn absent_fields_are_left_out_of_the_json_entirely() {
        let json = serde_json::to_string(&doc().window("hi", 0, 10)).unwrap();
        assert!(!json.contains("byline"), "{json}");
        assert!(!json.contains("nextOffset"), "{json}");
        assert!(json.contains("\"totalChars\":2"), "{json}");
    }
}
