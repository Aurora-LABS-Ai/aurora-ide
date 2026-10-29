//! Shell commands Aurora runs and tracks: the stream registry, stopping and
//! detaching, the per-run log file, and the lifecycle that spawns a command,
//! reads its output and classifies how it ended.
//!
//! Moved out of `commands/mod.rs` (Phase 1.7). Output goes to an
//! [`Events`] sink instead of a Tauri `AppHandle`; the IPC commands in
//! `commands` wrap these functions.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

use parking_lot::RwLock;
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;

use crate::host_events::Events;

use super::tracking as process_tracking;

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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandStreamChunk {
    pub stream: String,
    pub data: String,
    pub done: bool,
    pub exit_code: Option<i32>,
    pub success: Option<bool>,
}

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

    pub(crate) fn parse(raw: Option<&str>) -> Self {
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
    /// The job the shell was adopted into at spawn (Windows), shared with the
    /// streaming loop. It is how a stop reaches every process the command
    /// started, not only the ones a parent-pid walk can still see — see
    /// `process_tracking`. Never serialised: it is a kernel handle.
    #[serde(skip)]
    pub job: Option<std::sync::Arc<process_tracking::ShellJob>>,
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
    /// The conversation whose `shell_spawn` started it, when one did. A
    /// sub-agent's process belongs to the sub-agent: filing it under the
    /// conversation on screen told the parent about a process it never
    /// started and left the child that did unaware it had ended.
    pub thread_id: Option<String>,
    /// The agent's own choice, set with `shell_notify`: `Some(true)` wake it
    /// when this ends however long that takes, `Some(false)` do not wake it
    /// (it hears with the person's next message). `None` until it decides; the
    /// window then wakes it only if the ending comes soon after its turn.
    pub wake: Option<bool>,
}

/// Record the agent's choice for a running process (see
/// [`CommandStreamInfo::wake`]). Returns the process id and its name.
pub fn set_process_wake(identifier: &str, wake: bool) -> Result<(String, String), String> {
    let request_id = command_stream_key(identifier).ok_or_else(|| {
        format!(
            "No running background process matches '{identifier}'. It may have ended already; \
             list processes and retry with a current process ID."
        )
    })?;
    let mut streams = ACTIVE_COMMAND_STREAMS.write();
    let stream = streams
        .get_mut(&request_id)
        .ok_or_else(|| format!("Background process '{identifier}' has already ended."))?;
    stream.wake = Some(wake);
    let name = stream.name.clone().unwrap_or_else(|| stream.command.clone());
    Ok((stream.process_id.clone(), name))
}

/// Record which conversation a just-registered process belongs to.
pub fn tag_command_stream_thread(request_id: &str, thread_id: &str) {
    if let Some(stream) = ACTIVE_COMMAND_STREAMS.write().get_mut(request_id) {
        stream.thread_id = Some(thread_id.to_string());
    }
}

lazy_static::lazy_static! {
    pub(crate) static ref ACTIVE_COMMAND_STREAMS: RwLock<HashMap<String, CommandStreamInfo>> =
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
            job: None,
            detached: false,
            thread_id: None,
            wake: None,
        });
}

