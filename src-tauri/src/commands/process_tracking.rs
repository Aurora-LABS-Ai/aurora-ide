//! What did this command leave running?
//!
//! The question sounds like a parent-pid walk, and that was the first
//! implementation — it is wrong twice over. Handle inheritance misses
//! `Start-Process` (ShellExecute shares no handles, so no pipe is held), and
//! the parent-pid chain breaks at any DEAD intermediate: git-bash runs
//! commands through a wrapper, so by the time the shell has exited, the
//! `sleep &` survivor's ancestry passes through a process that is no longer
//! in the table, and the walk finds nothing.
//!
//! Windows has a primitive whose whole purpose is this question: a **job
//! object**. Assign the shell to a job at spawn and every process it starts —
//! transitively, through any number of intermediates, alive or dead — is in
//! the job too. At exit, `QueryInformationJobObject(BasicProcessIdList)`
//! answers "who is still here" by membership, not by ancestry.
//!
//! Deliberately NOT set: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The job here
//! is a ledger first — a surviving dev server must keep running when the
//! tracker is dropped. Killing is explicit, through [`ShellJob::kill_members`],
//! and it is the same membership that makes it reach what `taskkill /T`
//! cannot: on thread `1edca8e2` (2026-09-29) `shell_kill` on `npm run serve`
//! (git-bash → npm → node) reported success while the node server kept
//! listening, because its parent in the chain had already exited and the
//! parent-pid walk stopped there. `TerminateJobObject` ends every member
//! whatever its ancestry.
//!
//! What membership cannot see, on any design: processes launched through a
//! broker (elevation prompts, packaged/Store apps relayed via DCOM). Those
//! are started by a system service, not by the shell, and no ancestry- or
//! membership-based scheme attributes them. The pipe-drain check in the
//! lifecycle still runs beside this, so the two witnesses cover each other's
//! blind spots where Windows allows it at all.

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

/// One process a finished command left alive.
#[derive(Debug, Clone)]
pub struct Survivor {
    pub pid: u32,
    /// Executable name only — same rule as `terminal::RunningChild`: a
    /// command line can carry tokens and paths a result has no business
    /// echoing, and the name is what makes the survivor recognisable.
    pub name: String,
}

impl Survivor {
    /// The form the model reads: `notepad.exe (pid 1234)`.
    #[must_use]
    pub fn describe(&self) -> String {
        format!("{} (pid {})", self.name, self.pid)
    }

    /// Is this a POSIX shell process rather than the program it was running?
    fn is_shell(&self) -> bool {
        let name = self.name.to_ascii_lowercase();
        let stem = name.strip_suffix(".exe").unwrap_or(&name);
        matches!(stem, "bash" | "sh" | "dash" | "zsh" | "fish")
    }
}

/// How long to wait before reading the survivors again when the first read
/// caught only shells. See [`caught_mid_fork`].
pub const SURVIVOR_SETTLE_MS: u64 = 250;

/// Did a survivor read land in the gap between a shell forking a background
/// job and that job starting its program?
///
/// Git Bash runs `cmd &` as a fork (a second `bash.exe`) that then starts the
/// program. Read the job in that gap, which a loaded machine widens, and the
/// only survivor is `bash.exe`: real, but not what the command left running.
/// `a_survivor_holding_no_pipe_is_still_found_and_named` failed exactly once
/// in a full test run that way. When every survivor is a shell, the caller
/// reads once more after [`SURVIVOR_SETTLE_MS`]. A shell that really is the
/// survivor (`bash -c 'sleep 99' &`) is still reported, a moment later.
#[must_use]
pub fn caught_mid_fork(survivors: &[Survivor]) -> bool {
    !survivors.is_empty() && survivors.iter().all(Survivor::is_shell)
}

#[cfg(test)]
mod fork_window_tests {
    use super::{caught_mid_fork, Survivor};

    fn s(name: &str) -> Survivor {
        Survivor { pid: 1, name: name.into() }
    }

