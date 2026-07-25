//! Aurora's shell registry — one source of truth for every shell the app runs.
//!
//! Before this module, four places each decided independently how to start a
//! shell: the agent's tools, the diagnostics checker, the streaming command
//! runner, and the PTY terminal (which hardcoded an absolute Git path). They
//! disagreed, and none of them could be configured. Now a *profile* — an
//! executable plus a [`kinds::ShellKind`] — is registered once, and every
//! consumer resolves through [`resolve`].
//!
//! Design rules, in priority order:
//!
//! - **The user supplies a path; Aurora supplies everything else.** Flags,
//!   environment, and quoting are derived from the kind
//!   ([`kinds::ShellKind::command_args`], [`env::compose`]) so a profile can
//!   never carry wrong arguments.
//! - **Nothing is hardcoded.** Paths come from Windows Terminal, `PATH`, the
//!   registry, or the user. See [`discovery`].
//! - **The model can only ask for what exists.** The `shell` argument on
//!   `shell_execute` / `shell_spawn` is enumerated from enabled profiles, is
//!   **required**, and a substitution is always reported rather than silently
//!   applied. A command's syntax is not portable between `bash` and `pwsh`, so
//!   the shell it was written for is part of the command — leaving it implicit
//!   meant the model wrote POSIX and Aurora sometimes ran it in PowerShell.
//! - **The user enables and disables; Aurora picks.** There is deliberately no
//!   user-chosen default. Which shell a *tool call* runs in is now the model's
//!   statement, and the fallback for everything else (the PTY terminal,
//!   diagnostics) is derived: first usable POSIX shell, `Ready` before
//!   `Degraded`. Asking a user to nominate a default was asking them to answer
//!   a question they have no way to reason about.
//!
//! The registry is held in a process-global snapshot refreshed whenever
//! settings change, because [`crate::commands::build_shell_command`] runs deep
//! inside command execution where no database handle is available.

pub mod discovery;
pub mod env;
pub mod kinds;
pub mod text;
pub mod windows_terminal;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

pub use kinds::ShellKind;

/// `app_settings` key holding the serialized [`ShellProfiles`].
pub const SETTINGS_KEY: &str = "shell_profiles";

/// Current schema version of the persisted payload.
const SCHEMA_VERSION: u32 = 1;

/// How a profile came to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    /// Found by [`discovery::scan`].
    Scan,
    /// Registered by the user with an explicit path.
    Manual,
}

/// Whether a profile can actually run commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthState {
    /// Verified: it starts and its expected utilities are reachable.
    Ready,
    /// Starts, but something will bite later — a bash with no coreutils.
    Degraded,
    /// Cannot be launched at all.
    Failed,
}

/// Health verdict plus the human explanation shown in settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellHealth {
    pub state: HealthState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ShellHealth {
    #[must_use]
    pub const fn ready() -> Self {
        Self {
            state: HealthState::Ready,
            detail: None,
        }
    }

    /// Usable for execution. A degraded shell still runs commands, so it stays
    /// selectable — the warning belongs in the UI, not in a hard block.
    #[must_use]
    pub const fn is_usable(&self) -> bool {
        !matches!(self.state, HealthState::Failed)
    }
}

/// One registered shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    /// Stable id derived from the executable path, so re-scanning updates a
    /// profile in place instead of duplicating it.
    pub id: String,
    pub kind: ShellKind,
    pub label: String,
    /// Path as registered — `%PROGRAMFILES%\Git\bin\bash.exe` stays raw so it
    /// keeps resolving after a Windows or Git upgrade moves the target.
    pub path: String,
    /// Expanded path recorded at verification time, for display.
    pub exe: String,
    /// Whether the agent and terminal may use it.
    pub enabled: bool,
    /// The source marked this the user's preferred shell (Windows Terminal's
    /// `defaultProfile`). Informational — it does not set Aurora's default.
    #[serde(default)]
    pub preferred: bool,
    pub source: ProfileSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub health: ShellHealth,
    pub verified_at_ms: u64,
}

impl ShellProfile {
    /// Executable path with environment references expanded, resolved fresh
    /// on every use so a moved install self-heals.
    #[must_use]
    pub fn resolved_exe(&self) -> String {
        let expanded = env::expand_vars(&self.path);
        if Path::new(&expanded).is_file() {
            return expanded;
        }
        // Fall back to the path recorded at verification time; a stale entry
        // surfaces as a launch error rather than as silently doing nothing.
        if Path::new(&self.exe).is_file() {
            return self.exe.clone();
        }
        expanded
    }

