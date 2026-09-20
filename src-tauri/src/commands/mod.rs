use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

// Windows-specific imports for hiding console window
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Windows creation flags
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

use notify::{recommended_watcher, Config, Event, EventKind, RecursiveMode, Watcher};
use tauri::Emitter;

use parking_lot::RwLock;
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;

pub mod agent_v2;
pub mod agent_v2_permissions;
pub mod ark;
pub mod artifacts;
pub mod browser;
pub mod chat;
/// The Memory page — reading and editing what Aurora remembers about the user.
pub mod chat_memory;
pub mod chat_gallery;
pub mod chat_video;
pub mod image_direct;
pub mod image_providers;
pub mod checkpoints;
pub mod claude_code;
pub mod code_index;
pub mod codex;
pub mod commandcode;
/// Test-only: fails the build if a main-thread command waits on the database.
#[cfg(test)]
mod command_thread_safety;
pub mod cursor;
pub mod deepseek;
pub mod diagnostics;
pub mod editor_ops;
pub mod fonts;
pub mod git;
pub mod icon_themes;
pub mod kenari;
pub mod local_providers;
pub mod minimax;
pub mod modal;
pub mod opencode;
pub mod plans;
pub mod process_tracking;
pub mod conversation_stats;
pub mod project_stats;
pub mod prompt_refine;
pub mod provider_catalog;
pub mod provider_kernel;
pub mod provider_models;
pub mod provider_test;
pub mod settings;
pub mod shell_profiles;
pub mod speech;
pub mod speech_stream;
pub mod state;
pub mod team;
pub mod terminal;
pub mod themes;
pub mod threads;
pub mod title_maker;
pub mod todos;
pub mod tokens;
pub mod typing_assist;
pub mod undo_redo;
pub mod usage_stats;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub extension: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    /// The process was killed for exceeding its timeout rather than finishing
    /// on its own.
    ///
    /// `execute_command_stream` keeps whatever the process printed before the
    /// kill and used to return it as `exit_code: 1, success: false`, which is
    /// indistinguishable from a real exit-1 failure. Defaulted for
    /// `Deserialize` so payloads written before this field existed still load.
    #[serde(default)]
    pub timed_out: bool,
    /// The command exited, but a process it started is still alive and holding
    /// the output pipe open.
    ///
    /// Children inherit the shell's stdout/stderr handles, so a command like
    /// `Start-Process server.exe` or `server &` leaves the pipe open after the
    /// shell itself is gone. Waiting for that pipe to close is waiting for the
    /// survivor to die — which for a server is never, and is exactly how a
    /// finished command used to hold its tool call (and the model) forever.
    /// Defaulted for `Deserialize`, same reasoning as `timed_out`.
    #[serde(default)]
    pub left_running: bool,
    /// The survivors by name, `"notepad.exe (pid 1234)"`, when the process
    /// table could identify them. A held pipe proves a survivor exists without
    /// naming it, so `left_running` can be true while this is empty — but
    /// never the other way around.
    #[serde(default)]
    pub survivors: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepSearchRequest {
    pub case_insensitive: Option<bool>,
    pub context_lines: Option<u32>,
    pub glob: Option<String>,
    pub is_regex: Option<bool>,
    pub max_results: Option<u32>,
    pub output_mode: Option<String>,
    pub path: String,
    pub pattern: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepMatch {
    pub after_context: Option<Vec<String>>,
    pub before_context: Option<Vec<String>>,
    pub content: String,
    pub file: String,
    pub line_number: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepFileCount {
    pub count: usize,
    pub file: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipgrepSearchResponse {
    pub counts: Option<Vec<RipgrepFileCount>>,
    pub error: Option<String>,
    pub files: Option<Vec<String>>,
    pub matches: Option<Vec<RipgrepMatch>>,
    /// Plain-language note about the result set — what was capped, and the way
    /// out. Present on truncation and on an empty result; absent otherwise.
    pub message: Option<String>,
    pub pattern: String,
    /// How many items the response actually carries, in the unit `max_results`
    /// capped (matches for `content`, files for the other two modes).
    pub returned: Option<usize>,
    pub success: bool,
    pub tool: String,
    /// Total files with matches. Present only when the search ran to completion
    /// — a truncated search stops just past the cap and never counted them.
    pub total_files: Option<usize>,
    /// Total matches found. Present only when the search ran to completion; see
    /// `total_files`. Use `returned` for how much this response carries.
    pub total_matches: Option<usize>,
    pub truncated: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandStreamChunk {
    pub stream: String,
    pub data: String,
    pub done: bool,
    pub exit_code: Option<i32>,
    pub success: Option<bool>,
}

const DEFAULT_RG_TIMEOUT_MS: u64 = 30_000;
const MAX_RG_TIMEOUT_MS: u64 = 300_000;
const MIN_RG_TIMEOUT_MS: u64 = 1_000;

/// Who ended a running process.
///
/// The distinction reaches the log file, and it is the difference between the
/// agent reading "the user pulled the plug" and "my own `shell_kill` landed".
/// Without it a reader has to guess, and guessing about a process it started
/// is exactly how an agent invents a story about what happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    /// The person clicked stop on the background card.
    User,
    /// The agent called `shell_kill`.
    Agent,
}

impl StopReason {
    /// How the footer names it, written in the log for a later reader.
    fn describe(self) -> &'static str {
        match self {
            Self::User => "Stopped by the user",
            Self::Agent => "Stopped by the agent (shell_kill)",
        }
    }

    fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("agent") => Self::Agent,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStreamInfo {
    pub process_id: String,
    pub request_id: String,
    pub name: Option<String>,
    pub command: String,
    pub cwd: Option<String>,
    pub pid: Option<u32>,
    pub cancelled: bool,
    /// Set alongside `cancelled` so the streaming loop can name the ending in
    /// the log rather than just noticing that it was told to stop.
    pub stop_reason: Option<StopReason>,
    pub started_at_ms: u64,
    /// File the process's combined output is being written to, when one was
    /// requested. This is the only way the model can read what a background
    /// process printed — the live stream goes to the UI, not into the
    /// conversation.
    pub log_path: Option<String>,
    /// The user pressed "Run in background" on a foreground command: the tool
    /// call returns now, the process keeps running.
    ///
    /// Deliberately NOT a second flavour of `cancelled`. Cancelling kills the
    /// child and ends the stream; detaching changes only who is waiting — the
    /// loop below keeps draining the pipes, keeps mirroring into the log, and
    /// still announces the real ending on `shell-process-ended`. A detached
    /// command also loses its timeout, because the deadline existed to protect
    /// a caller that is no longer there.
    pub detached: bool,
}

lazy_static::lazy_static! {
    static ref ACTIVE_COMMAND_STREAMS: RwLock<HashMap<String, CommandStreamInfo>> =
        RwLock::new(HashMap::new());
}

pub fn register_command_stream(
    request_id: String,
    process_id: String,
    name: Option<String>,
    command: String,
    cwd: Option<String>,
    log_path: Option<String>,
) {
    let started_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let mut streams = ACTIVE_COMMAND_STREAMS.write();
    streams
        .entry(request_id.clone())
        .and_modify(|stream| {
            stream.process_id = process_id.clone();
            stream.name = name.clone().or_else(|| stream.name.clone());
            stream.command = command.clone();
            stream.cwd = cwd.clone();
            stream.log_path = log_path.clone().or_else(|| stream.log_path.clone());
        })
        .or_insert(CommandStreamInfo {
            process_id,
            request_id,
            name,
            command,
            cwd,
            pid: None,
            cancelled: false,
            stop_reason: None,
            started_at_ms,
            log_path,
            detached: false,
        });
}

#[must_use]
pub fn list_command_streams() -> Vec<CommandStreamInfo> {
    let mut streams: Vec<_> = ACTIVE_COMMAND_STREAMS.read().values().cloned().collect();
    streams.sort_by_key(|stream| stream.started_at_ms);
    streams
}

/// One live background process, as the Agent Window's dock needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcessRow {
    pub process_id: String,
    pub request_id: String,
    pub name: Option<String>,
    pub command: String,
    pub cwd: Option<String>,
    pub pid: Option<u32>,
    pub started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
}

/// The live process ledger, for the UI.
///
/// This registry is the single source of truth for what is actually running —
/// it is process-global and knows nothing about chats or projects. Until now
/// only the MODEL could read it (via `shell_list_processes`); the dock kept its
/// own shadow copy, built from `shell_spawn` tool results and keyed by thread.
///
/// That shadow copy is how a running process became unreachable: switch project,
/// and the dock looks up a different thread key and finds nothing, while the
/// process keeps running with no button to stop it. Reload the window and the
/// whole copy is gone. Reading the ledger directly means the dock can never
/// disagree with reality about what is running.
///
/// Cancelled entries are omitted — they are on their way out, and a stop button
/// for a process already stopping is a lie.
#[tauri::command]
pub fn shell_background_processes() -> Vec<BackgroundProcessRow> {
    list_command_streams()
        .into_iter()
        .filter(|stream| !stream.cancelled)
        // Every foreground `shell_execute` is in this ledger too — that is how
        // it gets a stop button and a live stream. It is not a BACKGROUND
        // process, though, and listing it as one put the command the agent is
        // currently waiting on into a panel titled "Background processes".
        //
        // Two things earn a place here, and both are deliberate acts: a
        // `shell_spawn` (which is required to carry a name) and a foreground
        // command someone pressed "Run in background" on.
        .filter(|stream| stream.detached || stream.name.is_some())
        .map(|stream| BackgroundProcessRow {
            process_id: stream.process_id,
            request_id: stream.request_id,
            name: stream.name,
            command: stream.command,
            cwd: stream.cwd,
            pid: stream.pid,
            started_at_ms: stream.started_at_ms,
            output_file: stream.log_path,
        })
        .collect()
}

fn command_stream_key(identifier: &str) -> Option<String> {
    let streams = ACTIVE_COMMAND_STREAMS.read();
    if streams.contains_key(identifier) {
        return Some(identifier.to_string());
    }
    streams
        .iter()
        .filter(|(_, stream)| {
            stream.process_id == identifier
                || stream.name.as_deref() == Some(identifier)
                || stream.pid.map(|pid| pid.to_string()).as_deref() == Some(identifier)
        })
        .max_by_key(|(_, stream)| stream.started_at_ms)
        .map(|(request_id, _)| request_id.clone())
}

pub fn cancel_tracked_command_stream(
    identifier: &str,
    reason: StopReason,
) -> Result<CommandStreamInfo, String> {
    let request_id = command_stream_key(identifier).ok_or_else(|| {
        format!(
            "No running background process matches '{identifier}'. List processes and retry with a current process ID."
        )
    })?;
    let stream = {
        let mut streams = ACTIVE_COMMAND_STREAMS.write();
        let stream = streams.get_mut(&request_id).ok_or_else(|| {
            format!("Background process '{identifier}' finished before it could be stopped.")
        })?;
        stream.cancelled = true;
        // First writer wins: if the agent's shell_kill and the user's stop
        // button race, the reason recorded is the one that actually ended it.
        stream.stop_reason.get_or_insert(reason);
        stream.clone()
    };
    if let Some(pid) = stream.pid {
        try_kill_pid(pid)?;
    }
    Ok(stream)
}

/// Hand a running foreground command over to the background.
///
/// Nothing is killed and nothing is cleaned up: the ledger row stays (so the
/// dock can show it and `shell_kill` can still stop it), the streaming loop
/// keeps draining and logging, and the ending is still announced. The only
/// thing that changes is that whoever was awaiting the result stops waiting.
///
/// Idempotent — pressing the button twice, or pressing it as the command
/// finishes, is not an error worth showing anyone.
pub fn detach_tracked_command_stream(identifier: &str) -> Result<CommandStreamInfo, String> {
    let request_id = command_stream_key(identifier).ok_or_else(|| {
        format!("No running command matches '{identifier}'. It may have already finished.")
    })?;
    let mut streams = ACTIVE_COMMAND_STREAMS.write();
    let stream = streams
        .get_mut(&request_id)
        .ok_or_else(|| format!("Command '{identifier}' finished before it could be detached."))?;
    // A command already on its way out is not a candidate: promising the caller
    // it is "still running in the background" would be the same lie
    // `browser_navigate` used to tell (lesson.md, 2026-08-21).
    if stream.cancelled {
        return Err(format!("Command '{identifier}' is already stopping."));
    }
    stream.detached = true;
    Ok(stream.clone())
}

/// Has this run been handed over to the background?
fn command_stream_detached(request_id: &str) -> bool {
    ACTIVE_COMMAND_STREAMS
        .read()
        .get(request_id)
        .is_some_and(|stream| stream.detached)
}

/// How often the waiting side asks whether the button was pressed.
///
/// Polled rather than signalled because that is how the streaming loop already
/// watches for a stop, and one wake-up every fifth of a second costs nothing
/// next to a process that is printing. The delay a person can perceive here is
/// the card settling, and 200ms is under that.
const DETACH_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

/// Resolves when `request_id` is handed to the background — never otherwise.
///
/// Meant to be raced against the run's own completion, so it deliberately has
/// no timeout of its own: a command nobody detaches ends by finishing.
pub async fn detached_mid_run(request_id: &str) {
    loop {
        if command_stream_detached(request_id) {
            return;
        }
        tokio::time::sleep(DETACH_POLL_INTERVAL).await;
    }
}

/// Tail of a process log, for the "here is what it printed before you sent it
/// to the background" half of a detached result.
///
/// Reads the tail rather than the head: the useful end of a long-running
/// command's output is the newest part, which is the same choice every shell
/// view in the window already makes. A log that cannot be read yields an empty
/// string — the result says what happened either way, and inventing an error
/// about a convenience copy would bury that.
#[must_use]
pub fn read_process_log_tail(path: Option<&str>) -> String {
    const MAX_TAIL_BYTES: usize = 32 * 1024;
    let Some(path) = path else {
        return String::new();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    if bytes.len() <= MAX_TAIL_BYTES {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    // Cut on a character boundary: a tail sliced mid-sequence renders as a
    // replacement glyph at the top of every detached result.
    let mut start = bytes.len() - MAX_TAIL_BYTES;
    while start < bytes.len() && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
        start += 1;
    }
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

/// Why the streaming loop should stop, if it should — `None` while running.
fn command_stream_stop(request_id: &str) -> Option<StopReason> {
    let streams = ACTIVE_COMMAND_STREAMS.read();
    let stream = streams.get(request_id)?;
    if !stream.cancelled {
        return None;
    }
    Some(stream.stop_reason.unwrap_or(StopReason::User))
}

fn cleanup_command_stream(request_id: &str) {
    let mut streams = ACTIVE_COMMAND_STREAMS.write();
    streams.remove(request_id);
}

/// Is this pid still a running process?
///
/// The question `taskkill`'s exit code cannot answer. Asked immediately after
/// a kill, so pid reuse is not a practical concern.
#[cfg(target_os = "windows")]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: `OpenProcess` takes no pointers; the handle it returns is closed
    // on every path below, and `GetExitCodeProcess` writes to a local we own.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // No such process, or one we may not even ask about. Either way it
            // is not something this kill left running.
            return false;
        }
        let mut code: u32 = 0;
        let queried = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        // A process that has exited reports its real exit code; only a live one
        // reports STILL_ACTIVE. If the query itself failed, say "gone" rather
        // than report a failure we cannot substantiate.
        queried != 0 && code == STILL_ACTIVE as u32
    }
}

/// Kill a pid and its whole tree. Shared with `commands::terminal`, which
/// needs the same reap when a terminal tab is closed.
pub(crate) fn try_kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd
            .output()
            .map_err(|error| format!("failed to start taskkill for pid {pid}: {error}"))?;
        if output.status.success() {
            return Ok(());
        }

        // `taskkill /T` walks the whole tree and exits non-zero if ANY member
        // of it resisted — including members that are not ours to kill and
        // members that had already exited, whose slot a system process now
        // holds. So its exit code answers "was the sweep perfect", and the
        // only question worth asking is "is the process I named gone".
        //
        // Measured on thread `c4669acf` (2026-09-05), killing a `go run`
        // spawn — which wraps the real server binary as a child:
        //
        // ```text
        // taskkill could not stop pid 26488: ERROR: The process with PID 35888
        // (child process of PID 1196) could not be terminated.
        // Reason: The operation attempted is not supported.
        // ```
        //
        // …repeated for about ten pids, reported as an outright failure. The
        // agent then had no way to tell a dead server from a live one and let
        // a ten-minute timeout reap it instead.
        if !process_is_alive(pid) {
            return Ok(());
        }

        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = if detail.trim().is_empty() {
            String::from_utf8_lossy(&output.stdout)
        } else {
            detail
        };
        Err(format!(
            "taskkill could not stop pid {pid}, and it is still running: {}",
            detail.trim()
        ))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .map_err(|error| format!("failed to start kill for pid {pid}: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "kill could not stop pid {pid}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

/// Locate a Git Bash executable on Windows.
///
/// Used so the agent's shell tools can default to a POSIX/bash environment
/// (matching how the model "thinks" — `ls`, `&&`, `rm -rf`, single-quote
/// quoting — and matching the bash-oriented safety validator) instead of
/// fighting PowerShell. Returns the first candidate that exists, or `None`
/// when Git Bash isn't installed (callers then fall back to PowerShell).
///
/// On non-Windows the platform shell is already POSIX, so this returns `None`.
#[cfg(target_os = "windows")]
#[must_use]
pub fn find_git_bash() -> Option<String> {
    let mut candidates: Vec<String> = vec![
        // Prefer the real MSYS2 process. Git's bin\bash.exe is a launcher
        // shim that can exit after handing the command to usr\bin\bash.exe;
        // tracking that short-lived PID makes a still-running npm/Node server
        // disappear from shell_list_processes and impossible to kill by id.
        r"C:\Program Files\Git\usr\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe".to_string(),
        r"C:\Git\usr\bin\bash.exe".to_string(),
        r"C:\Program Files\Git\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
        r"C:\Git\bin\bash.exe".to_string(),
    ];
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            candidates.push(format!(r"{pf}\Git\usr\bin\bash.exe"));
            candidates.push(format!(r"{pf}\Git\bin\bash.exe"));
        }
    }
    if let Ok(local) = std::env::var("LocalAppData") {
        candidates.push(format!(r"{local}\Programs\Git\usr\bin\bash.exe"));
        candidates.push(format!(r"{local}\Programs\Git\bin\bash.exe"));
    }
    candidates
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
}

#[cfg(not(target_os = "windows"))]
#[must_use]
pub fn find_git_bash() -> Option<String> {
    None
}

/// Build the child process for a command.
///
/// `shell` is a profile id or kind id (`"bash"`, `"pwsh"`, `"cmd"`), or `None`
/// for the registry default. Executable, flags, environment, and the channel
/// the command travels through all come from [`crate::shell`] — nothing about
/// a shell is decided here. The command is never quoted, escaped, or
/// interpolated: see [`crate::shell::delivery`] for how it reaches each shell
/// whole.
///
/// The unregistered branch only runs before the registry has been populated
/// (very early startup, or a database that could not be read). It goes
/// through the same [`crate::shell::ResolvedShell`], so it gets the MSYS
/// environment repair and the delivery rules the registry path gets.
fn build_shell_command(
    shell: Option<&str>,
    command: &str,
    cwd: &Option<String>,
) -> (crate::shell::ResolvedShell, TokioCommand) {
    let resolved = crate::shell::resolve(shell).unwrap_or_else(|| unregistered_shell(shell));

    let mut cmd = TokioCommand::new(&resolved.exe);
    resolved.apply_one_shot(&mut cmd, command);

    if let Some(ref working_dir) = cwd {
        cmd.current_dir(working_dir);
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    (resolved, cmd)
}

/// Pre-registry fallback: the shell Aurora reached for before profiles
/// existed — Git Bash on Windows, the system shell elsewhere, PowerShell 7
/// when something other than bash was asked for on Windows.
fn unregistered_shell(shell: Option<&str>) -> crate::shell::ResolvedShell {
    use crate::shell::{ResolvedShell, ShellKind};

    let posix = matches!(shell, Some("bash")) || cfg!(not(target_os = "windows"));

    if posix {
        #[cfg(target_os = "windows")]
        let exe = find_git_bash().unwrap_or_else(|| "bash".to_string());
        #[cfg(not(target_os = "windows"))]
        let exe = if matches!(shell, Some("bash")) {
            "bash".to_string()
        } else {
            "sh".to_string()
        };
        return ResolvedShell::unregistered(ShellKind::Bash, exe);
    }

    ResolvedShell::unregistered(ShellKind::Pwsh, "pwsh".to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,         // e.g., "windows", "macos", "linux"
    pub os_version: String, // e.g., "10.0.26200" for Windows
    pub arch: String,       // e.g., "x86_64", "aarch64"
    pub hostname: String,
    pub shell: Option<String>, // Default shell path
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraWebSearchRequest {
    pub action: Option<String>,
    pub query: Option<String>,
    pub url: Option<String>,
    pub num_results: Option<u32>,
    pub region: Option<String>,
    pub safe_search: Option<String>,
    /// Which catalogue to ask: `web` (the default) or `scholar`.
    pub source: Option<String>,
    /// Characters of page text to return from a fetch.
    pub max_chars: Option<u32>,
    /// Where in the page to start reading, for paging through a long one.
    pub offset: Option<u32>,
}

/// The reply to a web call.
///
/// `results` and `content` are flattened into the top level rather than nested
/// under a wrapper key. The nesting is what let the runtime's compactor mistake
/// a fetch's body for something it could not shrink and throw it away whole;
/// keeping the payload one level down keeps that path honest, and reads better
/// besides.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuroraWebSearchResponse {
    pub success: bool,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Present on a search.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<crate::websearch::SearchOutcome>,
    /// Present on a fetch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<crate::websearch::Document>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocumentValidationRequest {
    pub content: String,
    pub format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocumentValidationResponse {
    pub column: Option<usize>,
    pub error: Option<String>,
    pub line: Option<usize>,
    pub valid: bool,
}

fn decode_rg_text(raw: &Value) -> String {
    raw.get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Put a ripgrep-reported path back into the absolute form callers expect.
///
/// Searching runs with the search directory as the working directory (so that
/// slash-bearing globs anchor correctly), which makes ripgrep emit paths like
/// `.\src\main.rs`. Every consumer of this command — the transcript file chips,
/// "open in IDE", the review panel — needs a real path, so the relative form is
/// rejoined to the directory it was relative to. `None` (a single-file search)
/// leaves the path exactly as ripgrep reported it.
fn absolutize_rg_path(search_dir: Option<&PathBuf>, reported: String) -> String {
    let Some(dir) = search_dir else {
        return reported;
    };
    let trimmed = reported
        .strip_prefix("./")
        .or_else(|| reported.strip_prefix(".\\"))
        .unwrap_or(&reported);
    if trimmed.is_empty() {
        return dir.to_string_lossy().to_string();
    }
    dir.join(trimmed).to_string_lossy().to_string()
}

fn decode_rg_path(data: &Value) -> Option<String> {
    data.get("path").map(decode_rg_text)
}

fn trim_line_endings(value: String) -> String {
    value
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string()
}

/// Split a comma-separated list of globs into individual `--glob` arguments.
///
/// The comma is BOTH our list separator and glob syntax, so this cannot be a
/// plain `split(',')`. It used to be, and it silently destroyed the single most
/// natural way to write a multi-extension filter: `**/*.{ts,tsx}` was cut into
/// `**/*.{ts` and `tsx}`, and ripgrep rejected the first fragment with
/// "unclosed alternate group; missing '}'". The model had written a correct
/// glob and the harness broke it before ripgrep ever saw it — so the error read
/// as the model's fault and no rephrasing could fix it.
///
/// Commas are therefore separators only at the top level: inside `{…}`
/// alternation, inside a `[…]` character class, or after a backslash escape,
/// they belong to the pattern.
///
/// Unbalanced input is passed through rather than repaired. A stray `{` means
/// the caller's glob is genuinely malformed, and ripgrep's own message names
/// the problem far better than a guess at what was meant.
fn parse_glob_patterns(glob: &Option<String>) -> Vec<String> {
    let Some(value) = glob.as_ref() else {
        return Vec::new();
    };

    let mut patterns: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut brace_depth: usize = 0;
    let mut in_class = false;
    let mut escaped = false;

    // Takes both buffers as arguments rather than capturing them, so it needs no
    // `mut` of its own and never fights the borrow checker mid-loop.
    let flush = |current: &mut String, patterns: &mut Vec<String>| {
        let trimmed = current.trim();
        if !trimmed.is_empty() {
            patterns.push(trimmed.to_string());
        }
        current.clear();
    };

    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => {
                current.push(character);
                escaped = true;
            }
            '[' if !in_class => {
                in_class = true;
                current.push(character);
            }
            ']' if in_class => {
                in_class = false;
                current.push(character);
            }
            '{' if !in_class => {
                brace_depth += 1;
                current.push(character);
            }
            '}' if !in_class => {
                brace_depth = brace_depth.saturating_sub(1);
                current.push(character);
            }
            ',' if brace_depth == 0 && !in_class => {
                flush(&mut current, &mut patterns);
            }
            _ => current.push(character),
        }
    }
    flush(&mut current, &mut patterns);

    patterns
}

fn offset_to_line_column(content: &str, offset: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut column = 1usize;

    for character in content[..offset.min(content.len())].chars() {
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }

    (line, column)
}

#[tauri::command]
pub async fn validate_structured_document(
    request: StructuredDocumentValidationRequest,
) -> Result<StructuredDocumentValidationResponse, String> {
    let format = request.format.to_lowercase();

    match format.as_str() {
        "json" => match serde_json::from_str::<serde_json::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => Ok(StructuredDocumentValidationResponse {
                column: Some(error.column()),
                error: Some(error.to_string()),
                line: Some(error.line()),
                valid: false,
            }),
        },
        "yaml" | "yml" => match serde_yaml::from_str::<serde_yaml::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => {
                let location = error.location();
                Ok(StructuredDocumentValidationResponse {
                    column: location.as_ref().map(|value| value.column()),
                    error: Some(error.to_string()),
                    line: location.as_ref().map(|value| value.line()),
                    valid: false,
                })
            }
        },
        "toml" => match toml::from_str::<toml::Value>(&request.content) {
            Ok(_) => Ok(StructuredDocumentValidationResponse {
                column: None,
                error: None,
                line: None,
                valid: true,
            }),
            Err(error) => {
                let (line, column) = error
                    .span()
                    .map(|span| offset_to_line_column(&request.content, span.start))
                    .unwrap_or((1, 1));

                Ok(StructuredDocumentValidationResponse {
                    column: Some(column),
                    error: Some(error.to_string()),
                    line: Some(line),
                    valid: false,
                })
            }
        },
        _ => Err(format!(
            "Unsupported structured document format: {}",
            request.format
        )),
    }
}

#[tauri::command]
pub async fn ripgrep_search(
    request: RipgrepSearchRequest,
) -> Result<RipgrepSearchResponse, String> {
    use std::collections::BTreeMap;
    use std::process::Stdio;

    let RipgrepSearchRequest {
        case_insensitive,
        context_lines,
        glob,
        is_regex,
        max_results,
        output_mode,
        path,
        pattern,
        timeout_ms,
    } = request;

    let resolved_output_mode = output_mode.unwrap_or_else(|| "content".to_string());
    let resolved_context_lines = context_lines.unwrap_or(0);
    let resolved_max_results = max_results.unwrap_or(50).max(1) as usize;
    let resolved_timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_RG_TIMEOUT_MS)
        .clamp(MIN_RG_TIMEOUT_MS, MAX_RG_TIMEOUT_MS);
    let timeout = std::time::Duration::from_millis(resolved_timeout_ms);

    // Aurora's own ripgrep, falling back to the user's. Resolving to a
    // concrete path (rather than spawning the bare name "rg") is what makes
    // search work on a machine that has never had ripgrep installed — the
    // case that used to return a bare `program not found` and take the
    // agent's content search with it.
    let Some(rg) = crate::sidecar::ripgrep() else {
        return Ok(RipgrepSearchResponse {
            counts: None,
            error: Some(crate::sidecar::ripgrep_missing_message()),
            files: None,
            matches: None,
            message: None,
            pattern,
            returned: None,
            success: false,
            tool: "grep".to_string(),
            total_files: None,
            total_matches: None,
            truncated: None,
        });
    };

    let mut cmd = TokioCommand::new(&rg.path);
    cmd.arg("--json")
        .arg("--line-number")
        .arg("--with-filename")
        .arg("--hidden")
        .arg("--no-messages");
    // NB: deliberately NO `--max-count`. That is ripgrep's PER-FILE limit, and
    // passing `max_results` to it meant a "200 result" search could collect 200
    // matches *from every file* — thousands of rows — while `files_with_matches`
    // and `count` were never bounded at all. The cap is enforced below, on the
    // unit the caller actually asked to limit, by stopping the read early.

    if !is_regex.unwrap_or(true) {
        cmd.arg("--fixed-strings");
    }

    if case_insensitive.unwrap_or(false) {
        cmd.arg("--ignore-case");
    }

    if resolved_context_lines > 0 {
        cmd.arg("--context").arg(resolved_context_lines.to_string());
    }

    for pattern in parse_glob_patterns(&glob) {
        cmd.arg("--glob").arg(pattern);
    }

    // Run IN the search directory with `.` as the operand, rather than passing
    // the directory as the operand.
    //
    // ripgrep anchors a slash-bearing glob (`apps/x/src/**/*.ts`) to the WORKING
    // DIRECTORY, not to the path operand. Passing an absolute root therefore made
    // every path-qualified glob match nothing at all, while bare patterns like
    // `**/*.rs` kept working — a silent empty result set from a tool that looks
    // perfectly functional. `glob.rs` already ran in the root for exactly this
    // reason; `grep` never got the same treatment.
    //
    // A `path` naming a single FILE keeps the operand form: there is no directory
    // to run in, and a glob filter over one explicit file is meaningless anyway.
    let search_dir = Path::new(&path).is_dir().then(|| PathBuf::from(&path));
    if let Some(dir) = &search_dir {
        cmd.current_dir(dir);
    }
    // The pattern rides behind `-e`, never as a bare positional: a pattern that
    // itself starts with `-` (CSS custom properties like `--color-border-…`,
    // CLI flags in docs) is otherwise parsed by ripgrep as flags and the whole
    // call dies with "unrecognized flag". `-e` composes with `--fixed-strings`.
    cmd.arg("-e")
        .arg(&pattern)
        .arg(match &search_dir {
            Some(_) => ".",
            None => path.as_str(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    let child = cmd.spawn().map_err(|error| {
        format!(
            "Failed to execute ripgrep at {} ({}): {}",
            rg.path.display(),
            rg.source.as_str(),
            error
        )
    })?;
    let mut child = child;
    let pid = child.id();

    let Some(stdout_pipe) = child.stdout.take() else {
        return Err("ripgrep produced no stdout pipe".to_string());
    };
    // Drain stderr on its own task. Reading stdout to completion while stderr
    // fills its pipe buffer would deadlock; `wait_with_output` used to handle
    // that, and streaming stdout means we now own it.
    let stderr_pipe = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut collected = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut collected).await;
        }
        String::from_utf8_lossy(&collected).trim().to_string()
    });

    let mut matches: Vec<RipgrepMatch> = Vec::new();
    let mut files_with_matches: Vec<String> = Vec::new();
    let mut counts_by_file: BTreeMap<String, usize> = BTreeMap::new();
    let mut pending_context_by_file: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut last_match_index_by_file: BTreeMap<String, usize> = BTreeMap::new();
    // Files ripgrep has finished with — the only point at which that file's
    // match count is final, since it streams every match before the `end` event.
    let mut files_completed: usize = 0;
    let mut truncated = false;

    // Have we now collected MORE than the caller asked for? Measured on the unit
    // the active output mode actually returns, so `max_results` means the same
    // thing whichever mode is in play. Reading one unit past the cap is what
    // makes `truncated` an observation rather than a guess: stopping exactly at
    // the cap could never distinguish "exactly N results" from "N and counting".
    let over_cap = |matches: &Vec<RipgrepMatch>, files: &Vec<String>, completed: usize| -> bool {
        match resolved_output_mode.as_str() {
            "files_with_matches" => files.len() > resolved_max_results,
            "count" => completed > resolved_max_results,
            _ => matches.len() > resolved_max_results,
        }
    };

    let scan = async {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stdout_pipe).lines();

        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|error| format!("Failed to read rg output: {error}"))?
        {
            let line = line.as_str();
            if line.trim().is_empty() {
                continue;
            }

            let event: Value = serde_json::from_str(line)
                .map_err(|error| format!("Failed to parse rg output: {}", error))?;

            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();

            if event_type == "end" {
                files_completed += 1;
            }

            if event_type == "match" {
                let Some(data) = event.get("data") else {
                    continue;
                };

                let Some(file_path) = decode_rg_path(data) else {
                    continue;
                };
                let file_path = absolutize_rg_path(search_dir.as_ref(), file_path);

                let line_number =
                    data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as usize;

                let content =
                    trim_line_endings(decode_rg_text(data.get("lines").unwrap_or(&Value::Null)));
                let pending_context = pending_context_by_file
                    .remove(&file_path)
                    .unwrap_or_default();

                if !pending_context.is_empty() {
                    if let Some(previous_match_index) = last_match_index_by_file.get(&file_path) {
                        if let Some(previous_match) = matches.get_mut(*previous_match_index) {
                            let updated_after_context = previous_match
                                .after_context
                                .clone()
                                .unwrap_or_default()
                                .into_iter()
                                .chain(pending_context.clone().into_iter())
                                .collect::<Vec<_>>();
                            previous_match.after_context = Some(updated_after_context);
                        }
                    }
                }

                counts_by_file
                    .entry(file_path.clone())
                    .and_modify(|count| *count += 1)
                    .or_insert(1);

                if !files_with_matches.iter().any(|file| file == &file_path) {
                    files_with_matches.push(file_path.clone());
                }

                let match_index = matches.len();
                matches.push(RipgrepMatch {
                    after_context: None,
                    before_context: if pending_context.is_empty() {
                        None
                    } else {
                        Some(pending_context)
                    },
                    content,
                    file: file_path.clone(),
                    line_number,
                });
                last_match_index_by_file.insert(file_path, match_index);
            }

            if event_type == "context" {
                let Some(data) = event.get("data") else {
                    continue;
                };

                let Some(file_path) = decode_rg_path(data) else {
                    continue;
                };
                let file_path = absolutize_rg_path(search_dir.as_ref(), file_path);

                let context_content =
                    trim_line_endings(decode_rg_text(data.get("lines").unwrap_or(&Value::Null)));

                pending_context_by_file
                    .entry(file_path)
                    .or_default()
                    .push(context_content);
            }

            if over_cap(&matches, &files_with_matches, files_completed) {
                truncated = true;
                break;
            }
        }
        Ok::<(), String>(())
    };

    let timed_out = match tokio::time::timeout(timeout, scan).await {
        Ok(result) => {
            result?;
            false
        }
        Err(_) => true,
    };

    // Stop ripgrep whether we timed out or simply have enough. Without this a
    // capped search would leave it walking the rest of the tree for nothing.
    let _ = child.start_kill();
    if let Some(pid) = pid {
        let _ = try_kill_pid(pid);
    }
    let status = child.wait().await.ok();
    let stderr = stderr_task.await.unwrap_or_default();

    if timed_out {
        return Ok(RipgrepSearchResponse {
            counts: None,
            error: Some(format!(
                "ripgrep search timed out after {}ms — narrow `pattern`, or scope the search with `path` / `glob`",
                timeout.as_millis()
            )),
            files: None,
            matches: None,
            message: None,
            pattern,
            returned: None,
            success: false,
            tool: "grep".to_string(),
            total_files: None,
            total_matches: None,
            truncated: None,
        });
    }

    // Trim the one extra unit that proved there was more to find.
    if truncated {
        match resolved_output_mode.as_str() {
            "files_with_matches" => files_with_matches.truncate(resolved_max_results),
            "count" => {
                let keep: Vec<String> = files_with_matches
                    .iter()
                    .take(resolved_max_results)
                    .cloned()
                    .collect();
                counts_by_file.retain(|file, _| keep.contains(file));
            }
            _ => matches.truncate(resolved_max_results),
        }
    }

    for (file_path, trailing_context) in pending_context_by_file {
        if trailing_context.is_empty() {
            continue;
        }

        if let Some(last_match_index) = last_match_index_by_file.get(&file_path) {
            if let Some(last_match) = matches.get_mut(*last_match_index) {
                let updated_after_context = last_match
                    .after_context
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .chain(trailing_context.into_iter())
                    .collect::<Vec<_>>();
                last_match.after_context = Some(updated_after_context);
            }
        }
    }

    let total_matches = counts_by_file.values().sum::<usize>();

    // A killed process has no meaningful exit code, so only trust the status
    // when we let ripgrep run to completion.
    let exit_code = if truncated {
        Some(0)
    } else {
        status.and_then(|status| status.code())
    };

    if exit_code != Some(0) && total_matches == 0 {
        if exit_code == Some(1) {
            return Ok(RipgrepSearchResponse {
                counts: if resolved_output_mode == "count" {
                    Some(Vec::new())
                } else {
                    None
                },
                error: None,
                files: if resolved_output_mode == "files_with_matches" {
                    Some(Vec::new())
                } else {
                    None
                },
                matches: if resolved_output_mode == "content" {
                    Some(Vec::new())
                } else {
                    None
                },
                message: Some(
                    "No matches. Check the pattern, and widen `glob` / `path` if the files you \
                     expected were filtered out."
                        .to_string(),
                ),
                pattern,
                returned: Some(0),
                success: true,
                tool: "grep".to_string(),
                total_files: Some(0),
                total_matches: Some(0),
                truncated: Some(false),
            });
        }

        let error_message = if stderr.is_empty() {
            "ripgrep search failed".to_string()
        } else {
            stderr
        };

        return Ok(RipgrepSearchResponse {
            counts: None,
            error: Some(error_message),
            files: None,
            matches: None,
            message: None,
            pattern,
            returned: None,
            success: false,
            tool: "grep".to_string(),
            total_files: None,
            total_matches: None,
            truncated: None,
        });
    }

    let total_files = counts_by_file.len();

    let counts = if resolved_output_mode == "count" {
        Some(
            counts_by_file
                .iter()
                .map(|(file, count)| RipgrepFileCount {
                    file: file.clone(),
                    count: *count,
                })
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };

    let files = if resolved_output_mode == "files_with_matches" {
        Some(files_with_matches)
    } else {
        None
    };

    let content_matches = if resolved_output_mode == "content" {
        Some(matches)
    } else {
        None
    };

    // What the caller is actually holding, in the unit they capped.
    let returned = match resolved_output_mode.as_str() {
        "files_with_matches" => files.as_ref().map(Vec::len).unwrap_or(0),
        "count" => counts.as_ref().map(Vec::len).unwrap_or(0),
        _ => content_matches.as_ref().map(Vec::len).unwrap_or(0),
    };

    // Truncation has to name itself AND the way out, or the next call is a
    // guess. Note the totals below are honest about being floors: the search was
    // stopped early, so nothing here claims to know what the full count was.
    let message = truncated.then(|| {
        let unit = match resolved_output_mode.as_str() {
            "files_with_matches" => "files",
            "count" => "files",
            _ => "matches",
        };
        format!(
            "Showing the first {returned} {unit}; more exist. Raise `max_results`, narrow \
             `pattern`, or scope the search with `path` / `glob`."
        )
    });

    Ok(RipgrepSearchResponse {
        counts,
        error: None,
        files,
        matches: content_matches,
        message,
        pattern,
        returned: Some(returned),
        success: true,
        tool: "grep".to_string(),
        // Totals are reported ONLY for a search that ran to completion.
        //
        // A truncated search stops one unit past the cap, so it has no idea what
        // the real total is — it would say "7" where 240 exist. Reporting that
        // as a total is the same failure as the old `min(total, cap)` clamp:
        // a number that looks measured and isn't. `returned` says exactly how
        // much is in hand and `truncated` says there is more; anything wanting a
        // true count must raise `max_results` or narrow the search.
        total_files: (!truncated).then_some(total_files),
        total_matches: (!truncated).then_some(total_matches),
        truncated: Some(truncated),
    })
}