    #[test]
    fn only_shells_means_the_read_may_have_landed_mid_fork() {
        assert!(caught_mid_fork(&[s("bash.exe")]));
        assert!(caught_mid_fork(&[s("BASH.EXE"), s("sh")]));
        assert!(!caught_mid_fork(&[s("bash.exe"), s("sleep.exe")]), "the program is named");
        assert!(!caught_mid_fork(&[s("node.exe")]));
        assert!(!caught_mid_fork(&[]), "nothing left running is an answer");
        assert!(!caught_mid_fork(&[s("bashful.exe")]), "whole names only");
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::ShellJob;

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::Survivor;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
        QueryInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };

    /// A job the shell (and so everything it starts) is assigned to.
    ///
    /// Closing the handle on drop does not end the member processes — no
    /// kill-on-close limit is set — it only ends Aurora's ability to ask the
    /// question, which by then has been answered.
    pub struct ShellJob {
        handle: HANDLE,
        shell_pid: u32,
    }

    // SAFETY: a job object handle is a kernel handle; ownership can move
    // across threads, and this type never aliases it. Every call on it is a
    // kernel call that is itself thread-safe, so sharing a reference is safe too.
    unsafe impl Send for ShellJob {}
    unsafe impl Sync for ShellJob {}

    impl std::fmt::Debug for ShellJob {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("ShellJob")
                .field("shell_pid", &self.shell_pid)
                .finish_non_exhaustive()
        }
    }

    impl ShellJob {
        /// Create a job and put the just-spawned shell in it.
        ///
        /// `None` on any failure: tracking is an extra witness, never a
        /// reason to fail the command it is watching. One real failure mode
        /// is the shell already being in a job that forbids nesting (pre-Win8
        /// semantics, some CI runners) — the command must still run there.
        pub fn adopt(
            shell_pid: u32,
            shell_handle: std::os::windows::io::RawHandle,
        ) -> Option<Self> {
            // SAFETY: a null name and null security attributes are the
            // documented "anonymous job" form; the handle is checked before
            // use and owned by the returned value.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                if AssignProcessToJobObject(handle, shell_handle as HANDLE) == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self { handle, shell_pid })
            }
        }

        /// Make closing the job's last handle end every member.
        ///
        /// Not used for the agent's shells, whose job is a ledger (see the
        /// module docs). A Terminal tab wants the opposite: its processes
        /// live exactly as long as the tab, including when Aurora exits
        /// without running the window's close handlers.
        pub fn kill_on_close(&self) -> Result<(), String> {
            use windows_sys::Win32::System::JobObjects::{
                JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };
            // SAFETY: the struct is zeroed, one flag set, and passed with its
            // real size; the handle is owned by this value.
            let ok = unsafe {
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    self.handle,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                return Err(format!(
                    "could not set kill-on-close for the job of pid {}: {}",
                    self.shell_pid,
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }

        /// End every process in the job — the shell and everything it
        /// started, through any chain of intermediates, alive or dead.
        ///
        /// This is what `shell_kill` and the stop button mean by "stop it".
        /// The parent-pid walk (`try_kill_pid`) still runs beside it for a
        /// shell that could not be adopted into a job.
        pub fn kill_members(&self) -> Result<(), String> {
            // SAFETY: the handle is owned by this value; the call takes no
            // pointers and reports failure through its return value.
            let ok = unsafe { TerminateJobObject(self.handle, 1) };
            if ok == 0 {
                return Err(format!(
                    "TerminateJobObject failed for the job of pid {}: {}",
                    self.shell_pid,
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }

        /// Everyone still alive in the job, except the shell itself.
        ///
        /// Call after the shell has exited: whatever remains is, by
        /// definition, something the command started and left running.
        #[must_use]
        pub fn survivors(&self) -> Vec<Survivor> {
            // Fixed-capacity list: a command that leaves more than ~250
            // processes running is beyond naming individually anyway, and the
            // truncated form still proves survival.
            const CAPACITY: usize = 256;
            #[repr(C)]
            struct IdList {
                header: JOBOBJECT_BASIC_PROCESS_ID_LIST,
                more: [usize; CAPACITY],
            }
            // SAFETY: the buffer is sized and passed with its real byte
            // length; the returned count is clamped to what fits.
            let pids: Vec<u32> = unsafe {
                let mut list: IdList = std::mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicProcessIdList,
                    (&raw mut list).cast(),
                    std::mem::size_of::<IdList>() as u32,
                    std::ptr::null_mut(),
                );
                if ok == 0 {
                    return Vec::new();
                }
                let count = (list.header.NumberOfProcessIdsInList as usize).min(1 + CAPACITY);
                // The first id lives in the header's own one-element array;
                // the rest follow contiguously — that is the API's layout.
                std::slice::from_raw_parts(list.header.ProcessIdList.as_ptr(), count)
                    .iter()
                    .map(|&pid| pid as u32)
                    .collect()
            };

            let names = process_names();
            pids.into_iter()
                .filter(|&pid| pid != self.shell_pid && pid != 0)
                // The job list can carry a pid whose process has ALREADY
                // exited — the kernel keeps the entry while any handle to the
                // process is open (tokio itself holds one on the shell's
                // wrapper chain). Toolhelp lists only live processes, so
                // absence there means dead, not unnameable: skip it, or every
                // `echo hi` through a wrapper shell reports a phantom
                // survivor. Measured: `unknown (pid …)` on a plain echo.
                .filter_map(|pid| {
                    names.get(&pid).map(|name| Survivor {
                        pid,
                        name: name.clone(),
                    })
                })
                // Console plumbing rides along with any console child; it is
                // not something the command "left running", and counting it
                // would make every ordinary command look like a launcher.
                .filter(|survivor| !survivor.name.eq_ignore_ascii_case("conhost.exe"))
                .collect()
        }
    }

    impl Drop for ShellJob {
        fn drop(&mut self) {
            // SAFETY: the handle is owned by this value and closed once.
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }

    /// pid → executable name, one Toolhelp snapshot.
    fn process_names() -> std::collections::HashMap<u32, String> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        let mut names = std::collections::HashMap::new();
        // SAFETY: the snapshot handle is checked and closed on every path;
        // `entry` is zeroed with `dwSize` set as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return names;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    names.insert(
                        entry.th32ProcessID,
                        String::from_utf16_lossy(&entry.szExeFile[..end]),
                    );
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
        names
    }
}

/// Non-Windows: no job objects. The parent-pid walk in
/// `commands::terminal::descendants_of` is the available witness there; it
/// misses survivors behind dead intermediates, which the pipe-drain check
/// still catches when handles were inherited. Honest gap, documented rather
/// than papered over.
#[cfg(not(target_os = "windows"))]
#[derive(Debug)]
pub struct ShellJob;

#[cfg(not(target_os = "windows"))]
impl ShellJob {
    pub fn adopt(_shell_pid: u32, _shell_handle: ()) -> Option<Self> {
        None
    }
    pub fn kill_members(&self) -> Result<(), String> {
        Ok(())
    }
    #[must_use]
    pub fn survivors(&self) -> Vec<Survivor> {
        Vec::new()
    }
}

/// The failure `shell_kill` reported on thread `1edca8e2`, reproduced without
/// npm: `cmd /c start /b ping …` launches ping and exits, so by the time the
/// kill runs, ping's parent is gone and no parent-pid walk from the shell can
/// reach it. Job membership can, and does.
#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::ShellJob;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[test]
    fn kill_members_reaches_a_process_whose_parent_already_exited() {
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "start /b ping -n 60 127.0.0.1 >nul"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("cmd spawns");
        let job = ShellJob::adopt(child.id(), child.as_raw_handle()).expect("job adopts the shell");
        // The shell exits at once; ping outlives it.
        let _ = child.wait();

        let before = job.survivors();
        assert!(
            before.iter().any(|s| s.name.eq_ignore_ascii_case("ping.exe")),
            "ping should have outlived its parent: {before:?}"
        );

        job.kill_members().expect("terminate the job");
        std::thread::sleep(std::time::Duration::from_millis(300));

        let after = job.survivors();
        assert!(
            after.iter().all(|s| !s.name.eq_ignore_ascii_case("ping.exe")),
            "ping must be gone after the job kill: {after:?}"
        );
    }
}
