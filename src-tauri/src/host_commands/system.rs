//! The machine the host runs on: OS, shell, the process's own folder, and the
//! file cache's counters. Written once here; the window's commands in
//! `commands/mod.rs` are wrappers.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{done, CommandContext, CommandError};

// Windows creation flags
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const COMMANDS: &[&str] = &[
    "get_system_info",
    "get_workspace_root",
    "get_cache_stats",
    "machine_stats",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    _ctx: &CommandContext,
    name: &str,
    _args: &Value,
) -> Option<Result<Value, CommandError>> {
    Some(match name {
        "get_system_info" => done(get_system_info().await),
        "get_workspace_root" => done(get_workspace_root()),
        "get_cache_stats" => done(Ok(crate::file_cache::get_file_cache().stats())),
        "machine_stats" => done(machine_stats().await),
        _ => return None,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,         // e.g., "windows", "macos", "linux"
    pub os_version: String, // e.g., "10.0.26200" for Windows
    pub arch: String,       // e.g., "x86_64", "aarch64"
    pub hostname: String,
    pub shell: Option<String>, // Default shell path
}

/// Get system information (Cursor-style detailed info)
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

/// How loaded the engine's machine is right now (`machine.rs`).
pub async fn machine_stats() -> Result<crate::machine::MachineStats, String> {
    tokio::task::spawn_blocking(crate::machine::read)
        .await
        .map_err(|e| format!("Failed to read the machine: {e}"))?
}

/// The folder the host process was started in.
pub fn get_workspace_root() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get current directory: {}", e))
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
