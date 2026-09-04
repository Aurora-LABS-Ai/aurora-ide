//! Single source of truth for every filesystem location Aurora owns.
//!
//! Everything the IDE persists at runtime — SQLite DB, checkpoint git
//! shadows, agent session JSONLs, MCP config, semantic cache, logs —
//! lives under one root:
//!
//!   Windows: %LOCALAPPDATA%\AuroraIDE\
//!   macOS:   ~/Library/Application Support/AuroraIDE/
//!   Linux:   ~/.local/share/AuroraIDE/
//!
//! Subfolders are created lazily by the accessor that needs them, so a
//! brand-new install lands with only the dirs it actually touches.
//!
//! There is no migration from older locations on purpose — this is the
//! pre-1.0 single-developer phase. Once shipped to users, the layout
//! is frozen.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Root folder name under the platform's local-app-data root.
const ROOT_NAME: &str = "AuroraIDE";

/// Cache the resolved root so we only log it once per process and so
/// repeated lookups don't hit `dirs::*` over and over.
static RESOLVED_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the single AuroraIDE root, creating it if missing.
///
/// Hard-errors when the OS doesn't expose any of local-app-data /
/// data / home — silently dropping the DB into CWD would lead to
/// per-run state loss the user would only discover after losing a
/// session, which is far worse than a clear startup panic.
pub fn root() -> PathBuf {
    if let Some(cached) = RESOLVED_ROOT.get() {
        return cached.clone();
    }
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| {
            panic!(
                "AuroraIDE: cannot resolve a writable application directory \
                 (data_local_dir / data_dir / home_dir all returned None). \
                 The IDE refuses to fall back to the current working directory \
                 because that would lose all persisted state on every relaunch."
            )
        });
    let root = base.join(ROOT_NAME);
    ensure(&root);
    // Printed once per process, for the app's own logs — it is the answer to
    // "where did my data go", and it has earned its place there.
    //
    // Silenced for the `aurora` CLI, which resolves this on the way to
    // answering something else entirely. A command whose job is to print a
    // table of models should print a table of models; a diagnostic line above
    // it is noise the user did not ask for and, on stderr, noise a script has
    // to filter. `AURORA_QUIET_PATHS` is set by the CLI entry point before
    // anything touches this.
    if std::env::var_os("AURORA_QUIET_PATHS").is_none() {
        eprintln!("[paths] AuroraIDE root resolved to {}", root.display());
    }
    let _ = RESOLVED_ROOT.set(root.clone());
    root
}

/// `<root>/data/` — SQLite database + WAL/SHM sidecars.
pub fn data_dir() -> PathBuf {
    ensure_subdir("data")
}

/// `<root>/data/aurora.db`.
pub fn db_file() -> PathBuf {
    data_dir().join("aurora.db")
}

/// `<root>/checkpoints/` — git shadow repos, one per workspace hash.
pub fn checkpoints_dir() -> PathBuf {
    ensure_subdir("checkpoints")
}

/// `<root>/sessions/` — agent_v2 session JSONL + meta sidecars.
pub fn sessions_dir() -> PathBuf {
    ensure_subdir("sessions")
}

/// `<root>/Chats/` — Aurora Chat conversations, one FOLDER each.
///
/// Deliberately not `sessions/`, and deliberately not the same layout. A chat
/// owns images, so it owns a directory:
///
/// ```text
/// Chats/
///   chats.db                  <- derived FTS5 index, rebuildable from the folders
///   <conversation-id>/
///     conversation.jsonl      <- canonical history
///     meta.json
///     rich.jsonl
///     artifacts.json
///     assets/                 <- this conversation's images
/// ```
///
/// The folders are the truth and `chats.db` is an index built from them, so a
/// corrupt or deleted database costs a rebuild rather than history. Deleting a
/// conversation is deleting one directory, which is the whole reason the layout
/// differs from `sessions/`'s flat files plus stem-matched sidecars.
pub fn chats_dir() -> PathBuf {
    ensure_subdir("Chats")
}

/// `<root>/cli-tasks/` — the hand-off point between an `aurora agent` command
/// typed in a terminal and the running Aurora that executes it.
///
/// Two files per dispatch, both named by the task id:
///
/// - `<id>.task.json` — what the terminal asked for. The CLI writes it and
///   exits; the running app claims it.
/// - `<id>.jsonl` — what happened, one JSON object per line, appended live.
///   This is the file `--out` names and `--follow` tails.
///
/// A directory rather than a socket because the command has to work when
/// Aurora is NOT yet running: the request waits on disk until the app starts
/// and sweeps the folder, so `aurora agent` never fails just for being early.
/// It is also why the transcript is a file in the first place — a caller
/// (another agent, a CI step, a second terminal) can read the run as it
/// happens without holding a connection open.
///
/// Not under `cache/`: a dispatched task is a user's instruction and its
/// transcript is the record of what was done with it. Deleting this folder
/// loses work, so it does not live where "safe to delete" is the contract.
pub fn cli_tasks_dir() -> PathBuf {
    ensure_subdir("cli-tasks")
}

/// `<root>/bridge.json` — what the running app publishes about itself for
/// another process to read: whether the Agent Window is open, whether the user
/// has allowed outside agents to drive it, and what it is working on.
///
/// A single file at the root rather than a directory, because there is exactly
/// one of these per machine and it is rewritten whole every time.
///
/// Read by `aurora mcp` (see `cli_delegate::mcp`) to decide whether a tool call
/// can be carried out. Deliberately NOT read by `aurora agent`: a dispatched
/// task waits on disk for an Aurora that does not exist yet, and gating it on a
/// window would break the one property that makes the CLI usable from a cold
/// terminal.
///
/// The file is only ever a *hint*. It can outlive the process that wrote it —
/// a crash leaves it claiming a window that is gone — so every reader pairs it
/// with `cli_delegate::presence`, which the OS invalidates on process death.
pub fn bridge_state_file() -> PathBuf {
    root().join("bridge.json")
}

