//! A conversation's pictures: `assets/` under its folder, one manifest beside
//! them, one naming rule whichever door a picture came through.
//!
//! ## Why a copy, immediately
//!
//! The URL a generation comes back with promises nothing. Measured on a6api:
//! no `Cache-Control`, no `Expires`, no signature, a different host from the
//! API (`img.pinest.xyz`, behind Cloudflare, `cf-cache-status: DYNAMIC`), and a
//! date-bucketed path — the layout you build when you intend to prune by date.
//! So the bytes are downloaded into the conversation's own `assets/` the moment
//! they exist and everything Aurora shows or edits later reads the local copy.
//! The remote URL is kept in the manifest only so an edit on a provider that
//! wants a URL can offer it while it still resolves.
//!
//! ## One name shape
//!
//! `001-generated-an-aurora-over-mountains.png`: a sequence number the model
//! and the user can both say ("the first image"), the door it came through, a
//! slug of what it is, and an extension that matches the bytes rather than the
//! filename the provider or the user chose. The manifest (`assets/assets.json`)
//! holds what the name cannot: dimensions, prompt, model, provider, the source
//! URL, and the asset an edit started from.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Which door a picture came through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetSource {
    Generated,
    Edited,
    Attached,
}

impl AssetSource {
    fn slug(self) -> &'static str {
        match self {
            Self::Generated => "generated",
            Self::Edited => "edited",
            Self::Attached => "attached",
        }
    }
}

/// One picture the conversation owns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecord {
    /// File name inside `assets/`. The handle everything else uses.
    pub name: String,
    pub source: AssetSource,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Where the provider served it from, if it did. Not a promise it is still
    /// there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// For an edit: the asset it started from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub created_at: String,
}

/// What a caller knows about a picture before it has a name.
#[derive(Debug, Clone, Default)]
pub struct NewAsset {
    pub source: AssetSource,
    /// What to build the slug from — the prompt, or the original file name.
    pub hint: String,
    /// The media type the sender claimed. Overridden by the bytes when they
    /// disagree; a provider that says PNG and sends JPEG is not unheard of.
    pub declared_media_type: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub remote_url: Option<String>,
    pub parent: Option<String>,
}

