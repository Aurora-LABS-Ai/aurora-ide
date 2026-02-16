//! CLI module for `aurora .` command support
//! 
//! This module provides VS Code-like CLI functionality:
//! - `aurora .` - Open Aurora in current directory
//! - `aurora /path/to/folder` - Open Aurora in specified directory
//! - `aurora file.txt` - Open Aurora and open the file
//! - `aurora --help` - Show help
//! - `aurora --version` - Show version

use clap::Parser;
use std::path::{PathBuf, Path, Component};

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
        self.resolve_path()
            .map(|p| p.is_dir())
            .unwrap_or(false)
    }

    /// Check if this is a file path
    pub fn is_file(&self) -> bool {
        self.resolve_path()
            .map(|p| p.is_file())
            .unwrap_or(false)
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
            resolved.parent()
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
        let workspace_path = args.get_workspace_root()
            .and_then(|p| p.to_str().map(String::from));
        
        let file_path = args.get_file_to_open()
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
    use std::path::PathBuf;
    use std::process::Command;

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
        let batch_content = format!(
            "@echo off\r\n\"{exe}\" %*",
            exe = current_exe.display()
        );
        
        std::fs::write(&batch_path, batch_content)
            .map_err(|e| format!("Failed to create aurora.cmd: {}", e))?;

        // Remove stale `aurora.exe` snapshots from older installs.
        // If present, Windows may prefer it over aurora.cmd and launch an outdated build.
        let stale_exe_path = install_dir.join("aurora.exe");
        if stale_exe_path.exists() {
            std::fs::remove_file(&stale_exe_path)
                .map_err(|e| format!("Failed to remove stale aurora.exe: {}", e))?;
        }

        // Add to user PATH using PowerShell
        let install_dir_str = install_dir.to_str()
            .ok_or("Invalid install path")?;
        
        let ps_script = format!(
            r#"
            $path = [Environment]::GetEnvironmentVariable('Path', 'User')
            if ($path -notlike '*{dir}*') {{
                [Environment]::SetEnvironmentVariable('Path', "$path;{dir}", 'User')
                Write-Host 'Aurora CLI added to PATH. Restart your terminal to use "aurora ." command.'
            }} else {{
                Write-Host 'Aurora CLI is already in PATH.'
            }}
            "#,
            dir = install_dir_str
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_script])
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to add to PATH: {}", stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        println!("{}", stdout);
        println!("\nAurora CLI installed successfully!");
        println!("Location: {}", install_dir.display());
        println!("\nUsage:");
        println!("  aurora .              Open current directory");
        println!("  aurora /path/to/dir   Open specific directory");
        println!("  aurora file.txt       Open a file");

        Ok(())
    }

    /// Check if the CLI command is installed
    pub fn is_cli_installed() -> Result<bool, String> {
        let install_dir = get_cli_install_path();
        let cmd_path = install_dir.join("aurora.cmd");
        Ok(cmd_path.exists())
    }

    /// Uninstall the CLI command from PATH
    pub fn uninstall_cli() -> Result<(), String> {
        let install_dir = get_cli_install_path();

        let install_dir_str = install_dir.to_str()
            .ok_or("Invalid install path")?;

        // Remove from PATH
        let ps_script = format!(
            r#"
            $path = [Environment]::GetEnvironmentVariable('Path', 'User')
            $newPath = ($path -split ';' | Where-Object {{ $_ -ne '{dir}' }}) -join ';'
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            Write-Host 'Aurora CLI removed from PATH.'
            "#,
            dir = install_dir_str
        );

        Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_script])
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

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
    use std::path::PathBuf;
    use std::os::unix::fs::symlink;

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
        println!("  aurora .              Open current directory");
        println!("  aurora /path/to/dir   Open specific directory");
        println!("  aurora file.txt       Open a file");

        Ok(())
    }

    /// Check if the CLI command is installed
    pub fn is_cli_installed() -> Result<bool, String> {
        let symlink_path = get_cli_install_path().join("aurora");
        Ok(symlink_path.exists() || symlink_path.is_symlink())
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

