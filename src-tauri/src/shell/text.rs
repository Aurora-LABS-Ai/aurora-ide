//! Decoding command output into text.
//!
//! Windows console programs do not agree on an encoding. Git Bash and most
//! cross-platform tools emit UTF-8, but **PowerShell and `cmd` write to a
//! redirected pipe using the OEM console code page** (437 on a US install).
//! Measured: `pwsh -Command "Write-Output 'café'"` emits `caf 82 ...` — byte
//! `0x82` is `é` in CP437, and nothing at all in UTF-8.
//!
//! Decoding that with `String::from_utf8_lossy` turns every accented
//! character, box-drawing glyph, and localized error message into `U+FFFD`.
//! That reaches the model as well as the screen, so a file called `café.txt`
//! becomes unreferenceable and a localized compiler error becomes unreadable.
//!
//! [`StreamDecoder`] therefore tries UTF-8 first and falls back to the
//! console code page only when the bytes genuinely are not UTF-8, holding a
//! multi-byte character split between two reads until its tail arrives — a
//! case the previous per-chunk `from_utf8_lossy` got wrong, replacing a
//! perfectly valid character with `U+FFFD` whenever a 16 KB read landed
//! mid-sequence. (A one-shot `decode` used to sit beside it for the
//! unstreamed runner; that runner now shares the streamed lifecycle, so the
//! incremental decoder is the only entrance.)

/// Incremental decoder for streamed output.
///
/// Holds back only a trailing *incomplete* UTF-8 sequence (at most three
/// bytes) so it can be completed by the next chunk. Single-byte console code
/// pages have no such boundary problem, so the fallback path never buffers.
#[derive(Debug, Default)]
pub struct StreamDecoder {
    pending: Vec<u8>,
}

impl StreamDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode a chunk, returning whatever text is complete so far.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        if self.pending.is_empty() {
            // Fast path: decode the chunk in place unless it ends mid-character.
            match std::str::from_utf8(chunk) {
                Ok(text) => return text.to_string(),
                Err(error) if error.error_len().is_some() => return decode_console(chunk),
                Err(_) => {}
            }
        }
        self.pending.extend_from_slice(chunk);

        match std::str::from_utf8(&self.pending) {
            Ok(_) => {
                let text = String::from_utf8_lossy(&self.pending).into_owned();
                self.pending.clear();
                text
            }
            Err(error) if error.error_len().is_none() => {
                // Truncated character at the end: emit the valid prefix and
                // carry the tail into the next read.
                let valid = error.valid_up_to();
                let text = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
                self.pending.drain(..valid);
                text
            }
            Err(_) => {
                let text = decode_console(&self.pending);
                self.pending.clear();
                text
            }
        }
    }

    /// Flush anything held back when the stream ends. A tail still pending at
    /// EOF was never valid UTF-8, so it decodes through the console page.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let text = decode_console(&self.pending);
        self.pending.clear();
        text
    }
}

/// Decode using the system OEM console code page.
#[cfg(windows)]
fn decode_console(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    /// `CP_OEMCP` — "the system default OEM code page", which is what a
    /// console child writes when its output is redirected.
    const CP_OEMCP: u32 = 1;

    if bytes.is_empty() {
        return String::new();
    }
    let len = bytes.len() as i32;

    // SAFETY: `bytes` is a valid slice of `len` bytes; passing a null output
    // pointer with a zero count is the documented way to ask for the required
    // buffer size.
    let needed =
        unsafe { MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }

    let mut wide = vec![0u16; needed as usize];
    // SAFETY: `wide` has exactly `needed` elements, matching the count passed.
    let written =
        unsafe { MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), needed) };
    if written <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    String::from_utf16_lossy(&wide[..written as usize])
}

/// Non-Windows consoles are UTF-8; anything else is genuinely malformed.
#[cfg(not(windows))]
fn decode_console(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One whole buffer through the decoder: push then finish.
    fn decode_once(bytes: &[u8]) -> String {
        let mut decoder = StreamDecoder::new();
        let mut text = decoder.push(bytes);
        text.push_str(&decoder.finish());
        text
    }

    #[test]
    fn plain_utf8_passes_through() {
        assert_eq!(decode_once("hello".as_bytes()), "hello");
        assert_eq!(decode_once("café → ✓".as_bytes()), "café → ✓");
    }

    #[test]
    fn a_character_split_across_chunks_survives() {
        // "é" is 0xC3 0xA9; a read boundary between them must not corrupt it.
        let mut decoder = StreamDecoder::new();
        let first = decoder.push(&[b'c', b'a', b'f', 0xC3]);
        let second = decoder.push(&[0xA9, b'\n']);
        assert_eq!(format!("{first}{second}"), "caf\u{e9}\n");
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn console_code_page_bytes_decode_on_windows() {
        // 0x82 is `é` in CP437 and invalid UTF-8 — exactly what pwsh emits.
        let text = decode_once(&[b'c', b'a', b'f', 0x82]);
        assert!(
            !text.contains('\u{fffd}'),
            "must not be lossy, got: {text:?}"
        );
        if cfg!(windows) {
            assert_eq!(text, "caf\u{e9}");
        }
    }

    #[test]
    fn streamed_console_bytes_are_not_held_back() {
        let mut decoder = StreamDecoder::new();
        let text = decoder.push(&[b'x', 0x82, b'y']);
        assert!(
            text.starts_with('x') && text.ends_with('y'),
            "got: {text:?}"
        );
        assert!(
            decoder.finish().is_empty(),
            "single-byte pages never buffer"
        );
    }

    #[test]
    fn an_unfinished_tail_is_flushed_at_end_of_stream() {
        let mut decoder = StreamDecoder::new();
        assert!(decoder.push(&[0xC3]).is_empty(), "held back as incomplete");
        assert!(!decoder.finish().is_empty(), "flushed rather than dropped");
    }
}
