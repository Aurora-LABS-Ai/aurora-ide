//! Terminal sessions: Aurora's own pseudo terminals, for the Terminal panel and
//! for the agent's `terminal` tool.
//!
//! These replaced `tauri-plugin-pty`, for one reason above the rest: its
//! `spawn` returned a session COUNTER (0, 1, 2…) where the window expected a
//! process id. Closing a tab therefore asked "what is still running under
//! pid 2?" (nothing — that is a system process), closed without the warning,
//! and ran the tree kill against pid 2. `pnpm dev` started in the tab kept
//! running and holding its port. Two smaller faults went with it: every
//! 1 KB read was decoded on its own, so a character split across two reads
//! came out as replacement marks, and closed sessions were never removed.
//!
//! Each shell is put into a Windows job object the moment it is spawned, with
//! kill-on-close set. Everything the shell starts — through any chain of
//! wrappers, alive or dead (`pnpm` → `node` → `next-server`) — is a member, and
//! ending the session ends the job: [`kill`] terminates it explicitly, and
//! dropping the session closes the last handle, which the kernel answers by
//! ending every member. That also holds when Aurora exits without running the
//! window's close handlers. See `commands::process_tracking` for why a
//! parent-pid walk is not enough.
//!
//! Rust holds everything a reader needs: a vt100 screen with scrollback (what
//! the agent reads, see [`screen`]), the raw output (replayed to a window that
//! attaches later), the owner, the title and the exit code. A session the
//! agent opens with no window attached still answers the pseudo console's
//! cursor query, which would otherwise hold the shell before its first prompt.

pub mod keys;
pub mod screen;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::num::NonZeroU16;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Emitter;

use crate::commands::process_tracking::ShellJob;
use crate::commands::terminal::RunningChild;

/// What a session reports to the window, in order: output, then one exit.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: u32 },
}

/// Who a session belongs to and what it is called.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub title: String,
    /// Registry kind id (`pwsh`, `bash`, `cmd`, …).
    pub shell: String,
    pub cwd: Option<String>,
    /// The conversation whose agent started it; `None` for the user's own tab.
    pub owner_thread: Option<String>,
    /// The command an agent session was started for.
    pub command: Option<String>,
}

pub struct Session {
    pub id: u32,
    /// `None` once the shell has exited and the pseudo console was closed.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub pid: Option<u32>,
    job: Option<ShellJob>,
    pub info: Mutex<SessionInfo>,
    /// The screen and its scrollback, fed every byte the shell prints.
    parser: Mutex<vt100::Parser>,
    /// Raw output, newest last, capped at [`HISTORY_BYTES`]: what a window
    /// that attaches after the start is shown first.
    history: Mutex<Vec<u8>>,
    /// The window's stream, while one is attached.
    channel: Mutex<Option<Channel<PtyEvent>>>,
    /// Total bytes received: lets a caller tell when output has gone quiet.
    received: AtomicU64,
    running: AtomicBool,
    exit_code: Mutex<Option<u32>>,
    /// The screen line where the output of the most recent Enter begins.
    last_input_line: Mutex<Option<usize>>,
}

const HISTORY_BYTES: usize = 2 * 1024 * 1024;
const SCROLLBACK_LINES: usize = 10_000;

/// A terminal the agent opens: wide enough that long lines do not wrap, which
/// would split one log line into two when read back.
pub const AGENT_COLS: u16 = 200;
pub const AGENT_ROWS: u16 = 50;

