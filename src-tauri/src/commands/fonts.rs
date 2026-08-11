//! System font enumeration backing the Appearance font pickers.
//!
//! Enumerates installed font FAMILIES via DirectWrite and caches the result in
//! the `app_settings` key-value store, so the machine is scanned once — later
//! opens read the cached list and never pay the scan again. `refresh: true`
//! forces a rescan (Settings exposes it as "Rescan").
//!
//! DirectWrite, not GDI, deliberately: Chromium (the webview that will render
//! the chosen family) matches DirectWrite family names. GDI enumeration
//! (`InstalledFontCollection`, the registry) splits one family into per-weight
//! pseudo-families — "Gotham Book" / "Gotham Black" — that CSS cannot resolve.
//! See `.knowledge/lesson.md` (2026-08-08, "GDI names are not CSS names").

use std::sync::Mutex;

use tauri::State;

use crate::db::Database;

const SETTINGS_KEY: &str = "system_font_families";

/// Trim, drop empties and GDI vertical-font aliases, sort case-insensitively,
/// and de-duplicate (case-insensitive, first spelling wins).
fn normalize_families(raw: Vec<String>) -> Vec<String> {
    let mut families: Vec<String> = raw
        .into_iter()
        .map(|name| name.trim().to_string())
        // `@`-prefixed names are GDI's vertical-writing aliases; DirectWrite
        // should never produce them, but the filter is cheap insurance against
        // a future fallback enumerator.
        .filter(|name| !name.is_empty() && !name.starts_with('@'))
        .collect();
    families.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    families.dedup_by(|a, b| a.to_lowercase() == b.to_lowercase());
    families
}

/// Enumerate installed font families with DirectWrite (Windows).
///
/// Names are read from each family's localized-strings set, preferring
/// `en-us` and falling back to the first locale — the same resolution
/// Chromium applies, so what this returns is what CSS can ask for.
#[cfg(windows)]
fn enumerate_system_families() -> Result<Vec<String>, String> {
    use windows::core::w;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, DWRITE_FACTORY_TYPE_SHARED,
    };

    // SAFETY: DirectWrite's factory and collection objects are free-threaded;
    // every call below follows the documented calling convention, and buffers
    // handed to GetString are sized from GetStringLength (+1 for the NUL).
    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
            .map_err(|e| format!("DirectWrite factory failed: {e}"))?;

        let mut collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut collection, false)
            .map_err(|e| format!("Reading the system font collection failed: {e}"))?;
        let collection =
            collection.ok_or_else(|| "System font collection was empty".to_string())?;

        let count = collection.GetFontFamilyCount();
        let mut names = Vec::with_capacity(count as usize);
        for i in 0..count {
            let Ok(family) = collection.GetFontFamily(i) else {
                continue;
            };
            let Ok(localized) = family.GetFamilyNames() else {
                continue;
            };

            let mut index = 0u32;
            let mut exists = windows::core::BOOL::default();
            if localized
                .FindLocaleName(w!("en-us"), &mut index, &mut exists)
                .is_err()
                || !exists.as_bool()
            {
                index = 0;
            }

            let Ok(len) = localized.GetStringLength(index) else {
                continue;
            };
            let mut buf = vec![0u16; len as usize + 1];
            if localized.GetString(index, &mut buf).is_err() {
                continue;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        Ok(names)
    }
}

#[cfg(not(windows))]
fn enumerate_system_families() -> Result<Vec<String>, String> {
    // Non-Windows builds have no enumerator yet; an empty list keeps the
    // pickers usable (bundled faces + free text) rather than erroring.
    Ok(Vec::new())
}

fn read_cache(db: &Database) -> Option<Vec<String>> {
    db.settings()
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|setting| serde_json::from_str::<Vec<String>>(&setting.value).ok())
        // An empty cached list means a scan never succeeded — treat as absent
        // so the next open retries instead of pinning "no fonts" forever.
        .filter(|families| !families.is_empty())
}

/// Installed font families, cached after the first successful scan.
///
/// Async so the scan (and the SQLite write) stay off the main thread — a sync
/// command would run on the UI thread (see lesson.md 2026-07-01).
#[tauri::command]
pub async fn system_font_families(
    refresh: Option<bool>,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<String>, String> {
    let refresh = refresh.unwrap_or(false);

    if !refresh {
        let cached = {
            let guard = db.lock().map_err(|e| e.to_string())?;
            read_cache(&guard)
        };
        if let Some(families) = cached {
            return Ok(families);
        }
    }

    let families = normalize_families(enumerate_system_families()?);

    if !families.is_empty() {
        let encoded = serde_json::to_string(&families)
            .map_err(|e| format!("Failed to encode font list: {e}"))?;
        let guard = db.lock().map_err(|e| e.to_string())?;
        guard
            .settings()
            .set_setting(SETTINGS_KEY, &encoded)
            .map_err(|e| format!("Failed to cache font list: {e:?}"))?;
    }

    Ok(families)
}

#[cfg(test)]
mod tests {
    use super::normalize_families;

    #[test]
    fn normalize_sorts_case_insensitively_and_dedupes() {
        let raw = vec![
            "Segoe UI".to_string(),
            "arial".to_string(),
            "Arial".to_string(),
            "  Cambria  ".to_string(),
            "".to_string(),
            "@Yu Gothic".to_string(),
            "Zilla Slab".to_string(),
        ];
        assert_eq!(
            normalize_families(raw),
            vec!["arial", "Cambria", "Segoe UI", "Zilla Slab"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn directwrite_enumerates_real_families() {
        let families = super::enumerate_system_families().expect("DirectWrite scan");
        // Every Windows install ships these; if this fails the enumeration is
        // reading the wrong name table, not a machine quirk.
        let lower: Vec<String> = families.iter().map(|f| f.to_lowercase()).collect();
        assert!(
            lower.iter().any(|f| f == "segoe ui"),
            "Segoe UI missing from {} families",
            families.len()
        );
        assert!(lower.iter().any(|f| f == "arial"));
    }
}
