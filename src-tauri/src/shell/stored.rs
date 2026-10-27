//! The shell registry as saved in Settings, and loading it at start-up.
//!
//! Shared by the desktop app (Settings → Tools → Shell edits it through
//! `commands::shell_profiles`) and a host with no window, which only loads it.

use std::sync::Arc;

use super::{discovery, ShellProfiles, SETTINGS_KEY};
use crate::db::{Database, DatabaseAccess};

/// Load the persisted registry, or an empty one when nothing is stored yet.
///
/// A corrupt payload is treated as absent rather than fatal: the user gets an
/// empty list they can rescan, not a settings page that will not open.
pub fn load(db: &Database) -> ShellProfiles {
    db.settings()
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|setting| serde_json::from_str::<ShellProfiles>(&setting.value).ok())
        .unwrap_or_default()
}

pub fn persist(db: &Database, state: &ShellProfiles) -> Result<(), String> {
    let encoded = serde_json::to_string(state)
        .map_err(|error| format!("Failed to encode shell profiles: {error}"))?;
    db.settings()
        .set_setting(SETTINGS_KEY, &encoded)
        .map_err(|error| format!("Failed to save shell profiles: {error:?}"))
}

/// Load the registry at startup and, on a first run, scan so the agent has a
/// correctly configured shell before the user ever opens settings.
///
/// Runs off the startup path: scanning launches a process per candidate.
pub fn bootstrap(db: Arc<dyn DatabaseAccess>) {
    crate::rt::spawn(async move {
        let mut stored = None;
        if !db.with_db(&mut |db| stored = Some(load(db))) {
            return;
        }
        let stored = stored.unwrap_or_default();

        if !stored.profiles.is_empty() {
            super::install(stored);
            return;
        }

        let scanned = discovery::scan().await;
        let merged = ShellProfiles::default().merged_with_scan(scanned);

        // Best effort: a failed write still leaves a working in-memory
        // registry for this session.
        db.with_db(&mut |db| {
            let _ = persist(db, &merged);
        });
        super::install(merged);
    });
}