fn sessions() -> &'static Mutex<HashMap<u32, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// The app, for the window events an agent session sends. Unset in unit
/// tests, where those events have nowhere to go.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Called once at startup.
pub fn install(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

pub fn session(id: u32) -> Result<Arc<Session>, String> {
    sessions()
        .lock()
        .map_err(|_| "terminal session table is poisoned".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("No terminal {id}: it was closed, or never existed."))
}

pub fn all() -> Vec<Arc<Session>> {
    let mut list: Vec<Arc<Session>> = sessions()
        .lock()
        .map(|map| map.values().cloned().collect())
        .unwrap_or_default();
    list.sort_by_key(|session| session.id);
    list
}

impl Session {
    pub fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn exit_code(&self) -> Option<u32> {
        self.exit_code.lock().ok().and_then(|code| *code)
    }

    pub fn received(&self) -> u64 {
        self.received.load(Ordering::Acquire)
    }

    pub fn info(&self) -> SessionInfo {
        self.info.lock().map(|info| info.clone()).unwrap_or_else(|_| SessionInfo {
            title: String::new(),
            shell: String::new(),
            cwd: None,
            owner_thread: None,
            command: None,
        })
    }

    /// Clean text of the screen and scrollback; see [`screen::read`].
    pub fn read(&self, scope: screen::Scope, head: usize, tail: usize) -> screen::Read {
        match self.parser.lock() {
            Ok(mut parser) => screen::read(&mut parser, scope, head, tail),
            Err(_) => screen::Read::default(),
        }
    }

    /// Where the output of the most recent Enter begins, for reading "what the
    /// last input produced". Recorded on every write that carries an Enter,
    /// the user's keystrokes included, since they arrive through here too.
    pub fn last_input_line(&self) -> Option<usize> {
        self.last_input_line.lock().ok().and_then(|line| *line)
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        if memchr::memchr(b'\r', data).is_some() {
            if let (Ok(parser), Ok(mut line)) = (self.parser.lock(), self.last_input_line.lock()) {
                *line = Some(screen::cursor_line(&parser));
            }
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "terminal writer is poisoned".to_string())?;
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| format!("could not write to terminal {}: {error}", self.id))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = (cols.max(1), rows.max(1));
        if let Ok(mut parser) = self.parser.lock() {
            parser.set_size(nonzero(rows), nonzero(cols));
        }
        let master = self
            .master
            .lock()
            .map_err(|_| "terminal is poisoned".to_string())?;
        // Exited and closed: there is nothing to resize, and that is not an error.
        let Some(master) = master.as_ref() else {
            return Ok(());
        };
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("could not resize terminal {}: {error}", self.id))
    }

    /// Wait until output stops for `quiet`, the shell exits, or `limit` passes.
    /// Returns whether it went quiet (or ended) before the limit.
    pub fn settle(&self, quiet: Duration, limit: Duration) -> bool {
        let started = Instant::now();
        let mut last = self.received();
        let mut last_change = Instant::now();
        loop {
            if !self.running() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(40));
            let now = self.received();
            if now != last {
                last = now;
                last_change = Instant::now();
            } else if last_change.elapsed() >= quiet {
                return true;
            }
            if started.elapsed() >= limit {
                return false;
            }
        }
    }

    /// Stream to a window: replay what was printed so far, then live output.
    pub fn attach(&self, channel: Channel<PtyEvent>) -> Result<(), String> {
        let mut slot = self
            .channel
            .lock()
            .map_err(|_| "terminal channel is poisoned".to_string())?;
        let history = self.history.lock().map(|h| h.clone()).unwrap_or_default();
        if !history.is_empty() {
            // The pseudo console's cursor query is in there, already answered.
            // Replayed, xterm would answer it again — straight into the
            // running program's input.
            let replay = String::from_utf8_lossy(&history).replace("\x1b[6n", "");
            let _ = channel.send(PtyEvent::Data { data: replay });
        }
        if !self.running() {
            let _ = channel.send(PtyEvent::Exit {
                code: self.exit_code().unwrap_or(0),
            });
        }
        *slot = Some(channel);
        Ok(())
    }

    /// Everything the shell has running, by job membership.
    pub fn running_children(&self) -> Result<Vec<RunningChild>, String> {
        match (&self.job, self.pid) {
            (Some(job), _) => Ok(job
                .survivors()
                .into_iter()
                .map(|survivor| RunningChild {
                    pid: survivor.pid,
                    name: survivor.name,
                })
                .collect()),
            (None, Some(pid)) => crate::commands::terminal::descendants_of(pid),
            (None, None) => Ok(Vec::new()),
        }
    }
}

fn nonzero(value: u16) -> NonZeroU16 {
    NonZeroU16::new(value).unwrap_or(NonZeroU16::MIN)
}

/// Resolve a shell from the verified registry and add what a terminal needs.
///
/// POSIX shells read their own rc files, so they get only `TERM` (without it a
/// shell cannot know it is talking to an xterm). cmd takes no initialisation:
/// given PowerShell's `-Command` it prints its usage and exits. PowerShell
/// gets Aurora's prompt, installed only over the stock one.
pub fn resolve_shell(
    requested: &str,
) -> Result<(String, crate::shell::ShellKind, Vec<String>, Vec<(String, String)>), String> {
    use crate::shell::ShellKind;
    let resolved = crate::shell::resolve_interactive(Some(requested)).ok_or_else(|| {
        format!(
            "No {requested} shell is set up. Open Settings → Tools → Shells to scan for one, or \
             add it by path."
        )
    })?;
    let (mut args, mut env) = (resolved.args, resolved.env);
    match resolved.kind {
        ShellKind::Pwsh | ShellKind::PowerShell => {
            args.push("-Command".into());
            args.push(POWERSHELL_PROMPT_INIT.join("; "));
        }
        ShellKind::Cmd => {}
        ShellKind::Bash | ShellKind::Sh | ShellKind::Zsh => {
            env.retain(|(key, _)| key != "TERM");
            env.insert(0, ("TERM".into(), "xterm-256color".into()));
        }
    }
    Ok((resolved.exe, resolved.kind, args, env))
}