static FS_WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();

fn get_watcher_handle() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    FS_WATCHER.get_or_init(|| Mutex::new(None))
}

/// Search the web, or read one page.
///
/// The work lives in [`crate::websearch`]; this is the IPC edge. It resolves
/// which of the two actions was meant, validates that the argument that action
/// needs is present, and turns a [`crate::websearch::WebError`] into the string
/// the caller sees.
///
/// Both the per-request timeout and the response size ceiling are enforced
/// inside the client itself, so there is no wall-clock guard here: a hung
/// endpoint fails on its own rather than holding the bridge open.
#[tauri::command]
pub async fn aurora_websearch(
    request: AuroraWebSearchRequest,
) -> Result<AuroraWebSearchResponse, String> {
    // No browser rung on the IPC edge. The search webview belongs to the agent
    // window, and a frontend call is already running inside one — it can drive
    // a browser itself. The rung exists for the agent's tool, which cannot.
    aurora_websearch_with(request, None).await
}

/// The work behind [`aurora_websearch`], with the browser rung as a parameter.
///
/// Split out so the agent's tool can hand in a real browser while the IPC
/// command above stays a plain `#[tauri::command]` — every argument of one of
/// those is deserialized from the frontend's payload, so a `&dyn` cannot be a
/// parameter of it.
pub async fn aurora_websearch_with(
    mut request: AuroraWebSearchRequest,
    browser: Option<&dyn crate::websearch::PageSource>,
) -> Result<AuroraWebSearchResponse, String> {
    use crate::websearch::{self, FetchOptions, SafeSearch, SearchOptions, SearchSource};

    for value in [&mut request.action, &mut request.url, &mut request.query, &mut request.source] {
        *value = value.take().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    }
    request.action = request.action.map(|s| s.to_ascii_lowercase());
    request.source = request.source.map(|s| s.to_ascii_lowercase());

    // A caller that names a URL means "read it" even when it forgot to say so.
    let action = request.action.clone().unwrap_or_else(|| {
        if request.url.is_some() {
            "fetch".to_string()
        } else {
            "search".to_string()
        }
    });

    if !matches!(action.as_str(), "search" | "fetch") {
        return Err(format!("unknown web action '{action}'; use 'search' or 'fetch'"));
    }
    if action == "fetch" {
        let url = request
            .url
            .clone()
            .ok_or_else(|| "fetch needs a `url`.".to_string())?;

        let opts = FetchOptions {
            max_chars: request
                .max_chars
                .map(|n| n as usize)
                .unwrap_or(websearch::DEFAULT_MAX_CHARS),
            offset: request.offset.unwrap_or(0) as usize,
        };

        let document = websearch::fetch(&url, &opts)
            .await
            .map_err(|e| e.to_string())?;

        return Ok(AuroraWebSearchResponse {
            success: true,
            action,
            query: None,
            url: Some(url),
            search: None,
            document: Some(document),
            error: None,
        });
    }

    let query = request
        .query
        .clone()
        .ok_or_else(|| "search needs a `query`.".to_string())?;

    if let Some(source) = request.source.as_deref() {
        if !matches!(source, "web" | "scholar" | "papers" | "academic" | "images") {
            return Err(format!("unknown search source '{source}'; use 'web', 'scholar' or 'images'"));
        }
    }
    let opts = SearchOptions {
        limit: request.num_results.unwrap_or(10).clamp(1, 25) as usize,
        region: request.region.clone(),
        safe_search: request
            .safe_search
            .as_deref()
            .map(SafeSearch::parse)
            .unwrap_or_default(),
        source: request
            .source
            .as_deref()
            .map(SearchSource::parse)
            .unwrap_or_default(),
    };

    let outcome = websearch::search(&query, &opts, browser)
        .await
        .map_err(|e| e.to_string())?;

    Ok(AuroraWebSearchResponse {
        success: true,
        action,
        query: Some(query),
        url: None,
        search: Some(outcome),
        document: None,
        error: None,
    })
}