/// Stop a command and everything it started.
///
/// Two witnesses, the same pair survivor reporting uses. The job reaches every
/// member by membership, whatever its ancestry — the `npm run serve` case on
/// thread `1edca8e2` (2026-09-29): git-bash → npm → node, where node's parent
/// had already exited, so `taskkill /T` from the shell's pid stopped at the
/// gap and reported success over a server still holding its port. The
/// parent-pid walk still runs for a shell that could not be adopted into a
/// job, and its answer ("is the process I named gone") is the one returned.
pub(crate) fn kill_command_tree(
    job: Option<&process_tracking::ShellJob>,
    pid: Option<u32>,
) -> Result<(), String> {
    let job_result = job.map_or(Ok(()), process_tracking::ShellJob::kill_members);
    match pid {
        Some(pid) => try_kill_pid(pid).map_err(|walk_error| match job_result {
            Ok(()) => walk_error,
            Err(job_error) => format!("{walk_error}; {job_error}"),
        }),
        None => job_result,
    }
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
    /// The conversation that started it, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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
            thread_id: stream.thread_id,
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
    if stream.pid.is_some() || stream.job.is_some() {
        kill_command_tree(stream.job.as_deref(), stream.pid)?;
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
pub(crate) fn command_stream_detached(request_id: &str) -> bool {
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
pub(crate) fn command_stream_stop(request_id: &str) -> Option<StopReason> {
    let streams = ACTIVE_COMMAND_STREAMS.read();
    let stream = streams.get(request_id)?;
    if !stream.cancelled {
        return None;
    }
    Some(stream.stop_reason.unwrap_or(StopReason::User))
}

pub(crate) fn cleanup_command_stream(request_id: &str) {
    let mut streams = ACTIVE_COMMAND_STREAMS.write();
    streams.remove(request_id);
}

/// Is this pid still a running process?
///
/// The question `taskkill`'s exit code cannot answer. Asked immediately after
/// a kill, so pid reuse is not a practical concern.
#[cfg(target_os = "windows")]
pub(crate) fn process_is_alive(pid: u32) -> bool {
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

/// Execute a shell command with optional shell profile
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
///
/// Answers with the log file the run is mirrored into, so the process panel
/// can show its output from the first frame. Without it the card's row had no
/// file, and the ledger sync only adds rows it has never seen, so the panel
/// said "not recording output to a file" for the whole run.
pub fn detach_command_stream(request_id: String) -> Result<Option<String>, String> {
    detach_tracked_command_stream(&request_id).map(|stream| stream.log_path)
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
    super::tree::descendants_of(shell_pid)
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
    app: Option<Events>,
    request_id: String,
    pid: Option<u32>,
    job: Option<std::sync::Arc<process_tracking::ShellJob>>,
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
        if self.pid.is_some() || self.job.is_some() {
            let _ = kill_command_tree(self.job.as_deref(), self.pid);
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

pub(crate) struct ProcessLog {
    file: Option<std::fs::File>,
    /// Whether the next byte starts a line, so the footer never lands glued to
    /// a half-written line of the process's own output.
    at_line_start: bool,
}

impl ProcessLog {
    pub(crate) fn open(path: Option<&String>) -> Self {
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

    pub(crate) fn write(&mut self, text: &str) {
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
    pub(crate) fn footer(&mut self, summary: &str, started: std::time::Instant) {
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
pub(crate) fn human_duration(elapsed: std::time::Duration) -> String {
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
    /// The conversation whose `shell_spawn` started it, so the ending is
    /// told to that conversation — a sub-agent's, not whichever is on screen.
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    /// The agent's `shell_notify` choice; absent when it never made one.
    #[serde(skip_serializing_if = "Option::is_none")]
    wake: Option<bool>,
}

/// Emit [`ProcessEnded`]. Called before the stream leaves the ledger, which is
/// where the process id still lives.
fn emit_process_ended(
    app: &Events,
    request_id: &str,
    exit_code: Option<i32>,
    outcome: &'static str,
) {
    let owner = ACTIVE_COMMAND_STREAMS
        .read()
        .get(request_id)
        .map(|stream| (stream.process_id.clone(), stream.thread_id.clone(), stream.wake));
    let Some((process_id, thread_id, wake)) = owner else { return };
    let _ = app.emit(
        "shell-process-ended",
        ProcessEnded {
            process_id,
            request_id: request_id.to_string(),
            exit_code,
            outcome,
            thread_id,
            wake,
        },
    );
}

fn flush_shell_pending(
    app: Option<&Events>,
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
pub async fn execute_command_stream(
    events: Events,
    request_id: String,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    timeout_ms: Option<u64>,
    log_path: Option<String>,
    keep_stdin_open: Option<bool>,
) -> Result<CommandOutput, String> {
    run_command_lifecycle(
        Some(events),
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
    app: Option<Events>,
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
        (Some(shell_pid), Some(handle)) => {
            process_tracking::ShellJob::adopt(shell_pid, handle).map(std::sync::Arc::new)
        }
        _ => None,
    };
    #[cfg(not(target_os = "windows"))]
    let shell_job: Option<std::sync::Arc<process_tracking::ShellJob>> = None;

    let pid = child.id();
    if tracked {
        let mut streams = ACTIVE_COMMAND_STREAMS.write();
        if let Some(stream) = streams.get_mut(&request_id) {
            stream.pid = pid;
            // Shared with the ledger so `shell_kill` and the stop button can
            // end the whole job at once, without waiting for this loop.
            stream.job = shell_job.clone();
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
        job: shell_job.clone(),
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
            let _ = kill_command_tree(shell_job.as_deref(), pid);
            log.footer("Killed — stdout could not be captured", started);
            cleanup_command_stream(&request_id);
            return Err("Failed to capture stdout".to_string());
        }
    };
    let mut stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            guard.disarm();
            let _ = kill_command_tree(shell_job.as_deref(), pid);
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
            let _ = kill_command_tree(shell_job.as_deref(), pid);
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
                let _ = kill_command_tree(shell_job.as_deref(), pid);
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
                // A stop kills the tree from the caller's side, so the shell's
                // death lands HERE, before the loop comes back round to the
                // stop check at the top. Treating it as a natural exit reported
                // the kill as "Failed · exit 1" (the code Windows hands a
                // terminated process), which woke the idle conversation with a
                // failure and the agent restarted the very thing the user had
                // just stopped. The stop flag is set before the kill, so it is
                // always visible by the time this branch runs.
                if let Some(reason) = command_stream_stop(&request_id) {
                    ending = reason.describe().to_string();
                    break;
                }
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
                    Some(job) => {
                        let mut found = job.survivors();
                        if process_tracking::caught_mid_fork(&found) {
                            tokio::time::sleep(Duration::from_millis(
                                process_tracking::SURVIVOR_SETTLE_MS,
                            ))
                            .await;
                            found = job.survivors();
                        }
                        found.iter().map(process_tracking::Survivor::describe).collect()
                    }
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
