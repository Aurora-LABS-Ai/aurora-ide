//! CLI module for `aurora .` command support
//!
//! This module provides VS Code-like CLI functionality:
//! - `aurora .` - Open Aurora in current directory
//! - `aurora /path/to/folder` - Open Aurora in specified directory
//! - `aurora file.txt` - Open Aurora and open the file
//! - `aurora --help` - Show help
//! - `aurora --version` - Show version

use clap::{Parser, Subcommand};
use std::path::{Component, Path, PathBuf};

use crate::icon_pack::{execute_cli_command, IconPackCommand};

/// Normalize a path by resolving `.` and `..` components without using canonicalize()
/// This avoids the \\?\ prefix that Windows canonicalize() adds
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            Component::CurDir => {
                // Skip "." - current directory
            }
            Component::ParentDir => {
                // Go up one level if possible
                if !components.is_empty() {
                    components.pop();
                }
            }
            other => {
                components.push(other);
            }
        }
    }

    // Rebuild the path from components
    let mut result = PathBuf::new();
    for component in components {
        result.push(component.as_os_str());
    }

    // Handle empty result (shouldn't happen but be safe)
    if result.as_os_str().is_empty() {
        return path.to_path_buf();
    }

    result
}

/// Aurora - AI-Powered Agentic Code Editor
#[derive(Parser, Debug, Clone, Default)]
#[command(name = "aurora")]
#[command(author = "Aurora Team")]
#[command(version)]
#[command(about = "AI-Powered Agentic Code Editor", long_about = None)]
pub struct CliArgs {
    #[command(subcommand)]
    pub command: Option<CliCommand>,

    /// Path to open (file or folder). Use "." for current directory.
    #[arg(value_name = "PATH")]
    pub path: Option<PathBuf>,

    /// Open a new window even if Aurora is already running
    #[arg(short, long)]
    pub new_window: bool,

    /// Wait for the files to be closed before returning (for git editor, etc.)
    #[arg(short, long)]
    pub wait: bool,

    /// Go to a specific line (use with file path)
    #[arg(short, long, value_name = "LINE")]
    pub goto: Option<u32>,

    /// Open diff between two files
    #[arg(short, long, value_name = "FILE", num_args = 2)]
    pub diff: Option<Vec<PathBuf>>,

    /// Add folder to the current workspace
    #[arg(short, long)]
    pub add: bool,

    /// Force opening a new empty window
    #[arg(long)]
    pub new_empty_window: bool,

    /// Install the 'aurora' CLI command to system PATH (requires admin on Windows)
    #[arg(long)]
    pub install_cli: bool,

    /// Uninstall the 'aurora' CLI command from system PATH
    #[arg(long)]
    pub uninstall_cli: bool,
}

#[derive(Subcommand, Debug, Clone)]
pub enum CliCommand {
    /// Build and validate Aurora icon packs.
    #[command(name = "icon-pack")]
    IconPack {
        #[command(subcommand)]
        command: IconPackCommand,
    },
}

impl CliArgs {
    /// Parse command line arguments
    pub fn parse_args() -> Self {
        CliArgs::parse()
    }