/// Read directory contents

///
/// Args:
///   path: Directory path to read
///   include_hidden: Whether to include hidden files/folders (starting with .)
#[tauri::command]
pub async fn read_directory(
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);
    let show_hidden = include_hidden.unwrap_or(true); // Default to showing hidden files

    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();

    match fs::read_dir(dir_path) {
        Ok(read_dir) => {
            for entry in read_dir.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let file_path = entry.path();
                let metadata = entry.metadata().ok();

                // Skip hidden files/folders if not showing hidden
                // Always show .aurora (our config folder)
                if !show_hidden && file_name.starts_with('.') && file_name != ".aurora" {
                    continue;
                }

                // Always skip .git folder (too many internal files)
                // But .gitignore, .gitattributes etc. are fine (they're files, not the .git folder)
                if file_name == ".git" {
                    continue;
                }

                // Skip large generated folders that slow down the explorer
                if file_name == "node_modules"
                    || file_name == "target"
                    || file_name == "dist"
                    || file_name == ".pnpm"
                {
                    continue;
                }

                let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let is_file = metadata.as_ref().map(|m| m.is_file()).unwrap_or(false);
                let extension = file_path
                    .extension()
                    .map(|e| e.to_string_lossy().to_string());

                entries.push(FileEntry {
                    name: file_name,
                    path: file_path.to_string_lossy().to_string(),
                    is_dir,
                    is_file,
                    extension,
                });
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    // Sort: directories first, then files, alphabetically
    // Hidden files (starting with .) are sorted among their peers
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Maximum wall-clock time we'll wait for a file read before giving up so a
/// frozen disk or network share can never make the editor "load forever".
const FILE_READ_TIMEOUT_MS: u64 = 10_000;

/// Read file content (cached for performance, bounded by a wall-clock timeout)
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    let read_path = path.clone();
    let join = tokio::task::spawn_blocking(move || crate::file_cache::read_file_cached(&read_path));

    match tokio::time::timeout(std::time::Duration::from_millis(FILE_READ_TIMEOUT_MS), join).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("Failed to load file: {}", e)),
        Err(_) => Err(format!(
            "File read timed out after {}ms (path: {})",
            FILE_READ_TIMEOUT_MS, path
        )),
    }
}

