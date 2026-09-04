//! Tauri commands backing Settings → Tools → Shell.
//!
//! Every command persists to the `shell_profiles` app setting **and**
//! refreshes the in-process registry ([`crate::shell::install`]), because
//! command execution resolves against that snapshot rather than the database.
//! Persist-then-install keeps the two from drifting when a write fails.

use std::sync::Mutex;

use tauri::State;

use crate::db::Database;
use crate::shell::{
    discovery, kinds::ShellKind, HealthState, ProfileSource, ShellHealth, ShellProfile,
    ShellProfiles, SETTINGS_KEY,
};

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

fn persist(db: &Database, state: &ShellProfiles) -> Result<(), String> {
    let encoded = serde_json::to_string(state)
        .map_err(|error| format!("Failed to encode shell profiles: {error}"))?;
    db.settings()
        .set_setting(SETTINGS_KEY, &encoded)
        .map_err(|error| format!("Failed to save shell profiles: {error:?}"))
}

fn commit(db: &Database, state: ShellProfiles) -> Result<ShellProfiles, String> {
    persist(db, &state)?;
    crate::shell::install(state.clone());
    Ok(state)
}

fn with_db<T>(
    db: &State<'_, Mutex<Database>>,
    action: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    let guard = db.lock().map_err(|error| error.to_string())?;
    action(&guard)
}

/// Everything the PTY terminal needs to open an interactive session.
///
/// The terminal used to build this itself, hardcoding
/// `C:\Program Files\Git\bin\bash.exe` and a bare `pwsh.exe`. That failed for
/// any user whose Git lived elsewhere — while Settings → Shells sat right there
/// listing the verified path it should have used. The registry is the single
/// source of truth for where shells are; this exposes it to the one consumer
/// that was still guessing.
///
/// `args` are the interactive flags only. The caller appends its own prompt
/// initialisation (a `-Command` string for PowerShell kinds, `PROMPT_COMMAND`
/// in `env` for POSIX ones) — that split is presentation, and it belongs to the
/// terminal, not here.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveShell {
    pub id: String,
    pub kind: ShellKind,
    pub label: String,
    pub exe: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// `true` for bash/sh/zsh, so the caller knows which prompt style to append
    /// without re-deriving it from `kind`.
    pub is_posix: bool,
}

/// Resolve a shell for an interactive PTY session.
///
/// `requested` takes a kind id (`"bash"`, `"pwsh"`) or a profile id; omit it for
/// the derived fallback. Returns `None` only when nothing usable is registered,
/// which the caller reports rather than silently substituting a guess.
#[tauri::command(async)]
pub fn shell_interactive_config(requested: Option<String>) -> Option<InteractiveShell> {
    let resolved = crate::shell::resolve_interactive(requested.as_deref())?;
    Some(InteractiveShell {
        id: resolved.profile_id,
        kind: resolved.kind,
        label: resolved.label,
        exe: resolved.exe,
        args: resolved.args,
        env: resolved.env,
        is_posix: resolved.kind.is_posix(),
    })
}

/// Current registry contents — from memory, not from the database.
///
/// The registry is loaded from the database ONCE at startup and re-installed
/// on every write (see the module note), so the in-process copy is already the
/// current answer. Reading it here means asking "which shells do I have" never
/// queues behind whatever else is using the database — a chat being saved, a
/// settings write, a usage-stats pass.
///
/// That queue is what froze the app. This is called every time the terminal's
/// shell picker opens, it used to be a plain `#[tauri::command]` (Tauri runs
/// those on the MAIN thread), and `db.lock()` blocks until the database is
/// free. Main thread waiting = no repaint, and the window's close button stops
/// working. `(async)` alone would have fixed the freeze; not touching the
/// database at all also makes it instant.
///
/// The database read stays as a fallback for the window that exists before the
/// startup load finishes, and is safe there precisely because of `(async)`.
#[tauri::command(async)]
pub fn shell_profiles_get(db: State<'_, Mutex<Database>>) -> Result<ShellProfiles, String> {
    let in_memory = crate::shell::snapshot();
    if !in_memory.profiles.is_empty() {
        return Ok(in_memory);
    }
    with_db(&db, |db| Ok(load(db)))
}

/// Re-scan the machine and merge the results.
///
/// Existing enable/disable choices, manual entries, and user labels survive;
/// only verification data is refreshed. See
/// [`ShellProfiles::merged_with_scan`].
#[tauri::command]
pub async fn shell_profiles_scan(db: State<'_, Mutex<Database>>) -> Result<ShellProfiles, String> {
    // Scanning launches processes, so it happens outside the database lock.
    let scanned = discovery::scan().await;
    with_db(&db, |db| {
        let merged = load(db).merged_with_scan(scanned);
        commit(db, merged)
    })
}

