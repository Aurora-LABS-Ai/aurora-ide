//! Validated `<aurora_image …>` marker parsing — the single source of truth for
//! "is this text an embedded image, or text that merely *mentions* one?".
//!
//! Images reach the model as markers embedded in ordinary tool-result / user
//! message text:
//!
//! ```text
//! <aurora_image media_type="image/png" width="1400" height="812" src="C:\…\shot.png">BASE64</aurora_image>
//! ```
//!
//! Emitted by `tools::browser::…` (screenshots) and by the composer
//! (`image-markers.ts::buildImageMarker`, pasted/dropped images).
//!
//! ## Why this module exists
//!
//! Every consumer used to detect markers with a bare `contains("<aurora_image ")`
//! substring test and then take "everything up to the next `>`" as the header and
//! "everything up to the next `</aurora_image>`" as base64. That is a false
//! positive on **any text that quotes the marker syntax** — including this
//! project's own source and `.knowledge/knowledge.md`, which document the
//! pipeline. Reading such a file produced an `input_image` part whose payload was
//! several KB of prose, and the provider rejected the whole request:
//!
//! ```text
//! HTTP 400 — Invalid 'input[15].content[0].image_url'. Expected a base64-encoded
//! data URL with an image MIME type, but got an invalid base64-encoded value.
//! ```
//!
//! It also silently bypassed the tool-result size cap: `truncate_tool_content`
//! short-circuits into the leanify branch on the same substring, so any result
//! that quotes the syntax — a grep hit, shell output, a non-exact read — skipped
//! clamping and went to history whole.
//!
//! A marker is therefore only a marker when it is **structurally** one:
//!
//! 1. the header holds nothing but well-formed `name="value"` attributes, on a
//!    single line, with no `<`;
//! 2. a `media_type` attribute is present and is an `image/*` type;
//! 3. a `</aurora_image>` close tag follows; and
//! 4. the body is either valid base64, or empty (a *lean* marker, whose bytes
//!    were stripped for persistence and are re-read from `src` at request time).
//!
//! Prose that mentions `<aurora_image ` fails rule 1 or 2 and stays plain text.
//! Because rule 4 is enforced here, every consumer may treat
//! [`AuroraImageMarker::body`] as a valid base64 payload without re-checking.

/// Longest edge any image handed to a model is allowed. Applies to BOTH axes —
/// a full-page capture is tall, not wide, so bounding the width alone left the
/// expensive dimension unbounded.
pub const MAX_EDGE: u32 = 1024;

/// JPEG quality for the encoded image. 85 is the measured knee: at 1024px it
/// held every small UI label a PNG of the same capture held, at roughly a fifth
/// of the bytes — and those bytes are re-sent on every subsequent turn, since
/// history keeps a path and rehydrates the file into each request.
pub const JPEG_QUALITY: u8 = 85;

/// Media type [`encode_for_vision`] always produces.
pub const ENCODED_MEDIA_TYPE: &str = "image/jpeg";

/// Decode an image, fit it inside [`MAX_EDGE`] square (aspect preserved, never
/// upscaled), and re-encode as JPEG. Returns `(jpeg_bytes, width, height)` where
/// the dimensions are those of the RETURNED image.
///
/// On any decode/encode failure the original bytes come back with `(0, 0)`
/// dimensions, so the caller still has an image — one that degrades to "the
/// file exactly as it is on disk" is still an image the model can see, as long
/// as the format is one the provider accepts.
///
/// Format-agnostic on input: it reads the bytes rather than trusting a name, so
/// neither caller has to announce what it holds.
pub fn encode_for_vision(bytes: Vec<u8>) -> (Vec<u8>, u32, u32) {
    let Ok(img) = image::load_from_memory(&bytes) else {
        return (bytes, 0, 0);
    };
    let (w, h) = (img.width(), img.height());
    // `resize` fits WITHIN the box and keeps the aspect ratio, so passing the
    // bound on both axes is what makes it a longest-edge cap.
    let img = if w > MAX_EDGE || h > MAX_EDGE {
        img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let (ow, oh) = (img.width(), img.height());
    // JPEG has no alpha channel; `to_rgb8` composites away a channel the
    // encoder would otherwise reject outright.
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut out);
    let encoded = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, JPEG_QUALITY)
        .encode_image(&rgb)
        .is_ok();
    if encoded {
        (out, ow, oh)
    } else {
        (bytes, w, h)
    }
}

