use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

// Windows-specific imports for hiding console window
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Windows creation flags
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use notify::{recommended_watcher, Config, Event, EventKind, RecursiveMode, Watcher};
use tauri::Emitter;

pub mod state;
pub mod settings;
pub mod threads;
pub mod llm;
pub mod chat;
pub mod themes;
pub mod semantic;
pub mod git;

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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,           // e.g., "windows", "macos", "linux"
    pub os_version: String,   // e.g., "10.0.26200" for Windows
    pub arch: String,         // e.g., "x86_64", "aarch64"
    pub hostname: String,
    pub shell: Option<String>, // Default shell path
}

static FS_WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();

fn get_watcher_handle() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    FS_WATCHER.get_or_init(|| Mutex::new(None))
}

/// Read directory contents
/// 
/// Args:
///   path: Directory path to read
///   include_hidden: Whether to include hidden files/folders (starting with .)
#[tauri::command]
pub async fn read_directory(path: String, include_hidden: Option<bool>) -> Result<Vec<FileEntry>, String> {
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
                if file_name == "node_modules" || file_name == "target" || file_name == "dist" || file_name == ".pnpm" {
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
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// Read file content (cached for performance)
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    // Use the cached file reader for performance
    crate::file_cache::read_file_cached(&path)
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

    let result = fs::write(file_path, &content)
        .map_err(|e| format!("Failed to write file: {}", e));
    
    // Invalidate cache after write (file content changed)
    crate::file_cache::get_file_cache().invalidate(&path);
    
    result
}

/// Execute a shell command with optional shell profile
#[tauri::command]
pub async fn execute_command(command: String, cwd: Option<String>, shell: Option<String>) -> Result<CommandOutput, String> {
    let shell_profile = shell.as_deref().unwrap_or("powershell");
    
    // Determine shell and arguments based on profile
    let (shell_exe, shell_args): (String, Vec<&str>) = match shell_profile {
        "bash" => {
            // Try common Git Bash locations on Windows
            #[cfg(target_os = "windows")]
            {
                let git_bash_paths = [
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                    r"C:\Git\bin\bash.exe",
                ];
                
                let bash_path = git_bash_paths.iter()
                    .find(|p| std::path::Path::new(p).exists())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "bash".to_string());
                
                // Don't use -i flag - causes PTY warnings without proper terminal
                (bash_path, vec!["-c"])
            }
            #[cfg(not(target_os = "windows"))]
            {
                ("bash".to_string(), vec!["-c"])
            }
        }
        _ => {
            // Default to PowerShell
            #[cfg(target_os = "windows")]
            {
                ("pwsh".to_string(), vec!["-NoProfile", "-NonInteractive", "-Command"])
            }
            #[cfg(not(target_os = "windows"))]
            {
                ("sh".to_string(), vec!["-c"])
            }
        }
    };

    let mut cmd = Command::new(&shell_exe);
    
    // Add shell arguments
    for arg in &shell_args {
        cmd.arg(arg);
    }
    cmd.arg(&command);

    if let Some(ref working_dir) = cwd {
        cmd.current_dir(working_dir);
    }

    // On Windows, hide the console window to prevent popup
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    // Execute command
    match cmd.output() {
        Ok(output) => {
            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
                success: output.status.success(),
            })
        }
        Err(e) => {
            // On Windows with PowerShell, try fallback to powershell.exe
            #[cfg(target_os = "windows")]
            if shell_profile != "bash" {
                let mut fallback_cmd = Command::new("powershell");
                fallback_cmd
                    .arg("-NoProfile")
                    .arg("-NonInteractive")
                    .arg("-Command")
                    .arg(&command);
                
                if let Some(ref working_dir) = cwd {
                    fallback_cmd.current_dir(working_dir);
                }

                // Hide console window for fallback command too
                fallback_cmd.creation_flags(CREATE_NO_WINDOW);

                match fallback_cmd.output() {
                    Ok(output) => {
                        return Ok(CommandOutput {
                            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                            exit_code: output.status.code(),
                            success: output.status.success(),
                        });
                    }
                    Err(fallback_e) => {
                        return Err(format!("Failed to execute with pwsh and powershell: {}, {}", e, fallback_e));
                    }
                }
            }
            
            Err(format!("Failed to execute command with {}: {}", shell_exe, e))
        }
    }
}

/// Get system information (Cursor-style detailed info)
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    
    // Get OS version
    let os_version = get_os_version();
    
    // Get default shell
    let shell = get_default_shell();
    
    Ok(SystemInfo {
        os,
        os_version,
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
        shell,
    })
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
        if let Ok(output) = Command::new("sw_vers")
            .arg("-productVersion")
            .output()
        {
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
            let ps5_path = format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", system_root);
            if Path::new(&ps5_path).exists() {
                return Some(ps5_path);
            }
        }
        
        // Fallback to cmd.exe
        Some(std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string()))
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        // Unix-like: check SHELL env var
        std::env::var("SHELL").ok().or_else(|| Some("/bin/sh".to_string()))
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
    fs::File::create(file_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

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

    fs::create_dir_all(dir_path)
        .map_err(|e| format!("Failed to create folder: {}", e))
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
        fs::remove_dir_all(target_path)
            .map_err(|e| format!("Failed to delete folder: {}", e))
    } else {
        // Invalidate the specific file
        crate::file_cache::get_file_cache().invalidate(&path);
        fs::remove_file(target_path)
            .map_err(|e| format!("Failed to delete file: {}", e))
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

    fs::rename(old, new)
        .map_err(|e| format!("Failed to rename: {}", e))
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
        fs::copy(src, dest)
            .map_err(|e| format!("Failed to copy file: {}", e))?;
    } else if src.is_dir() {
        copy_dir_recursive(src, dest)?;
    }

    Ok(())
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
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
            // Map event kind to string
            let kind_str = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "remove",
                EventKind::Any => "any",
                EventKind::Access(_) => "access",
                EventKind::Other => "other",
            };

            let paths: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();

            // Emit to frontend; ignore errors if no windows
            let _ = app_handle.emit(
                "fs-changed",
                FsEventPayload {
                    paths,
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
        let result = Command::new("xdg-open")
            .arg(reveal_path.to_string_lossy().to_string())
            .spawn();
        
        if result.is_err() {
            // Try nautilus (GNOME)
            let _ = Command::new("nautilus")
                .arg("--select")
                .arg(&path)
                .spawn();
        }
    }

    Ok(())
}

/// Open a terminal at the specified path
#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);
    
    // Use the path directly if it's a directory, otherwise use its parent
    let terminal_path = if target_path.is_dir() {
        target_path.to_path_buf()
    } else {
        target_path.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| target_path.to_path_buf())
    };

    if !terminal_path.exists() {
        return Err(format!("Path does not exist: {}", terminal_path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        // Try Windows Terminal first, then fall back to cmd
        let wt_result = Command::new("wt")
            .arg("-d")
            .arg(terminal_path.to_string_lossy().to_string())
            .spawn();
        
        if wt_result.is_err() {
            // Fall back to PowerShell in a new window
            Command::new("powershell")
                .arg("-NoExit")
                .arg("-Command")
                .arg(format!("cd '{}'", terminal_path.display()))
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Open Terminal.app with the specified directory
        let script = format!(
            "tell application \"Terminal\" to do script \"cd '{}'\"",
            terminal_path.display()
        );
        Command::new("osascript")
            .arg("-e")
            .arg(&script)
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
                _ => Command::new(terminal)
                    .current_dir(&terminal_path)
                    .spawn(),
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
    crate::file_cache::read_files_batch_cached(paths)
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
