//! Connect-RPC stream framing.
//!
//! Cursor's `agent.v1.AgentService/Run` is a Connect **streaming** call, whose
//! wire format is a sequence of 5-byte-prefixed envelopes:
//!
//! ```text
//! ┌────────┬──────────────────┬───────────────┐
//! │ flags  │ length (u32 BE)  │ payload       │
//! │ 1 byte │ 4 bytes          │ `length` bytes│
//! └────────┴──────────────────┴───────────────┘
//! ```
//!
//! Two flag bits matter:
//!
//! - `0x01` — the payload is gzip-compressed.
//! - `0x02` — this is the **end-of-stream** envelope. Its payload is JSON, not
//!   protobuf: `{}` on success, or `{"error":{"code":…,"message":…}}`.
//!
//! The unary methods on the same service use a *different* format — bare body,
//! no envelope — which is why [`super::unary`] exists separately. Sending the
//! streaming content type to a unary method returns a bodyless `415`, an error
//! that says nothing about the actual cause, so the two are kept apart at the
//! type level rather than behind a boolean.

use std::io::Read;

/// Payload is gzip-compressed.
const FLAG_COMPRESSED: u8 = 0x01;
/// Terminal envelope; payload is a JSON trailer.
const FLAG_END_STREAM: u8 = 0x02;

/// Envelope header size: one flag byte plus a `u32` length.
const HEADER_LEN: usize = 5;

/// A refusal to decode a frame, kept separate from a turn-level error so the
/// caller can distinguish "this stream is malformed" from "the model said no".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The declared payload length exceeds what we are willing to buffer.
    TooLarge { declared: usize, max: usize },
    /// Flagged as gzip but did not decompress.
    Decompress(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { declared, max } => write!(
                f,
                "Cursor sent a {declared}-byte frame, over the {max}-byte limit"
            ),
            Self::Decompress(err) => write!(f, "Cursor sent an undecompressable frame: {err}"),
        }
    }
}

/// Upper bound on a single envelope.
///
/// Not a guess at what Cursor sends: it is a guard against a desynchronised
/// stream, where four arbitrary bytes get read as a length and would otherwise
/// have us allocate gigabytes. 64 MiB is far above any real frame and far
/// below anything that hurts.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// One decoded envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// A protobuf `AgentServerMessage`, already decompressed.
    Message(Vec<u8>),
    /// The terminal envelope's JSON trailer.
    EndOfStream(Vec<u8>),
}

/// Wrap a payload as a client-to-server envelope.
///
/// Aurora never compresses what it sends. The request side of a turn is small
/// — actions and blob replies — and an uncompressed frame is one fewer thing
/// to be wrong about when a stream desynchronises.
#[must_use]
pub fn encode(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.push(0);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Incremental envelope reader.
///
/// HTTP/2 data chunks have no relationship to envelope boundaries: one chunk
/// may carry three frames, or a third of one. Feed every chunk to [`push`] and
/// drain whatever completed.
///
/// [`push`]: FrameDecoder::push
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    finished: bool,
}

impl FrameDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Append bytes and return every envelope they completed.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, FrameError> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.buffer.extend_from_slice(chunk);

        let mut frames = Vec::new();
        loop {
            if self.buffer.len() < HEADER_LEN {
                break;
            }
            let flags = self.buffer[0];
            let len = u32::from_be_bytes([
                self.buffer[1],
                self.buffer[2],
                self.buffer[3],
                self.buffer[4],
            ]) as usize;

            if len > MAX_FRAME_BYTES {
                return Err(FrameError::TooLarge {
                    declared: len,
                    max: MAX_FRAME_BYTES,
                });
            }
            if self.buffer.len() < HEADER_LEN + len {
                break; // Partial frame — wait for more bytes.
            }

            let payload = self.buffer[HEADER_LEN..HEADER_LEN + len].to_vec();
            self.buffer.drain(..HEADER_LEN + len);

            let payload = if flags & FLAG_COMPRESSED != 0 {
                gunzip(&payload)?
            } else {
                payload
            };

            if flags & FLAG_END_STREAM != 0 {
                self.finished = true;
                frames.push(Frame::EndOfStream(payload));
                break;
            }
            frames.push(Frame::Message(payload));
        }
        Ok(frames)
    }
}

fn gunzip(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    let mut decoder = flate2::read::GzDecoder::new(payload);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|err| FrameError::Decompress(err.to_string()))?;
    Ok(out)
}