/// Escape a value for a marker attribute.
///
/// Values are read back by [`AuroraImageMarker::attr`], whose parser scans to
/// the next `"` — so a Windows path containing a quote would end the value
/// early and turn the rest of the header into garbage attributes. `&` goes
/// first, or the escape of the escape would be ambiguous.
pub fn escape_attr(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;")
}

/// Reverse [`escape_attr`].
pub fn unescape_attr(value: &str) -> String {
    value.replace("&quot;", "\"").replace("&amp;", "&")
}

/// Opening token. The trailing space is part of the contract: the tag always
/// carries at least a `media_type` attribute.
const OPEN: &str = "<aurora_image ";
/// Closing token.
pub const CLOSE: &str = "</aurora_image>";

/// A structurally valid marker located inside a larger string.
///
/// Offsets are byte indices into the string passed to [`find_marker`] and always
/// fall on `char` boundaries, so they are safe to slice with.
#[derive(Debug)]
pub struct AuroraImageMarker<'a> {
    /// Byte offset of the opening `<`.
    pub start: usize,
    /// Byte offset just past the header's closing `>` (= start of the body).
    pub header_end: usize,
    /// Byte offset just past `</aurora_image>`.
    pub end: usize,
    /// Raw body slice. Either valid base64 (possibly with surrounding
    /// whitespace) or blank — see [`AuroraImageMarker::payload`].
    pub body: &'a str,
    attrs: Vec<(&'a str, &'a str)>,
}

impl<'a> AuroraImageMarker<'a> {
    /// Attribute value by name, or `None` when absent.
    pub fn attr(&self, name: &str) -> Option<&'a str> {
        self.attrs.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
    }

    /// The `media_type` attribute. Always present and always `image/…` —
    /// validation rejects markers without it.
    pub fn media_type(&self) -> &'a str {
        self.attr("media_type").unwrap_or("image/png")
    }

    /// The `src` attribute: the on-disk PNG a *lean* marker is rehydrated from.
    /// `None` for inline markers (composer attachments, legacy threads).
    pub fn src(&self) -> Option<&'a str> {
        self.attr("src")
    }

    /// The trimmed base64 body, or `None` for a lean marker whose bytes were
    /// stripped for persistence. Guaranteed valid base64 when `Some`.
    pub fn payload(&self) -> Option<&'a str> {
        let trimmed = self.body.trim();
        (!trimmed.is_empty()).then_some(trimmed)
    }
}

/// Find the first structurally valid marker at or after `from`.
///
/// Occurrences that fail validation are skipped, not treated as terminal: a file
/// that *discusses* the marker syntax and later embeds a real screenshot still
/// yields the real one.
pub fn find_marker(content: &str, from: usize) -> Option<AuroraImageMarker<'_>> {
    let mut search = from.min(content.len());
    loop {
        let rel = content.get(search..)?.find(OPEN)?;
        let start = search + rel;
        match parse_at(content, start) {
            Some(marker) => return Some(marker),
            // Prose that merely quotes the token. Resume past this occurrence.
            None => search = start + OPEN.len(),
        }
    }
}

/// True when `content` embeds at least one structurally valid marker.
///
/// Use this in place of `content.contains("<aurora_image ")` — the substring test
/// fires on documentation and source code that quote the syntax.
pub fn has_marker(content: &str) -> bool {
    find_marker(content, 0).is_some()
}

