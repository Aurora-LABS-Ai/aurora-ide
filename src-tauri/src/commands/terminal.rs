//! What a shell has left running, by parent-pid walk.
//!
//! The Terminal panel no longer depends on this: its shells live in job
//! objects (`commands::terminal_pty`), which answer by membership. The walk
//! here stays for the places without a job — the shell lifecycle's exit check
//! and a terminal whose shell could not be adopted. Its tab-close commands
//! were removed: they took `IPty.pid`, which `tauri-plugin-pty` filled with a
//! session counter, so they aimed at system processes and never at the tab's.

use serde::Serialize;

/// One process a shell has left running.
#[derive(Debug, Clone, Serialize)]
pub struct RunningChild {
    pub pid: u32,
    /// Executable name (`node.exe`, `electron`). Never a full command line —
    /// that can carry tokens and paths a warning dialog has no business
    /// showing, and the name alone is what makes it recognisable.
    pub name: String,
}

/// Walk a (pid, parent pid, name) table into every descendant of `root`.
///
/// Shared by both platforms so the traversal — which is where the interesting
/// mistakes live — is written and tested once.
fn collect_descendants(table: &[(u32, u32, String)], root: u32) -> Vec<RunningChild> {
    let mut found = Vec::new();
    let mut frontier = vec![root];
    // Guards against a pid table containing a cycle, which a snapshot taken
    // while pids are being recycled can genuinely produce. Without it the walk
    // never terminates and the close button hangs.
    let mut seen = std::collections::HashSet::from([root]);
    while let Some(parent) = frontier.pop() {
        for (pid, ppid, name) in table {
            if *ppid != parent || !seen.insert(*pid) {
                continue;
            }
            found.push(RunningChild {
                pid: *pid,
                name: name.clone(),
            });
            frontier.push(*pid);
        }
    }
    found
}

/// `pub(crate)` because the shell lifecycle (`commands::run_command_lifecycle`)
/// uses the same walk at command exit: a survivor that inherited no pipe
/// (`Start-Process` goes through ShellExecute, which shares no handles) is
/// invisible to the pipe-drain check, but its parent-pid link still points at
/// the dead shell — Windows never rewrites it — so the table walk finds it.
#[cfg(target_os = "windows")]
pub(crate) fn descendants_of(root: u32) -> Result<Vec<RunningChild>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: the snapshot handle is checked before use and closed on every
    // path out; `entry` is zeroed and its `dwSize` set as the API requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("could not enumerate processes".to_string());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut table = Vec::new();
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                table.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..end]),
                ));
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        Ok(collect_descendants(&table, root))
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn descendants_of(root: u32) -> Result<Vec<RunningChild>, String> {
    use std::process::Command;

    let output = Command::new("ps")
        .args(["-eo", "pid=,ppid=,comm="])
        .output()
        .map_err(|error| format!("could not enumerate processes: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);

    let mut table = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        // `comm` can contain spaces; everything after the two ids is the name.
        let name = parts.collect::<Vec<_>>().join(" ");
        table.push((pid, ppid, name));
    }
    Ok(collect_descendants(&table, root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, name: &str) -> (u32, u32, String) {
        (pid, ppid, name.to_string())
    }

    /// The case from the bug report: the shell started pnpm, which started
    /// node, which started Electron. Only the shell's pid is known, and the
    /// process worth warning about is three levels down.
    #[test]
    fn finds_a_grandchild_the_shell_never_knew_about() {
        let table = vec![
            row(100, 1, "pwsh.exe"),
            row(200, 100, "pnpm.cmd"),
            row(300, 200, "node.exe"),
            row(400, 300, "electron.exe"),
            row(999, 1, "explorer.exe"),
        ];
        let mut found = collect_descendants(&table, 100);
        found.sort_by_key(|c| c.pid);
        let names: Vec<_> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["pnpm.cmd", "node.exe", "electron.exe"]);
    }

    /// An idle shell must not warn. A dialog that appears every single time is
    /// one people click through without reading, which costs the warning its
    /// only job.
    #[test]
    fn an_idle_shell_has_no_children() {
        let table = vec![row(100, 1, "pwsh.exe"), row(999, 1, "explorer.exe")];
        assert!(collect_descendants(&table, 100).is_empty());
    }

    /// The shell itself is never reported as its own child.
    #[test]
    fn the_shell_is_not_in_its_own_list() {
        let table = vec![row(100, 1, "pwsh.exe"), row(200, 100, "node.exe")];
        let found = collect_descendants(&table, 100);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, 200);
    }

    /// Pid recycling can produce a snapshot where a process appears to be its
    /// own ancestor. The walk must end rather than hang the close button.
    #[test]
    fn a_cycle_terminates_instead_of_hanging() {
        let table = vec![
            row(100, 1, "pwsh.exe"),
            row(200, 100, "a.exe"),
            row(300, 200, "b.exe"),
            row(200, 300, "a.exe"),
        ];
        let found = collect_descendants(&table, 100);
        assert_eq!(found.len(), 2);
    }
}