/// PowerShell's terminal initialisation: a compact prompt (short path ·
/// pwshN · OK/ERR), installed ONLY when the user's profile left the stock
/// prompt in place. Defining it unconditionally overwrote oh-my-posh,
/// starship or a hand-written theme; a terminal hosts a shell, it does not
/// impersonate one. Moved here from the window's `shell-config.ts`.
const POWERSHELL_PROMPT_INIT: &[&str] = &[
    r"$global:AuroraPromptVersion='2'",
    r"$global:AuroraStockPrompt=$false",
    r"try{",
    r"  $__p=(Get-Command prompt -ErrorAction SilentlyContinue).Definition",
    r"  $global:AuroraStockPrompt = [string]::IsNullOrWhiteSpace($__p) -or $__p -match 'executionContext\.SessionState\.Path\.CurrentLocation'",
    r"} catch { $global:AuroraStockPrompt=$true }",
    r"function global:Aurora-ShortPath([string]$p,[int]$maxLen){",
    r"  if(-not $p){ return '' }",
    r"  if($maxLen -lt 20){ return (Split-Path -Leaf $p) }",
    r"  $drive=''",
    r"  $rest=$p",
    r"  if($p -match '^[A-Za-z]:'){ $drive=$p.Substring(0,2); $rest=$p.Substring(2) }",
    r"  $parts = ($rest -split '[\\/]+') | Where-Object { $_ -ne '' }",
    r"  if($parts.Count -le 3){ return ($drive + '\' + ($parts -join '\')).TrimEnd('\') }",
    r"  $head = $parts[0]",
    r"  $tail = ($parts | Select-Object -Last 2) -join '\'",
    r"  return ($drive + '\' + $head + '\...\' + $tail).TrimEnd('\')",
    r"}",
    r"if($global:AuroraStockPrompt){",
    r"function global:prompt{",
    r"  $w=80; try{ $w=$Host.UI.RawUI.WindowSize.Width } catch {}",
    r"  if($w -lt 40){ return '> ' }",
    r"  $path=(Get-Location).Path",
    r"  $short=Aurora-ShortPath $path ($w-28)",
    r"  $ok= if($?){'OK'} else {'ERR'}",
    r"  $ver= try{ $PSVersionTable.PSVersion.Major } catch { 0 }",
    r"  $useColor=$false; try{ $useColor = [bool]$Host.UI.SupportsVirtualTerminal } catch {}",
    r#"  if(-not $useColor){ return "$short | pwsh$ver | $ok`n> " }"#,
    r"  $esc=[char]27",
    r#"  $c="$esc[36m"; $y="$esc[33m"; $g="$esc[32m"; $r="$esc[31m"; $d="$esc[90m"; $x="$esc[0m""#,
    r"  $sc= if($ok -eq 'OK'){ $g } else { $r }",
    r#"  return "${c}${short}${x} ${d}|${x} ${y}pwsh${ver}${x} ${d}|${x} ${sc}${ok}${x}`n> ""#,
    r"}",
    r"}",
    r"try{ Set-PSReadLineOption -BellStyle None -ErrorAction SilentlyContinue } catch {}",
];

/// What starting a session needs.
pub struct Spawn<'a> {
    pub exe: &'a str,
    pub args: &'a [String],
    pub env: &'a [(String, String)],
    pub cols: u16,
    pub rows: u16,
    pub info: SessionInfo,
    pub channel: Option<Channel<PtyEvent>>,
}