/// Read file content + metadata (size + mtime) in a single IPC round-trip.
/// The editor uses this so a tab can be mounted with the canonical freshness
/// stamp captured at read time, eliminating the need for a separate stat
/// call after every open. Goes through the same mtime-validated cache as
/// [`read_file_content`].
#[tauri::command]
pub async fn read_file_with_meta(path: String) -> Result<crate::file_cache::FileMeta, String> {
    let read_path = path.clone();
    let join = tokio::task::spawn_blocking(move || {
        crate::file_cache::read_file_cached_with_meta(&read_path)
    });

    match tokio::time::timeout(std::time::Duration::from_millis(FILE_READ_TIMEOUT_MS), join).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("Failed to load file: {}", e)),
        Err(_) => Err(format!(
            "File read timed out after {}ms (path: {})",
            FILE_READ_TIMEOUT_MS, path
        )),
    }
}

/// Cheap freshness probe. Returns the current disk mtime so the editor can
/// decide whether a tab's already-rendered content is still in sync without
/// re-reading the whole file. `None` is encoded as `0` so the frontend can
/// treat "missing" and "epoch" as one degenerate case.
#[tauri::command]
pub async fn stat_file_mtime(path: String) -> Result<u64, String> {
    let read_path = path.clone();
    tokio::task::spawn_blocking(move || crate::file_cache::get_file_mtime(&read_path).unwrap_or(0))
        .await
        .map_err(|e| format!("mtime task failed: {}", e))
}

/// Write file content
#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    let result = fs::write(file_path, &content).map_err(|e| format!("Failed to write file: {}", e));

    // Invalidate cache after write (file content changed)
    crate::file_cache::get_file_cache().invalidate(&path);

    result
}

/// Execute a shell command with optional shell profile
#[tauri::command]
pub async fn execute_command(
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    // The same lifecycle the streamed path runs — spawn, read, classify the
    // ending — minus the app handle, so nothing is emitted or tracked. This
    // used to be a second hand-rolled runner built on `wait_with_output`,
    // which waits for pipe EOF: a command that finished but left a child
    // holding the pipe was reported as "timed out and was killed", false on
    // both counts. One runner, one classification.
    let request_id = format!("fg-{}", uuid::Uuid::new_v4().simple());
    let effective_timeout_ms = timeout_ms.unwrap_or(30_000);
    let output = run_command_lifecycle(
        None, request_id, command, cwd, shell, timeout_ms, None, false,
    )
    .await?;
    if output.timed_out {
        // This caller's contract predates `timed_out`: a timeout is an `Err`.
        return Err(format!(
            "Command timed out after {effective_timeout_ms}ms and was killed. Re-run with a \
             larger `timeout` if it just needs longer, or start it with shell_spawn if it has no \
             natural end."
        ));
    }
    Ok(output)
}

/// What a stop attempt actually achieved.
///
/// The caller paints a row from this, so the two failing cases must not look
/// alike. A process that ended by itself a moment before the click is
/// `stopped` — that is the outcome the click asked for, and reporting it as an
/// error would make the common race look like a fault. A process that is still
/// running because the kill failed is NOT stopped, and saying otherwise leaves
/// a live process wearing a settled row.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStopOutcome {
    /// The process is no longer running: it was killed, or it had already ended.
    pub stopped: bool,
    /// Why it could not be stopped. Only ever set when `stopped` is false.
    pub error: Option<String>,
}

/// Stop a running stream.
///
/// `reason` is `"user"` (the default, and what the stop button sends) or
/// `"agent"`. It is recorded in the process's log file so whoever reads that
/// file later learns how the output ended instead of inferring it.
///
/// Still `Ok` for a stream that had already finished — cancellation is
/// idempotent by design — but that case is now distinguishable from a kill that
/// failed. This used to discard the result entirely (`let _ = …`) and always
/// answer `Ok(())`, so the dock settled every row to "Stopped" whether or not
/// anything had been stopped.
#[tauri::command]
pub fn cancel_command_stream(
    request_id: String,
    reason: Option<String>,
) -> Result<CommandStopOutcome, String> {
    match cancel_tracked_command_stream(&request_id, StopReason::parse(reason.as_deref())) {
        Ok(_) => Ok(CommandStopOutcome { stopped: true, error: None }),
        // Gone from the registry: it ended between the click and this call.
        Err(_) if command_stream_key(&request_id).is_none() => {
            Ok(CommandStopOutcome { stopped: true, error: None })
        }
        // Still tracked, so `try_kill_pid` is what failed and the process is
        // still out there.
        Err(message) => Ok(CommandStopOutcome { stopped: false, error: Some(message) }),
    }
}

/// Hand a running foreground command to the background — the "Run in
/// background" button on a shell tool card.
///
/// Errors are returned rather than swallowed, unlike the cancel above: this one
/// has a visible consequence (the card settles, the tool call answers the
/// model), so a click that did nothing must not look like a click that worked.
#[tauri::command]
pub fn detach_command_stream(request_id: String) -> Result<(), String> {
    detach_tracked_command_stream(&request_id).map(|_| ())
}

// Shell stream batching constants.
//
// The original implementation emitted a Tauri IPC event for every 4 KB chunk
// it read from the child process. Long-running commands (e.g. `npm install`,
// `cargo build`) produced thousands of events per second, saturating the JS
// event loop and freezing the entire IDE — file reads, editor input, and even
// the chat panel would stall behind the backlog.
//
// We now coalesce reads server-side and emit at most ~30 Hz (or sooner if the
// pending buffer grows large). The wire format stays compatible with existing
// TS listeners (`{ stream, data, done, ... }`) — we just send fewer, larger
// chunks. This drops the IPC volume by 1-2 orders of magnitude without losing
// any output, and the agent still gets the full text via the awaited
// CommandOutput at the end.
/// Lifetime a foreground command gets once it is handed to the background.
///
/// Matches `shell_spawn`'s own "effectively no cap": a detached command is
/// stopped by a person or by `shell_kill`, not by the clock its caller left
/// behind. Keeping a real (if distant) deadline rather than none at all means
/// a forgotten process still cannot outlive the machine's uptime silently.
const DETACHED_LIFETIME_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

const SHELL_STREAM_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(33);
const SHELL_STREAM_FLUSH_BYTES: usize = 32 * 1024;
const SHELL_STREAM_READ_BUF: usize = 16 * 1024;

/// How long to wait for a pipe to close after its shell has already exited.
///
/// A shell that exited alone closes its pipes in the same instant, so the
/// ordinary case pays nothing. The window exists for the other case: a child
/// the command started inherited the pipe's write end and is still alive.
/// Nothing Aurora can await ends that — only the survivor's own death does —
/// so past this point the pipe being open IS the answer: the command finished
/// and left something running.
const EXIT_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_millis(300);

/// Read what remains of a pipe once the process that owned it has exited.
///
/// Returns the bytes that arrived and whether the pipe is still held open by a
/// surviving child (`true` = the grace window closed before EOF did). Callers
/// fold the flag into `CommandOutput::left_running`. `already_eof` short-cuts
/// the wait when the streaming loop saw this pipe close before the exit.
async fn drain_exited_pipe<R: tokio::io::AsyncRead + Unpin>(
    pipe: &mut R,
    already_eof: bool,
) -> (Vec<u8>, bool) {
    use tokio::io::AsyncReadExt;

    if already_eof {
        return (Vec::new(), false);
    }
    let mut collected = Vec::new();
    let mut chunk = vec![0u8; SHELL_STREAM_READ_BUF];
    let deadline = tokio::time::Instant::now() + EXIT_DRAIN_GRACE;
    loop {
        match tokio::time::timeout_at(deadline, pipe.read(&mut chunk)).await {
            // EOF: the pipe closed properly — everything is collected.
            Ok(Ok(0)) => return (collected, false),
            Ok(Ok(n)) => collected.extend_from_slice(&chunk[..n]),
            // A read error after exit is a closed pipe, not a held one.
            Ok(Err(_)) => return (collected, false),
            // Grace elapsed with the pipe still open: a survivor holds it.
            Err(_) => return (collected, true),
        }
    }
}

/// The processes a finished command left alive, by name, for the model to
/// read: `"notepad.exe (pid 1234)"`.
///
/// `conhost.exe` is excluded — it is Windows console plumbing that rides along
/// with any console child, not something the command "left running", and
/// reporting it would make every ordinary command look like a launcher.
fn surviving_descendants(shell_pid: u32) -> Vec<String> {
    crate::commands::terminal::descendants_of(shell_pid)
        .unwrap_or_default()
        .into_iter()
        .filter(|child| !child.name.eq_ignore_ascii_case("conhost.exe"))
        .map(|child| format!("{} (pid {})", child.name, child.pid))
        .collect()
}

/// Runs when `run_command_lifecycle`'s future is dropped mid-flight — the one
/// path where the code after the drop point never executes. That happens when
/// the awaiting turn is cancelled while a foreground command is still running.
///
/// Without this, the child process kept running unwatched, its log never got a
/// footer, and its ledger row leaked — `shell_list_processes` then listed a
/// long-dead foreground command as a running "background process" for the rest
/// of the session (observed live in session `41841342`, message 63).
///
/// Every ordinary ending calls `disarm()` first, so this fires only for the
/// dropped-future case.
struct LifecycleGuard {
    armed: bool,
    app: Option<tauri::AppHandle>,
    request_id: String,
    pid: Option<u32>,
    log_path: Option<String>,
    started: std::time::Instant,
}

impl LifecycleGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for LifecycleGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(pid) = self.pid {
            let _ = try_kill_pid(pid);
        }
        // The loop's own `ProcessLog` died with the future; append the footer
        // through a fresh handle so the log still states how the run ended.
        let mut log = ProcessLog::open(self.log_path.as_ref());
        log.footer("Stopped with the conversation turn", self.started);
        if let Some(app) = &self.app {
            let _ = app.emit(
                &format!("shell-stream-{}", self.request_id),
                CommandStreamChunk {
                    stream: "meta".to_string(),
                    data: String::new(),
                    done: true,
                    exit_code: None,
                    success: Some(false),
                },
            );
            emit_process_ended(app, &self.request_id, None, "stopped");
        }
        cleanup_command_stream(&self.request_id);
    }
}

/// The log file a background process's output is mirrored into.
///
/// Flushed per chunk: the file exists so the agent can read a running
/// process's output with `file_read`, and buffered writes would make a live
/// server look silent. Failures are ignored — losing the log must never take
/// down the command.
///
/// Every run ends with [`ProcessLog::footer`]. A log that simply stops is
/// indistinguishable from a crash, a clean exit, a kill, and a stalled writer,
/// which leaves a reader to invent whichever one fits its expectations. The
/// footer removes the guess: the file states how it ended.
/// Marks the one line in a process log that Aurora wrote rather than the
/// process. `shell_read_output` keys "has this run ended, and how" off it, so
/// the prefix lives here next to the code that emits it instead of being
/// re-spelled at the reader.
pub const PROCESS_LOG_FOOTER_PREFIX: &str = "[aurora]";

struct ProcessLog {
    file: Option<std::fs::File>,
    /// Whether the next byte starts a line, so the footer never lands glued to
    /// a half-written line of the process's own output.
    at_line_start: bool,
}

impl ProcessLog {
    fn open(path: Option<&String>) -> Self {
        let file = path.and_then(|path| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok()
        });
        Self {
            file,
            at_line_start: true,
        }
    }

    fn write(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Some(handle) = self.file.as_mut() {
            use std::io::Write;
            let _ = handle.write_all(text.as_bytes());
            let _ = handle.flush();
        }
        self.at_line_start = text.ends_with('\n');
    }

    /// Close the log with a single line naming how the process ended.
    fn footer(&mut self, summary: &str, started: std::time::Instant) {
        if self.file.is_none() {
            return;
        }
        let lead = if self.at_line_start { "" } else { "\n" };
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let ran = human_duration(started.elapsed());
        self.write(&format!(
            "{lead}{PROCESS_LOG_FOOTER_PREFIX} {summary} — {stamp}, ran {ran}. No further output.\n"
        ));
    }
}

/// Compact elapsed time for the log footer: `1.4s`, `47s`, `3m 12s`, `1h 04m`.
fn human_duration(elapsed: std::time::Duration) -> String {
    let secs = elapsed.as_secs();
    match secs {
        0 => format!("{}ms", elapsed.subsec_millis()),
        1..=9 => format!("{:.1}s", elapsed.as_secs_f64()),
        10..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m {:02}s", secs / 60, secs % 60),
        _ => format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60),
    }
}

/// Announcement that a tracked process has ended, keyed by the id the window
/// knows it by.
///
/// The output stream's `done` marker is keyed by *request* id, while the
/// background dock keys its rows by the `bg-…` *process* id — so a card
/// listening for `done` had to guess which stream was its own, and a row whose
/// process had already exited kept reporting that it was running. This event
/// carries both ids and the outcome, so nothing has to be inferred.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessEnded {
    process_id: String,
    request_id: String,
    exit_code: Option<i32>,
    /// `"exited"` when the process ended by itself, `"stopped"` when something
    /// ended it — the same distinction the log's closing line draws.
    outcome: &'static str,
}

/// Emit [`ProcessEnded`]. Called before the stream leaves the ledger, which is
/// where the process id still lives.
fn emit_process_ended(
    app: &tauri::AppHandle,
    request_id: &str,
    exit_code: Option<i32>,
    outcome: &'static str,
) {
    let process_id = ACTIVE_COMMAND_STREAMS
        .read()
        .get(request_id)
        .map(|stream| stream.process_id.clone());
    let Some(process_id) = process_id else { return };
    let _ = app.emit(
        "shell-process-ended",
        ProcessEnded {
            process_id,
            request_id: request_id.to_string(),
            exit_code,
            outcome,
        },
    );
}

fn flush_shell_pending(
    app: Option<&tauri::AppHandle>,
    request_id: &str,
    stdout_pending: &mut String,
    stderr_pending: &mut String,
) {
    // An untracked run has no listener; drop the pending text rather than
    // letting it grow for a stream nobody is on. The full output still
    // accumulates in the buffers the caller returns.
    let Some(app) = app else {
        stdout_pending.clear();
        stderr_pending.clear();
        return;
    };
    if !stdout_pending.is_empty() {
        let _ = app.emit(
            &format!("shell-stream-{}", request_id),
            CommandStreamChunk {
                stream: "stdout".to_string(),
                data: std::mem::take(stdout_pending),
                done: false,
                exit_code: None,
                success: None,
            },
        );
    }
    if !stderr_pending.is_empty() {
        let _ = app.emit(
            &format!("shell-stream-{}", request_id),
            CommandStreamChunk {
                stream: "stderr".to_string(),
                data: std::mem::take(stderr_pending),
                done: false,
                exit_code: None,
                success: None,
            },
        );
    }
}