    #[must_use]
    fn usable(&self) -> bool {
        self.enabled && self.health.is_usable()
    }
}

/// The persisted registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfiles {
    pub version: u32,
    pub profiles: Vec<ShellProfile>,
}

impl Default for ShellProfiles {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            profiles: Vec::new(),
        }
    }
}

impl ShellProfiles {
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&ShellProfile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }

    /// The profile used when no shell is named — the PTY terminal, diagnostics,
    /// and any legacy caller.
    ///
    /// Derived, never configured: the first usable shell in [`ShellKind::ALL`]
    /// order, which puts POSIX ahead of PowerShell because Aurora's prompts,
    /// habits, and command validator are all bash-shaped. Agent tool calls no
    /// longer reach this path at all — `shell` is required on `shell_execute`
    /// and `shell_spawn`, so the model states where its command runs.
    #[must_use]
    pub fn default_profile(&self) -> Option<&ShellProfile> {
        ShellKind::ALL
            .iter()
            .find_map(|kind| self.first_usable_of(*kind))
    }

    fn first_usable_of(&self, kind: ShellKind) -> Option<&ShellProfile> {
        // Ready beats Degraded: given two bash installs, prefer the one with
        // a working userland.
        self.profiles
            .iter()
            .filter(|profile| profile.kind == kind && profile.usable())
            .min_by_key(|profile| match profile.health.state {
                HealthState::Ready => 0,
                HealthState::Degraded => 1,
                HealthState::Failed => 2,
            })
    }

    /// Kinds the model may choose between, default first.
    #[must_use]
    pub fn available_kinds(&self) -> Vec<ShellKind> {
        let mut kinds: Vec<ShellKind> = Vec::new();
        if let Some(default) = self.default_profile() {
            kinds.push(default.kind);
        }
        for profile in &self.profiles {
            if profile.usable() && !kinds.contains(&profile.kind) {
                kinds.push(profile.kind);
            }
        }
        kinds
    }

    /// Merge a fresh scan into this registry.
    ///
    /// User decisions survive: manual profiles are never dropped, and an
    /// explicit enable/disable is preserved for profiles that already exist.
    /// Only verification data and auto-generated labels are refreshed.
    ///
    /// A scan is authoritative about what it found, so scanned entries it no
    /// longer returns are dropped. Without that, a registry built by an
    /// earlier, broader scan would keep every duplicate install forever.
    #[must_use]
    pub fn merged_with_scan(&self, scanned: Vec<ShellProfile>) -> Self {
        let mut merged = self.clone();
        merged.version = SCHEMA_VERSION;

        if !scanned.is_empty() {
            let found_ids: std::collections::HashSet<&str> =
                scanned.iter().map(|profile| profile.id.as_str()).collect();
            merged.profiles.retain(|profile| {
                profile.source == ProfileSource::Manual || found_ids.contains(profile.id.as_str())
            });
        }

        for found in scanned {
            match merged
                .profiles
                .iter_mut()
                .find(|existing| existing.id == found.id)
            {
                Some(existing) => {
                    existing.kind = found.kind;
                    existing.exe = found.exe;
                    existing.version = found.version;
                    existing.health = found.health;
                    existing.preferred = found.preferred;
                    existing.verified_at_ms = found.verified_at_ms;
                    // A manually registered path and a user-set label are the
                    // user's, not the scanner's.
                    if existing.source == ProfileSource::Scan {
                        existing.label = found.label;
                        existing.path = found.path;
                    }
                }
                None => merged.profiles.push(found),
            }
        }

        merged
    }
}

/// A shell resolved to something spawnable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedShell {
    pub profile_id: String,
    pub kind: ShellKind,
    pub label: String,
    pub exe: String,
    /// Flags preceding the command. The command itself is appended by the
    /// caller as a single argument — never interpolated into a string.
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Set when the caller asked for a shell that was unavailable and a
    /// different one was used. Callers must report this rather than let the
    /// model believe its command ran under the shell it asked for.
    pub substituted_from: Option<String>,
}

static REGISTRY: OnceLock<RwLock<ShellProfiles>> = OnceLock::new();

fn registry() -> &'static RwLock<ShellProfiles> {
    REGISTRY.get_or_init(|| RwLock::new(ShellProfiles::default()))
}

/// Current registry contents.
#[must_use]
pub fn snapshot() -> ShellProfiles {
    registry().read().clone()
}

/// Replace the registry. Called after load, scan, and every settings write.
pub fn install(state: ShellProfiles) {
    *registry().write() = state;
}

