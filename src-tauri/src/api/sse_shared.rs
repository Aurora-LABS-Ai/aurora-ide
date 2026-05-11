//! Shared SSE plumbing for Aurora's HTTP streaming adapters.
//!
//! Phase 5 (Sub-E adapter audit) folds the byte-level frame buffer
//! and the per-frame `data:` payload extractor into one canonical
//! home so that `api::anthropic` and `api::openai_compat` (and any
//! future provider adapter) call the same code instead of carrying
//! duplicate copies.
//!
//! ## What this module covers
//!
//! - [`SseFrameBuffer`] — owns a `Vec<u8>` that accumulates raw bytes
//!   pulled from the upstream `reqwest` response stream. The buffer
//!   intentionally splits on the *byte-level* `\n\n` / `\r\n\r\n`
//!   terminator so multi-byte UTF-8 codepoints split across two
//!   `Bytes` chunks reassemble cleanly. (This was a real Phase 5
//!   bug in the original kernel, fixed earlier this year and now
//!   shared verbatim.)
//! - [`frame_payloads`] — walks the lines of one SSE frame, ignores
//!   comments / `event:` lines, and surfaces every `data:` payload
//!   as a separate `String`. The `[DONE]` sentinel is filtered out
//!   so call sites never see it.
//!
//! ## What this module deliberately does NOT cover
//!
//! - Provider-specific JSON wire shapes (Anthropic event types,
//!   OpenAI streaming envelopes). Those still live in
//!   [`super::provider_kernel_adapter`] because they are JSON
//!   models, not SSE plumbing.
//! - HTTP error mapping (`reqwest::Error` → `ApiError`, status codes
//!   → `ApiError`). Same reason.
//! - `commands::provider_kernel::streaming` is left untouched in
//!   Phase 5 — that module is `pub(crate)` to a private `streaming`
//!   submodule and modifying it falls outside Sub-E's scope per the
//!   contract. The existing kernel keeps its internal copy until the
//!   eventual full retirement of `provider_kernel`. See
//!   `src-tauri/src/api/AUDIT.md` for the full audit decision.

#![allow(dead_code)]

/// Byte-level SSE frame buffer.
///
/// Behaviour matches `commands::provider_kernel::streaming::SseFrameBuffer`
/// exactly — same separator detection, same `from_utf8_lossy` policy
/// for the rare malformed-UTF-8 frame. Both copies coexist by design;
/// see the module-level note above.
pub struct SseFrameBuffer {
    buffer: Vec<u8>,
}

impl SseFrameBuffer {
    #[must_use]
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn extend(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Drain all complete frames currently sitting in the buffer.
    /// Bytes past the last terminator stay so the next chunk can
    /// finish the in-flight frame.
    pub fn take_frames(&mut self) -> Vec<String> {
        let mut frames = Vec::new();
        loop {
            let separator = self
                .buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|position| (position, 2))
                .or_else(|| {
                    self.buffer
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|position| (position, 4))
                });

            let Some((position, separator_len)) = separator else {
                break;
            };

            let frame_bytes: Vec<u8> = self.buffer.drain(..position + separator_len).collect();
            let frame_len = frame_bytes.len().saturating_sub(separator_len);
            let frame = String::from_utf8_lossy(&frame_bytes[..frame_len]).into_owned();
            frames.push(frame);
        }
        frames
    }

    /// Bytes still in the buffer that haven't completed a frame yet.
    /// Used by tests to assert progress.
    #[must_use]
    pub fn pending_len(&self) -> usize {
        self.buffer.len()
    }
}

impl Default for SseFrameBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-frame `data:` payload extractor. Walks the lines of one SSE
/// frame, ignores comments and `event:` lines, and returns each
/// `data:` payload as a separate `String`. The `[DONE]` sentinel is
/// filtered out — providers like OpenAI emit it as a closing marker
/// and call sites should never see it.
#[must_use]
pub fn frame_payloads(frame: &str) -> Vec<String> {
    let mut payloads = Vec::new();
    for line in frame.split('\n') {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() || trimmed.starts_with(':') {
            continue;
        }

        let payload = if let Some(rest) = trimmed.strip_prefix("data: ") {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("data:") {
            rest.trim_start()
        } else {
            continue;
        };

        if payload == "[DONE]" {
            continue;
        }

        payloads.push(payload.to_string());
    }
    payloads
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_buffer_splits_on_double_lf() {
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 2);
        assert!(frames[0].contains("{\"a\":1}"));
        assert!(frames[1].contains("{\"b\":2}"));
        assert_eq!(buf.pending_len(), 0);
    }

    #[test]
    fn frame_buffer_splits_on_crlf_crlf() {
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"a\":1}\r\n\r\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].contains("{\"a\":1}"));
    }

    #[test]
    fn frame_buffer_holds_partial_frame_until_terminator() {
        let mut buf = SseFrameBuffer::new();
        buf.extend(b"data: {\"hel");
        assert!(buf.take_frames().is_empty());
        assert!(buf.pending_len() > 0);
        buf.extend(b"lo\":\"world\"}\n\n");
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        let payloads = frame_payloads(&frames[0]);
        assert_eq!(payloads, vec![r#"{"hello":"world"}"#.to_string()]);
        assert_eq!(buf.pending_len(), 0);
    }

    #[test]
    fn frame_buffer_preserves_multi_byte_utf8_across_chunks() {
        // "héllo" → bytes for é are 0xC3 0xA9. Split between two
        // chunks; the full frame must reassemble cleanly.
        let bytes = "data: héllo\n\n".as_bytes();
        let split = bytes
            .iter()
            .position(|&b| b == 0xC3)
            .expect("find the multi-byte start") + 1;
        let mut buf = SseFrameBuffer::new();
        buf.extend(&bytes[..split]);
        assert!(buf.take_frames().is_empty());
        buf.extend(&bytes[split..]);
        let frames = buf.take_frames();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].contains("héllo"), "got: {}", frames[0]);
    }

    #[test]
    fn frame_payloads_skips_done_marker() {
        assert!(frame_payloads("data: [DONE]").is_empty());
    }

    #[test]
    fn frame_payloads_skips_comments_and_event_only_frames() {
        let frame = ": keep-alive\nevent: ping";
        assert!(frame_payloads(frame).is_empty());
    }

    #[test]
    fn frame_payloads_handles_data_without_space() {
        let frame = "data:hello";
        assert_eq!(frame_payloads(frame), vec!["hello".to_string()]);
    }

    #[test]
    fn frame_payloads_returns_multiple_data_lines() {
        let frame = "data: a\ndata: b";
        assert_eq!(
            frame_payloads(frame),
            vec!["a".to_string(), "b".to_string()],
        );
    }
}
