//! `file_read`'s image path — opening a picture so a vision model can SEE it.
//!
//! ## Why this exists
//!
//! `file_read` used to hand every path to `read_to_string`. A PNG therefore
//! came back as:
//!
//! ```text
//! Failed to read file: stream did not contain valid UTF-8
//! ```
//!
//! which is true and useless. The agent reported it itself (`report_aurora_issue`,
//! 2026-08-31): it had a screen design on disk, could not open it, and had to
//! route the whole task through the Browser panel to look at a local file.
//!
//! Aurora already knows how to show a model a picture — `browser_screenshot`
//! has done it since the browser tools shipped. The whole pipeline is there:
//! an `<aurora_image>` marker in the tool result, leaned to a path for
//! persistence, rehydrated into a real image block at request-build time, and
//! stripped to a placeholder for models without vision. The only thing missing
//! was a reader that produced one from a file.
//!
//! ## What it does
//!
//! Detection is by CONTENT, never by extension: the first bytes of the file
//! decide. A `.png` holding text is read as text, and a `.bin` holding a JPEG is
//! shown as a picture — both are what the caller meant, and neither can be got
//! right from a name.
//!
//! The image is then decoded, bounded to [`aurora_image::MAX_EDGE`], and
//! re-encoded as JPEG by the same function screenshots use. The result is
//! written to `<root>/cache/agent-images/` under a name derived from its own
//! bytes, and the marker points at that file rather than at the original. That
//! detail is load-bearing: history keeps the marker and re-reads `src` on every
//! later turn, so a marker pointing at the user's 8 MB original would re-upload
//! 8 MB per turn, undoing the downscale it just did.
//!
//! Content-addressed naming also means reading the same image twice produces
//! the same `src`, so the prompt prefix does not change and the provider's cache
//! survives.

use std::path::Path;

use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::api::aurora_image;

/// Formats Aurora can decode AND a vision API will accept. Kept in step with
/// the `image` crate features in `Cargo.toml`: a format listed here that the
/// decoder was not built for would be detected and then fail to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ImageKind {
    Png,
    Jpeg,
    Gif,
    WebP,
}

impl ImageKind {
    /// How the file describes itself, for the caption.
    fn label(self) -> &'static str {
        match self {
            ImageKind::Png => "PNG",
            ImageKind::Jpeg => "JPEG",
            ImageKind::Gif => "GIF",
            ImageKind::WebP => "WebP",
        }
    }
}

/// Largest file worth decoding. Past this the decode is slower than the read
/// the caller is waiting on, and the source is almost certainly not a picture
/// anybody meant to look at. Refused with a sentence, never with a UTF-8 error.
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// How many bytes of a file are needed to recognise every format above. WebP
/// needs the most: `RIFF` + a 4-byte size + `WEBP` = 12.
const SNIFF_LEN: usize = 12;

/// Cached encodes kept before the oldest are dropped. Count-based, not
/// age-based, so a thread reopened days later still renders its images while a
/// session that reads a hundred screens cannot grow the folder without bound.
const KEEP_CACHED: usize = 300;

/// Identify `bytes` by its magic number, or `None` when it is not an image
/// Aurora can show.
pub(super) fn sniff_bytes(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageKind::Png);
    }
    // JPEG: SOI marker. Every variant (JFIF, Exif, raw) opens with it.
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageKind::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    // RIFF container; bytes 4..8 are the chunk size, which says nothing here.
    if bytes.len() >= SNIFF_LEN && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::WebP);
    }
    None
}