/// Start a shell on a new pseudo terminal and put it in a job.
pub fn spawn(request: Spawn<'_>) -> Result<Arc<Session>, String> {
    let Spawn {
        exe,
        args,
        env,
        cols,
        rows,
        info,
        channel,
    } = request;
    let (cols, rows) = (cols.max(1), rows.max(1));
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("could not open a pseudo terminal: {error}"))?;
    let mut command = CommandBuilder::new(exe);
    command.args(args);
    if let Some(cwd) = &info.cwd {
        command.cwd(cwd);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("could not start {exe}: {error}"))?;
    // The slave belongs to the child now. Holding it here would keep the
    // terminal open after the shell exits, and the reader would never end.
    drop(pair.slave);

    let pid = child.process_id();
    let job = pid.and_then(adopt_into_job);
    if pid.is_some() && job.is_none() {
        crate::logging::log_warn(
            "terminal",
            &format!(
                "shell pid {pid:?} could not be put into a job; closing it falls back to the \
                 process-tree kill"
            ),
        );
    }

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("could not read the terminal: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("could not write to the terminal: {error}"))?;
    let killer = child.clone_killer();

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let session = Arc::new(Session {
        id,
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        pid,
        job,
        info: Mutex::new(info),
        parser: Mutex::new(vt100::Parser::new(nonzero(rows), nonzero(cols), SCROLLBACK_LINES)),
        history: Mutex::new(Vec::new()),
        channel: Mutex::new(channel),
        received: AtomicU64::new(0),
        running: AtomicBool::new(true),
        exit_code: Mutex::new(None),
        last_input_line: Mutex::new(None),
    });
    sessions()
        .lock()
        .map_err(|_| "terminal session table is poisoned".to_string())?
        .insert(id, Arc::clone(&session));

    let (reader_done, reader_finished) = std::sync::mpsc::channel::<()>();
    let reading = Arc::clone(&session);
    std::thread::Builder::new()
        .name(format!("terminal-{id}-read"))
        .spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                let read = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let bytes = &buffer[..read];
                pending.extend_from_slice(bytes);
                let text = take_complete_utf8(&mut pending);
                reading.absorb(bytes, text);
            }
            if !pending.is_empty() {
                reading.send(PtyEvent::Data {
                    data: String::from_utf8_lossy(&pending).into_owned(),
                });
            }
            let _ = reader_done.send(());
        })
        .map_err(|error| format!("could not start the terminal reader: {error}"))?;

    let watching = Arc::clone(&session);
    std::thread::Builder::new()
        .name(format!("terminal-{id}-wait"))
        .spawn(move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            // The pseudo console holds the last output until it is closed.
            // Give it a moment to flush, close it so the reader reaches its
            // end, and only then report the exit — after the final output.
            std::thread::sleep(Duration::from_millis(150));
            if let Ok(mut master) = watching.master.lock() {
                master.take();
            }
            let _ = reader_finished.recv_timeout(Duration::from_secs(2));
            if let Ok(mut slot) = watching.exit_code.lock() {
                *slot = Some(code);
            }
            watching.running.store(false, Ordering::Release);
            watching.send(PtyEvent::Exit { code });
            watching.announce_exit(code);
        })
        .map_err(|error| format!("could not start the terminal watcher: {error}"))?;

    Ok(session)
}

impl Session {
    /// Feed the screen and history, send `text` to an attached window, and
    /// answer the cursor query when no window is attached to answer it.
    ///
    /// History and the send happen under the channel lock, which [`attach`]
    /// also holds while it replays history: a chunk is either in the replay or
    /// sent live, never both.
    fn absorb(&self, bytes: &[u8], text: String) {
        let cursor = self.parser.lock().ok().map(|mut parser| {
            parser.process(bytes);
            parser.screen().cursor_position()
        });
        let attached = {
            let slot = self.channel.lock();
            if let Ok(mut history) = self.history.lock() {
                history.extend_from_slice(bytes);
                if history.len() > HISTORY_BYTES {
                    let excess = history.len() - HISTORY_BYTES;
                    history.drain(..excess);
                }
            }
            match slot.as_ref().ok().and_then(|slot| slot.as_ref()) {
                Some(channel) => {
                    if !text.is_empty() {
                        let _ = channel.send(PtyEvent::Data { data: text });
                    }
                    true
                }
                None => false,
            }
        };
        self.received.fetch_add(bytes.len() as u64, Ordering::AcqRel);
        // ConPTY asks where the cursor is (`ESC[6n`) while the shell starts,
        // and holds the shell until the terminal answers. xterm answers in the
        // panel; with no window attached, nobody would.
        if !attached && memchr::memmem::find(bytes, b"\x1b[6n").is_some() {
            if let Some((row, col)) = cursor {
                let _ = self.write(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes());
            }
        }
    }

    fn send(&self, event: PtyEvent) {
        if let Ok(slot) = self.channel.lock() {
            if let Some(channel) = slot.as_ref() {
                let _ = channel.send(event);
            }
        }
    }

