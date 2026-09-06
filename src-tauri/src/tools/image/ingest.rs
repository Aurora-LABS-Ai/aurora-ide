//! Pictures the USER brought, landed in the conversation's `assets/`.
//!
//! ## Why this exists
//!
//! A pasted image travels to the model inside the user's message as an
//! `<aurora_image media_type="…">BASE64</aurora_image>` marker
//! (`lib/render/image-markers.ts` builds it, the provider adapters split it
//! into a real image block). That got the picture to the MODEL and nowhere
//! else — it was never written to disk, so the conversation's `assets/` held
//! only pictures `generate_image` had made.
//!
//! The consequence was measured on a real turn: a user pasted a photo and said
//! "make her hair dark". The model called `generate_image` with `op: "edit"`
//! and `source: "1"` — the tool's own documented way of naming "the first
//! picture in this conversation". `assets::find` fell through to its positional
//! lookup, landed on an unrelated picture generated earlier in the thread, and
//! the edit ran, billed and reported success against the wrong source. The
//! model then described the result as a faithful edit of the photo, because it
//! had no way to know otherwise.
//!
//! [`AssetSource::Attached`] already existed — and was the `Default` — so the
//! shape was designed for this from the start. Only the step that fills it was
//! missing.
//!
//! ## What it does
//!
//! [`ingest_user_images`] walks a user message's markers, writes every one that
//! carries its own bytes into `assets/`, and rewrites that marker to point at
//! the stored file. Afterwards a pasted picture is an asset like any other:
//! `generate_image op:"list"` reports it, `op:"edit"` can start from it, and it
//! survives the conversation being reopened.
//!
//! A marker that already names a `src` is left exactly as it is — that one came
//! from `assets/` in the first place and re-storing it would duplicate the file
//! on every turn it stays in the transcript.

use crate::api::aurora_image;

use super::assets::{self, AssetRecord, AssetSource, NewAsset};

/// What one ingest run did.
#[derive(Debug, Default)]
pub struct Ingested {
    /// The message with every stored marker rewritten to name its file.
    pub text: String,
    /// Pictures written, in the order they appeared.
    pub stored: Vec<AssetRecord>,
}

/// Land every self-carrying `<aurora_image>` in `text` into `assets_dir`.
///
/// Best-effort per picture: one that cannot be decoded or written is left in
/// the message untouched, so the model still sees it even when Aurora could not
/// keep it. Losing the picture entirely would be worse than losing the handle.
///
/// Pass `canvas` to also put each stored picture in the Canvas, the way a
/// generated one is placed. A picture the conversation owns but the Canvas does
/// not show is one the person cannot open, compare or export — the folder is
/// not the interface.
pub fn ingest_user_images_into(
    assets_dir: &std::path::Path,
    text: &str,
    canvas: Option<(&crate::agent_runtime::session_store::SessionStore, &str)>,
) -> Ingested {
    let mut result = ingest_user_images(assets_dir, text);
    if let Some((store, thread_id)) = canvas {
        for record in &result.stored {
            // Best-effort, and deliberately not fatal: the picture is already
            // saved and already on its way to the model. A Canvas entry that
            // could not be written is worth a log line, not a failed turn.
            if let Err(err) = super::place_in_canvas(
                store,
                thread_id,
                assets_dir,
                record,
                &title_for(record),
            ) {
                eprintln!("[image::ingest] could not place {} in the canvas: {err}", record.name);
            }
        }
    }
    result.text = std::mem::take(&mut result.text);
    result
}