/// Peek at a file on disk and say whether it is an image Aurora can show.
///
/// Reads [`SNIFF_LEN`] bytes, not the file. Returns `None` for a directory, an
/// unreadable path, a file too short to identify, and anything that is not one
/// of the four formats — every one of which the ordinary text reader then
/// handles exactly as it did before.
pub(super) fn sniff_path(path: &Path) -> Option<ImageKind> {
    use std::io::Read;

    if !path.is_file() {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut head = [0u8; SNIFF_LEN];
    // A short read is not an error: a 6-byte file simply cannot be an image.
    let read = file.read(&mut head).ok()?;
    sniff_bytes(&head[..read])
}

/// One opened picture: what the model sees, and what the inventory says about
/// it.
///
/// The two travel together because they describe the same file and are read by
/// different halves of the result — the marker cannot live inside the JSON (its
/// attribute quotes would be escaped and the parser would reject it), and the
/// JSON cannot be left out (a mixed call whose inventory counts only the text
/// files is a wrong answer, not a shorter one).
pub(super) struct ImageRead {
    /// The `<aurora_image>` marker + caption, or a plain sentence on failure.
    pub block: String,
    /// This file's row for the batch reader's `files` array.
    pub row: serde_json::Value,
}

/// Open an image and return the tool-result body for it: an `<aurora_image>`
/// marker the request builder turns into a real image block, followed by a
/// caption naming the file and what was actually shown.
///
/// Never fails into an error the caller has to render: an image that cannot be
/// decoded comes back as a plain sentence saying so, because the caller is
/// concatenating this with other files' results and a thrown error would lose
/// them too.
pub(super) fn read_image(display_path: &str, full_path: &Path, kind: ImageKind) -> ImageRead {
    read_image_into(
        &crate::paths::agent_images_dir(),
        display_path,
        full_path,
        kind,
    )
}

/// A row for a picture that could not be opened. Same shape the batch reader
/// gives an unreadable text file, so one inventory reads uniformly.
fn failed_row(display_path: &str, error: &str) -> serde_json::Value {
    json!({
        "path": display_path,
        "success": false,
        "kind": "image",
        "error": error,
    })
}

/// [`read_image`] with the cache directory named, so a test can point it at
/// scratch space. A unit test that writes into the real cache is how a file
/// nobody asked for ends up in the user's app data — and, here, how the
/// deduplication test would start depending on what earlier runs left behind.
fn read_image_into(
    cache_dir: &Path,
    display_path: &str,
    full_path: &Path,
    kind: ImageKind,
) -> ImageRead {
    let size = match std::fs::metadata(full_path) {
        Ok(meta) => meta.len(),
        Err(err) => {
            let block = format!("{display_path} — could not be opened: {err}");
            let row = failed_row(display_path, &format!("could not be opened: {err}"));
            return ImageRead { block, row };
        }
    };
    if size > MAX_IMAGE_BYTES {
        let reason = format!(
            "{label} image of {}, too large to open (limit {}). Resize it, or point a browser at \
             it with `browser_navigate`.",
            human_size(size),
            human_size(MAX_IMAGE_BYTES),
            label = kind.label(),
        );
        return ImageRead {
            block: format!("{display_path} — {reason}"),
            row: failed_row(display_path, &reason),
        };
    }

    let bytes = match std::fs::read(full_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            return ImageRead {
                block: format!("{display_path} — could not be read: {err}"),
                row: failed_row(display_path, &format!("could not be read: {err}")),
            }
        }
    };

    // Original dimensions come from the header alone, so they are known even
    // when the full decode fails and are reported against the file the user
    // has, not against the copy Aurora made.
    let source_dimensions = image::load_from_memory(&bytes)
        .ok()
        .map(|img| (img.width(), img.height()));

    let (encoded, width, height) = aurora_image::encode_for_vision(bytes);
    // `encode_for_vision` reports (0, 0) when it could not decode — it returns
    // the untouched bytes so a caller with a provider-acceptable format still
    // has an image. Here that format is known to be one of four the APIs take,
    // so the bytes are worth sending; the caption just cannot claim a size.
    let decoded = width != 0 && height != 0;
    let media_type = if decoded {
        aurora_image::ENCODED_MEDIA_TYPE
    } else {
        match kind {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Gif => "image/gif",
            ImageKind::WebP => "image/webp",
        }
    };

    let src = cache_encoded(cache_dir, &encoded, decoded);
    let marker = build_marker(
        media_type,
        decoded.then_some((width, height)),
        src.as_deref(),
        display_path,
        &encoded,
    );

    let shown = decoded.then_some((width, height));
    // The row carries no `content`: the picture is the content, and it is
    // already in the block. What it does carry is everything a caller checking
    // its own inventory needs — that this path was read, that it was an image,
    // and at what size.
    let row = json!({
        "path": display_path,
        "success": true,
        "kind": "image",
        "format": kind.label(),
        "size": size,
        "width": source_dimensions.map(|(w, _)| w),
        "height": source_dimensions.map(|(_, h)| h),
        "shownWidth": shown.map(|(w, _)| w),
        "shownHeight": shown.map(|(_, h)| h),
    });

    ImageRead {
        block: format!(
            "{marker}\n{}",
            caption(display_path, kind, size, source_dimensions, shown)
        ),
        row,
    }
}

