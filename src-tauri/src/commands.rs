use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

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
    pub os: String,
    pub arch: String,
    pub hostname: String,
}

/// Read directory contents
#[tauri::command]
pub async fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);
    
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
                
                // Skip hidden files/folders (starting with .)
                if file_name.starts_with('.') {
                    continue;
                }
                
                // Skip node_modules, target, dist folders
                if file_name == "node_modules" || file_name == "target" || file_name == "dist" {
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
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(entries)
}

/// Read file content
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    
    if !file_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }
    
    fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read file: {}", e))
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
    
    fs::write(file_path, content)
        .map_err(|e| format!("Failed to write file: {}", e))
}

/// Execute a shell command
#[tauri::command]
pub async fn execute_command(command: String, cwd: Option<String>) -> Result<CommandOutput, String> {
    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "sh"
    };
    
    let shell_arg = if cfg!(target_os = "windows") {
        "/C"
    } else {
        "-c"
    };
    
    let mut cmd = Command::new(shell);
    cmd.arg(shell_arg).arg(&command);
    
    if let Some(working_dir) = cwd {
        cmd.current_dir(working_dir);
    }
    
    match cmd.output() {
        Ok(output) => {
            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
                success: output.status.success(),
            })
        }
        Err(e) => Err(format!("Failed to execute command: {}", e)),
    }
}

/// Get system information
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
    })
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
    
    if target_path.is_dir() {
        fs::remove_dir_all(target_path)
            .map_err(|e| format!("Failed to delete folder: {}", e))
    } else {
        fs::remove_file(target_path)
            .map_err(|e| format!("Failed to delete file: {}", e))
    }
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
    
    fs::rename(old, new)
        .map_err(|e| format!("Failed to rename: {}", e))
}