/// `<root>/code-index/` — one cached symbol index per workspace, named by the
/// same workspace hash `checkpoints_dir` uses, plus a `.meta.json` sidecar.
/// Disposable: deleting it costs a sub-second rebuild, never user data.
pub fn code_index_dir() -> PathBuf {
    ensure_subdir("code-index")
}

/// `<root>/config/` — user-facing JSON config files (e.g. mcp.json).
pub fn config_dir() -> PathBuf {
    ensure_subdir("config")
}

/// `<root>/limits/` — what Aurora has LEARNED about an endpoint rather than
/// been told, currently `context-limits.json` (see
/// `agent_runtime::context_limits`).
///
/// Deliberately not `config/` (nobody authors this) and not `cache/` (it is
/// not derivable from anything on disk — it is only relearned by having a
/// request refused, which costs a real round-trip).
pub fn limits_dir() -> PathBuf {
    ensure_subdir("limits")
}

/// `<root>/typing-assist/` — bundled frequency dictionaries (copied here on
/// first activation) + the personal `lexicon.json` learned from what you type.
pub fn typing_assist_dir() -> PathBuf {
    ensure_subdir("typing-assist")
}

/// `<root>/auth/` — machine-managed provider credentials Aurora rotates
/// itself (currently `cursor-auth.json`).
///
/// Deliberately not `config/` (nobody hand-authors these, and inviting an
/// editor into a file holding bearer tokens is how they end up in a paste),
/// and not `cache/` (losing it costs a re-sign-in, not a rebuild). Providers
/// whose credentials live in *another* tool's file — Codex, whose source of
/// truth is `~/.codex/auth.json` — do not use this directory at all.
pub fn auth_dir() -> PathBuf {
    ensure_subdir("auth")
}

/// `~/.aurora/mcp.json` — user-facing, human-editable MCP server config in the
/// Cursor/Claude format (keyed by server name). Lives in the home `.aurora`
/// dir (beside the team brain) so it is portable and user-inspectable rather
/// than buried in platform app-data with internal ids.
pub fn mcp_config_file() -> PathBuf {
    aurora_home_dir().join("mcp.json")
}

/// Legacy MCP config location (`<root>/config/mcp.json`). Kept only so the
/// loader can perform a one-time migration of an existing install to the new
/// home-dir, name-keyed file.
pub fn legacy_mcp_config_file() -> PathBuf {
    config_dir().join("mcp.json")
}

/// `<root>/cache/` — derived/regeneratable data (semantic indexes, etc).
///
/// Its only caller today is [`agent_images_dir`], which resolves to scratch
/// space under `cfg(test)` — so a test build genuinely reaches this through
/// nothing, and the dead-code warning is right about the build it fires in and
/// wrong about the product.
#[cfg_attr(test, allow(dead_code))]
pub fn cache_dir() -> PathBuf {
    ensure_subdir("cache")
}

/// `<root>/cache/agent-images/` — downscaled copies of images the agent opened
/// with `file_read`, kept so a thread can re-show one without re-encoding.
///
/// Under `cache/` because every file here is regeneratable from the original on
/// disk: deleting the folder costs a re-encode, never a picture.
///
/// Under `cargo test` this resolves to scratch space instead. The whole crate
/// compiles with `cfg(test)` there, so a tool exercised through its real entry
/// point — which cannot be handed a directory — still keeps its encodes out of
/// the user's app data. A test that leaves files in the folder it is testing is
/// how a picture nobody asked for ends up in somebody's cache.
pub fn agent_images_dir() -> PathBuf {
    #[cfg(test)]
    let dir = std::env::temp_dir().join("aurora-agent-images-tests");
    #[cfg(not(test))]
    let dir = cache_dir().join("agent-images");
    ensure(&dir);
    dir
}

/// `~/.aurora/` — the **Agent Team shared brain** root.
///
/// Intentionally NOT under the AuroraIDE app-data root resolved by
/// [`root`]. The team workspace mirrors the `.claude` memory-dir idea
/// (ground truth §5/§6): it lives in the user's home so it is portable,
/// user-inspectable, and project-scoped rather than buried in
/// platform-specific app data. Created lazily.
///
/// Falls back to the app-data root when the OS exposes no home dir, so
/// resolution never panics — the brain just lands beside the rest of
/// Aurora's state in that degenerate case.
pub fn aurora_home_dir() -> PathBuf {
    let base = dirs::home_dir().unwrap_or_else(root);
    let dir = base.join(".aurora");
    ensure(&dir);
    dir
}

/// `~/.aurora/projects/` — one subfolder per opened project's team brain.
pub fn team_projects_dir() -> PathBuf {
    let dir = aurora_home_dir().join("projects");
    ensure(&dir);
    dir
}

/// `<root>/logs/` — home of the rotating `aurora.log` written by [`crate::logging`].
pub fn logs_dir() -> PathBuf {
    ensure_subdir("logs")
}

/// `<root>/reports/` — faults the agent reported via `report_aurora_issue`.
///
/// Deliberately under Aurora's own root and not in the open workspace: these
/// describe Aurora, not the user's project, and a file written into whatever
/// repository happened to be open gets committed by accident.
pub fn reports_dir() -> PathBuf {
    ensure_subdir("reports")
}

fn ensure_subdir(name: &str) -> PathBuf {
    let dir = root().join(name);
    ensure(&dir);
    dir
}

fn ensure(p: &Path) {
    let _ = std::fs::create_dir_all(p);
}