/// The `<aurora_image …>` block itself.
///
/// The body carries the base64 only when there is no cached file to re-read it
/// from; with a `src`, history leans the body away and rehydrates from disk,
/// which is what keeps the thread JSONL small and the per-turn upload constant.
fn build_marker(
    media_type: &str,
    dimensions: Option<(u32, u32)>,
    src: Option<&str>,
    name: &str,
    encoded: &[u8],
) -> String {
    let mut header = format!("media_type=\"{media_type}\"");
    if let Some((w, h)) = dimensions {
        header.push_str(&format!(" width=\"{w}\" height=\"{h}\""));
    }
    if let Some(src) = src {
        header.push_str(&format!(" src=\"{}\"", aurora_image::escape_attr(src)));
    }
    // `name` is the path the CALLER named, not the cache file — the card would
    // otherwise be titled `img-9f2c….jpg`, which names nothing anybody asked
    // for. It is the whole path rather than the last segment because the card
    // matches it against the read's own inventory to decide which picture a
    // selected file chip belongs to; two folders can hold one filename, and the
    // label takes the last segment for itself.
    header.push_str(&format!(" name=\"{}\"", aurora_image::escape_attr(name)));

    // With a `src` the body is still written: `leanify_aurora_images` strips it
    // for persistence, and until it does this is the copy that reaches the
    // model on THIS turn.
    let body = base64::engine::general_purpose::STANDARD.encode(encoded);
    format!(
        "<aurora_image {header}>{body}{close}",
        close = aurora_image::CLOSE
    )
}

/// The sentence under the picture.
///
/// It states the file's real format and size, and — separately — what the model
/// was actually shown, because those differ whenever a large image was
/// downscaled and a model reasoning about pixel measurements needs to know
/// which number it is looking at. It is also the whole result for a model
/// without vision, where the marker is replaced by a placeholder.
fn caption(
    display_path: &str,
    kind: ImageKind,
    size: u64,
    source: Option<(u32, u32)>,
    shown: Option<(u32, u32)>,
) -> String {
    let mut out = format!("{display_path} — {} image", kind.label());
    if let Some((w, h)) = source {
        out.push_str(&format!(", {w}×{h} px"));
    }
    out.push_str(&format!(", {}.", human_size(size)));

    match (source, shown) {
        (Some((sw, sh)), Some((w, h))) if (sw, sh) != (w, h) => {
            out.push_str(&format!(" Shown to you downscaled to {w}×{h}."));
        }
        (_, Some(_)) => out.push_str(" Shown to you at full size."),
        // Undecodable: the bytes still go, since the format is one every vision
        // API accepts, but promising a size Aurora never measured would be a
        // guess dressed as a fact.
        (_, None) => out.push_str(" Aurora could not decode it to measure or resize it; the file was sent as it is on disk."),
    }
    out
}

/// Write the encoded image into the agent-image cache and return its absolute
/// path, or `None` when the cache is unwritable (the marker then keeps its
/// base64 body, which still shows the model the picture — it just costs the
/// bytes again on every later turn).
///
/// The name is a digest of the encoded bytes, so the same picture read twice
/// resolves to one file and one `src`, leaving the prompt prefix byte-identical
/// across turns.
fn cache_encoded(dir: &Path, encoded: &[u8], decoded: bool) -> Option<String> {
    std::fs::create_dir_all(dir).ok()?;
    prune_cache(dir);

    let digest = Sha256::digest(encoded);
    let stem: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    // The extension is cosmetic — every consumer reads `media_type` off the
    // marker — but a cache folder a person may open should not be full of files
    // that lie about what they hold.
    let ext = if decoded { "jpg" } else { "bin" };
    let file = dir.join(format!("img-{stem}.{ext}"));

    // Written even when the bytes are already there, so the modified time
    // records last USE. Pruning is by that time, and a picture the thread keeps
    // showing must not be collected as though it were old.
    std::fs::write(&file, encoded).ok()?;
    Some(file.to_string_lossy().to_string())
}

