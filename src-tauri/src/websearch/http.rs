//! The one HTTP client the web tools use, and the rules for turning a
//! response body into a Rust `String` without corrupting it.
//!
//! Two things here are easy to get wrong and expensive to debug later:
//!
//! * **Character encoding.** A large part of the web is still not UTF-8.
//!   Calling `reqwest`'s `.text()` assumes UTF-8 and silently substitutes
//!   U+FFFD for every byte that is not, so a Japanese or Russian page arrives
//!   as a wall of question marks that looks like a parser bug. We resolve the
//!   encoding the way a browser does: the `Content-Type` header first, then a
//!   byte-order mark, then the page's own `<meta charset>`, then UTF-8.
//!
//! * **Response size.** Nothing stops a URL from being a 2 GB file. The body
//!   is read in chunks against a ceiling and the read stops there, so a single
//!   bad link cannot exhaust memory. When that happens the caller is told, so
//!   a half-read page is never presented as a whole one.

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use reqwest::Client;

use super::WebError;

/// Chrome on Windows. Search endpoints and a fair number of CDNs serve a
/// challenge page or an empty result set to anything that self-identifies as a
/// script, so the request has to look like a browser to get an answer at all.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Ceiling on a single response body. 8 MiB is far past any documentation
/// page and far short of anything that threatens the process.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// How long any one request may take, start to finish.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Redirect hops followed before giving up. Matched to what browsers allow;
/// where the request finally lands is reported to the caller either way.
const MAX_REDIRECTS: usize = 10;

static CLIENT: OnceLock<Client> = OnceLock::new();