/// Run a command, streaming its output to the frontend as it arrives.
///
/// `log_path` optionally mirrors the combined output into a file as it
/// decodes, so a long-running process can be read back later with `file_read`
/// — the live stream reaches the UI only, never the model.
///
/// `keep_stdin_open` is for background spawns: the child gets a stdin pipe
/// Aurora holds open for its whole life, so a server that treats stdin EOF as
/// "shut down" is not killed by the dead handle a GUI process would otherwise
/// pass it. Foreground commands get an explicitly closed stdin instead — a
/// deterministic, immediate EOF for anything that reads it.
#[tauri::command]
pub async fn execute_command_stream(
    app: tauri::AppHandle,
    request_id: String,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
    log_path: Option<String>,
    keep_stdin_open: Option<bool>,
) -> Result<CommandOutput, String> {
    run_command_lifecycle(
        Some(app),
        request_id,
        command,
        cwd,
        shell,
        timeout_ms,
        log_path,
        keep_stdin_open.unwrap_or(false),
    )
    .await
}

/// Everything that runs between "spawn the shell" and "state how it ended" —
/// the ONE place that decides what a command's outcome was.
///
/// `execute_command_stream` (streams to the UI, tracked in the ledger) and
/// `execute_command` (silent, untracked — lint checkers, unit tests) are both
/// this function; `app: None` is what "silent" means. There used to be two
/// runners that classified completion differently, and the differences were
/// all bugs: one hung forever on a pipe a finished command's child still held,
/// the other reported that same situation as a timeout-and-kill.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_command_lifecycle(
    app: Option<tauri::AppHandle>,
    request_id: String,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
    log_path: Option<String>,
    keep_stdin_open: bool,
) -> Result<CommandOutput, String> {
    use std::process::Stdio;
    use std::time::Duration;

    // Untracked runs skip the ledger entirely: there is no UI to list them,
    // no stop button to honour, and a row nothing will clean up is how
    // phantom "background processes" appear in shell_list_processes.
    let tracked = app.is_some();
    if tracked {
        register_command_stream(
            request_id.clone(),
            request_id.clone(),
            None,
            command.clone(),
            cwd.clone(),
            log_path.clone(),
        );
    }

    // Opened once and appended to as chunks decode. Failure to open is not
    // fatal: the command still runs and still streams to the UI, the model
    // just loses the ability to read it back.
    let mut log = ProcessLog::open(log_path.as_ref());
    let started = std::time::Instant::now();

    let shell_profile = shell.as_deref();
    // Mutable because "Run in background" lifts it mid-run — see the detach
    // branch in the loop below.
    let mut timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let (resolved, mut cmd) = build_shell_command(shell_profile, &command, &cwd);
    let shell_exe = resolved.exe.clone();
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Never inherit Aurora's own stdin: a GUI process's stdin is a dead
    // handle, and children inherit it transitively — a grandchild server that
    // reads stdin got an instant EOF and, if it treats EOF as "shut down",
    // died seconds after a clean start with nothing in its log to say why.
    cmd.stdin(if keep_stdin_open {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            // One substitution only: `pwsh` is an install, `powershell` is
            // the OS, and the two read the same syntax — so a machine without
            // PowerShell 7 still gets its PowerShell command run.
            //
            // Nothing else falls back. This used to retry ANY failed spawn
            // except the literal `"bash"` kind id in Windows PowerShell, which
            // meant a registered bash profile (whose id is `sh-…`, not
            // `bash`) that failed to start silently ran its POSIX command in
            // PowerShell and returned that shell's confusion as the result.
            // A spawn error that names the shell is the honest answer.
            #[cfg(target_os = "windows")]
            let fallback_child = if resolved.kind == crate::shell::ShellKind::Pwsh {
                let stand_in = crate::shell::ResolvedShell::unregistered(
                    crate::shell::ShellKind::PowerShell,
                    "powershell".to_string(),
                );
                let mut fallback = TokioCommand::new(&stand_in.exe);
                stand_in.apply_one_shot(&mut fallback, &command);
                if let Some(ref working_dir) = cwd {
                    fallback.current_dir(working_dir);
                }
                fallback.stdout(Stdio::piped());
                fallback.stderr(Stdio::piped());
                fallback.stdin(if keep_stdin_open {
                    Stdio::piped()
                } else {
                    Stdio::null()
                });
                fallback.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
                fallback.spawn().ok()
            } else {
                None
            };
            #[cfg(not(target_os = "windows"))]
            let fallback_child: Option<tokio::process::Child> = None;

            match fallback_child {
                Some(c) => c,
                None => {
                    log.footer(&format!("Never started ({shell_exe}: {e})"), started);
                    if tracked {
                        cleanup_command_stream(&request_id);
                    }
                    return Err(format!(
                        "Could not start {} ({shell_exe}): {e}. Check the shell under Settings → \
                         Tools → Shells, or name a different one with `shell`.",
                        resolved.label
                    ));
                }
            }
        }
    };

    // Held for the child's whole life when `keep_stdin_open`: dropping it is
    // what closes the pipe, so the binding existing IS the feature.
    let _held_stdin = child.stdin.take();

    // Job membership is the exit-time answer to "what did this command leave
    // running" — see `process_tracking`. Adopted immediately after spawn so
    // everything the shell starts lands in the job with it. `None` (job
    // creation refused, non-Windows) falls back to the parent-pid walk below.
    #[cfg(target_os = "windows")]
    let shell_job = match (child.id(), child.raw_handle()) {
        (Some(shell_pid), Some(handle)) => process_tracking::ShellJob::adopt(shell_pid, handle),
        _ => None,
    };
    #[cfg(not(target_os = "windows"))]
    let shell_job: Option<process_tracking::ShellJob> = None;

    let pid = child.id();
    if tracked {
        let mut streams = ACTIVE_COMMAND_STREAMS.write();
        if let Some(stream) = streams.get_mut(&request_id) {
            stream.pid = pid;
        }
    }

    // If this future is dropped mid-run — the turn was cancelled while the
    // command was still going — nothing after this line runs. Without the
    // guard the child kept running unwatched and its ledger row leaked,
    // showing up in shell_list_processes as a phantom "background process"
    // for the rest of the session.
    let mut guard = LifecycleGuard {
        armed: true,
        app: app.clone(),
        request_id: request_id.clone(),
        pid,
        log_path: log_path.clone(),
        started,
    };

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut stdout_pending = String::new();
    let mut stderr_pending = String::new();

    let mut stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            guard.disarm();
            if let Some(pid) = pid {
                let _ = try_kill_pid(pid);
            }
            log.footer("Killed — stdout could not be captured", started);
            cleanup_command_stream(&request_id);
            return Err("Failed to capture stdout".to_string());
        }
    };
    let mut stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            guard.disarm();
            if let Some(pid) = pid {
                let _ = try_kill_pid(pid);
            }
            log.footer("Killed — stderr could not be captured", started);
            cleanup_command_stream(&request_id);
            return Err("Failed to capture stderr".to_string());
        }
    };

    let mut stdout_bytes = vec![0u8; SHELL_STREAM_READ_BUF];
    let mut stderr_bytes = vec![0u8; SHELL_STREAM_READ_BUF];
    // Decode per stream, not per read: a 16 KB boundary can land in the middle
    // of a multi-byte character, and PowerShell / cmd are not UTF-8 at all.
    let mut stdout_decode = crate::shell::text::StreamDecoder::new();
    let mut stderr_decode = crate::shell::text::StreamDecoder::new();

    let mut stdout_done = false;
    let mut stderr_done = false;

    let mut wait_fut = Box::pin(child.wait());
    let mut timeout_fut = Box::pin(tokio::time::sleep(timeout));
    let mut flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));

    // Set by whichever branch ends the run, and written to the log as the last
    // line before returning.
    //
    // Not an `Option` with a "reason unrecorded" fallback: every `break` below
    // assigns it first and the natural-exit branch returns instead, so the
    // compiler proves the loop cannot fall out without a cause. Keeping the
    // fallback meant carrying an unreachable branch that claimed the logs could
    // be incomplete when they cannot.
    let ending: String;
    // Distinguishes "we killed it for running too long" from "the user or the
    // agent stopped it" — the two reach the same exit below but mean opposite
    // things to whoever reads the result.
    let mut timed_out = false;
    // Applied once. The flag lives out here because the check is per-iteration
    // and re-arming the timer on every pass would push the deadline forward
    // forever — which is the same bug in the opposite direction.
    let mut detach_applied = false;

    loop {
        if let Some(reason) = command_stream_stop(&request_id) {
            if let Some(pid) = pid {
                let _ = try_kill_pid(pid);
            }
            ending = reason.describe().to_string();
            break;
        }

        // Handed to the background mid-run. The loop does NOT end here — it is
        // what keeps the pipes drained (a full pipe blocks the child), keeps
        // the log fed, and still reports the real ending. Only two things
        // change: the deadline is lifted, because it existed to protect a
        // caller that has stopped waiting, and the log says where the reader
        // went. Same "effectively no cap" the background tools already use.
        //
        // Nothing is written to the log here. The log IS the command's output —
        // it is what the detached result hands back and what `shell_read_output`
        // reads later — so a note about the hand-off would appear as a line the
        // command printed, which it did not. The ending still gets its footer,
        // and who was waiting is not a fact about what ran.
        if !detach_applied && command_stream_detached(&request_id) {
            detach_applied = true;
            timeout = std::time::Duration::from_millis(DETACHED_LIFETIME_MS);
            timeout_fut = Box::pin(tokio::time::sleep(timeout));
        }

        tokio::select! {
            _ = &mut timeout_fut => {
                if let Some(pid) = pid {
                    let _ = try_kill_pid(pid);
                }
                flush_shell_pending(app.as_ref(), &request_id, &mut stdout_pending, &mut stderr_pending);
                if let Some(app) = &app {
                    let _ = app.emit(
                        &format!("shell-stream-error-{}", request_id),
                        format!("Command timed out after {}ms", timeout.as_millis()),
                    );
                }
                ending = format!("Timed out after {}ms", timeout.as_millis());
                timed_out = true;
                break;
            }
            _ = &mut flush_fut => {
                flush_shell_pending(app.as_ref(), &request_id, &mut stdout_pending, &mut stderr_pending);
                flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));
            }
            read = stdout.read(&mut stdout_bytes), if !stdout_done => {
                match read {
                    Ok(0) => { stdout_done = true; }
                    Ok(n) => {
                        let data = stdout_decode.push(&stdout_bytes[..n]);
                        log.write(&data);
                        stdout_buf.push_str(&data);
                        stdout_pending.push_str(&data);
                        if stdout_pending.len() + stderr_pending.len() >= SHELL_STREAM_FLUSH_BYTES {
                            flush_shell_pending(app.as_ref(), &request_id, &mut stdout_pending, &mut stderr_pending);
                            flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));
                        }
                    }
                    Err(e) => {
                        stdout_done = true;
                        flush_shell_pending(app.as_ref(), &request_id, &mut stdout_pending, &mut stderr_pending);
                        if let Some(app) = &app {
                            let _ = app.emit(
                                &format!("shell-stream-error-{}", request_id),
                                format!("stdout read error: {}", e),
                            );
                        }
                    }
                }
            }
            read = stderr.read(&mut stderr_bytes), if !stderr_done => {
                match read {
                    Ok(0) => { stderr_done = true; }
                    Ok(n) => {
                        let data = stderr_decode.push(&stderr_bytes[..n]);
                        log.write(&data);
                        stderr_buf.push_str(&data);
                        stderr_pending.push_str(&data);
                        if stdout_pending.len() + stderr_pending.len() >= SHELL_STREAM_FLUSH_BYTES {
                            flush_shell_pending(app.as_ref(), &request_id, &mut stdout_pending, &mut stderr_pending);
                            flush_fut = Box::pin(tokio::time::sleep(SHELL_STREAM_FLUSH_INTERVAL));
                        }
                    }
                    Err(e) => {
                        stderr_done = true;
                        flush_shell_pending(app.as_ref(), &request_id, &mut stdout_pending, &mut stderr_pending);
                        if let Some(app) = &app {
                            let _ = app.emit(
                                &format!("shell-stream-error-{}", request_id),
                                format!("stderr read error: {}", e),
                            );
                        }
                    }
                }
            }
            status = &mut wait_fut => {
                let (exit_code, success) = match status {
                    Ok(s) => (s.code(), Some(s.success())),
                    Err(_) => (None, None),
                };

                // The shell is gone; drain what remains of its pipes inside a
                // grace window instead of waiting for EOF. A pipe that will
                // not close is held by a process the command started and left
                // behind — for a server that EOF never comes, and waiting for
                // it held a FINISHED command's tool call (and the model) for
                // as long as the server lived. This branch is also past the
                // timeout race, so nothing else could end the wait.
                let (tail, stdout_held) = drain_exited_pipe(&mut stdout, stdout_done).await;
                if !tail.is_empty() {
                    let data = stdout_decode.push(&tail);
                    log.write(&data);
                    stdout_buf.push_str(&data);
                    stdout_pending.push_str(&data);
                }

                let (tail, stderr_held) = drain_exited_pipe(&mut stderr, stderr_done).await;
                if !tail.is_empty() {
                    let data = stderr_decode.push(&tail);
                    log.write(&data);
                    stderr_buf.push_str(&data);
                    stderr_pending.push_str(&data);
                }

                // Second witness: job membership. A held pipe only catches
                // survivors that inherited handles — `Start-Process` goes
                // through ShellExecute, which shares none, so its survivor
                // closes no pipe and was invisible here (observed live: a
                // launcher was told "nothing is left running" over a process
                // the very next tool call could see). Membership also survives
                // dead intermediates, which the parent-pid fallback does not:
                // git-bash wraps the real shell, so a plain ppid walk loses
                // the chain the moment the wrapper dies.
                let survivors: Vec<String> = match &shell_job {
                    Some(job) => job
                        .survivors()
                        .iter()
                        .map(process_tracking::Survivor::describe)
                        .collect(),
                    None => match pid {
                        Some(shell_pid) => {
                            tokio::task::spawn_blocking(move || surviving_descendants(shell_pid))
                                .await
                                .unwrap_or_default()
                        }
                        None => Vec::new(),
                    },
                };
                let left_running = stdout_held || stderr_held || !survivors.is_empty();

                // Anything still held back was never valid UTF-8 — emit it
                // rather than silently dropping the last characters.
                for (decoder, buf, pending) in [
                    (&mut stdout_decode, &mut stdout_buf, &mut stdout_pending),
                    (&mut stderr_decode, &mut stderr_buf, &mut stderr_pending),
                ] {
                    let rest = decoder.finish();
                    if !rest.is_empty() {
                        log.write(&rest);
                        buf.push_str(&rest);
                        pending.push_str(&rest);
                    }
                }

                // Final flush of any remaining pending output, then emit a
                // single done marker so listeners can detect completion.
                flush_shell_pending(app.as_ref(), &request_id, &mut stdout_pending, &mut stderr_pending);
                if let Some(app) = &app {
                    let _ = app.emit(
                        &format!("shell-stream-{}", request_id),
                        CommandStreamChunk {
                            stream: "meta".to_string(),
                            data: String::new(),
                            done: true,
                            exit_code,
                            success,
                        },
                    );
                }

                let exit_summary = match exit_code {
                    Some(0) => "Exited normally (code 0)".to_string(),
                    Some(code) => format!("Exited with code {code}"),
                    // No code on Windows means the process was terminated
                    // by something outside this run — say so rather than
                    // reporting a success it never reported.
                    None => "Ended without reporting an exit code".to_string(),
                };
                log.footer(
                    &if left_running {
                        format!(
                            "{exit_summary} — a process it started is still running and holding \
                             the output stream, untracked"
                        )
                    } else {
                        exit_summary
                    },
                    started,
                );
                if let Some(app) = &app {
                    emit_process_ended(app, &request_id, exit_code, "exited");
                }
                guard.disarm();
                cleanup_command_stream(&request_id);
                return Ok(CommandOutput {
                    stdout: stdout_buf,
                    stderr: stderr_buf,
                    exit_code,
                    success: success.unwrap_or(false),
                    timed_out: false,
                    left_running,
                    survivors,
                });
            }
        }

        if stdout_done && stderr_done {
            if let Some(reason) = command_stream_stop(&request_id) {
                ending = reason.describe().to_string();
                break;
            }
        }
    }

    flush_shell_pending(
        app.as_ref(),
        &request_id,
        &mut stdout_pending,
        &mut stderr_pending,
    );

    // Every path out of the loop is a termination, so the listener needs the
    // same done marker the natural-exit branch sends. Without it a cancelled
    // stream's view stays spinning on a process that is already dead.
    if let Some(app) = &app {
        let _ = app.emit(
            &format!("shell-stream-{}", request_id),
            CommandStreamChunk {
                stream: "meta".to_string(),
                data: String::new(),
                done: true,
                exit_code: None,
                success: Some(false),
            },
        );
    }

    log.footer(&ending, started);
    // Every path down here ended the process rather than watching it finish,
    // so the row settles as stopped — matching what the log now says.
    if let Some(app) = &app {
        emit_process_ended(app, &request_id, None, "stopped");
    }
    guard.disarm();
    cleanup_command_stream(&request_id);
    Ok(CommandOutput {
        stdout: stdout_buf,
        stderr: stderr_buf,
        // No exit code on a killed process: it never reported one. This used to
        // claim `Some(1)`, which reads as "the command failed with code 1" and
        // sent the model off fixing a command that had merely run long.
        exit_code: None,
        success: false,
        timed_out,
        // Killed as a tree — nothing survives a stop or a timeout.
        left_running: false,
        survivors: Vec::new(),
    })
}

