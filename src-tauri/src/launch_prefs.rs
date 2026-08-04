//! Boot-time launch preference — which window a bare app-icon launch opens.
//!
//! Aurora normally opens the IDE. A user who lives in the agent window can flip
//! that, so launching from the Start menu / desktop icon opens the Agent window
//! instead.
//!
//! # Why a file and not `app_settings`
//!
//! Every other user setting (including the agent window's remembered size,
//! `app_settings.agent_window_bounds`) lives in SQLite. This one cannot, and the
//! reason is ordering, not taste:
//!
//! `lib.rs::run_with_args` needs the answer BEFORE `tauri::Builder` is even
//! constructed: the IDE window is created invisible (`"visible": false` in
//! tauri.conf.json) and only revealed by the `on_page_load` hook when the
//! launch is NOT agent-mode — a decision wired into the builder itself.
//! `db::Database::init` runs later in `setup()` (it needs the `AppHandle`, and
//! it runs migrations), so a value read from SQLite would arrive after the
//! moment it is needed.
//!
//! So this is *boot config* — the small set of facts needed before the app's
//! state layer exists — and it gets a plain JSON file next to everything else
//! Aurora owns. It is deliberately tiny and defaults hard: any error at all
//! (missing, unreadable, corrupt, unknown value) resolves to the IDE, because a
//! launch preference that fails closed into "no window" would be unrecoverable
//! without editing a file by hand.

use serde::{Deserialize, Serialize};

use crate::paths;

/// The window a bare launch opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LaunchSurface {
    /// The full IDE (`main` window). Aurora's default since 1.0.
    #[default]
    Ide,
    /// The Agent window only.
    Agent,
}

/// On-disk shape. A struct rather than a bare string so later boot-config facts
/// (a startup theme, a "restore last project" flag) can join it without a
/// second file or a format break.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LaunchConfig {
    surface: LaunchSurface,
}

/// `<root>/launch.json` — sits beside `data/`, `sessions/`, and the rest.
fn config_file() -> std::path::PathBuf {
    paths::root().join("launch.json")
}

/// Parse the stored config, resolving anything unusable to the IDE.
///
/// Separated from the IO so it is testable without touching the real
/// application directory.
fn parse(raw: &str) -> LaunchSurface {
    serde_json::from_str::<LaunchConfig>(raw)
        .map(|config| config.surface)
        .unwrap_or_default()
}

fn serialize(surface: LaunchSurface) -> String {
    serde_json::to_string_pretty(&LaunchConfig { surface })
        .unwrap_or_else(|_| "{\n  \"surface\": \"ide\"\n}".to_string())
}

/// Which surface a bare launch should open. Never fails — see the module docs.
pub fn read() -> LaunchSurface {
    match std::fs::read_to_string(config_file()) {
        Ok(raw) => parse(&raw),
        // Missing file is the overwhelmingly common case (every install that has
        // never changed the setting), so it is not worth a log line.
        Err(_) => LaunchSurface::Ide,
    }
}

/// Persist the launch surface. Surfaces the real IO error — this is called from
/// a settings toggle, where silently not saving is the worst outcome.
pub fn write(surface: LaunchSurface) -> Result<(), String> {
    let path = config_file();
    std::fs::write(&path, serialize(surface))
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_the_ide() {
        assert_eq!(LaunchSurface::default(), LaunchSurface::Ide);
    }

    #[test]
    fn reads_both_surfaces() {
        assert_eq!(parse(r#"{"surface":"ide"}"#), LaunchSurface::Ide);
        assert_eq!(parse(r#"{"surface":"agent"}"#), LaunchSurface::Agent);
    }

    /// Every failure mode resolves to the IDE. A launch preference that could
    /// resolve to "nothing" would strand the user with no window at all.
    #[test]
    fn every_unusable_input_falls_back_to_the_ide() {
        for raw in [
            "",
            "not json",
            "{}",
            "null",
            "[]",
            r#"{"surface":"editor"}"#, // unknown variant
            r#"{"surface":null}"#,     // wrong type
            r#"{"surface":"Agent"}"#,  // wrong case — serde is lowercase
            r#"{"other":"agent"}"#,    // missing field
        ] {
            assert_eq!(
                parse(raw),
                LaunchSurface::Ide,
                "expected IDE fallback for {raw:?}",
            );
        }
    }

    #[test]
    fn round_trips_through_the_stored_form() {
        for surface in [LaunchSurface::Ide, LaunchSurface::Agent] {
            assert_eq!(parse(&serialize(surface)), surface);
        }
    }

    /// The file is hand-editable, so the written form must be the one the
    /// fallback test above proves is readable — lowercase, under `surface`.
    #[test]
    fn writes_lowercase_surface_names() {
        assert!(serialize(LaunchSurface::Agent).contains("\"agent\""));
        assert!(serialize(LaunchSurface::Ide).contains("\"ide\""));
    }
}