/// The shared client. Built once: a `reqwest::Client` owns a connection pool,
/// and building one per request throws away connection reuse and TLS session
/// resumption, which is most of the latency on a second request to one host.
pub fn client() -> Result<&'static Client, WebError> {
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let built = Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .user_agent(BROWSER_UA)
        .default_headers(default_headers())
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .cookie_store(true)
        .build()
        .map_err(|e| WebError::Setup(e.to_string()))?;
    Ok(CLIENT.get_or_init(|| built))
}

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,\
             text/plain;q=0.8,*/*;q=0.7",
        ),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_UA));
    headers
}

/// A response body, read and decoded.
pub struct Fetched {
    /// Where the request finished, after every redirect.
    pub final_url: String,
    /// The `Content-Type` value with parameters stripped (`text/html`).
    pub content_type: Option<String>,
    /// The unmodified `Content-Type` header, parameters included. Kept
    /// alongside the stripped form because the charset lives in the
    /// parameters.
    pub content_type_full: Option<String>,
    /// The raw bytes, capped at [`MAX_RESPONSE_BYTES`].
    pub bytes: Vec<u8>,
    /// True when the body was longer than the cap and the read stopped early.
    pub size_capped: bool,
}

impl Fetched {
    /// Decode the body to text using the encoding the response and the
    /// document declare.
    pub fn text(&self) -> String {
        decode(&self.bytes, self.charset_label().as_deref())
    }

    /// The `charset=` parameter of `Content-Type`, if the server sent one.
    fn charset_label(&self) -> Option<String> {
        self.content_type_full
            .as_deref()?
            .split(';')
            .skip(1)
            .filter_map(|p| {
                let (k, v) = p.split_once('=')?;
                (k.trim().eq_ignore_ascii_case("charset")).then(|| v.trim().trim_matches('"'))
            })
            .next()
            .map(str::to_string)
    }
}

/// Send a GET and read the body.
pub async fn get(url: &str) -> Result<Fetched, WebError> {
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| classify(url, e))?;
    read(url, response).await
}

/// Send a form POST and read the body. Used by the search endpoint that only
/// answers to POST.
pub async fn post_form(url: &str, form: &[(&str, &str)]) -> Result<Fetched, WebError> {
    let response = client()?
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|e| classify(url, e))?;
    read(url, response).await
}

async fn read(requested: &str, response: reqwest::Response) -> Result<Fetched, WebError> {
    let status = response.status();
    let final_url = response.url().to_string();
    let content_type_full = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    if !status.is_success() {
        return Err(WebError::Status {
            url: final_url,
            status: status.as_u16(),
            reason: status.canonical_reason().unwrap_or("").to_string(),
        });
    }

    // Read in chunks rather than with `.bytes()`, which buffers the whole body
    // before it can be inspected — the exact behaviour the cap exists to
    // prevent.
    let mut bytes: Vec<u8> = Vec::new();
    let mut size_capped = false;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| classify(requested, e))?;
        let room = MAX_RESPONSE_BYTES.saturating_sub(bytes.len());
        if chunk.len() >= room {
            bytes.extend_from_slice(&chunk[..room]);
            size_capped = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }

    let content_type = content_type_full
        .as_deref()
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_ascii_lowercase());

    Ok(Fetched {
        final_url,
        content_type,
        content_type_full,
        bytes,
        size_capped,
    })
}

/// Decode bytes to text, resolving the encoding in the order a browser does.
///
/// `declared` is the `charset` from the `Content-Type` header. It wins when
/// present and recognised, because the server knows what it encoded. Failing
/// that a byte-order mark is definitive, and failing that the document's own
/// `<meta charset>` is consulted before falling back to UTF-8.
pub fn decode(bytes: &[u8], declared: Option<&str>) -> String {
    if let Some(enc) = declared.and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes())) {
        let (text, _, _) = enc.decode(bytes);
        return text.into_owned();
    }
    if let Some((enc, _)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _, _) = enc.decode(bytes);
        return text.into_owned();
    }
    if let Some(enc) = sniff_meta_charset(bytes) {
        let (text, _, _) = enc.decode(bytes);
        return text.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Look for `<meta charset=…>` or `<meta http-equiv="content-type" …>` in the
/// head of the document.
///
/// Only the first 4 KiB is searched, which is where the HTML specification
/// requires the declaration to be, and searching further would mean scanning a
/// megabyte of body text for something that cannot legally be there.
fn sniff_meta_charset(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();

    // <meta charset="shift_jis">
    if let Some(at) = text.find("charset") {
        let tail = &text[at + "charset".len()..];
        let value: String = tail
            .trim_start()
            .trim_start_matches('=')
            .trim_start()
            .trim_start_matches(['"', '\''])
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !value.is_empty() {
            return encoding_rs::Encoding::for_label(value.as_bytes());
        }
    }
    None
}

/// Turn a transport failure into a message that names what actually went
/// wrong. `reqwest`'s own `Display` is a chain of wrapper types
/// ("error sending request for url ..."), which tells a reader nothing about
/// whether to retry, fix the URL, or give up.
fn classify(url: &str, err: reqwest::Error) -> WebError {
    let url = url.to_string();
    if err.is_timeout() {
        return WebError::Timeout {
            url,
            seconds: REQUEST_TIMEOUT.as_secs(),
        };
    }
    if err.is_connect() {
        return WebError::Unreachable {
            url,
            detail: root_cause(&err),
        };
    }
    if err.is_redirect() {
        return WebError::TooManyRedirects {
            url,
            limit: MAX_REDIRECTS,
        };
    }
    WebError::Transport {
        url,
        detail: root_cause(&err),
    }
}

/// The innermost message in an error chain — the one naming the real fault
/// (`dns error`, `certificate has expired`) rather than the wrapper.
fn root_cause(err: &dyn std::error::Error) -> String {
    let mut current: &dyn std::error::Error = err;
    while let Some(source) = current.source() {
        current = source;
    }
    current.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declared_charset_wins() {
        // "héllo" in latin-1: 0xE9 is not valid UTF-8 on its own.
        let bytes = [b'h', 0xE9, b'l', b'l', b'o'];
        assert_eq!(decode(&bytes, Some("iso-8859-1")), "héllo");
    }

    #[test]
    fn a_page_that_declares_nothing_is_read_as_utf8() {
        assert_eq!(decode("héllo".as_bytes(), None), "héllo");
    }

    #[test]
    fn a_byte_order_mark_is_honoured_when_the_header_is_silent() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("hi".as_bytes());
        assert_eq!(decode(&bytes, None), "hi");
    }

    /// The case that produces a page full of replacement characters when the
    /// decoder assumes UTF-8: the server sends no charset and the declaration
    /// lives in the markup.
    #[test]
    fn a_meta_charset_in_the_markup_is_found_when_the_header_is_silent() {
        let mut bytes = b"<html><head><meta charset=\"windows-1251\"></head><body>".to_vec();
        bytes.push(0xCF); // "П" in windows-1251
        bytes.extend_from_slice(b"</body></html>");
        let text = decode(&bytes, None);
        assert!(text.contains('П'), "{text}");
        assert!(!text.contains('\u{FFFD}'), "{text}");
    }

    #[test]
    fn an_unrecognised_charset_label_falls_through_to_utf8() {
        assert_eq!(decode("ok".as_bytes(), Some("not-a-charset")), "ok");
    }

    #[test]
    fn the_meta_sniff_only_reads_the_head_of_the_document() {
        // A `charset` mentioned deep in body prose must not be mistaken for a
        // declaration; only the first 4 KiB is searched.
        let mut bytes = vec![b'x'; 5000];
        bytes.extend_from_slice(b"charset=windows-1251");
        assert!(sniff_meta_charset(&bytes).is_none());
    }
}