/// Get system information (Cursor-style detailed info)
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    tokio::task::spawn_blocking(move || {
        // These helpers use blocking I/O / process execution, so run off the async runtime.
        let os_version = get_os_version();
        let shell = get_default_shell();

        SystemInfo {
            os,
            os_version,
            arch,
            hostname: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
            shell,
        }
    })
    .await
    .map_err(|e| format!("Failed to collect system info: {}", e))
}

/// Get OS version string
fn get_os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        // Try to get Windows version from registry or environment
        if let Ok(output) = Command::new("cmd")
            .args(["/c", "ver"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let version_str = String::from_utf8_lossy(&output.stdout);
            // Parse "Microsoft Windows [Version 10.0.26200.2605]"
            if let Some(start) = version_str.find("Version ") {
                if let Some(end) = version_str[start..].find(']') {
                    let ver = &version_str[start + 8..start + end];
                    // Return just major.minor.build (e.g., "10.0.26200")
                    let parts: Vec<&str> = ver.split('.').collect();
                    if parts.len() >= 3 {
                        return format!("{}.{}.{}", parts[0], parts[1], parts[2]);
                    }
                    return ver.to_string();
                }
            }
        }
        "unknown".to_string()
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("sw_vers").arg("-productVersion").output() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        "unknown".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        // Try to read from /etc/os-release
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            for line in content.lines() {
                if line.starts_with("VERSION_ID=") {
                    return line
                        .trim_start_matches("VERSION_ID=")
                        .trim_matches('"')
                        .to_string();
                }
            }
        }
        // Fallback to uname
        if let Ok(output) = Command::new("uname").arg("-r").output() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        "unknown".to_string()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown".to_string()
    }
}

/// Get default shell path
fn get_default_shell() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Check for PowerShell 7 first, then fall back to PowerShell 5, then cmd
        let ps7_paths = [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files (x86)\PowerShell\7\pwsh.exe",
        ];

        for path in ps7_paths {
            if Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        // Check for Windows PowerShell
        if let Ok(system_root) = std::env::var("SystemRoot") {
            let ps5_path = format!(
                r"{}\System32\WindowsPowerShell\v1.0\powershell.exe",
                system_root
            );
            if Path::new(&ps5_path).exists() {
                return Some(ps5_path);
            }
        }

        // Fallback to cmd.exe
        Some(
            std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string()),
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix-like: check SHELL env var
        std::env::var("SHELL")
            .ok()
            .or_else(|| Some("/bin/sh".to_string()))
    }
}

/// Create a new file
#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Check if file already exists
    if file_path.exists() {
        return Err(format!("File already exists: {}", path));
    }

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    // Create empty file
    fs::File::create(file_path).map_err(|e| format!("Failed to create file: {}", e))?;

    Ok(())
}

/// Create a new folder
#[tauri::command]
pub async fn create_folder(path: String) -> Result<(), String> {
    let dir_path = Path::new(&path);

    // Check if folder already exists
    if dir_path.exists() {
        return Err(format!("Folder already exists: {}", path));
    }

    fs::create_dir_all(dir_path).map_err(|e| format!("Failed to create folder: {}", e))
}

/// Delete a file or folder
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let result = if target_path.is_dir() {
        // Invalidate all cached files under this directory
        crate::file_cache::get_file_cache().invalidate_prefix(&path);
        fs::remove_dir_all(target_path).map_err(|e| format!("Failed to delete folder: {}", e))
    } else {
        // Invalidate the specific file
        crate::file_cache::get_file_cache().invalidate(&path);
        fs::remove_file(target_path).map_err(|e| format!("Failed to delete file: {}", e))
    };

    result
}

/// Rename a file or folder
#[tauri::command]
pub async fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err(format!("Path does not exist: {}", old_path));
    }

    if new.exists() {
        return Err(format!("Destination already exists: {}", new_path));
    }

    // Invalidate old path from cache (it's being renamed)
    let cache = crate::file_cache::get_file_cache();
    if old.is_dir() {
        cache.invalidate_prefix(&old_path);
    } else {
        cache.invalidate(&old_path);
    }

    fs::rename(old, new).map_err(|e| format!("Failed to rename: {}", e))
}

/// Copy a file or folder to a new location
#[tauri::command]
pub async fn copy_path(source: String, destination: String) -> Result<(), String> {
    let src = Path::new(&source);
    let dest = Path::new(&destination);

    if !src.exists() {
        return Err(format!("Source does not exist: {}", source));
    }

    if dest.exists() {
        return Err(format!("Destination already exists: {}", destination));
    }

    // Create parent directories if needed
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }

    if src.is_file() {
        fs::copy(src, dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    } else if src.is_dir() {
        copy_dir_recursive(src, dest)?;
    }

    Ok(())
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create directory: {}", e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }

    Ok(())
}

/// Get the current workspace root directory
#[tauri::command]
pub async fn get_workspace_root() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get current directory: {}", e))
}

#[derive(Debug, Serialize, Clone)]
pub struct FsEventPayload {
    pub paths: Vec<String>,
    pub kind: String,
}

/// Subtrees that produce constant churn but never carry user-relevant
/// content. Any path whose components contain one of these names is
/// dropped before the watcher emits an `fs-changed` event.
///
/// Keep this list tight — anything we add here will go invisible to
/// the file explorer's auto-refresh + the in-IDE git status reload.
const WATCH_IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".parcel-cache",
    ".pnpm-store",
    ".yarn",
];

/// File suffixes that are always editor/build noise (lock files,
/// SQLite WAL/SHM, sourcemap rebuilds, …). Filtering these costs us
/// nothing because they're never opened in the editor.
const WATCH_IGNORED_FILE_SUFFIXES: &[&str] = &[
    ".lock",
    ".tmp",
    ".swp",
    ".swo",
    "~",
    ".db-wal",
    ".db-shm",
    ".sqlite-wal",
    ".sqlite-shm",
];

#[inline]
pub fn is_ignored_watch_path(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if WATCH_IGNORED_FILE_SUFFIXES
            .iter()
            .any(|suffix| file_name.ends_with(suffix))
        {
            return true;
        }
    }
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| WATCH_IGNORED_DIR_NAMES.contains(&name))
            .unwrap_or(false)
    })
}

/// Start a filesystem watcher that emits `fs-changed` events to the frontend.
#[tauri::command]
pub async fn start_fs_watcher(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Watch path does not exist: {}", path));
    }

    // Stop existing watcher if any
    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = None;
    }

    let app_handle = app.clone();
    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            // Skip Access events outright — they fire on every read
            // (mtime/atime stat) and the frontend ignores them anyway.
            // Without this filter, running `git status` or HMR scans
            // alone produces thousands of IPC roundtrips per second.
            if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
                return;
            }

            // Drop events that touch only IGNORED subtrees (`.git/`,
            // `node_modules/`, `target/`, `build/`, `dist/`, etc).
            // Cargo, pnpm and Vite churn these directories thousands
            // of times during a dev rebuild and every modification
            // would otherwise:
            //   1. Invalidate the Rust file cache for that path
            //   2. Schedule a debounced `git_get_status` reload
            // Both are pure overhead — none of those files are user
            // content. We filter event-level (not path-level) so that
            // a single mixed event still fires for the user-content
            // paths it carries.
            let kept_paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !is_ignored_watch_path(p))
                .map(|p| p.to_string_lossy().to_string())
                .collect();

            if kept_paths.is_empty() {
                return;
            }

            let kind_str = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "remove",
                EventKind::Any => "any",
                EventKind::Access(_) => "access",
                EventKind::Other => "other",
            };

            let _ = app_handle.emit(
                "fs-changed",
                FsEventPayload {
                    paths: kept_paths,
                    kind: kind_str.to_string(),
                },
            );
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .configure(Config::default().with_compare_contents(false))
        .map_err(|e| format!("Failed to configure watcher: {}", e))?;

    watcher
        .watch(target, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    {
        let mut guard = get_watcher_handle()
            .lock()
            .map_err(|e| format!("Failed to lock watcher: {}", e))?;
        *guard = Some(watcher);
    }

    Ok(())
}

/// Stop the filesystem watcher
#[tauri::command]
pub async fn stop_fs_watcher() -> Result<(), String> {
    let mut guard = get_watcher_handle()
        .lock()
        .map_err(|e| format!("Failed to lock watcher: {}", e))?;
    *guard = None;
    Ok(())
}

/// Reveal a file or folder in the system file explorer
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Determine the path to reveal (parent folder if it's a file)
    #[allow(unused_variables)]
    let reveal_path = if target_path.is_file() {
        target_path.parent().unwrap_or(target_path)
    } else {
        target_path
    };

    #[cfg(target_os = "windows")]
    {
        // On Windows, use explorer with /select to highlight the item
        let select_path = if target_path.is_file() {
            format!("/select,{}", path)
        } else {
            path.clone()
        };

        Command::new("explorer")
            .arg(&select_path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open first, then fall back to common file managers
        if let Err(xdg_error) = Command::new("xdg-open").arg(reveal_path).spawn() {
            Command::new("nautilus")
                .arg("--select")
                .arg(&path)
                .spawn()
                .map_err(|nautilus_error| {
                    format!(
                        "Failed to open a file manager (xdg-open: {xdg_error}; nautilus: {nautilus_error})"
                    )
                })?;
        }
    }

    Ok(())
}

/// Open a terminal at the specified path
#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);

    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", target_path.display()));
    }

    // Use the path directly if it's a directory, otherwise use its parent
    let terminal_path = if target_path.is_dir() {
        target_path.to_path_buf()
    } else {
        target_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| target_path.to_path_buf())
    };

    #[cfg(target_os = "windows")]
    {
        // Try Windows Terminal first, then fall back to PowerShell.
        let wt_result = Command::new("wt")
            .arg("-d")
            .arg(terminal_path.to_string_lossy().to_string())
            .spawn();

        if wt_result.is_err() {
            // Fall back to PowerShell in a new window. `current_dir` avoids
            // interpolating a user path into a command string (and correctly
            // handles folders containing quotes or shell metacharacters).
            Command::new("powershell")
                .arg("-NoLogo")
                .arg("-NoExit")
                .current_dir(&terminal_path)
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&terminal_path)
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
        let mut opened = false;

        for terminal in terminals {
            let result = match terminal {
                "gnome-terminal" => Command::new(terminal)
                    .arg("--working-directory")
                    .arg(terminal_path.to_string_lossy().to_string())
                    .spawn(),
                "konsole" => Command::new(terminal)
                    .arg("--workdir")
                    .arg(terminal_path.to_string_lossy().to_string())
                    .spawn(),
                _ => Command::new(terminal).current_dir(&terminal_path).spawn(),
            };

            if result.is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            return Err("No supported terminal emulator found".to_string());
        }
    }

    Ok(())
}

// =============================================================================
// BATCH FILE OPERATIONS (Performance Optimized)
// =============================================================================

use std::collections::HashMap;

/// Read multiple files in a single IPC call (reduces overhead dramatically)
/// Returns a map of path -> content (or error message)
#[tauri::command]
pub async fn read_files_batch(paths: Vec<String>) -> HashMap<String, Result<String, String>> {
    let fallback_paths = paths.clone();
    match tokio::task::spawn_blocking(move || crate::file_cache::read_files_batch_cached(paths))
        .await
    {
        Ok(results) => results,
        Err(error) => fallback_paths
            .into_iter()
            .map(|path| (path, Err(format!("Batch file read task failed: {}", error))))
            .collect(),
    }
}

/// Invalidate a specific file or directory prefix from the cache
/// Call this after external file modifications
#[tauri::command]
pub async fn invalidate_file_cache(path: String, is_prefix: bool) -> Result<(), String> {
    let cache = crate::file_cache::get_file_cache();
    if is_prefix {
        cache.invalidate_prefix(&path);
    } else {
        cache.invalidate(&path);
    }
    Ok(())
}

/// Get cache statistics for debugging
#[tauri::command]
pub async fn get_cache_stats() -> (usize, usize) {
    crate::file_cache::get_file_cache().stats()
}

// =============================================================================
// CLI COMMANDS
// =============================================================================

/// Install the Aurora CLI to system PATH
/// This allows using `aurora .` from any terminal
#[tauri::command]
pub async fn install_aurora_cli() -> Result<String, String> {
    crate::cli::install::install_cli().map(|_| "Aurora CLI installed successfully".to_string())
}

/// Check if the Aurora CLI is installed
#[tauri::command]
pub async fn is_aurora_cli_installed() -> Result<bool, String> {
    crate::cli::install::is_cli_installed()
}

/// Uninstall the Aurora CLI from system PATH
#[tauri::command]
pub async fn uninstall_aurora_cli() -> Result<String, String> {
    crate::cli::install::uninstall_cli().map(|_| "Aurora CLI uninstalled successfully".to_string())
}

/// Install Aurora into the Windows Explorer context menu
#[tauri::command]
pub async fn install_aurora_context_menu() -> Result<String, String> {
    crate::cli::install::install_context_menu()
        .map(|_| "Aurora context menu installed successfully".to_string())
}

/// Check whether the Aurora context menu is installed
#[tauri::command]
pub async fn is_aurora_context_menu_installed() -> Result<bool, String> {
    crate::cli::install::is_context_menu_installed()
}