impl Default for AssetSource {
    fn default() -> Self {
        Self::Attached
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    assets: Vec<AssetRecord>,
}

const MANIFEST_FILE: &str = "assets.json";

/// Ceiling on one stored picture. Generated images are a few megabytes; a
/// provider that hands back more than this has handed back something else.
pub const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;

/// The pictures one conversation holds, in the order they arrived.
pub fn list(assets_dir: &Path) -> Result<Vec<AssetRecord>, String> {
    Ok(load_manifest(assets_dir)?.assets)
}

fn load_manifest(assets_dir: &Path) -> Result<Manifest, String> {
    let path = assets_dir.join(MANIFEST_FILE);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("the assets manifest at {} is unreadable: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(error) => Err(format!("could not read {}: {error}", path.display())),
    }
}

fn save_manifest(assets_dir: &Path, manifest: &Manifest) -> Result<(), String> {
    let path = assets_dir.join(MANIFEST_FILE);
    let tmp = assets_dir.join(format!("{MANIFEST_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("could not encode the assets manifest: {error}"))?;
    fs::write(&tmp, bytes).map_err(|error| format!("could not write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|error| format!("could not replace {}: {error}", path.display()))
}

/// Find a picture by what someone called it: its exact name, its name without
/// the extension, or its position ("1", "first" is the caller's job to turn
/// into "1").
pub fn find<'a>(assets: &'a [AssetRecord], wanted: &str) -> Option<&'a AssetRecord> {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return None;
    }
    if let Some(hit) = assets.iter().find(|a| a.name.eq_ignore_ascii_case(wanted)) {
        return Some(hit);
    }
    if let Some(hit) = assets.iter().find(|a| {
        Path::new(&a.name)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case(wanted))
    }) {
        return Some(hit);
    }
    // A bare number is a position, 1-based, in arrival order.
    wanted
        .parse::<usize>()
        .ok()
        .filter(|n| *n >= 1)
        .and_then(|n| assets.get(n - 1))
}

/// Write `bytes` into `assets_dir` under a fresh name and record it.
///
/// The extension and `media_type` come from the bytes; a declared type is
/// used only when the bytes are not a format Aurora recognises. Dimensions are
/// read from the header alone — no full decode — and a picture whose header
/// cannot be read is refused rather than stored as a file nothing can open.
pub fn store(assets_dir: &Path, new: NewAsset, bytes: &[u8]) -> Result<AssetRecord, String> {
    if bytes.is_empty() {
        return Err("the image is empty (0 bytes)".to_string());
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "the image is {} MiB, above the {} MiB limit for a conversation asset",
            bytes.len() / 1024 / 1024,
            MAX_ASSET_BYTES / 1024 / 1024
        ));
    }
    let media_type = sniff_media_type(bytes)
        .map(str::to_string)
        .or(new.declared_media_type.clone())
        .ok_or_else(|| "the bytes are not a PNG, JPEG, WebP or GIF image".to_string())?;
    let (width, height) = dimensions(bytes).ok_or_else(|| {
        format!("the {media_type} data could not be read as an image; nothing was saved")
    })?;

    fs::create_dir_all(assets_dir)
        .map_err(|error| format!("could not create {}: {error}", assets_dir.display()))?;
    let mut manifest = load_manifest(assets_dir)?;
    let name = next_name(assets_dir, &manifest, new.source, &new.hint, extension_for(&media_type));
    let path = assets_dir.join(&name);
    fs::write(&path, bytes).map_err(|error| format!("could not write {}: {error}", path.display()))?;

    let record = AssetRecord {
        name,
        source: new.source,
        media_type,
        width,
        height,
        prompt: new.prompt,
        model: new.model,
        provider: new.provider,
        remote_url: new.remote_url,
        parent: new.parent,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    manifest.assets.push(record.clone());
    if let Err(error) = save_manifest(assets_dir, &manifest) {
        // A file the manifest does not know about is an orphan the next
        // `next_name` would step over; remove it so the failure is clean.
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(record)
}

/// `NNN-<source>-<slug>.<ext>`, unique in both the manifest and the directory.
fn next_name(
    assets_dir: &Path,
    manifest: &Manifest,
    source: AssetSource,
    hint: &str,
    extension: &str,
) -> String {
    let slug = slug(hint);
    let mut seq = manifest.assets.len() + 1;
    loop {
        let name = if slug.is_empty() {
            format!("{seq:03}-{}.{extension}", source.slug())
        } else {
            format!("{seq:03}-{}-{slug}.{extension}", source.slug())
        };
        let taken = manifest.assets.iter().any(|a| a.name == name) || assets_dir.join(&name).exists();
        if !taken {
            return name;
        }
        seq += 1;
    }
}

/// Lowercase ASCII words joined by dashes, at most 40 characters, never
/// ending on a dash. `"An Aurora, over the mountains!"` →
/// `an-aurora-over-the-mountains`.
#[must_use]
pub fn slug(text: &str) -> String {
    const MAX: usize = 40;
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                if out.len() + 1 >= MAX {
                    break;
                }
                out.push('-');
            }
            pending_dash = false;
            if out.len() >= MAX {
                break;
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    // The cut above can land mid-word; trim back to a word boundary so the
    // name does not end in a fragment. The full text lives in the manifest.
    if out.len() >= MAX {
        if let Some(cut) = out.rfind('-') {
            out.truncate(cut);
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Media type from the leading bytes, for the four formats Aurora stores.
#[must_use]
pub fn sniff_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

#[must_use]
pub fn extension_for(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

/// Width and height from the header alone.
fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

/// What an `image` artifact's content holds — the record the Canvas renders
/// from, and everything it needs to say "this file is gone" by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageArtifactContent {
    pub asset: String,
    pub path: String,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    pub source: AssetSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub created_at: String,
}

impl ImageArtifactContent {
    #[must_use]
    pub fn from_record(assets_dir: &Path, record: &AssetRecord) -> Self {
        Self {
            asset: record.name.clone(),
            path: display_path(&assets_dir.join(&record.name)),
            media_type: record.media_type.clone(),
            width: record.width,
            height: record.height,
            source: record.source,
            prompt: record.prompt.clone(),
            model: record.model.clone(),
            provider: record.provider.clone(),
            parent: record.parent.clone(),
            created_at: record.created_at.clone(),
        }
    }
}

/// A path as the frontend can load it: no `\\?\` prefix on Windows, forward
/// slashes are fine either way.
#[must_use]
pub fn display_path(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

/// The artifact id for an asset: `image-001-generated-…`, derived from the
/// name so re-editing the same picture never collides with a fresh one.
#[must_use]
pub fn artifact_id_for(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let mut id = format!("image-{stem}");
    id.truncate(64);
    id
}

/// Absolute path of one asset.
#[must_use]
pub fn path_of(assets_dir: &Path, record: &AssetRecord) -> PathBuf {
    assets_dir.join(&record.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real 1x1 PNG, so dimensions and sniffing run against genuine bytes.
    fn png_1x1() -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbaImage::from_pixel(1, 1, image::Rgba([10, 20, 30, 255]))
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn jpeg_2x3() -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbImage::from_pixel(2, 3, image::Rgb([10, 20, 30]))
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Jpeg)
            .unwrap();
        out
    }

    fn generated(hint: &str) -> NewAsset {
        NewAsset {
            source: AssetSource::Generated,
            hint: hint.into(),
            prompt: Some(hint.into()),
            model: Some("gpt-image-1.5".into()),
            provider: Some("a6api".into()),
            remote_url: Some("https://img.example/x.png".into()),
            ..NewAsset::default()
        }
    }

    #[test]
    fn slugs_are_lowercase_dashed_and_bounded() {
        assert_eq!(slug("An Aurora, over the mountains!"), "an-aurora-over-the-mountains");
        assert_eq!(slug("   "), "");
        assert_eq!(slug("émoji ✨ stars"), "moji-stars");
        let long = slug("the quick brown fox jumps over the lazy dog again and again");
        assert!(long.len() <= 40, "{long}");
        assert!(!long.ends_with('-'));
        assert_eq!(long, "the-quick-brown-fox-jumps-over-the-lazy");
    }

    #[test]
    fn names_are_sequenced_sourced_slugged_and_typed_by_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        let first = store(&assets, generated("An aurora over mountains"), &png_1x1()).unwrap();
        assert_eq!(first.name, "001-generated-an-aurora-over-mountains.png");
        assert_eq!((first.width, first.height), (1, 1));
        assert_eq!(first.media_type, "image/png");

        let mut attached = NewAsset {
            source: AssetSource::Attached,
            hint: "Photo.PNG".into(),
            // Lies about the type; the bytes are JPEG.
            declared_media_type: Some("image/png".into()),
            ..NewAsset::default()
        };
        attached.prompt = None;
        let second = store(&assets, attached, &jpeg_2x3()).unwrap();
        assert_eq!(second.name, "002-attached-photo-png.jpg");
        assert_eq!(second.media_type, "image/jpeg");
        assert_eq!((second.width, second.height), (2, 3));

        let listed = list(&assets).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].remote_url.as_deref(), Some("https://img.example/x.png"));
        assert!(assets.join(&first.name).exists());
        assert!(assets.join(&second.name).exists());
    }

    #[test]
    fn an_empty_hint_still_yields_a_name() {
        let dir = tempfile::tempdir().unwrap();
        let record = store(dir.path(), generated(""), &png_1x1()).unwrap();
        assert_eq!(record.name, "001-generated.png");
    }

    /// A file the manifest does not know about — a crash between the write and
    /// the manifest save, a hand-copied file — is stepped over, not clobbered.
    #[test]
    fn a_name_already_on_disk_is_never_reused() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(dir.path().join("001-generated-x.png"), b"stray").unwrap();
        let record = store(dir.path(), generated("x"), &png_1x1()).unwrap();
        assert_eq!(record.name, "002-generated-x.png");
        assert_eq!(fs::read(dir.path().join("001-generated-x.png")).unwrap(), b"stray");
    }

    #[test]
    fn bytes_that_are_not_an_image_are_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let err = store(dir.path(), generated("x"), b"<html>not an image</html>").unwrap_err();
        assert!(err.contains("not a PNG, JPEG, WebP or GIF"), "{err}");
        assert!(list(dir.path()).unwrap().is_empty());
        assert!(store(dir.path(), generated("x"), b"").is_err());
        // A PNG signature with a broken header: the type is known, the size is not.
        let err = store(dir.path(), generated("x"), &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0])
            .unwrap_err();
        assert!(err.contains("could not be read as an image"), "{err}");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "no orphan file");
    }

    #[test]
    fn find_matches_name_stem_or_position() {
        let dir = tempfile::tempdir().unwrap();
        let a = store(dir.path(), generated("first one"), &png_1x1()).unwrap();
        let b = store(dir.path(), generated("second one"), &png_1x1()).unwrap();
        let all = list(dir.path()).unwrap();
        assert_eq!(find(&all, &a.name).unwrap().name, a.name);
        assert_eq!(find(&all, "002-GENERATED-SECOND-ONE").unwrap().name, b.name);
        assert_eq!(find(&all, "1").unwrap().name, a.name);
        assert_eq!(find(&all, "2").unwrap().name, b.name);
        assert!(find(&all, "3").is_none());
        assert!(find(&all, "0").is_none());
        assert!(find(&all, "").is_none());
        assert!(find(&all, "nope").is_none());
    }

    #[test]
    fn sniffing_recognises_the_four_stored_formats() {
        assert_eq!(sniff_media_type(&png_1x1()), Some("image/png"));
        assert_eq!(sniff_media_type(&jpeg_2x3()), Some("image/jpeg"));
        assert_eq!(sniff_media_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_media_type(b"GIF89a..."), Some("image/gif"));
        assert_eq!(sniff_media_type(b"plain"), None);
        assert_eq!(extension_for("image/jpeg"), "jpg");
        assert_eq!(extension_for("image/png"), "png");
    }

    #[test]
    fn the_artifact_content_names_the_file_and_where_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let record = store(dir.path(), generated("aurora"), &png_1x1()).unwrap();
        let content = ImageArtifactContent::from_record(dir.path(), &record);
        assert_eq!(content.asset, "001-generated-aurora.png");
        assert!(content.path.ends_with("001-generated-aurora.png"));
        assert!(!content.path.starts_with(r"\\?\"), "{}", content.path);
        assert_eq!(content.source, AssetSource::Generated);
        let json = serde_json::to_value(&content).unwrap();
        assert_eq!(json["mediaType"], "image/png");
        assert!(json.get("parent").is_none(), "absent fields are omitted");
        assert_eq!(artifact_id_for(&record.name), "image-001-generated-aurora");
    }

    #[test]
    fn a_missing_manifest_is_an_empty_list_and_a_corrupt_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list(dir.path()).unwrap().is_empty());
        fs::write(dir.path().join(MANIFEST_FILE), b"{not json").unwrap();
        let err = list(dir.path()).unwrap_err();
        assert!(err.contains("unreadable"), "{err}");
    }
}