    /// Resolve the path to an absolute, normalized path
    pub fn resolve_path(&self) -> Option<PathBuf> {
        self.path.as_ref().and_then(|p| {
            let absolute = if p.is_absolute() {
                p.clone()
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(p))
                    .unwrap_or_else(|_| p.clone())
            };

            // Normalize the path to resolve ".", ".." components
            // NOTE: We avoid canonicalize() on Windows because it adds \\?\ prefix
            let normalized = normalize_path(&absolute);
            Some(normalized)
        })
    }

    /// Check if this is a folder path
    pub fn is_folder(&self) -> bool {
        self.resolve_path().map(|p| p.is_dir()).unwrap_or(false)
    }

    /// Check if this is a file path
    pub fn is_file(&self) -> bool {
        self.resolve_path().map(|p| p.is_file()).unwrap_or(false)
    }

    /// Get the workspace root (folder to open)
    pub fn get_workspace_root(&self) -> Option<PathBuf> {
        let resolved = self.resolve_path()?;

        if resolved.is_dir() {
            Some(resolved)
        } else if resolved.is_file() {
            // For files, use the parent directory as workspace
            resolved.parent().map(|p| p.to_path_buf())
        } else {
            // Path doesn't exist yet - could be a new file
            // Use parent directory or current directory
            resolved
                .parent()
                .filter(|p| p.exists())
                .map(|p| p.to_path_buf())
                .or_else(|| std::env::current_dir().ok())
        }
    }

    /// Get the file to open (if path is a file)
    pub fn get_file_to_open(&self) -> Option<PathBuf> {
        let resolved = self.resolve_path()?;

        if resolved.is_file() {
            Some(resolved)
        } else {
            None
        }
    }

    /// Execute a non-GUI CLI command and return whether one was handled.
    pub fn execute_non_gui_command(&self) -> Result<bool, String> {
        match &self.command {
            Some(CliCommand::IconPack { command }) => {
                execute_cli_command(command).map_err(|error| error.to_string())?;
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

/// Data structure to pass to frontend via Tauri event
#[derive(Debug, Clone, serde::Serialize)]
pub struct CliOpenRequest {
    /// Workspace root folder to open
    pub workspace_path: Option<String>,

    /// Specific file to open (and focus)
    pub file_path: Option<String>,

    /// Line number to go to (1-indexed)
    pub goto_line: Option<u32>,

    /// Whether this should open in a new window
    pub new_window: bool,

    /// Files for diff view
    pub diff_files: Option<(String, String)>,
}

impl From<&CliArgs> for CliOpenRequest {
    fn from(args: &CliArgs) -> Self {
        let workspace_path = args
            .get_workspace_root()
            .and_then(|p| p.to_str().map(String::from));

        let file_path = args
            .get_file_to_open()
            .and_then(|p| p.to_str().map(String::from));

        let diff_files = args.diff.as_ref().and_then(|files| {
            if files.len() == 2 {
                let f1 = files[0].to_str()?.to_string();
                let f2 = files[1].to_str()?.to_string();
                Some((f1, f2))
            } else {
                None
            }
        });

        CliOpenRequest {
            workspace_path,
            file_path,
            goto_line: args.goto,
            new_window: args.new_window,
            diff_files,
        }
    }
}

#[cfg(windows)]
pub mod install {
    use std::io::ErrorKind;
    use std::path::PathBuf;
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    const DIRECTORY_CONTEXT_MENU_KEY: &str = r"Software\Classes\Directory\shell\Aurora";
    const DIRECTORY_BACKGROUND_CONTEXT_MENU_KEY: &str =
        r"Software\Classes\Directory\Background\shell\Aurora";
    const DRIVE_CONTEXT_MENU_KEY: &str = r"Software\Classes\Drive\shell\Aurora";
    const USER_ENVIRONMENT_KEY: &str = "Environment";

    fn get_hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    fn normalize_windows_path_for_compare(path: &str) -> String {
        path.trim()
            .trim_end_matches('\\')
            .trim_end_matches('/')
            .to_ascii_lowercase()
    }

    fn split_user_path(path_value: &str) -> Vec<String> {
        path_value
            .split(';')
            .filter_map(|entry| {
                let trimmed = entry.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
            .collect()
    }

    fn path_contains_dir(path_value: &str, dir: &str) -> bool {
        let normalized_dir = normalize_windows_path_for_compare(dir);
        split_user_path(path_value)
            .into_iter()
            .any(|entry| normalize_windows_path_for_compare(&entry) == normalized_dir)
    }

    fn read_user_path() -> Result<String, String> {
        let hkcu = get_hkcu();
        let env_key = match hkcu.open_subkey_with_flags(USER_ENVIRONMENT_KEY, KEY_READ) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(String::new()),
            Err(error) => {
                return Err(format!("Failed to open HKCU\\Environment: {}", error));
            }
        };

        match env_key.get_value::<String, _>("Path") {
            Ok(value) => Ok(value),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(format!("Failed to read user PATH: {}", error)),
        }
    }

    fn write_user_path_segments(segments: &[String]) -> Result<(), String> {
        let hkcu = get_hkcu();
        let (env_key, _) = hkcu
            .create_subkey(USER_ENVIRONMENT_KEY)
            .map_err(|error| format!("Failed to open HKCU\\Environment for write: {}", error))?;

        if segments.is_empty() {
            match env_key.delete_value("Path") {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Failed to clear user PATH: {}", error)),
            }
        } else {
            env_key
                .set_value("Path", &segments.join(";"))
                .map_err(|error| format!("Failed to update user PATH: {}", error))?;
        }

        broadcast_environment_change();
        Ok(())
    }

    fn set_registry_value(
        key_path: &str,
        value_name: Option<&str>,
        value: &str,
    ) -> Result<(), String> {
        let hkcu = get_hkcu();
        let (key, _) = hkcu
            .create_subkey(key_path)
            .map_err(|error| format!("Failed to open registry key {}: {}", key_path, error))?;

        match value_name {
            Some(name) => key.set_value(name, &value).map_err(|error| {
                format!(
                    "Failed to write registry value {}\\{}: {}",
                    key_path, name, error
                )
            }),
            None => key
                .set_value("", &value)
                .map_err(|error| format!("Failed to write registry value {}: {}", key_path, error)),
        }
    }

    fn registry_key_exists(key_path: &str) -> Result<bool, String> {
        let hkcu = get_hkcu();
        match hkcu.open_subkey_with_flags(key_path, KEY_READ) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Failed to query registry key {}: {}",
                key_path, error
            )),
        }
    }

    fn delete_registry_tree(key_path: &str) -> Result<(), String> {
        let hkcu = get_hkcu();
        match hkcu.delete_subkey_all(key_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Failed to delete registry key {}: {}",
                key_path, error
            )),
        }
    }

    fn broadcast_environment_change() {
        let payload: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result: usize = 0;

        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                payload.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result as *mut usize,
            );
        }
    }

    fn notify_shell_association_change() {
        unsafe {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED as i32,
                SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
    }

    /// Get the path where Aurora CLI should be installed
    pub fn get_cli_install_path() -> PathBuf {
        // Install to %LOCALAPPDATA%\Aurora\bin
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\Users\\Default\\AppData\\Local"))
            .join("Aurora")
            .join("bin")
    }

    /// Install the CLI command to system PATH
    pub fn install_cli() -> Result<(), String> {
        let install_dir = get_cli_install_path();

        // Create the directory
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Failed to create install directory: {}", e))?;

        // Get current executable path
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get current executable: {}", e))?;

        // Create a batch file that calls the main exe
        let batch_path = install_dir.join("aurora.cmd");
        let batch_content = format!("@echo off\r\n\"{exe}\" %*", exe = current_exe.display());

        std::fs::write(&batch_path, batch_content)
            .map_err(|e| format!("Failed to create aurora.cmd: {}", e))?;

        // Remove stale `aurora.exe` snapshots from older installs.
        // If present, Windows may prefer it over aurora.cmd and launch an outdated build.
        let stale_exe_path = install_dir.join("aurora.exe");
        if stale_exe_path.exists() {
            std::fs::remove_file(&stale_exe_path)
                .map_err(|e| format!("Failed to remove stale aurora.exe: {}", e))?;
        }

        let install_dir_str = install_dir.to_str().ok_or("Invalid install path")?;

        let existing_path = read_user_path()?;
        let mut segments = split_user_path(&existing_path);
        if !path_contains_dir(&existing_path, install_dir_str) {
            segments.push(install_dir_str.to_string());
            write_user_path_segments(&segments)?;
        }
        println!("\nAurora CLI installed successfully!");
        println!("Location: {}", install_dir.display());
        println!("\nUsage:");
        println!("  aurora .                              Open current directory");
        println!("  aurora /path/to/dir                   Open specific directory");
        println!("  aurora file.txt                       Open a file");
        println!("  aurora icon-pack build --manifest ... Build a .aurora icon-pack bundle");

        Ok(())
    }

    /// Check if the CLI command is installed
    pub fn is_cli_installed() -> Result<bool, String> {
        let install_dir = get_cli_install_path();
        let cmd_path = install_dir.join("aurora.cmd");
        let install_dir_str = install_dir.to_str().ok_or("Invalid install path")?;
        let path_value = read_user_path()?;
        Ok(cmd_path.exists() && path_contains_dir(&path_value, install_dir_str))
    }

    /// Install Aurora into Windows Explorer context menu for folders and directory backgrounds.
    pub fn install_context_menu() -> Result<(), String> {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get current executable: {}", e))?;
        let exe = current_exe.to_string_lossy().to_string();
        let icon_value = exe.clone();
        let folder_command = format!(r#""{}" "%1""#, exe);
        let background_command = format!(r#""{}" "%V""#, exe);

        for key in [
            DIRECTORY_CONTEXT_MENU_KEY,
            DIRECTORY_BACKGROUND_CONTEXT_MENU_KEY,
            DRIVE_CONTEXT_MENU_KEY,
        ] {
            set_registry_value(key, None, "Open with Aurora")?;
            set_registry_value(key, Some("Icon"), &icon_value)?;
        }

        set_registry_value(
            &format!(r"{}\command", DIRECTORY_CONTEXT_MENU_KEY),
            None,
            &folder_command,
        )?;
        set_registry_value(
            &format!(r"{}\command", DIRECTORY_BACKGROUND_CONTEXT_MENU_KEY),
            None,
            &background_command,
        )?;
        set_registry_value(
            &format!(r"{}\command", DRIVE_CONTEXT_MENU_KEY),
            None,
            &folder_command,
        )?;

        notify_shell_association_change();

        Ok(())
    }

    /// Check whether Aurora context menu registration exists.
    pub fn is_context_menu_installed() -> Result<bool, String> {
        Ok(registry_key_exists(DIRECTORY_CONTEXT_MENU_KEY)?
            && registry_key_exists(&format!(r"{}\command", DIRECTORY_CONTEXT_MENU_KEY))?
            && registry_key_exists(DIRECTORY_BACKGROUND_CONTEXT_MENU_KEY)?
            && registry_key_exists(&format!(
                r"{}\command",
                DIRECTORY_BACKGROUND_CONTEXT_MENU_KEY
            ))?
            && registry_key_exists(DRIVE_CONTEXT_MENU_KEY)?
            && registry_key_exists(&format!(r"{}\command", DRIVE_CONTEXT_MENU_KEY))?)
    }

    /// Remove Aurora from Windows Explorer context menus.
    pub fn uninstall_context_menu() -> Result<(), String> {
        delete_registry_tree(DIRECTORY_CONTEXT_MENU_KEY)?;
        delete_registry_tree(DIRECTORY_BACKGROUND_CONTEXT_MENU_KEY)?;
        delete_registry_tree(DRIVE_CONTEXT_MENU_KEY)?;
        notify_shell_association_change();
        Ok(())
    }

    /// Uninstall the CLI command from PATH
    pub fn uninstall_cli() -> Result<(), String> {
        let install_dir = get_cli_install_path();

        let install_dir_str = install_dir.to_str().ok_or("Invalid install path")?;
        let normalized_dir = normalize_windows_path_for_compare(install_dir_str);
        let existing_path = read_user_path()?;
        let filtered_segments = split_user_path(&existing_path)
            .into_iter()
            .filter(|segment| normalize_windows_path_for_compare(segment) != normalized_dir)
            .collect::<Vec<_>>();
        write_user_path_segments(&filtered_segments)?;

        // Remove files
        if install_dir.exists() {
            std::fs::remove_dir_all(&install_dir)
                .map_err(|e| format!("Failed to remove install directory: {}", e))?;
        }

        println!("Aurora CLI uninstalled successfully!");
        Ok(())
    }
}

#[cfg(unix)]
pub mod install {
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    /// Get the path where Aurora CLI symlink should be created
    pub fn get_cli_install_path() -> PathBuf {
        // Install to ~/.local/bin (standard user bin on Linux/macOS)
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join(".local")
            .join("bin")
    }

    /// Install the CLI command (create symlink)
    pub fn install_cli() -> Result<(), String> {
        let install_dir = get_cli_install_path();

        // Create the directory
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Failed to create install directory: {}", e))?;

        // Get current executable path
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get current executable: {}", e))?;

        let symlink_path = install_dir.join("aurora");

        // Remove existing symlink if present
        if symlink_path.exists() || symlink_path.is_symlink() {
            std::fs::remove_file(&symlink_path)
                .map_err(|e| format!("Failed to remove existing symlink: {}", e))?;
        }

        // Create symlink
        symlink(&current_exe, &symlink_path)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;

        println!("Aurora CLI installed successfully!");
        println!("Location: {}", symlink_path.display());
        println!("\nMake sure {} is in your PATH.", install_dir.display());
        println!("Add this to your ~/.bashrc or ~/.zshrc:");
        println!("  export PATH=\"$HOME/.local/bin:$PATH\"");
        println!("\nUsage:");
        println!("  aurora .                              Open current directory");
        println!("  aurora /path/to/dir                   Open specific directory");
        println!("  aurora file.txt                       Open a file");
        println!("  aurora icon-pack build --manifest ... Build a .aurora icon-pack bundle");

        Ok(())
    }

    /// Check if the CLI command is installed
    pub fn is_cli_installed() -> Result<bool, String> {
        let symlink_path = get_cli_install_path().join("aurora");
        Ok(symlink_path.exists() || symlink_path.is_symlink())
    }

    pub fn install_context_menu() -> Result<(), String> {
        Err("Windows Explorer context menus are only supported on Windows.".to_string())
    }

    pub fn is_context_menu_installed() -> Result<bool, String> {
        Ok(false)
    }

    pub fn uninstall_context_menu() -> Result<(), String> {
        Err("Windows Explorer context menus are only supported on Windows.".to_string())
    }

    /// Uninstall the CLI command
    pub fn uninstall_cli() -> Result<(), String> {
        let symlink_path = get_cli_install_path().join("aurora");

        if symlink_path.exists() || symlink_path.is_symlink() {
            std::fs::remove_file(&symlink_path)
                .map_err(|e| format!("Failed to remove symlink: {}", e))?;
        }

        println!("Aurora CLI uninstalled successfully!");
        Ok(())
    }
}
