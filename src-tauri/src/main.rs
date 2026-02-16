// Prevents additional console window on Windows in release
// NOTE: We conditionally enable console for CLI commands
#![cfg_attr(
    all(not(debug_assertions), not(feature = "cli-mode")),
    windows_subsystem = "windows"
)]

use aurora_lib::cli::{CliArgs, install};
use std::env;

// Environment variable used to pass CLI args to spawned GUI process
const AURORA_CLI_PATH_ENV: &str = "AURORA_CLI_PATH";
const AURORA_CLI_FILE_ENV: &str = "AURORA_CLI_FILE";

fn main() {
    // Check if we were spawned with CLI path via environment variable
    // This means we're the detached GUI process
    let env_path = env::var(AURORA_CLI_PATH_ENV).ok();
    let env_file = env::var(AURORA_CLI_FILE_ENV).ok();
    
    if env_path.is_some() || env_file.is_some() {
        // We're the spawned GUI process - run with the path from env
        let mut args = CliArgs::default();
        if let Some(file) = env_file {
            // Preserve explicit file-open intent.
            args.path = Some(std::path::PathBuf::from(file));
        } else if let Some(path) = env_path {
            args.path = Some(std::path::PathBuf::from(path));
        }
        // Clear env vars so child processes don't inherit them
        env::remove_var(AURORA_CLI_PATH_ENV);
        env::remove_var(AURORA_CLI_FILE_ENV);
        
        aurora_lib::run_with_args(args);
        return;
    }

    // Parse CLI arguments
    let args = CliArgs::parse_args();

    // Handle install/uninstall CLI commands (these exit immediately)
    if args.install_cli {
        match install::install_cli() {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("Error: {}", e);
                std::process::exit(1);
            }
        }
    }

    if args.uninstall_cli {
        match install::uninstall_cli() {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("Error: {}", e);
                std::process::exit(1);
            }
        }
    }

    // If a path was provided, spawn a detached GUI process and exit
    // This frees the terminal immediately
    if args.path.is_some() {
        if let Err(e) = spawn_detached_gui(&args) {
            eprintln!("Failed to launch Aurora: {}", e);
            std::process::exit(1);
        }
        // Exit immediately - the spawned process will handle the GUI
        return;
    }

    // No path argument - run GUI directly (e.g., launched from Start menu)
    aurora_lib::run_with_args(args)
}

/// Spawn Aurora as a detached process so the terminal is freed
fn spawn_detached_gui(args: &CliArgs) -> Result<(), String> {
    let current_exe = env::current_exe()
        .map_err(|e| format!("Failed to get current executable: {}", e))?;
    
    let mut cmd = std::process::Command::new(&current_exe);
    
    // Pass the path via environment variable
    if let Some(resolved) = args.resolve_path() {
        if resolved.is_dir() {
            cmd.env(AURORA_CLI_PATH_ENV, resolved.to_string_lossy().to_string());
        } else if resolved.is_file() {
            // For files, set both workspace (parent) and file
            if let Some(parent) = resolved.parent() {
                cmd.env(AURORA_CLI_PATH_ENV, parent.to_string_lossy().to_string());
            }
            cmd.env(AURORA_CLI_FILE_ENV, resolved.to_string_lossy().to_string());
        } else {
            // Path doesn't exist - assume it's meant to be a directory
            cmd.env(AURORA_CLI_PATH_ENV, resolved.to_string_lossy().to_string());
        }
    }

    // Platform-specific detachment
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
        // This detaches from the current console
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    // On Unix, no special detachment flags needed - the process 
    // will continue running after we exit
    #[cfg(unix)]
    let _ = &cmd; // silence unused warning

    // Spawn the detached process
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn Aurora: {}", e))?;

    Ok(())
}