/// Validate a candidate marker starting at `start` (which must index the `<` of
/// an `OPEN` occurrence). Returns `None` when it is not a real marker.
fn parse_at(content: &str, start: usize) -> Option<AuroraImageMarker<'_>> {
    let attrs_start = start + OPEN.len();
    let rest = content.get(attrs_start..)?;

    // The header is single-line and contains no nested tag. Bailing on `<` and
    // newlines is what stops a paragraph of prose from being read as a 1 KB
    // "header" running to some unrelated `>` further down the page.
    let gt = rest.find('>')?;
    let header = &rest[..gt];
    if header.contains('<') || header.contains('\n') || header.contains('\r') {
        return None;
    }

    let attrs = parse_attrs(header)?;
    let media_type = attrs
        .iter()
        .find(|(k, _)| *k == "media_type")
        .map(|(_, v)| *v)?;
    if !media_type.starts_with("image/") || media_type.len() == "image/".len() {
        return None;
    }

    let header_end = attrs_start + gt + 1;
    let close_rel = content.get(header_end..)?.find(CLOSE)?;
    let body_end = header_end + close_rel;
    let body = &content[header_end..body_end];

    // Empty body = lean marker (bytes stripped for persistence, re-read from
    // `src`). Anything else must actually be base64 — this is the check that
    // keeps a broken payload out of the request instead of letting the provider
    // reject the whole turn.
    let trimmed = body.trim();
    if !trimmed.is_empty() && !is_base64_payload(trimmed) {
        return None;
    }

    Some(AuroraImageMarker {
        start,
        header_end,
        end: body_end + CLOSE.len(),
        body,
        attrs,
    })
}

/// Parse a header into `name="value"` pairs. Returns `None` if the header holds
/// anything else — unquoted values, stray words, missing separators.
fn parse_attrs(header: &str) -> Option<Vec<(&str, &str)>> {
    let bytes = header.as_bytes();
    let mut out: Vec<(&str, &str)> = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }

        let name_start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-')
        {
            i += 1;
        }
        if i == name_start {
            return None; // not an attribute name
        }
        let name = &header[name_start..i];

        if bytes.get(i) != Some(&b'=') {
            return None;
        }
        i += 1;
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        i += 1;

        // Values are XML-escaped upstream, so they never contain a raw `"`.
        // Scanning bytes is UTF-8 safe: `"` never appears in a continuation byte.
        let value_start = i;
        while i < bytes.len() && bytes[i] != b'"' {
            i += 1;
        }
        if i >= bytes.len() {
            return None; // unterminated value
        }
        let value = &header[value_start..i];
        i += 1; // past the closing quote

        // Attributes are whitespace-separated; anything else is not a header.
        if i < bytes.len() && bytes[i] != b' ' && bytes[i] != b'\t' {
            return None;
        }
        out.push((name, value));
    }

    (!out.is_empty()).then_some(out)
}

