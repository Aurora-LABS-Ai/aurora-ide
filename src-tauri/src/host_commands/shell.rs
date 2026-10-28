//! Shell commands and Settings → Tools → Shell: running a command (whole or
//! streamed), stopping or detaching a stream, the background process list,
//! and the shell profiles. The window's commands (`commands/mod.rs`,
//! `commands/shell_profiles.rs`) are wrappers over these.
//!
//! Every profile change persists to the `shell_profiles` app setting **and**
//! refreshes the in-process registry ([`crate::shell::install`]), because
//! command execution resolves against that snapshot rather than the database.
//! Persist-then-install keeps the two from drifting when a write fails.

use std::sync::Arc;

use serde_json::Value;

use super::{arg, done, run_db, CommandContext, CommandError};
use crate::db::{Database, DatabaseAccess};
use crate::process::streams;
use crate::shell::stored::{load, persist};
use crate::shell::{
    discovery, kinds::ShellKind, HealthState, ProfileSource, ShellHealth, ShellProfile,
    ShellProfiles,
};

pub const COMMANDS: &[&str] = &[
    "execute_command",
    "execute_command_stream",
    "cancel_command_stream",
    "detach_command_stream",
    "shell_background_processes",
    "shell_profiles_get",
    "shell_profiles_scan",
    "shell_profiles_add",
    "shell_profiles_remove",
    "shell_profiles_set_enabled",
    "shell_profiles_verify",
    "shell_tools_inventory",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    Some(match name {
        "execute_command" => {
            let command: String = get!("command");
            let cwd: Option<String> = get!("cwd");
            let shell: Option<String> = get!("shell");
            let timeout_ms: Option<u64> = get!("timeoutMs");
            done(streams::execute_command(command, cwd, shell, timeout_ms).await)
        }
        "execute_command_stream" => {
            let request_id: String = get!("requestId");
            let command: String = get!("command");
            let cwd: Option<String> = get!("cwd");
            let shell: Option<String> = get!("shell");
            let timeout_ms: Option<u64> = get!("timeoutMs");
            let log_path: Option<String> = get!("logPath");
            let keep_stdin_open: Option<bool> = get!("keepStdinOpen");
            done(
                streams::execute_command_stream(
                    ctx.events.clone(),
                    request_id,
                    command,
                    cwd,
                    shell,
                    timeout_ms,
                    log_path,
                    keep_stdin_open,
                )
                .await,
            )
        }
        "cancel_command_stream" => {
            let request_id: String = get!("requestId");
            let reason: Option<String> = get!("reason");
            done(streams::cancel_command_stream(request_id, reason))
        }
        "detach_command_stream" => done(streams::detach_command_stream(get!("requestId"))),
        "shell_background_processes" => done(Ok(streams::shell_background_processes())),
        "shell_profiles_get" => done(profiles_get(ctx.db.clone()).await),
        "shell_profiles_scan" => done(profiles_scan(ctx.db.clone()).await),
        "shell_profiles_add" => {
            let path: String = get!("path");
            let label: Option<String> = get!("label");
            done(profiles_add(ctx.db.clone(), path, label).await)
        }
        "shell_profiles_remove" => done(profiles_remove(ctx.db.clone(), get!("id")).await),
        "shell_profiles_set_enabled" => {
            let id: String = get!("id");
            let enabled: bool = get!("enabled");
            done(profiles_set_enabled(ctx.db.clone(), id, enabled).await)
        }
        "shell_profiles_verify" => done(profiles_verify(ctx.db.clone(), get!("id")).await),
        "shell_tools_inventory" => done(Ok(tools_inventory().await)),
        _ => return None,
    })
}

fn commit(db: &Database, state: ShellProfiles) -> Result<ShellProfiles, String> {
    persist(db, &state)?;
    crate::shell::install(state.clone());
    Ok(state)
}