// `is_empty()` lived here, for callers wanting to keep legacy behaviour before
// the first scan. Nothing used it: `resolve` already returns `None` in exactly
// that case, and every caller branches on that instead — one signal rather than
// two that could disagree.

/// Resolve a `shell` argument to something spawnable.
///
/// `requested` accepts a kind id (`"bash"`, `"pwsh"`, `"cmd"`) or a profile
/// id. Resolution order:
///
/// 1. exact profile id
/// 2. a usable profile of the requested kind
/// 3. a related kind — `pwsh` ⇄ `powershell` and `bash` → `sh`/`zsh` — which
///    is what makes Aurora's legacy `"powershell"` argument keep working
/// 4. the registry default
///
/// Returns `None` only when nothing is registered.
#[must_use]
pub fn resolve(requested: Option<&str>) -> Option<ResolvedShell> {
    resolve_inner(requested, false)
}

/// Like [`resolve`], but with the flags that open an **interactive** session
/// instead of the ones that run a single command.
///
/// This is what the PTY terminal spawns. Before it existed the terminal
/// hardcoded `C:\Program Files\Git\bin\bash.exe` and a bare `pwsh.exe`, so a
/// user whose Git lived anywhere else got a terminal that failed to start
/// while the settings page happily listed the shell it could not launch. The
/// registry already knew the real path; nothing consumed it.
#[must_use]
pub fn resolve_interactive(requested: Option<&str>) -> Option<ResolvedShell> {
    resolve_inner(requested, true)
}

fn resolve_inner(requested: Option<&str>, interactive: bool) -> Option<ResolvedShell> {
    let state = snapshot();
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());

    let direct = requested.and_then(|value| {
        state
            .get(value)
            .filter(|profile| profile.usable())
            .or_else(|| ShellKind::from_id(value).and_then(|kind| state.first_usable_of(kind)))
    });

    let (profile, substituted_from) = match (direct, requested) {
        (Some(profile), _) => (Some(profile), None),
        (None, Some(value)) => {
            let fallback = ShellKind::from_id(value)
                .and_then(|kind| {
                    related_kinds(kind)
                        .iter()
                        .find_map(|k| state.first_usable_of(*k))
                })
                .or_else(|| state.default_profile());
            (fallback, Some(value.to_string()))
        }
        (None, None) => (state.default_profile(), None),
    };

    let profile = profile?;
    let exe = profile.resolved_exe();
    let env = env::compose(profile.kind, Path::new(&exe));

    let args = if interactive {
        profile.kind.interactive_args()
    } else {
        profile.kind.command_args()
    };

    Some(ResolvedShell {
        profile_id: profile.id.clone(),
        kind: profile.kind,
        label: profile.label.clone(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        exe,
        env,
        // Only report a substitution when the kind actually changed.
        substituted_from: substituted_from
            .filter(|value| ShellKind::from_id(value).is_none_or(|kind| kind != profile.kind)),
    })
}

/// The kind a command will actually run under — what the safety validator
/// must be told. Falls back to the platform's native family when nothing is
/// registered yet, matching the pre-registry behaviour.
#[must_use]
pub fn resolve_kind(requested: Option<&str>) -> ShellKind {
    if let Some(resolved) = resolve(requested) {
        return resolved.kind;
    }
    requested
        .and_then(ShellKind::from_id)
        .unwrap_or(if cfg!(windows) {
            ShellKind::Bash
        } else {
            ShellKind::Sh
        })
}

/// Kinds close enough to substitute for one another.
fn related_kinds(kind: ShellKind) -> &'static [ShellKind] {
    match kind {
        // Aurora's historical `"powershell"` argument meant PowerShell 7.
        ShellKind::PowerShell => &[ShellKind::Pwsh],
        ShellKind::Pwsh => &[ShellKind::PowerShell],
        ShellKind::Bash => &[ShellKind::Zsh, ShellKind::Sh],
        ShellKind::Sh | ShellKind::Zsh => &[ShellKind::Bash, ShellKind::Sh],
        ShellKind::Cmd => &[],
    }
}

/// Kinds the model may pass, default first. Empty until the first scan.
#[must_use]
pub fn available_kinds() -> Vec<ShellKind> {
    snapshot().available_kinds()
}