/// Standard-alphabet base64 check: correct alphabet, length a multiple of 4,
/// padding only in the final two positions. No allocation, single pass.
///
/// Deliberately rejects embedded whitespace/newlines — neither emitter wraps its
/// output, and accepting wrapped payloads would re-open the prose false positive.
pub fn is_base64_payload(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 4 || bytes.len() % 4 != 0 {
        return false;
    }
    let mut padding = 0usize;
    for (i, &c) in bytes.iter().enumerate() {
        match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => {
                if padding > 0 {
                    return false; // data after padding
                }
            }
            b'=' => {
                if i + 2 < bytes.len() {
                    return false; // padding outside the final quantum
                }
                padding += 1;
            }
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real screenshot marker: every attribute the browser tool emits.
    const SHOT: &str = concat!(
        r#"<aurora_image media_type="image/png" width="1400" height="812" src="C:\shots\a.png">"#,
        "aGVsbG8=",
        "</aurora_image>",
    );

    #[test]
    fn parses_a_real_marker() {
        let m = find_marker(SHOT, 0).expect("marker");
        assert_eq!(m.media_type(), "image/png");
        assert_eq!(m.src(), Some(r"C:\shots\a.png"));
        assert_eq!(m.attr("width"), Some("1400"));
        assert_eq!(m.payload(), Some("aGVsbG8="));
        assert_eq!(m.end, SHOT.len());
    }

    #[test]
    fn parses_a_composer_marker() {
        let raw = r#"look at this <aurora_image media_type="image/jpeg">aGVsbG8=</aurora_image>"#;
        let m = find_marker(raw, 0).expect("marker");
        assert_eq!(m.media_type(), "image/jpeg");
        assert_eq!(m.src(), None);
        assert_eq!(m.payload(), Some("aGVsbG8="));
    }

    #[test]
    fn parses_a_lean_marker() {
        let raw = r#"<aurora_image media_type="image/png" src="/tmp/a.png"></aurora_image>"#;
        let m = find_marker(raw, 0).expect("marker");
        assert_eq!(m.payload(), None);
        assert_eq!(m.src(), Some("/tmp/a.png"));
    }

    /// The regression this module exists for: `.knowledge/knowledge.md` and the
    /// pipeline's own source quote the marker syntax in prose. Before the
    /// validated parse, reading either produced an `input_image` whose payload
    /// was ~2.8 KB of markdown → provider HTTP 400 on the whole request.
    #[test]
    fn prose_quoting_the_marker_is_not_a_marker() {
        let prose = concat!(
            "FIX: `truncate_tool_content` now returns early when ",
            "`s.contains(\"<aurora_image \")`. Downscale bounds the size so this is safe.\n",
            "- **In-card image**: the MODEL copy keeps the full `<aurora_image>` block ",
            "(vision), and the UI copy emits a lean envelope instead.\n",
            "- reload: parse both the lean JSON and the raw ",
            "`<aurora_image ... src=.. w.. h..>BASE64</aurora_image>` block.\n",
        );
        assert!(find_marker(prose, 0).is_none());
        assert!(!has_marker(prose));
    }

    #[test]
    fn a_real_marker_after_prose_is_still_found() {
        let raw = format!("docs mention <aurora_image ...> loosely.\n\n{SHOT}");
        let m = find_marker(&raw, 0).expect("marker");
        assert_eq!(m.payload(), Some("aGVsbG8="));
        assert_eq!(m.end, raw.len());
    }

    #[test]
    fn rejects_malformed_headers_and_bodies() {
        // No media_type.
        assert!(!has_marker(
            r#"<aurora_image width="10">aGVsbG8=</aurora_image>"#
        ));
        // media_type is not an image type.
        assert!(!has_marker(
            r#"<aurora_image media_type="text/plain">aGVsbG8=</aurora_image>"#
        ));
        // Unquoted attribute value.
        assert!(!has_marker(
            r#"<aurora_image media_type=image/png>aGVsbG8=</aurora_image>"#
        ));
        // Stray word in the header.
        assert!(!has_marker(
            r#"<aurora_image media_type="image/png" oops>aGVsbG8=</aurora_image>"#
        ));
        // Body is not base64.
        assert!(!has_marker(
            r#"<aurora_image media_type="image/png">not base64!</aurora_image>"#
        ));
        // No close tag.
        assert!(!has_marker(
            r#"<aurora_image media_type="image/png">aGVsbG8="#
        ));
    }

    #[test]
    fn base64_validation() {
        assert!(is_base64_payload("aGVsbG8="));
        assert!(is_base64_payload("aGVsbG93b3JsZA=="));
        assert!(is_base64_payload("AAAA"));
        assert!(is_base64_payload("aGVs")); // unpadded, still a whole quantum
        assert!(!is_base64_payload(""));
        assert!(!is_base64_payload("aGV")); // length not a multiple of 4
        assert!(!is_base64_payload("aGVs bG8=")); // embedded space
        assert!(!is_base64_payload("aGVs\nbG8=")); // wrapped
        assert!(!is_base64_payload("a=GVsbG8=")); // padding mid-payload
        assert!(!is_base64_payload("hello worl")); // prose
    }

    /// Multi-byte prose around a marker must not shift byte offsets.
    #[test]
    fn offsets_are_char_boundaries_with_unicode() {
        let raw = format!("Screenshot — página ✓\n{SHOT}\ntrailing — done");
        let m = find_marker(&raw, 0).expect("marker");
        assert_eq!(&raw[m.start..m.end], SHOT);
        assert_eq!(m.body, "aGVsbG8=");
        assert!(raw[m.header_end..].starts_with("aGVsbG8="));
    }
}