/// Keep the newest [`KEEP_CACHED`] files, deleting the rest. Best-effort and
/// silent: a cache that cannot be pruned is not a reason to fail a read.
fn prune_cache(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    if files.len() <= KEEP_CACHED {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(KEEP_CACHED) {
        let _ = std::fs::remove_file(path);
    }
}

/// Bytes as a person reads them. One decimal past KB, because the difference
/// between a 240 KB and a 2.4 MB screenshot is the whole point of saying it.
fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let bytes = bytes as f64;
    if bytes >= MB {
        format!("{:.1} MB", bytes / MB)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes / KB)
    } else {
        format!("{bytes:.0} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real 2×3 PNG, encoded once so the tests exercise the actual decoder
    /// rather than a hand-written header.
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode png");
        out
    }

    /// Every test writes its cache here, never into the user's real one under
    /// the AuroraIDE root.
    fn scratch_cache() -> std::path::PathBuf {
        std::env::temp_dir().join("aurora-image-read-tests/cache")
    }

    /// What the model sees, with the cache pointed at scratch space.
    fn read(display_path: &str, full_path: &Path, kind: ImageKind) -> String {
        read_into(display_path, full_path, kind).block
    }

    /// The whole result — picture and inventory row.
    fn read_into(display_path: &str, full_path: &Path, kind: ImageKind) -> ImageRead {
        read_image_into(&scratch_cache(), display_path, full_path, kind)
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("aurora-image-read-tests");
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir.join(name)
    }

    #[test]
    fn recognises_every_format_by_its_magic_number() {
        assert_eq!(sniff_bytes(&png_bytes(2, 2)), Some(ImageKind::Png));
        assert_eq!(
            sniff_bytes(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(ImageKind::Jpeg)
        );
        assert_eq!(sniff_bytes(b"GIF89a....."), Some(ImageKind::Gif));
        assert_eq!(sniff_bytes(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageKind::WebP));
    }

    /// The other half of the contract: anything not an image must fall through
    /// to the text reader untouched, including text that merely looks binary.
    #[test]
    fn text_and_other_binaries_are_not_images() {
        assert_eq!(sniff_bytes(b"import React from 'react'"), None);
        assert_eq!(sniff_bytes(b"<svg xmlns=\"http://www.w3.org/"), None);
        assert_eq!(sniff_bytes(b"PK\x03\x04"), None); // zip
        assert_eq!(sniff_bytes(b"RIFF\0\0\0\0WAVE"), None); // riff, not webp
        assert_eq!(sniff_bytes(b""), None);
        assert_eq!(sniff_bytes(b"\x89PNG"), None); // truncated signature
    }

    /// Detection is by content. A file named `.png` that holds source code is
    /// source code, and the text reader — not this module — must answer it.
    #[test]
    fn a_misnamed_file_is_judged_by_its_bytes() {
        let text_as_png = scratch("actually-text.png");
        std::fs::write(&text_as_png, b"export const x = 1;\n").expect("write");
        assert_eq!(sniff_path(&text_as_png), None);

        let png_as_bin = scratch("actually-png.bin");
        std::fs::write(&png_as_bin, png_bytes(4, 4)).expect("write");
        assert_eq!(sniff_path(&png_as_bin), Some(ImageKind::Png));
    }

    #[test]
    fn a_directory_is_never_an_image() {
        assert_eq!(sniff_path(&std::env::temp_dir()), None);
        assert_eq!(sniff_path(Path::new("no/such/file.png")), None);
    }

    /// The result must be a marker the request builder actually accepts —
    /// that parser is strict, and a marker it rejects reaches the model as
    /// prose, which is the whole failure this module exists to end.
    #[test]
    fn produces_a_marker_the_request_builder_parses() {
        let path = scratch("shot.png");
        std::fs::write(&path, png_bytes(40, 20)).expect("write");

        let body = read("docs/shot.png", &path, ImageKind::Png);
        let marker = aurora_image::find_marker(&body, 0).expect("valid marker");

        assert_eq!(marker.media_type(), "image/jpeg", "re-encoded as JPEG");
        assert_eq!(marker.attr("width"), Some("40"));
        assert_eq!(marker.attr("height"), Some("20"));
        assert_eq!(
            marker.attr("name"),
            Some("docs/shot.png"),
            "the path the caller named, so a chip can be matched to its picture"
        );
        assert!(marker.payload().is_some(), "carries the bytes this turn");
        assert!(
            marker.src().is_some_and(|src| Path::new(src).is_file()),
            "cached copy exists on disk for later turns"
        );
    }

    /// The caption is the entire result for a model without vision, so it has
    /// to name the file and say what happened to it.
    #[test]
    fn captions_name_the_file_and_the_size_actually_shown() {
        let big = scratch("big.png");
        std::fs::write(&big, png_bytes(2400, 1200)).expect("write");
        let body = read("art/big.png", &big, ImageKind::Png);
        assert!(body.contains("art/big.png — PNG image, 2400×1200 px"));
        assert!(
            body.contains("downscaled to 1024×512"),
            "says which numbers the model is looking at, got: {}",
            body.rsplit('\n').next().unwrap_or_default()
        );

        let small = scratch("small.png");
        std::fs::write(&small, png_bytes(64, 64)).expect("write");
        let body = read("art/small.png", &small, ImageKind::Png);
        assert!(body.contains("Shown to you at full size."));
    }

    /// Same picture, same `src` — the prompt prefix must not move between
    /// turns just because a file was opened twice.
    #[test]
    fn the_same_image_caches_to_the_same_path() {
        let a = scratch("dup-a.png");
        let b = scratch("dup-b.png");
        let bytes = png_bytes(30, 30);
        std::fs::write(&a, &bytes).expect("write");
        std::fs::write(&b, &bytes).expect("write");

        let src_of = |body: &str| {
            aurora_image::find_marker(body, 0)
                .and_then(|m| m.src())
                .map(str::to_string)
        };
        assert_eq!(
            src_of(&read("a.png", &a, ImageKind::Png)),
            src_of(&read("b.png", &b, ImageKind::Png)),
        );
    }

    #[test]
    fn refuses_a_file_too_large_to_decode_with_a_sentence_not_an_error() {
        let path = scratch("huge.png");
        // Sparse-ish: the size check reads metadata, so the bytes past the
        // header never have to be real.
        let file = std::fs::File::create(&path).expect("create");
        file.set_len(MAX_IMAGE_BYTES + 1).expect("grow");
        drop(file);

        let body = read("huge.png", &path, ImageKind::Png);
        assert!(aurora_image::find_marker(&body, 0).is_none());
        assert!(body.contains("too large to open"), "got: {body}");
    }

    /// The point of the whole module: a PNG on disk has to arrive at the
    /// provider as an actual image block. Everything else here checks a step;
    /// this checks that the steps connect.
    #[test]
    fn a_png_on_disk_reaches_the_request_as_an_image_block() {
        use crate::api::provider_kernel_adapter::{split_aurora_images, AuroraImagePiece};

        let path = scratch("end-to-end.png");
        std::fs::write(&path, png_bytes(120, 80)).expect("write");

        let body = read("docs/end-to-end.png", &path, ImageKind::Png);
        let pieces = split_aurora_images(&body);

        let images: Vec<_> = pieces
            .iter()
            .filter_map(|piece| match piece {
                AuroraImagePiece::Image { media_type, base64 } => Some((media_type, base64)),
                AuroraImagePiece::Text(_) => None,
            })
            .collect();
        assert_eq!(images.len(), 1, "exactly one image block");
        assert_eq!(images[0].0, "image/jpeg");
        assert!(
            !images[0].1.is_empty(),
            "the block carries bytes, not an empty payload"
        );

        // And the caption survives beside it — a model without vision gets
        // that sentence and nothing else.
        assert!(
            pieces
                .iter()
                .any(|piece| matches!(piece, AuroraImagePiece::Text(t) if t.contains("docs/end-to-end.png"))),
            "caption is a sibling text block"
        );
    }

    /// A mixed call's inventory has to account for the pictures too. When it
    /// did not, a nine-path read reported `totalFiles: 3` — filed by the agent
    /// against Aurora within an hour of the image reader shipping.
    #[test]
    fn an_opened_image_carries_an_inventory_row() {
        let path = scratch("inventory.png");
        std::fs::write(&path, png_bytes(1600, 900)).expect("write");

        let row = read_into("screens/inventory.png", &path, ImageKind::Png).row;
        assert_eq!(row["path"], "screens/inventory.png");
        assert_eq!(row["success"], true);
        assert_eq!(row["kind"], "image");
        assert_eq!(row["format"], "PNG");
        assert_eq!(row["width"], 1600);
        assert_eq!(row["height"], 900);
        assert_eq!(row["shownWidth"], 1024);
        assert_eq!(row["shownHeight"], 576);
        // The picture is the content, and it already rode in the block. A
        // `content` key here would be an empty string the model reads as a
        // file that came back blank.
        assert!(row.get("content").is_none());
    }

    /// A picture that could not be opened still owes the inventory a row, or
    /// the count silently disagrees with the paths that were named.
    #[test]
    fn an_unopenable_image_still_rows_up_as_a_failure() {
        let result = read_into(
            "screens/gone.png",
            Path::new("no/such/gone.png"),
            ImageKind::Png,
        );
        assert_eq!(result.row["path"], "screens/gone.png");
        assert_eq!(result.row["success"], false);
        assert!(result.row["error"].is_string());
        assert!(aurora_image::find_marker(&result.block, 0).is_none());
    }

    #[test]
    fn human_sizes_read_the_way_a_person_says_them() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(240 * 1024), "240 KB");
        assert_eq!(human_size(3 * 1024 * 1024 + 512 * 1024), "3.5 MB");
    }
}
