//! Find file icon themes the user already has installed.
//!
//! Aurora ships two icon packs and can import more, but "import" starts with
//! the user finding a theme — and most people running an editor like this one
//! already have several sitting in `~/.vscode/extensions`. Listing those turns
//! a download-and-locate chore into picking from a list.
//!
//! Scanned per editor, because someone with VS Code, Cursor and VSCodium
//! installed has three separate extension folders and no reason to care which
//! one a theme came from. A root that does not exist is simply skipped: not
//! having Cursor installed is not an error.
//!
//! Only the extension's `package.json` is read here. Parsing the theme itself
//! and inlining a thousand SVGs is the frontend's job, done once when the user
//! actually picks one — doing it for every installed extension up front would
//! make opening a settings panel read hundreds of megabytes.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One installed icon theme, as much as its `package.json` can tell us.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledIconTheme {
    /// `publisher.name`, stable across versions so re-scanning does not
    /// produce a second entry for a theme that merely updated.
    pub id: String,
    /// `displayName`, falling back to the package name.
    pub name: String,
    pub publisher: Option<String>,
    pub version: String,
    pub description: Option<String>,
    /// Absolute path to the extension folder — what the importer needs.
    pub extension_dir: String,
    /// Which editor it was found under, e.g. "VS Code".
    pub source: String,
    /// `false` when every icon definition draws a font glyph, which Aurora
    /// cannot render. Surfaced so the UI can say so BEFORE the user picks it
    /// and gets an error.
    pub renderable: bool,
}

/// Editor extension folders, relative to the user's home directory.
///
/// Ordered so the most likely source is scanned first; duplicates across
/// editors are collapsed by id later, keeping the first seen.
const EXTENSION_ROOTS: &[(&str, &str)] = &[
    (".vscode/extensions", "VS Code"),
    (".vscode-insiders/extensions", "VS Code Insiders"),
    (".vscode-oss/extensions", "VSCodium"),
    (".cursor/extensions", "Cursor"),
    (".windsurf/extensions", "Windsurf"),
];

/// Whether a theme's icons are files Aurora can show.
///
/// A theme is renderable when at least ONE definition names an `iconPath`.
/// Seti and VS Code's own default give every definition a `fontCharacter`
/// instead, and Aurora has no glyph icon kind — so those would import as an
/// empty pack. Cheaper to find out now, from the theme file, than to let the
/// user pick it and read an error.
fn theme_is_renderable(extension_dir: &Path, package: &serde_json::Value) -> bool {
    let Some(relative) = package
        .get("contributes")
        .and_then(|c| c.get("iconThemes"))
        .and_then(|t| t.as_array())
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| {
                    entry.get("_preferred").and_then(serde_json::Value::as_bool) == Some(true)
                })
                .or_else(|| entries.first())
        })
        .and_then(|entry| entry.get("path"))
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };

    let theme_path = extension_dir.join(relative.trim_start_matches("./"));
    let Ok(raw) = std::fs::read_to_string(&theme_path) else {
        // Unreadable is not the same as font-based. Let the import report the
        // real reason rather than hiding the theme from the list.
        return true;
    };
    let Ok(theme) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    let Some(definitions) = theme.get("iconDefinitions").and_then(|d| d.as_object()) else {
        return true;
    };
    definitions
        .values()
        .any(|definition| definition.get("iconPath").is_some())
}

/// Read one extension folder, returning a theme when it contributes one.
fn read_extension(dir: &Path, source: &str) -> Option<InstalledIconTheme> {
    let raw = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let package: serde_json::Value = serde_json::from_str(&raw).ok()?;

    // No icon theme contributed — a colour theme, a linter, anything else.
    let contributes_icons = package
        .get("contributes")
        .and_then(|c| c.get("iconThemes"))
        .and_then(|t| t.as_array())
        .is_some_and(|entries| !entries.is_empty());
    if !contributes_icons {
        return None;
    }

    let text = |key: &str| {
        package
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
    };

    let name = text("name")?;
    let publisher = text("publisher");

    Some(InstalledIconTheme {
        id: match &publisher {
            Some(publisher) => format!("{publisher}.{name}"),
            None => name.clone(),
        },
        name: text("displayName").unwrap_or_else(|| name.clone()),
        publisher,
        version: text("version").unwrap_or_else(|| "0.0.0".to_string()),
        description: text("description"),
        extension_dir: dir.to_string_lossy().to_string(),
        source: source.to_string(),
        renderable: theme_is_renderable(dir, &package),
    })
}

/// Every icon theme installed for any editor we know about.
///
/// Never fails on a missing folder: someone without Cursor installed simply
/// has no Cursor themes, which is an empty list, not an error.
fn scan() -> Vec<InstalledIconTheme> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };

    let mut found: Vec<InstalledIconTheme> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (relative, source) in EXTENSION_ROOTS {
        let root: PathBuf = home.join(relative);
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(theme) = read_extension(&entry.path(), source) else {
                continue;
            };
            // The same theme installed in two editors is one theme. Keep the
            // first, which is the higher-priority root.
            if seen.insert(theme.id.clone()) {
                found.push(theme);
            }
        }
    }

    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