/// Remove Aurora from the Windows Explorer context menu
#[tauri::command]
pub async fn uninstall_aurora_context_menu() -> Result<String, String> {
    crate::cli::install::uninstall_context_menu()
        .map(|_| "Aurora context menu removed successfully".to_string())
}

/// App-state slot holding the CLI open request that this process was
/// launched with (if any). Populated once at startup in
/// `aurora_lib::run_with_args` and consumed exactly once by the
/// frontend's bootstrap effect via [`cli_take_pending_open_request`].
///
/// The slot exists because the prior design pushed a `cli-open` event
/// 500 ms after window creation — but Tauri events are not buffered, so
/// if the JS bundle wasn't ready in time the event was silently dropped
/// and "last workspace" restore won the race. Pull-on-mount eliminates
/// that race entirely.
#[derive(Default)]
pub struct PendingCliOpenState(pub Mutex<Option<crate::cli::CliOpenRequest>>);

/// The presence guard advertising that an Aurora is running.
///
/// Held purely for its lifetime — nothing ever reads it. It lives in managed
/// state because that is what keeps it alive for the process: dropped, the
/// name is released and every `aurora agent` in every terminal starts
/// launching a second Aurora on top of this one.
///
/// `None` when the OS refused the name. Not fatal — see
/// [`crate::cli_delegate::presence::hold`].
/// The `dead_code` allow is the point of the type, not a concession to it:
/// this is an RAII handle whose only job is to exist. rustc is right that
/// nothing reads the field and wrong that removing it would be harmless.
#[allow(dead_code)]
pub struct CliPresence(pub Option<single_instance::SingleInstance>);

/// The filesystem watcher over the CLI task directory.
///
/// Same reason as [`CliPresence`]: `notify` stops watching the moment the
/// watcher is dropped, so it has to be owned by something that outlives
/// startup. Behind a `Mutex` only because managed state must be `Sync` and
/// `RecommendedWatcher` is not.
/// Held, never read — see the note on [`CliPresence`].
#[allow(dead_code)]
pub struct CliTaskWatcher(pub Mutex<Option<notify::RecommendedWatcher>>);