    /// Tell the window an agent's terminal ended, so it can tell the agent's
    /// conversation — if a turn is running there (the window decides).
    fn announce_exit(&self, code: u32) {
        let info = self.info();
        let Some(owner) = info.owner_thread.clone() else {
            return;
        };
        if let Some(app) = APP.get() {
            let _ = app.emit(
                "terminal-exited",
                TerminalExited {
                    id: self.id,
                    title: info.title,
                    exit_code: code,
                    owner_thread: owner,
                },
            );
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExited {
    id: u32,
    title: String,
    exit_code: u32,
    owner_thread: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOpened {
    id: u32,
    #[serde(flatten)]
    info: SessionInfo,
}

/// Open a terminal for the agent: an interactive shell, shown in the window's
/// Terminal panel, that runs `command` as if typed and exits with it.
///
/// Typed rather than passed as the shell's `-Command`: the person watching
/// sees the command at the prompt, the program gets a real interactive
/// terminal, and every shell takes it the same way. The exit suffix makes the
/// shell end with the program, so its exit code is the session's.
pub fn open_for_agent(
    shell: &str,
    command: &str,
    cwd: Option<String>,
    title: String,
    owner_thread: String,
) -> Result<Arc<Session>, String> {
    use crate::shell::ShellKind;
    let (exe, kind, args, env) = resolve_shell(shell)?;
    let session = spawn(Spawn {
        exe: &exe,
        args: &args,
        env: &env,
        cols: AGENT_COLS,
        rows: AGENT_ROWS,
        info: SessionInfo {
            title,
            shell: kind.id().to_string(),
            cwd,
            owner_thread: Some(owner_thread),
            command: Some(command.to_string()),
        },
        channel: None,
    })?;
    let typed = match kind {
        ShellKind::Pwsh | ShellKind::PowerShell => {
            format!("{command}; exit $LASTEXITCODE\r")
        }
        ShellKind::Cmd => format!("{command} & exit\r"),
        ShellKind::Bash | ShellKind::Sh | ShellKind::Zsh => format!("{command}; exit $?\r"),
    };
    session.write(typed.as_bytes())?;
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "terminal-opened",
            TerminalOpened {
                id: session.id,
                info: session.info(),
            },
        );
    }
    Ok(session)
}

/// End a session: the shell and everything it started.
///
/// The job is terminated explicitly, then the session is dropped, which
/// closes the job handle — a second guarantee from the kernel. Without a job
/// (another platform, or adoption failed) the process-tree kill runs instead.
/// A session that is already gone is not an error: the close button must work.
pub fn kill(id: u32) -> Result<(), String> {
    let removed = sessions()
        .lock()
        .map_err(|_| "terminal session table is poisoned".to_string())?
        .remove(&id);
    let Some(session) = removed else {
        return Ok(());
    };
    let mut failures = Vec::new();
    match &session.job {
        Some(job) => {
            if let Err(error) = job.kill_members() {
                failures.push(error);
            }
        }
        None => {
            if let Some(pid) = session.pid {
                if let Err(error) = crate::commands::try_kill_pid(pid) {
                    failures.push(error);
                }
            }
        }
    }
    if let Ok(mut killer) = session.killer.lock() {
        // Usually already dead by now; that is the expected case.
        let _ = killer.kill();
    }
    drop(session);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// The longest valid UTF-8 prefix of `pending`, removed from it. A character
/// cut by the read boundary stays behind for the next read; bytes that are
/// invalid outright are replaced so one bad byte cannot stall the stream.
fn take_complete_utf8(pending: &mut Vec<u8>) -> String {
    let mut end = 0;
    loop {
        match std::str::from_utf8(&pending[end..]) {
            Ok(_) => {
                end = pending.len();
                break;
            }
            Err(error) => match error.error_len() {
                // Invalid bytes, not a split character: consume them and go on.
                Some(bad) => end += error.valid_up_to() + bad,
                // A character cut at the end: keep it for the next read.
                None => {
                    end += error.valid_up_to();
                    break;
                }
            },
        }
    }
    let text = String::from_utf8_lossy(&pending[..end]).into_owned();
    pending.drain(..end);
    text
}

/// Put a just-spawned shell into a job that ends all its members when closed.
#[cfg(target_os = "windows")]
fn adopt_into_job(pid: u32) -> Option<ShellJob> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // SAFETY: `OpenProcess` takes no pointers; the handle is checked and
    // closed once the assignment is done (the job keeps its own reference).
    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return None;
        }
        let job = ShellJob::adopt(pid, handle.cast());
        CloseHandle(handle);
        let job = job?;
        if let Err(error) = job.kill_on_close() {
            crate::logging::log_warn("terminal", &error);
        }
        Some(job)
    }
}

#[cfg(not(target_os = "windows"))]
fn adopt_into_job(_pid: u32) -> Option<ShellJob> {
    None
}

#[cfg(test)]
mod tests;