/// Read the end-of-stream trailer.
///
/// `Ok(())` means the turn ended cleanly. `Err` carries the server's own
/// message, which is far more useful than "stream closed" — it is where a
/// revoked token, an unknown model, or a plan limit actually shows up.
pub fn read_trailer(payload: &[u8]) -> Result<(), String> {
    let text = String::from_utf8_lossy(payload);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        // Not JSON. Non-empty trailers are rare enough that passing the text
        // through beats swallowing it.
        return Err(trimmed.chars().take(500).collect());
    };
    let Some(error) = parsed.get("error") else {
        return Ok(());
    };
    let code = error
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("error");
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(trimmed);
    Err(format!("{code}: {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).expect("gzip write");
        encoder.finish().expect("gzip finish")
    }

    fn envelope(flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![flags];
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn encode_writes_a_five_byte_header() {
        let framed = encode(b"hello");
        assert_eq!(framed[0], 0, "Aurora never sets the compressed flag");
        assert_eq!(&framed[1..5], &5u32.to_be_bytes());
        assert_eq!(&framed[5..], b"hello");
    }

    #[test]
    fn decodes_several_frames_from_one_chunk() {
        let mut chunk = envelope(0, b"one");
        chunk.extend(envelope(0, b"two"));
        let frames = FrameDecoder::new().push(&chunk).expect("decode");
        assert_eq!(
            frames,
            vec![
                Frame::Message(b"one".to_vec()),
                Frame::Message(b"two".to_vec())
            ]
        );
    }

    /// The case that breaks naive readers: HTTP/2 chunk boundaries have
    /// nothing to do with frame boundaries.
    #[test]
    fn reassembles_a_frame_split_across_chunks() {
        let full = envelope(0, b"split-payload");
        let mut decoder = FrameDecoder::new();

        // Split mid-header, then mid-payload.
        assert!(decoder.push(&full[..2]).expect("partial header").is_empty());
        assert!(decoder.push(&full[2..9]).expect("partial body").is_empty());
        let frames = decoder.push(&full[9..]).expect("completed");
        assert_eq!(frames, vec![Frame::Message(b"split-payload".to_vec())]);
    }

    #[test]
    fn decompresses_gzipped_frames() {
        let framed = envelope(FLAG_COMPRESSED, &gzip(b"compressed body"));
        let frames = FrameDecoder::new().push(&framed).expect("decode");
        assert_eq!(frames, vec![Frame::Message(b"compressed body".to_vec())]);
    }

    #[test]
    fn stops_at_end_of_stream_and_ignores_trailing_bytes() {
        let mut chunk = envelope(0, b"body");
        chunk.extend(envelope(FLAG_END_STREAM, b"{}"));
        chunk.extend(envelope(0, b"after-goodbye"));

        let mut decoder = FrameDecoder::new();
        let frames = decoder.push(&chunk).expect("decode");
        assert_eq!(
            frames,
            vec![
                Frame::Message(b"body".to_vec()),
                Frame::EndOfStream(b"{}".to_vec())
            ]
        );
        assert!(decoder.push(b"more").expect("post-end").is_empty());
    }

    #[test]
    fn rejects_an_absurd_length_instead_of_allocating() {
        // A desynchronised stream reads arbitrary bytes as a length; without
        // the cap this would try to reserve ~4 GiB.
        let bogus = vec![0x00, 0xFF, 0xFF, 0xFF, 0xFF];
        assert!(matches!(
            FrameDecoder::new().push(&bogus),
            Err(FrameError::TooLarge { .. })
        ));
    }

    #[test]
    fn a_bad_gzip_frame_reports_decompression_not_silence() {
        let framed = envelope(FLAG_COMPRESSED, b"not actually gzip");
        assert!(matches!(
            FrameDecoder::new().push(&framed),
            Err(FrameError::Decompress(_))
        ));
    }

    #[test]
    fn trailers_separate_success_from_failure() {
        assert!(read_trailer(b"{}").is_ok());
        assert!(read_trailer(b"").is_ok());

        let err = read_trailer(br#"{"error":{"code":"unauthenticated","message":"bad token"}}"#)
            .expect_err("must surface the server's error");
        assert!(err.contains("unauthenticated"), "got: {err}");
        assert!(err.contains("bad token"), "got: {err}");

        // Non-JSON trailer: pass the text through rather than swallow it.
        let err = read_trailer(b"upstream exploded").expect_err("non-JSON is still an error");
        assert!(err.contains("upstream exploded"));
    }
}