/// Take (and clear) the pending CLI open request for this process.
///
/// Returns `Some(request)` on the first call after the app was launched
/// with a path/file arg, then `None` on every subsequent call. The
/// frontend uses this from its bootstrap effect to decide whether to
/// honour a CLI-supplied workspace or fall back to the saved
/// "last workspace" in the database.
#[tauri::command]
pub fn cli_take_pending_open_request(
    state: tauri::State<'_, PendingCliOpenState>,
) -> Option<crate::cli::CliOpenRequest> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn globs(value: &str) -> Vec<String> {
        parse_glob_patterns(&Some(value.to_string()))
    }

    /// `process_is_alive` is what lets a kill report the truth when
    /// `taskkill /T` exits non-zero over a tree member it could not touch. It
    /// is only worth anything if it actually distinguishes the two states, so
    /// this drives a real process through both.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_killed_process_reads_as_gone_and_a_live_one_does_not() {
        // `pause` is a cmd BUILT-IN blocking on stdin, and the pipe stays open
        // for as long as the `Child` owns it. No external binary, so the test
        // cannot pass vacuously on a runner with a thin PATH — the first
        // version of it used `ping`, which was not on PATH here, exited
        // immediately, and made every assertion below true for the wrong
        // reason.
        let mut child = Command::new("cmd")
            .args(["/c", "pause"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn a process to kill");
        let pid = child.id();

        // Long enough that a process which failed to start has already gone,
        // so "alive" below is a real observation rather than a head start.
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            process_is_alive(pid),
            "a blocked process must read as alive — if this fails the test is proving nothing"
        );
        try_kill_pid(pid).expect("killing a plain child must succeed");
        assert!(
            !process_is_alive(pid),
            "the process must be gone once taskkill has run"
        );
        // Reaped so the test leaves no zombie behind on the runner.
        let _ = child.wait();

        // And the case the fix is FOR: a pid that no longer exists is not
        // something a kill left running, so it must never read as alive.
        assert!(!process_is_alive(pid), "a reaped pid must read as gone");
    }

    /// The regression this whole function exists for: a comma inside `{…}` is
    /// glob syntax, not a list separator. Splitting on it handed ripgrep
    /// `**/*.{ts` and it failed with "unclosed alternate group".
    #[test]
    fn brace_alternation_survives_as_one_glob() {
        assert_eq!(globs("**/*.{ts,tsx}"), vec!["**/*.{ts,tsx}"]);
        assert_eq!(globs("**/*.{ts,tsx,js,jsx}"), vec!["**/*.{ts,tsx,js,jsx}"]);
    }

    #[test]
    fn top_level_commas_still_separate_globs() {
        assert_eq!(
            globs("src/**/*.ts, tests/**/*.ts"),
            vec!["src/**/*.ts", "tests/**/*.ts"],
        );
    }

    #[test]
    fn separates_at_the_top_level_while_preserving_inner_commas() {
        assert_eq!(
            globs("src/**/*.{ts,tsx}, docs/**/*.{md,mdx}"),
            vec!["src/**/*.{ts,tsx}", "docs/**/*.{md,mdx}"],
        );
    }

    #[test]
    fn handles_nested_braces() {
        assert_eq!(globs("src/{a,b/{c,d}}/*.rs"), vec!["src/{a,b/{c,d}}/*.rs"],);
    }

    /// A comma inside a character class is a literal comma, not a separator.
    #[test]
    fn character_classes_keep_their_commas_and_braces() {
        assert_eq!(globs("file[a,b].rs"), vec!["file[a,b].rs"]);
        assert_eq!(globs("weird[{].rs"), vec!["weird[{].rs"]);
    }

    #[test]
    fn escaped_characters_are_not_treated_as_syntax() {
        assert_eq!(globs(r"a\,b.rs"), vec![r"a\,b.rs"]);
        assert_eq!(globs(r"a\{b,c.rs"), vec![r"a\{b", "c.rs"]);
    }

    /// Malformed input is forwarded verbatim so ripgrep can name the real
    /// problem — repairing it here would only guess at the intent.
    #[test]
    fn unbalanced_braces_pass_through_untouched() {
        assert_eq!(globs("**/*.{ts"), vec!["**/*.{ts"]);
    }

    #[test]
    fn blank_and_missing_values_yield_no_globs() {
        assert!(parse_glob_patterns(&None).is_empty());
        assert!(globs("").is_empty());
        assert!(globs("   ").is_empty());
        assert!(globs(" , , ").is_empty());
    }

    #[test]
    fn trims_whitespace_around_each_glob() {
        assert_eq!(
            globs("  **/*.rs  ,  **/*.toml "),
            vec!["**/*.rs", "**/*.toml"]
        );
    }

    #[test]
    fn keeps_negated_globs_intact() {
        assert_eq!(
            globs("**/*.{ts,tsx}, !**/node_modules/**"),
            vec!["**/*.{ts,tsx}", "!**/node_modules/**"],
        );
    }

    /// Searching runs inside the directory so slash-bearing globs anchor, which
    /// makes ripgrep report relative paths. Callers still need real ones.
    #[test]
    fn rejoins_relative_rg_paths_onto_the_search_directory() {
        let dir = PathBuf::from("E:/repo");
        for reported in ["./src/main.rs", ".\\src/main.rs", "src/main.rs"] {
            let out = absolutize_rg_path(Some(&dir), reported.to_string());
            assert!(
                out.starts_with("E:/repo") && out.ends_with("main.rs"),
                "unexpected {out} for {reported}",
            );
        }
    }

    /// A single-file search keeps the operand form, so its paths are already
    /// whatever the caller passed in and must not be rewritten.
    #[test]
    fn single_file_searches_keep_their_reported_path() {
        assert_eq!(
            absolutize_rg_path(None, "E:/repo/src/main.rs".to_string()),
            "E:/repo/src/main.rs",
        );
    }

    #[test]
    fn a_bare_dot_resolves_to_the_search_directory_itself() {
        let dir = PathBuf::from("E:/repo");
        assert_eq!(absolutize_rg_path(Some(&dir), "./".to_string()), "E:/repo");
    }

    // ---- `max_results` semantics -------------------------------------------
    //
    // These run the REAL ripgrep. `max_results` used to be forwarded to
    // `--max-count`, which is ripgrep's per-FILE limit: asking for 5 results
    // could collect hundreds, and the reported total was then clamped to the
    // cap, so the response claimed "5 matches" when thousands existed. Nothing
    // capped `files_with_matches` or `count` at all.

    fn cap_fixture(name: &str, files: usize, hits_per_file: usize) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aurora-grep-cap-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        for file in 0..files {
            let body = (0..hits_per_file)
                .map(|hit| format!("let needle_{file}_{hit} = 1;"))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(dir.join(format!("f{file}.rs")), body).expect("fixture file");
        }
        dir
    }

    fn search(dir: &PathBuf, mode: &str, max_results: u32) -> RipgrepSearchResponse {
        let request = RipgrepSearchRequest {
            case_insensitive: None,
            context_lines: None,
            glob: None,
            is_regex: Some(false),
            max_results: Some(max_results),
            output_mode: Some(mode.to_string()),
            path: dir.to_string_lossy().to_string(),
            pattern: "needle_".to_string(),
            timeout_ms: Some(30_000),
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(ripgrep_search(request))
            .expect("search ran")
    }

    #[test]
    fn content_mode_caps_total_matches_not_matches_per_file() {
        // 4 files x 10 hits = 40 matches available; ask for 6.
        let dir = cap_fixture("content", 4, 10);
        let response = search(&dir, "content", 6);
        let matches = response.matches.expect("content mode returns matches");

        assert_eq!(matches.len(), 6, "the cap is a TOTAL, not a per-file limit");
        assert_eq!(response.returned, Some(6));
        assert_eq!(response.truncated, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_search_names_the_cap_and_the_way_out() {
        let dir = cap_fixture("message", 4, 10);
        let response = search(&dir, "content", 6);
        let message = response.message.expect("truncation explains itself");

        assert!(message.contains("first 6"), "{message}");
        assert!(message.contains("max_results"), "{message}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The old code reported `total_matches.min(max_results)` — the cap itself,
    /// dressed as a measurement. A truncated search stops one unit past the cap,
    /// so it genuinely does not know the total; reporting the handful it happened
    /// to see would repeat the same lie in a new shape. It reports nothing, and
    /// `returned` + `truncated` carry the truth instead.
    #[test]
    fn a_truncated_search_reports_no_total_rather_than_a_fabricated_one() {
        let dir = cap_fixture("totals", 4, 10);
        let response = search(&dir, "content", 6);

        assert_eq!(response.truncated, Some(true));
        assert_eq!(response.returned, Some(6));
        assert_eq!(
            response.total_matches, None,
            "a stopped search must not publish a total it never counted",
        );
        assert_eq!(response.total_files, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The complement: a search that finished DOES know, and must say so.
    #[test]
    fn a_complete_search_reports_exact_totals() {
        let dir = cap_fixture("exact-totals", 4, 10);
        let response = search(&dir, "content", 500);

        assert_eq!(response.truncated, Some(false));
        assert_eq!(response.total_matches, Some(40));
        assert_eq!(response.total_files, Some(4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_with_matches_is_capped_too() {
        let dir = cap_fixture("files", 6, 2);
        let response = search(&dir, "files_with_matches", 3);
        let files = response.files.expect("files mode returns files");

        assert_eq!(files.len(), 3);
        assert_eq!(response.returned, Some(3));
        assert_eq!(response.truncated, Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn count_mode_is_capped_and_its_counts_stay_whole() {
        let dir = cap_fixture("counts", 6, 4);
        let response = search(&dir, "count", 3);
        let counts = response.counts.expect("count mode returns counts");

        assert_eq!(counts.len(), 3);
        // A file only appears once ripgrep has finished it, so a capped search
        // never reports a half-counted file.
        for entry in &counts {
            assert_eq!(entry.count, 4, "{} was counted mid-file", entry.file);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_search_that_fits_is_not_marked_truncated() {
        let dir = cap_fixture("fits", 2, 3);
        let response = search(&dir, "content", 50);

        assert_eq!(response.returned, Some(6));
        assert_eq!(response.total_matches, Some(6));
        assert_eq!(response.truncated, Some(false));
        assert!(response.message.is_none(), "nothing to explain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Exactly `max_results` results is a COMPLETE search, not a truncated one.
    /// Reading one unit past the cap is what makes that distinguishable.
    #[test]
    fn landing_exactly_on_the_cap_is_not_truncation() {
        let dir = cap_fixture("exact", 2, 3);
        let response = search(&dir, "content", 6);

        assert_eq!(response.returned, Some(6));
        assert_eq!(response.truncated, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pattern that starts with `-` used to be eaten by ripgrep as flags
    /// ("rg: unrecognized flag --color-border-…") because it was passed as a
    /// bare positional. `-e` makes any pattern safe — this pins the original
    /// failing shape, in both regex and fixed-string modes.
    #[test]
    fn a_pattern_starting_with_dashes_is_not_parsed_as_flags() {
        let dir = std::env::temp_dir().join("aurora-grep-dash-pattern");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        std::fs::write(
            dir.join("tokens.css"),
            ":root {\n  --color-border-success: #0a0;\n  --color-border-danger: #a00;\n}\n",
        )
        .expect("fixture file");

        for (pattern, is_regex) in [
            ("--color-border-(success|danger)", true),
            ("--color-border-success", false),
        ] {
            let request = RipgrepSearchRequest {
                case_insensitive: None,
                context_lines: None,
                glob: None,
                is_regex: Some(is_regex),
                max_results: Some(10),
                output_mode: Some("content".to_string()),
                path: dir.to_string_lossy().to_string(),
                pattern: pattern.to_string(),
                timeout_ms: Some(30_000),
            };
            let response = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(ripgrep_search(request))
                .expect("search ran");

            assert_eq!(
                response.success, true,
                "pattern {pattern:?} failed: {:?}",
                response.error
            );
            let expected = if is_regex { 2 } else { 1 };
            assert_eq!(
                response.total_matches,
                Some(expected),
                "pattern {pattern:?} should match",
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_result_explains_itself_rather_than_going_silent() {
        let dir = cap_fixture("empty", 1, 1);
        let request = RipgrepSearchRequest {
            case_insensitive: None,
            context_lines: None,
            glob: None,
            is_regex: Some(false),
            max_results: Some(10),
            output_mode: Some("content".to_string()),
            path: dir.to_string_lossy().to_string(),
            pattern: "no_such_text_anywhere".to_string(),
            timeout_ms: Some(30_000),
        };
        let response = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(ripgrep_search(request))
            .expect("search ran");

        assert_eq!(response.success, true);
        assert_eq!(response.total_matches, Some(0));
        assert_eq!(response.truncated, Some(false));
        assert!(response.message.is_some(), "an empty result must say why");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn read_back(log: ProcessLog, path: &std::path::Path) -> String {
        drop(log);
        std::fs::read_to_string(path).expect("log readable")
    }

    #[test]
    fn footer_closes_a_log_that_ends_mid_line() {
        let file = std::env::temp_dir().join("aurora-log-midline");
        let _ = std::fs::remove_file(&file);
        let path = file.to_string_lossy().to_string();

        let mut log = ProcessLog::open(Some(&path));
        // A killed process rarely gets to finish its last line.
        log.write("line 1\nline 2");
        log.footer("Stopped by the user", std::time::Instant::now());

        let text = read_back(log, &file);
        assert!(
            text.contains("line 2\n[aurora] Stopped by the user"),
            "footer must start its own line: {text:?}"
        );
        assert!(text.ends_with("No further output.\n"));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn footer_does_not_insert_a_blank_line_after_clean_output() {
        let file = std::env::temp_dir().join("aurora-log-clean");
        let _ = std::fs::remove_file(&file);
        let path = file.to_string_lossy().to_string();

        let mut log = ProcessLog::open(Some(&path));
        log.write("done\n");
        log.footer("Exited normally (code 0)", std::time::Instant::now());

        let text = read_back(log, &file);
        assert!(text.contains("done\n[aurora] Exited normally (code 0)"));
        assert!(!text.contains("\n\n"));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn footer_is_a_no_op_without_a_file() {
        // A command with no log path must not panic on the way out.
        ProcessLog::open(None).footer("Stopped by the user", std::time::Instant::now());
    }

    #[test]
    fn stop_reason_defaults_to_the_user() {
        assert_eq!(StopReason::parse(None), StopReason::User);
        assert_eq!(StopReason::parse(Some("user")), StopReason::User);
        assert_eq!(StopReason::parse(Some("agent")), StopReason::Agent);
        // An unknown string is the stop button misreporting itself, not the
        // agent — attributing it to shell_kill would be a lie in the log.
        assert_eq!(StopReason::parse(Some("nonsense")), StopReason::User);
    }

    #[test]
    fn durations_read_naturally() {
        use std::time::Duration;
        assert_eq!(human_duration(Duration::from_millis(320)), "320ms");
        assert_eq!(human_duration(Duration::from_millis(1_400)), "1.4s");
        assert_eq!(human_duration(Duration::from_secs(47)), "47s");
        assert_eq!(human_duration(Duration::from_secs(192)), "3m 12s");
        assert_eq!(human_duration(Duration::from_secs(3_840)), "1h 04m");
    }

    /// Registers one ledger row and removes it however the test ends, so these
    /// cannot leak into each other through the process-wide map.
    fn with_registered_stream(request_id: &str, body: impl FnOnce()) {
        register_command_stream(
            request_id.to_string(),
            request_id.to_string(),
            None,
            "pnpm build".to_string(),
            None,
            None,
        );
        body();
        cleanup_command_stream(request_id);
    }

    #[test]
    fn detaching_leaves_the_process_running_and_listed() {
        with_registered_stream("detach-keeps-the-row", || {
            assert!(!command_stream_detached("detach-keeps-the-row"));

            let stream = detach_tracked_command_stream("detach-keeps-the-row")
                .expect("a running command can be handed over");

            assert!(stream.detached);
            // The row must survive: the dock renders from it, `shell_kill`
            // resolves through it, and the ending is announced off it. Removing
            // it here is what would make a detached process unstoppable.
            assert!(command_stream_detached("detach-keeps-the-row"));
            assert!(list_command_streams()
                .iter()
                .any(|row| row.request_id == "detach-keeps-the-row"));
            // And it is NOT a cancellation: nothing was asked to stop.
            assert!(!stream.cancelled);
            assert_eq!(command_stream_stop("detach-keeps-the-row"), None);
        });
    }

    /// The dock's list is not the ledger. Every foreground `shell_execute` is
    /// tracked too — that is how it gets a stop button and a live stream — and
    /// listing those as background processes is what made an ordinary command
    /// announce itself as one when it finished.
    #[test]
    fn only_deliberate_background_work_reaches_the_process_list() {
        // A plain foreground command: no name, nobody detached it.
        with_registered_stream("dock-foreground", || {
            assert!(
                !shell_background_processes()
                    .iter()
                    .any(|row| row.request_id == "dock-foreground"),
                "a command the agent is waiting on is not a background process"
            );

            // The same command, after the user presses "Run in background".
            detach_tracked_command_stream("dock-foreground").expect("detaches");
            assert!(
                shell_background_processes()
                    .iter()
                    .any(|row| row.request_id == "dock-foreground"),
                "handing it over is what puts it in the list"
            );
        });

        // A spawn, which the schema requires to carry a name.
        register_command_stream(
            "dock-spawn".into(),
            "dock-spawn".into(),
            Some("Vite dev server".into()),
            "pnpm dev".into(),
            None,
            None,
        );
        assert!(shell_background_processes()
            .iter()
            .any(|row| row.request_id == "dock-spawn"));
        cleanup_command_stream("dock-spawn");
    }

    #[test]
    fn detaching_twice_is_not_an_error() {
        with_registered_stream("detach-idempotent", || {
            assert!(detach_tracked_command_stream("detach-idempotent").is_ok());
            // Double-click, or a click as the command finishes. Neither is
            // worth an error message to a person who got what they asked for.
            assert!(detach_tracked_command_stream("detach-idempotent").is_ok());
        });
    }

    #[test]
    fn a_stopping_command_cannot_be_detached() {
        with_registered_stream("detach-after-stop", || {
            {
                let mut streams = ACTIVE_COMMAND_STREAMS.write();
                let stream = streams.get_mut("detach-after-stop").expect("registered");
                stream.cancelled = true;
                stream.stop_reason = Some(StopReason::User);
            }
            // Answering "it is running in the background" over a process on its
            // way out is the same lie `browser_navigate` used to tell.
            let err = detach_tracked_command_stream("detach-after-stop")
                .expect_err("a stopping command is not a candidate");
            assert!(err.contains("already stopping"), "{err}");
        });
    }

    #[test]
    fn detaching_something_that_already_finished_says_so() {
        let err = detach_tracked_command_stream("never-registered")
            .expect_err("nothing to hand over");
        assert!(err.contains("already finished"), "{err}");
    }

    #[test]
    fn the_log_tail_survives_a_missing_file_and_a_split_character() {
        // No log, no panic: the detached result still states what happened.
        assert_eq!(read_process_log_tail(None), "");
        assert_eq!(read_process_log_tail(Some("E:/nope/missing.log")), "");

        let dir = std::env::temp_dir().join("aurora-detach-tail-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("out.log");

        std::fs::write(&path, "short output\n").expect("write");
        assert_eq!(
            read_process_log_tail(path.to_str()),
            "short output\n",
            "a log under the cap is returned whole"
        );

        // 32 KiB of a 3-byte character, so the naive cut lands mid-sequence.
        let big = "☃".repeat(20_000);
        std::fs::write(&path, &big).expect("write");
        let tail = read_process_log_tail(path.to_str());
        assert!(tail.len() <= 32 * 1024);
        assert!(
            !tail.starts_with('\u{FFFD}'),
            "the tail must start on a character boundary, not a replacement glyph"
        );
        assert!(big.ends_with(&tail), "the tail is the END of the log");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// How a command's ending is classified — the defects here were found in one
/// real session (`41841342`, 2026-08-21): a finished command whose child still
/// held the output pipe hung its tool call for as long as the child lived,
/// and the model, waiting on a card that said RUNNING, invented "Aurora's
/// background wrapper terminated it".
#[cfg(test)]
mod command_lifecycle_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn bash_available() -> bool {
        #[cfg(target_os = "windows")]
        {
            find_git_bash().is_some()
        }
        #[cfg(not(target_os = "windows"))]
        {
            true
        }
    }

    /// The screenshot bug. `sleep 8 & echo done`: the shell exits at once,
    /// the `sleep` inherits stdout and holds the pipe. Waiting for pipe EOF
    /// means waiting the full 8 seconds a survivor happens to live — with a
    /// server, forever. The run must end when the SHELL ends.
    #[tokio::test]
    async fn a_finished_command_with_a_survivor_returns_instead_of_hanging() {
        if !bash_available() {
            eprintln!("skipped: no bash on this machine");
            return;
        }
        let started = Instant::now();
        let output = execute_command(
            "sleep 8 & echo done".to_string(),
            None,
            Some("bash".to_string()),
            Some(30_000),
        )
        .await
        .expect("the command itself succeeded");
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "hung waiting for the survivor's pipe: {:?}",
            started.elapsed()
        );
        assert!(output.success, "exit 0 is a success: {output:?}");
        assert!(
            output.left_running,
            "the surviving child must be reported: {output:?}"
        );
        assert!(!output.timed_out, "this is not a timeout: {output:?}");
        assert!(output.stdout.contains("done"), "{output:?}");
    }

    #[tokio::test]
    async fn a_plain_command_leaves_nothing_running() {
        if !bash_available() {
            eprintln!("skipped: no bash on this machine");
            return;
        }
        let output = execute_command(
            "echo hi".to_string(),
            None,
            Some("bash".to_string()),
            Some(30_000),
        )
        .await
        .expect("echo runs");
        assert!(output.success);
        assert!(!output.left_running, "{output:?}");
        assert!(output.stdout.contains("hi"));
    }

    /// The `aurora-tool-findings.md` bug (2026-09-01): Git Bash re-parses its
    /// own command line and eats one layer of backslashes, so
    /// `'C:\Users\x'` — inside single quotes, which bash promises to leave
    /// alone — reached the command as `C:Usersx`. Every Windows path carried
    /// through bash was silently corrupted. The command must arrive verbatim.
    #[tokio::test]
    async fn backslashes_survive_the_trip_into_bash() {
        if !bash_available() {
            eprintln!("skipped: no bash on this machine");
            return;
        }
        let cases: &[(&str, &str)] = &[
            // The report's shape: a Windows path inside single quotes.
            (r"printf '%s\n' 'C:\Users\Alvan\x'", r"C:\Users\Alvan\x"),
            // Unquoted, bash's own escape rule: `\\` is one backslash.
            (r"printf '%s\n' C:\\temp", r"C:\temp"),
            // Escaped quotes inside double quotes.
            (r#"printf '%s\n' "say \"hi\"""#, r#"say "hi""#),
            // A `$` that bash must still expand — the fix must not turn
            // bash into a literal-only shell.
            (r#"X=1; printf '%s\n' "$X-${X}""#, "1-1"),
            // Multi-line, with a quoted heredoc carrying a backslash.
            ("cat <<'EOF'\nline1 \\back\nEOF", "line1 \\back"),
        ];
        for (command, expected) in cases {
            let output = execute_command(
                (*command).to_string(),
                None,
                Some("bash".to_string()),
                Some(30_000),
            )
            .await
            .expect("the command runs");
            assert_eq!(
                output.stdout.trim_end(),
                *expected,
                "command {command:?} — stderr: {}",
                output.stderr
            );
        }
    }

    /// The command travels through the environment on Windows; the bootstrap
    /// must drop it before the command runs, so a child never inherits its
    /// own source text (and a 100 KB heredoc never lands in every grandchild's
    /// environment block).
    #[tokio::test]
    async fn the_command_text_is_not_inherited_by_children() {
        if !bash_available() {
            eprintln!("skipped: no bash on this machine");
            return;
        }
        let output = execute_command(
            format!(
                "printf '%s\\n' \"${{{}:-absent}}\"",
                crate::shell::delivery::COMMAND_ENV_VAR
            ),
            None,
            Some("bash".to_string()),
            Some(30_000),
        )
        .await
        .expect("the command runs");
        assert_eq!(output.stdout.trim_end(), "absent", "{output:?}");
    }

    /// Error text must read like a terminal's — `bash: line 2: …` — with the
    /// line numbers of the command the model wrote, not of any bootstrap.
    #[tokio::test]
    async fn errors_carry_the_commands_own_line_numbers() {
        if !bash_available() {
            eprintln!("skipped: no bash on this machine");
            return;
        }
        let output = execute_command(
            "echo before\nno_such_command_xyz\necho after".to_string(),
            None,
            Some("bash".to_string()),
            Some(30_000),
        )
        .await
        .expect("the command runs");
        assert!(output.stderr.contains("line 2"), "{output:?}");
        assert!(
            output.stderr.contains("no_such_command_xyz: command not found"),
            "{output:?}"
        );
        assert!(
            !output.stderr.contains("__aurora_cmd"),
            "the bootstrap must stay invisible: {}",
            output.stderr
        );
        assert!(output.stdout.contains("before") && output.stdout.contains("after"));
    }

    /// A timeout still means what it says: the SHELL was still running at the
    /// deadline. (Before the unification this path also fired for a finished
    /// shell whose child held the pipe, reporting "timed out and was killed"
    /// about a command that had already exited.)
    #[tokio::test]
    async fn a_true_timeout_is_still_an_error_for_this_caller() {
        if !bash_available() {
            eprintln!("skipped: no bash on this machine");
            return;
        }
        let err = execute_command(
            "sleep 30".to_string(),
            None,
            Some("bash".to_string()),
            Some(1_500),
        )
        .await
        .expect_err("must time out");
        assert!(err.contains("timed out"), "{err}");
    }

    /// The drain itself, on a raw pipe: EOF ends it cleanly, a held-open
    /// write end ends it with `held = true` — and quickly.
    #[tokio::test]
    async fn drain_reports_a_held_pipe_without_waiting_for_it() {
        use tokio::io::AsyncWriteExt;

        // Closed writer → clean EOF.
        let (mut writer, mut reader) = tokio::io::duplex(64);
        writer.write_all(b"tail").await.unwrap();
        drop(writer);
        let (bytes, held) = drain_exited_pipe(&mut reader, false).await;
        assert_eq!(bytes, b"tail");
        assert!(!held);

        // Held writer → the grace window closes, the data still arrives.
        let (mut writer, mut reader) = tokio::io::duplex(64);
        writer.write_all(b"tail").await.unwrap();
        let started = std::time::Instant::now();
        let (bytes, held) = drain_exited_pipe(&mut reader, false).await;
        assert_eq!(bytes, b"tail");
        assert!(held, "an open write end is a survivor");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the grace window is short by design"
        );
        drop(writer);
    }

    /// `already_eof` short-circuits: the streaming loop saw this pipe close,
    /// so there is nothing to wait for and no survivor to report.
    #[tokio::test]
    async fn drain_skips_a_pipe_the_loop_already_finished() {
        let (writer, mut reader) = tokio::io::duplex(64);
        let started = std::time::Instant::now();
        let (bytes, held) = drain_exited_pipe(&mut reader, true).await;
        assert!(bytes.is_empty());
        assert!(!held);
        assert!(started.elapsed() < Duration::from_millis(50));
        drop(writer);
    }

    /// The second witness. `>/dev/null 2>&1` hands the survivor no pipe at
    /// all — the same shape as `Start-Process`, whose ShellExecute launch
    /// shares no handles — so the pipe drain sees a clean close and, alone,
    /// would report "nothing is left running" over a live process (observed
    /// in the 2026-08-21 harness run, defect report filed by Aurora itself).
    /// Only the process-table walk can catch this one, and it must also NAME
    /// the survivor so the note is actionable.
    #[tokio::test]
    async fn a_survivor_holding_no_pipe_is_still_found_and_named() {
        if !bash_available() {
            eprintln!("skipped: no bash on this machine");
            return;
        }
        let output = execute_command(
            "sleep 15 >/dev/null 2>&1 & echo launched".to_string(),
            None,
            Some("bash".to_string()),
            Some(30_000),
        )
        .await
        .expect("the launcher itself succeeded");
        assert!(output.success, "{output:?}");
        assert!(
            output.left_running,
            "a pipe-less survivor must still be reported: {output:?}"
        );
        assert!(
            output
                .survivors
                .iter()
                .any(|name| name.to_ascii_lowercase().contains("sleep")),
            "the survivor is named: {:?}",
            output.survivors
        );
    }
}