/// Current registry contents — from memory, not from the database.
///
/// The registry is loaded from the database ONCE at startup and re-installed
/// on every write (see the module note), so the in-process copy is already the
/// current answer. Reading it here means asking "which shells do I have" never
/// queues behind whatever else is using the database — a chat being saved, a
/// settings write, a usage-stats pass.
///
/// That queue is what froze the app once: this is called every time the
/// terminal's shell picker opens, and it used to wait on the database lock on
/// the window's main thread.
///
/// The database read stays as a fallback for the window that exists before the
/// startup load finishes.
pub async fn profiles_get(db: Arc<dyn DatabaseAccess>) -> Result<ShellProfiles, String> {
    let in_memory = crate::shell::snapshot();
    if !in_memory.profiles.is_empty() {
        return Ok(in_memory);
    }
    run_db(db, |db| Ok(load(db))).await
}

/// Re-scan the machine and merge the results.
///
/// Existing enable/disable choices, manual entries, and user labels survive;
/// only verification data is refreshed. See
/// [`ShellProfiles::merged_with_scan`].
pub async fn profiles_scan(db: Arc<dyn DatabaseAccess>) -> Result<ShellProfiles, String> {
    // Scanning launches processes, so it happens outside the database lock.
    let scanned = discovery::scan().await;
    run_db(db, |db| {
        let merged = load(db).merged_with_scan(scanned);
        commit(db, merged)
    })
    .await
}

/// Register a shell by path.
///
/// The path is verified by running it before it is saved, so a typo or a
/// non-shell executable fails here with a reason instead of failing later
/// inside an agent turn.
pub async fn profiles_add(
    db: Arc<dyn DatabaseAccess>,
    path: String,
    label: Option<String>,
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

    run_db(db, move |db| {
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
    .await
}

/// Remove a profile. Scanned profiles come back on the next scan; manual ones
/// do not, which is what makes removal meaningful.
pub async fn profiles_remove(db: Arc<dyn DatabaseAccess>, id: String) -> Result<ShellProfiles, String> {
    run_db(db, move |db| {
        let mut state = load(db);
        state.profiles.retain(|profile| profile.id != id);
        commit(db, state)
    })
    .await
}

/// Enable or disable a profile for agent and terminal use.
pub async fn profiles_set_enabled(
    db: Arc<dyn DatabaseAccess>,
    id: String,
    enabled: bool,
) -> Result<ShellProfiles, String> {
    run_db(db, move |db| {
        let mut state = load(db);
        let profile = state
            .profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| format!("No shell profile with id '{id}'"))?;
        profile.enabled = enabled;
        commit(db, state)
    })
    .await
}

/// Re-verify one profile without a full rescan — the "why is this degraded"
/// button after the user fixes an install.
pub async fn profiles_verify(db: Arc<dyn DatabaseAccess>, id: String) -> Result<ShellProfiles, String> {
    let lookup = id.clone();
    let existing = run_db(db.clone(), move |db| {
        load(db)
            .get(&lookup)
            .cloned()
            .ok_or_else(|| format!("No shell profile with id '{lookup}'"))
    })
    .await?;

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

    run_db(db, move |db| {
        let mut state = load(db);
        if let Some(profile) = state.profiles.iter_mut().find(|profile| profile.id == id) {
            profile.version = outcome.version.clone();
            profile.health = outcome.health.clone();
            profile.verified_at_ms = crate::shell::now_ms();
        }
        commit(db, state)
    })
    .await
}

/// The well-known command-line tools found on the PATH the agent's shells run
/// with, with where each resolved — the settings-page view of the
/// `<machine_tools>` block the agent receives. Re-scanned on every call: it is
/// a handful of directory listings, and a stale answer here would contradict
/// what the next conversation is told.
pub async fn tools_inventory() -> Vec<crate::shell::toolchain::FoundTool> {
    tokio::task::spawn_blocking(crate::shell::toolchain::inventory)
        .await
        .unwrap_or_default()
}
