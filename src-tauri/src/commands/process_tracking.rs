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
//! is a ledger, not a leash — a surviving dev server must keep running when
//! the tracker is dropped; killing is `try_kill_pid`'s job and stays so.
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
}

#[cfg(target_os = "windows")]
pub use windows_impl::ShellJob;

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::Survivor;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
        QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
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
    // across threads, and this type never aliases it.
    unsafe impl Send for ShellJob {}

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
pub struct ShellJob;

#[cfg(not(target_os = "windows"))]
impl ShellJob {
    pub fn adopt(_shell_pid: u32, _shell_handle: ()) -> Option<Self> {
        None
    }
    #[must_use]
    pub fn survivors(&self) -> Vec<Survivor> {
        Vec::new()
    }
}