/// Register a shell by path.
///
/// The path is verified by running it before it is saved, so a typo or a
/// non-shell executable fails here with a reason instead of failing later
/// inside an agent turn.
#[tauri::command]
pub async fn shell_profiles_add(
    path: String,
    label: Option<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<ShellProfiles, String> {
    let raw = path.trim().trim_matches('"').to_string();
    if raw.is_empty() {
        return Err("Enter the full path to a shell executable.".into());
    }

    let expanded = crate::shell::env::expand_vars(&raw);
    let exe = discovery::resolve_executable(std::path::Path::new(&expanded))
        .ok_or_else(|| format!("No executable found at {expanded}"))?;

    let kind = ShellKind::from_exe(&exe).ok_or_else(|| {
        format!(
            "Aurora does not know how to run {}. Supported shells are bash, sh, zsh, pwsh, \
             powershell, and cmd.",
            exe.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| expanded.clone())
        )
    })?;

    let outcome = discovery::verify(kind, &exe).await;
    if outcome.health.state == HealthState::Failed {
        let detail = outcome
            .health
            .detail
            .unwrap_or_else(|| "it could not be started".into());
        return Err(format!("{} could not be verified: {detail}", exe.display()));
    }

    let profile = ShellProfile {
        id: crate::shell::profile_id(&exe),
        kind,
        label: label
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| kind.default_label().to_string()),
        // Store what the user typed: `%PROGRAMFILES%\Git\bin\bash.exe` keeps
        // resolving after an upgrade moves the target.
        path: raw,
        exe: exe.to_string_lossy().to_string(),
        enabled: true,
        preferred: false,
        source: ProfileSource::Manual,
        version: outcome.version,
        health: outcome.health,
        verified_at_ms: crate::shell::now_ms(),
    };

    with_db(&db, |db| {
        let mut state = load(db);
        match state
            .profiles
            .iter_mut()
            .find(|existing| existing.id == profile.id)
        {
            // Re-adding a known path updates it in place rather than
            // creating a second row for the same executable.
            Some(existing) => *existing = profile,
            None => state.profiles.push(profile),
        }
        commit(db, state)
    })
}

/// Remove a profile. Scanned profiles come back on the next scan; manual ones
/// do not, which is what makes removal meaningful.
#[tauri::command(async)]
pub fn shell_profiles_remove(
    id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<ShellProfiles, String> {
    with_db(&db, |db| {
        let mut state = load(db);
        state.profiles.retain(|profile| profile.id != id);
        commit(db, state)
    })
}

/// Enable or disable a profile for agent and terminal use.
#[tauri::command(async)]
pub fn shell_profiles_set_enabled(
    id: String,
    enabled: bool,
    db: State<'_, Mutex<Database>>,
) -> Result<ShellProfiles, String> {
    with_db(&db, |db| {
        let mut state = load(db);
        let profile = state
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| format!("No shell profile with id '{id}'"))?;
        profile.enabled = enabled;
        commit(db, state)
    })
}

// `shell_profiles_set_default` used to live here. It was removed with the
// user-chosen default: enabling and disabling is a question a user can answer
// ("do I have this shell, do I want Aurora using it"), whereas nominating a
// default asked them to predict which shell an unwritten command would need.
// The model now states the shell on every call, and everything else derives its
// fallback from `ShellProfiles::default_profile`.

/// Re-verify one profile without a full rescan — the "why is this degraded"
/// button after the user fixes an install.
#[tauri::command]
pub async fn shell_profiles_verify(
    id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<ShellProfiles, String> {
    let existing = with_db(&db, |db| {
        load(db)
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("No shell profile with id '{id}'"))
    })?;

    let expanded = crate::shell::env::expand_vars(&existing.path);
    let outcome = match discovery::resolve_executable(std::path::Path::new(&expanded)) {
        Some(exe) => discovery::verify(existing.kind, &exe).await,
        None => discovery::Verification {
            version: None,
            health: ShellHealth {
                state: HealthState::Failed,
                detail: Some(format!("no executable found at {expanded}")),
            },
        },
    };

    with_db(&db, |db| {
        let mut state = load(db);
        if let Some(profile) = state.profiles.iter_mut().find(|profile| profile.id == id) {
            profile.version = outcome.version.clone();
            profile.health = outcome.health.clone();
            profile.verified_at_ms = crate::shell::now_ms();
        }
        commit(db, state)
    })
}

/// The well-known command-line tools found on the PATH the agent's shells run
/// with, with where each resolved — the settings-page view of the
/// `<machine_tools>` block the agent receives. Re-scanned on every call: it is
/// a handful of directory listings, and a stale answer here would contradict
/// what the next conversation is told.
#[tauri::command]
pub async fn shell_tools_inventory() -> Vec<crate::shell::toolchain::FoundTool> {
    tokio::task::spawn_blocking(crate::shell::toolchain::inventory)
        .await
        .unwrap_or_default()
}

/// Load the registry at startup and, on a first run, scan so the agent has a
/// correctly configured shell before the user ever opens settings.
///
/// Runs off the startup path: scanning launches a process per candidate.
pub fn bootstrap(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let stored = {
            let Some(db) = app.try_state::<Mutex<Database>>() else {
                return;
            };
            let Ok(guard) = db.lock() else { return };
            load(&guard)
        };

        if !stored.profiles.is_empty() {
            crate::shell::install(stored);
            return;
        }

        let scanned = discovery::scan().await;
        let merged = ShellProfiles::default().merged_with_scan(scanned);

        let Some(db) = app.try_state::<Mutex<Database>>() else {
            return;
        };
        let Ok(guard) = db.lock() else { return };
        // Best effort: a failed write still leaves a working in-memory
        // registry for this session.
        let _ = persist(&guard, &merged);
        crate::shell::install(merged);
    });
}