/// List icon themes installed in the user's editors.
///
/// `async` + `spawn_blocking`: this reads a few hundred small files, and a
/// sync command body would do that on Tauri's UI thread.
#[tauri::command]
pub async fn list_installed_icon_themes() -> Result<Vec<InstalledIconTheme>, String> {
    tokio::task::spawn_blocking(scan)
        .await
        .map_err(|error| format!("icon theme scan failed: {error}"))
}

/// Everything an icon theme's images can be, as a data URI.
///
/// SVG is text and rides through as-is. Raster formats have to be base64'd,
/// and that is the whole reason this lives in Rust: the generic
/// `read_file_content` decodes UTF-8, so a PNG arrives as mojibake. Themes
/// built on PNG are not a corner case — VSCode Great Icons is 298 PNGs and no
/// SVG at all, and reading only SVG would import it as an empty pack.
fn icon_as_data_uri(path: &Path) -> Option<String> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();

    if extension == "svg" {
        // A data URI, not raw markup. Returning markup meant the pack parser
        // had to recognise it, and its test is `startsWith("<svg")` — which an
        // SVG opening with `<?xml version="1.0"?>` fails. That is not exotic:
        // anything Inkscape saves has that prolog, and VSCode Great Icons ships
        // 244 such files, so the whole theme was rejected over one of them.
        // Encoding here makes the answer independent of how the file happens to
        // start — prolog, comment, DOCTYPE, or BOM.
        let text = std::fs::read_to_string(path).ok()?;
        if text.trim().is_empty() {
            return None;
        }
        use base64::Engine as _;
        return Some(format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(text.trim())
        ));
    }

    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        _ => return None,
    };
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    use base64::Engine as _;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Resolve `relative` against `base`, honouring `.` and `..`.
fn resolve_relative(base: &Path, relative: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for segment in relative.split(['/', '\\']).filter(|s| !s.is_empty()) {
        match segment {
            "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// A theme's images, keyed by the `iconPath` exactly as the theme spelled it.
///
/// `theme_path` is the theme JSON; icon paths are relative to ITS folder, not
/// the extension root — themes that build into `dist/` reference `../icons/…`
/// and get this wrong constantly if you assume otherwise.
///
/// Reads are confined to `extension_dir`. A theme is a file the user pointed
/// at rather than something Aurora vouches for, and `../../../` in an
/// `iconPath` should read nothing rather than whatever it names.
#[tauri::command]
pub async fn read_icon_theme_assets(
    extension_dir: String,
    theme_path: String,
    icon_paths: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    tokio::task::spawn_blocking(move || {
        let root =
            std::fs::canonicalize(&extension_dir).unwrap_or_else(|_| PathBuf::from(&extension_dir));
        let theme_dir = Path::new(&theme_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.clone());

        let mut out = std::collections::HashMap::new();
        let mut budget: usize = 64 * 1024 * 1024;

        for icon_path in icon_paths {
            let resolved = resolve_relative(&theme_dir, &icon_path);
            let Ok(canonical) = std::fs::canonicalize(&resolved) else {
                continue;
            };
            if !canonical.starts_with(&root) {
                continue;
            }
            let Some(data) = icon_as_data_uri(&canonical) else {
                continue;
            };
            budget = match budget.checked_sub(data.len()) {
                Some(left) => left,
                // A theme large enough to exhaust this is a theme something is
                // wrong with. Stop rather than hand the WebView a string it
                // cannot hold.
                None => break,
            };
            out.insert(icon_path, data);
        }
        out
    })
    .await
    .map_err(|error| format!("icon asset read failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, relative: &str, body: &str) {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, body).expect("write");
    }

    #[test]
    fn an_icon_theme_extension_is_recognised() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext = tmp.path().join("pkief.material-icon-theme-5.0.0");
        write(
            &ext,
            "package.json",
            r#"{"name":"material-icon-theme","displayName":"Material Icon Theme",
                "publisher":"PKief","version":"5.0.0","description":"Material icons",
                "contributes":{"iconThemes":[{"id":"material","path":"./dist/theme.json"}]}}"#,
        );
        write(
            &ext,
            "dist/theme.json",
            r#"{"iconDefinitions":{"_file":{"iconPath":"../icons/file.svg"}}}"#,
        );

        let theme = read_extension(&ext, "VS Code").expect("recognised");
        assert_eq!(theme.id, "PKief.material-icon-theme");
        assert_eq!(theme.name, "Material Icon Theme");
        assert!(theme.renderable);
    }

    #[test]
    fn an_extension_that_contributes_no_icon_theme_is_ignored() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext = tmp.path().join("some.colour-theme-1.0.0");
        write(
            &ext,
            "package.json",
            r#"{"name":"dracula","publisher":"x","version":"1.0.0",
                "contributes":{"themes":[{"path":"./dracula.json"}]}}"#,
        );

        assert!(read_extension(&ext, "VS Code").is_none());
    }

    /// Seti-style themes draw every icon from a woff. Aurora has no glyph
    /// kind, so they must be flagged in the LIST — finding out at import time
    /// means the user picks a theme and gets an error for their trouble.
    #[test]
    fn a_font_based_theme_is_listed_but_flagged_unrenderable() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext = tmp.path().join("seti-1.0.0");
        write(
            &ext,
            "package.json",
            r#"{"name":"seti","publisher":"vscode","version":"1.0.0",
                "contributes":{"iconThemes":[{"id":"seti","path":"./seti.json"}]}}"#,
        );
        write(
            &ext,
            "seti.json",
            r#"{"fonts":[{"id":"seti"}],
                "iconDefinitions":{"_a":{"fontCharacter":"\\E001","fontId":"seti"}}}"#,
        );

        let theme = read_extension(&ext, "VS Code").expect("listed");
        assert!(!theme.renderable, "a font-only theme cannot be rendered");
    }

    /// A theme whose JSON is missing or broken is still worth showing — the
    /// import path reports the real reason, and hiding it looks like Aurora
    /// simply cannot see an extension the user knows is installed.
    #[test]
    fn an_unreadable_theme_file_does_not_hide_the_extension() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext = tmp.path().join("broken-1.0.0");
        write(
            &ext,
            "package.json",
            r#"{"name":"broken","publisher":"x","version":"1.0.0",
                "contributes":{"iconThemes":[{"id":"b","path":"./missing.json"}]}}"#,
        );

        let theme = read_extension(&ext, "VS Code").expect("listed");
        assert!(theme.renderable);
    }

    /// Raster icons are not a corner case: VSCode Great Icons mixes 54 PNGs in
    /// with its SVGs, and a reader that handled only SVG would drop them.
    #[test]
    fn every_icon_comes_back_as_a_data_uri_whatever_its_format() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // The 67-byte 1x1 PNG, written as bytes so this is a real image.
        let png: [u8; 67] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(tmp.path().join("a.png"), png).expect("write png");
        write(tmp.path(), "b.svg", "  <svg viewBox=\"0 0 16 16\"/>  ");

        let as_png = icon_as_data_uri(&tmp.path().join("a.png")).expect("png read");
        assert!(as_png.starts_with("data:image/png;base64,"), "got {as_png}");

        let as_svg = icon_as_data_uri(&tmp.path().join("b.svg")).expect("svg read");
        assert!(
            as_svg.starts_with("data:image/svg+xml;base64,"),
            "got {as_svg}"
        );
    }

    /// SVG used to come back as raw markup, which left the pack parser to
    /// recognise it — and its test is `startsWith("<svg")`. Anything Inkscape
    /// saves opens with `<?xml version="1.0"?>` instead, so importing VSCode
    /// Great Icons failed on `valgrind.svg` and took the whole theme with it.
    /// Encoding here makes the answer independent of how the file starts.
    #[test]
    fn an_svg_behind_an_xml_prolog_still_reads() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(
            tmp.path(),
            "prologued.svg",
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\r\n\
             <!-- Created with Inkscape -->\r\n<svg viewBox=\"0 0 16 16\"/>",
        );

        let encoded = icon_as_data_uri(&tmp.path().join("prologued.svg")).expect("svg read");
        assert!(
            encoded.starts_with("data:image/svg+xml;base64,"),
            "got {encoded}"
        );
    }

    #[test]
    fn an_empty_icon_file_is_not_offered_as_an_icon() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "blank.svg", "   \n  ");
        assert!(icon_as_data_uri(&tmp.path().join("blank.svg")).is_none());
    }

    #[test]
    fn an_unknown_file_type_is_left_alone() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "notes.txt", "hello");
        assert!(icon_as_data_uri(&tmp.path().join("notes.txt")).is_none());
    }

    /// Themes that build into `dist/` reference their icons as `../icons/…`.
    #[test]
    fn icon_paths_resolve_out_of_the_theme_folder() {
        assert_eq!(
            resolve_relative(Path::new("C:/ext/dist"), "../icons/a.svg"),
            PathBuf::from("C:/ext/icons/a.svg"),
        );
        assert_eq!(
            resolve_relative(Path::new("C:/ext"), "./icons/./a.svg"),
            PathBuf::from("C:/ext/icons/a.svg"),
        );
    }

    #[test]
    fn the_preferred_theme_entry_decides_renderability() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext = tmp.path().join("multi-1.0.0");
        write(
            &ext,
            "package.json",
            r#"{"name":"multi","publisher":"x","version":"1.0.0","contributes":{"iconThemes":[
                {"id":"font","path":"./font.json"},
                {"id":"svg","path":"./svg.json","_preferred":true}]}}"#,
        );
        write(
            &ext,
            "font.json",
            r#"{"iconDefinitions":{"_a":{"fontCharacter":"\\E001"}}}"#,
        );
        write(
            &ext,
            "svg.json",
            r#"{"iconDefinitions":{"_a":{"iconPath":"./a.svg"}}}"#,
        );

        let theme = read_extension(&ext, "VS Code").expect("listed");
        assert!(theme.renderable, "the preferred entry is the SVG one");
    }
}