/// One sentence per available shell, for the tool description. Generated from
/// the registry so the model's guidance can never describe a shell the user
/// does not have — the list is exactly what the user left enabled.
#[must_use]
pub fn model_facing_summary() -> Option<String> {
    let state = snapshot();
    let kinds = state.available_kinds();
    if kinds.is_empty() {
        return None;
    }

    let listed = kinds
        .iter()
        .map(|kind| format!("`{}` ({})", kind.id(), kind.syntax_hint()))
        .collect::<Vec<_>>()
        .join("; ");

    Some(format!(
        "This machine has: {listed}. `shell` is REQUIRED — name the shell you wrote the command \
         for, and write the command in that shell's syntax.",
    ))
}

/// Stable profile id for an executable path.
#[must_use]
pub fn profile_id(exe: &Path) -> String {
    let normalized = exe.to_string_lossy().replace('/', "\\").to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("sh-{hash:016x}")
}

#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, kind: ShellKind, state: HealthState) -> ShellProfile {
        ShellProfile {
            id: id.into(),
            kind,
            label: kind.default_label().into(),
            path: format!("/bin/{}", kind.id()),
            exe: format!("/bin/{}", kind.id()),
            enabled: true,
            preferred: false,
            source: ProfileSource::Scan,
            version: None,
            health: ShellHealth {
                state,
                detail: None,
            },
            verified_at_ms: 0,
        }
    }

    fn registry_of(profiles: Vec<ShellProfile>) -> ShellProfiles {
        ShellProfiles {
            version: SCHEMA_VERSION,
            profiles,
        }
    }

    #[test]
    fn default_prefers_posix_over_the_terminal_preference() {
        let mut pwsh = profile("p", ShellKind::Pwsh, HealthState::Ready);
        pwsh.preferred = true;
        let state = registry_of(vec![
            pwsh,
            profile("b", ShellKind::Bash, HealthState::Ready),
        ]);
        assert_eq!(
            state.default_profile().map(|p| p.kind),
            Some(ShellKind::Bash)
        );
    }

    /// The fallback is derived, not configured. Registration order must not
    /// change it — only `ShellKind::ALL` order does.
    #[test]
    fn the_fallback_is_derived_from_kind_order_not_registration_order() {
        let pwsh_first = registry_of(vec![
            profile("p", ShellKind::Pwsh, HealthState::Ready),
            profile("b", ShellKind::Bash, HealthState::Ready),
        ]);
        let bash_first = registry_of(vec![
            profile("b", ShellKind::Bash, HealthState::Ready),
            profile("p", ShellKind::Pwsh, HealthState::Ready),
        ]);
        assert_eq!(
            pwsh_first.default_profile().map(|p| p.kind),
            Some(ShellKind::Bash)
        );
        assert_eq!(
            bash_first.default_profile().map(|p| p.kind),
            Some(ShellKind::Bash)
        );
    }

    /// A registry persisted before the user-chosen default was removed still
    /// carries `defaultId`. Serde must ignore it rather than refuse to load,
    /// or an existing install comes back with no shells at all.
    #[test]
    fn a_persisted_default_id_is_ignored_not_fatal() {
        let legacy = r#"{"version":1,"defaultId":"sh-deadbeef","profiles":[]}"#;
        let parsed: ShellProfiles =
            serde_json::from_str(legacy).expect("legacy payload must still load");
        assert!(parsed.profiles.is_empty());
        assert_eq!(parsed.version, 1);
    }

    #[test]
    fn failed_profiles_are_never_selected() {
        let state = registry_of(vec![
            profile("b", ShellKind::Bash, HealthState::Failed),
            profile("p", ShellKind::Pwsh, HealthState::Ready),
        ]);
        assert_eq!(
            state.default_profile().map(|p| p.kind),
            Some(ShellKind::Pwsh)
        );
        assert!(!state.available_kinds().contains(&ShellKind::Bash));
    }

    #[test]
    fn a_healthy_install_beats_a_degraded_twin() {
        let mut degraded = profile("d", ShellKind::Bash, HealthState::Degraded);
        degraded.id = "degraded".into();
        let mut ready = profile("r", ShellKind::Bash, HealthState::Ready);
        ready.id = "ready".into();
        let state = registry_of(vec![degraded, ready]);
        assert_eq!(
            state
                .first_usable_of(ShellKind::Bash)
                .map(|p| p.id.as_str()),
            Some("ready")
        );
    }

    #[test]
    fn disabled_profiles_are_hidden_from_the_model() {
        let mut disabled = profile("c", ShellKind::Cmd, HealthState::Ready);
        disabled.enabled = false;
        let state = registry_of(vec![
            profile("b", ShellKind::Bash, HealthState::Ready),
            disabled,
        ]);
        assert!(!state.available_kinds().contains(&ShellKind::Cmd));
    }

    #[test]
    fn scan_merge_keeps_user_decisions() {
        let mut existing = profile("keep", ShellKind::Bash, HealthState::Ready);
        existing.enabled = false;
        existing.source = ProfileSource::Manual;
        existing.label = "My Bash".into();
        let state = registry_of(vec![existing]);

        let mut rescanned = profile("keep", ShellKind::Bash, HealthState::Degraded);
        rescanned.label = "Git Bash".into();
        rescanned.enabled = true;

        let merged = state.merged_with_scan(vec![rescanned]);
        let profile = merged.get("keep").expect("profile survives");
        assert!(
            !profile.enabled,
            "an explicit disable must survive a rescan"
        );
        assert_eq!(profile.label, "My Bash", "a manual label must survive");
        assert_eq!(
            profile.health.state,
            HealthState::Degraded,
            "health refreshes"
        );
    }

    #[test]
    fn scan_merge_drops_stale_scanned_profiles_but_keeps_manual_ones() {
        // The shape a broader earlier scan leaves behind: four pwsh installs.
        let mut older = Vec::new();
        for id in ["pwsh-a", "pwsh-b", "pwsh-c"] {
            let mut profile = profile(id, ShellKind::Pwsh, HealthState::Ready);
            profile.id = id.into();
            older.push(profile);
        }
        let mut manual = profile("mine", ShellKind::Bash, HealthState::Ready);
        manual.id = "mine".into();
        manual.source = ProfileSource::Manual;
        older.push(manual);
        let state = registry_of(older);

        let mut kept = profile("pwsh-a", ShellKind::Pwsh, HealthState::Ready);
        kept.id = "pwsh-a".into();
        let merged = state.merged_with_scan(vec![kept]);

        let ids: Vec<&str> = merged.profiles.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"pwsh-a"), "the scanned shell survives");
        assert!(ids.contains(&"mine"), "a manual entry is never displaced");
        assert!(!ids.contains(&"pwsh-b"), "stale duplicates are cleared");
        assert!(!ids.contains(&"pwsh-c"), "stale duplicates are cleared");
    }

    #[test]
    fn an_empty_scan_never_clears_the_registry() {
        // A scan that found nothing (no shells installed, or a probe failure)
        // must not wipe a working configuration.
        let state = registry_of(vec![profile("b", ShellKind::Bash, HealthState::Ready)]);
        let merged = state.merged_with_scan(Vec::new());
        assert_eq!(merged.profiles.len(), 1);
    }

    #[test]
    fn scan_merge_adds_new_profiles() {
        let state = registry_of(vec![profile("b", ShellKind::Bash, HealthState::Ready)]);
        // The scan still sees `b` and additionally finds `c` — both survive.
        //
        // The scan list has to include `b`: a scan-sourced profile the latest
        // scan no longer reports is treated as stale and pruned (the rule
        // `scan_merge_prunes_stale_duplicates` pins). Passing only `c` here
        // meant "bash is gone, cmd appeared", so expecting two profiles
        // contradicted that rule rather than testing this one.
        let merged = state.merged_with_scan(vec![
            profile("b", ShellKind::Bash, HealthState::Ready),
            profile("c", ShellKind::Cmd, HealthState::Ready),
        ]);
        let ids: Vec<&str> = merged.profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(merged.profiles.len(), 2, "{ids:?}");
        assert!(
            ids.contains(&"c"),
            "the newly found shell is added: {ids:?}"
        );
    }

    /// Disabling every shell must leave nothing selectable rather than falling
    /// back to one the user switched off.
    #[test]
    fn disabling_everything_leaves_no_fallback() {
        let mut only = profile("b", ShellKind::Bash, HealthState::Ready);
        only.enabled = false;
        let state = registry_of(vec![only]);
        assert!(state.default_profile().is_none());
        assert!(state.available_kinds().is_empty());
    }

    #[test]
    fn profile_ids_are_path_stable_and_case_insensitive() {
        assert_eq!(
            profile_id(Path::new(r"C:\Program Files\Git\bin\bash.exe")),
            profile_id(Path::new("c:/program files/git/bin/BASH.exe"))
        );
        assert_ne!(
            profile_id(Path::new(r"C:\Git\bin\bash.exe")),
            profile_id(Path::new(r"C:\Git\usr\bin\bash.exe"))
        );
    }

    #[test]
    fn related_kinds_bridge_the_two_powershells() {
        assert!(related_kinds(ShellKind::PowerShell).contains(&ShellKind::Pwsh));
        assert!(related_kinds(ShellKind::Pwsh).contains(&ShellKind::PowerShell));
    }
}