/// A name for a pasted picture in the Canvas index.
///
/// The file name, without its sequence prefix or extension — there is no prompt
/// to draw on, and "attached image" repeated four times names nothing.
fn title_for(record: &AssetRecord) -> String {
    let stem = std::path::Path::new(&record.name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&record.name);
    let cleaned = stem
        .split('-')
        .skip_while(|part| part.chars().all(|c| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.trim().is_empty() {
        record.name.clone()
    } else {
        cleaned
    }
}

pub fn ingest_user_images(assets_dir: &std::path::Path, text: &str) -> Ingested {
    if !aurora_image::has_marker(text) {
        return Ingested {
            text: text.to_string(),
            stored: Vec::new(),
        };
    }

    let mut out = String::with_capacity(text.len());
    let mut stored = Vec::new();
    let mut cursor = 0usize;

    while let Some(marker) = aurora_image::find_marker(text, cursor) {
        out.push_str(&text[cursor..marker.start]);
        let raw = &text[marker.start..marker.end];

        // Already ours: it names a file in `assets/`. Storing it again would
        // write a second copy every time the transcript is replayed.
        if marker.src().is_some() || marker.payload().is_none() {
            out.push_str(raw);
            cursor = marker.end;
            continue;
        }

        match store_marker(assets_dir, &marker) {
            Some(record) => {
                out.push_str(&rewritten(&marker, &record));
                stored.push(record);
            }
            None => out.push_str(raw),
        }
        cursor = marker.end;
    }
    out.push_str(&text[cursor..]);

    Ingested { text: out, stored }
}

/// Decode one marker's body and write it. `None` on anything unusable.
fn store_marker(
    assets_dir: &std::path::Path,
    marker: &aurora_image::AuroraImageMarker<'_>,
) -> Option<AssetRecord> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(marker.payload()?)
        .ok()?;
    let declared = Some(marker.media_type().to_string());
    // The name the user's file had, when the composer sent one — a picture
    // called `holiday.png` is worth more as a handle than `attached-001`.
    let hint = marker
        .attr("name")
        .unwrap_or("attached image")
        .to_string();

    assets::store(
        assets_dir,
        NewAsset {
            source: AssetSource::Attached,
            hint,
            declared_media_type: declared,
            prompt: None,
            model: None,
            provider: None,
            remote_url: None,
            parent: None,
        },
        &bytes,
    )
    .ok()
}

/// The same marker, now naming the file it was written to.
///
/// The base64 body stays: the model still needs the pixels on this turn, and
/// the runtime's own history clamp is what decides when to drop them later.
/// Only `media_type` is carried over — it is the one attribute an inline marker
/// is guaranteed to have, and the rest are Aurora's own bookkeeping.
fn rewritten(marker: &aurora_image::AuroraImageMarker<'_>, record: &AssetRecord) -> String {
    format!(
        "<aurora_image media_type=\"{media}\" name=\"{name}\" src=\"{name}\">{body}{close}",
        media = aurora_image::escape_attr(marker.media_type()),
        name = aurora_image::escape_attr(&record.name),
        body = marker.body,
        close = aurora_image::CLOSE
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1×1 PNG, so `store` sees real image bytes and can size it.
    fn png_1x1() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }

    fn marker(bytes: &[u8]) -> String {
        use base64::Engine;
        format!(
            "<aurora_image media_type=\"image/png\">{}</aurora_image>",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    /// The whole point: after a turn, what the user pasted is a picture the
    /// conversation owns and `generate_image` can start an edit from.
    #[test]
    fn a_pasted_picture_becomes_an_asset() {
        let tmp = tempfile::tempdir().unwrap();
        let text = format!("make her hair dark\n\n{}", marker(&png_1x1()));

        let result = ingest_user_images(tmp.path(), &text);

        assert_eq!(result.stored.len(), 1, "the picture should be on disk");
        let record = &result.stored[0];
        assert!(tmp.path().join(&record.name).exists());
        // Findable by the handles the tool documents.
        let listed = assets::list(tmp.path()).unwrap();
        assert!(assets::find(&listed, &record.name).is_some());
        assert!(assets::find(&listed, "1").is_some(), "position 1 is now the pasted picture");
        // And the message now names it, so the model can quote the handle back.
        assert!(result.text.contains(&format!("src=\"{}\"", record.name)));
        assert!(result.text.starts_with("make her hair dark"));
    }

    /// A marker that already came out of `assets/` must not be written again —
    /// otherwise every replay of the transcript grows the folder.
    #[test]
    fn an_already_stored_picture_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let text = "<aurora_image name=\"001-x.png\" src=\"001-x.png\"></aurora_image>";
        let result = ingest_user_images(tmp.path(), text);
        assert!(result.stored.is_empty());
        assert_eq!(result.text, text);
    }

    #[test]
    fn a_message_with_no_pictures_is_returned_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let result = ingest_user_images(tmp.path(), "just words");
        assert_eq!(result.text, "just words");
        assert!(result.stored.is_empty());
    }

    /// Bytes that are not an image keep their marker: the model can still see
    /// whatever the provider makes of them, which beats silently dropping it.
    #[test]
    fn something_that_is_not_an_image_stays_in_the_message() {
        let tmp = tempfile::tempdir().unwrap();
        let text = marker(b"not a picture at all");
        let result = ingest_user_images(tmp.path(), &text);
        assert!(result.stored.is_empty());
        assert_eq!(result.text, text);
    }

    #[test]
    fn several_pictures_all_land_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let text = format!("two\n{}\n{}", marker(&png_1x1()), marker(&png_1x1()));
        let result = ingest_user_images(tmp.path(), &text);
        assert_eq!(result.stored.len(), 2);
        assert_ne!(result.stored[0].name, result.stored[1].name);
    }
}
