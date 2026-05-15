use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

// Windows-specific imports for hiding console window
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Windows creation flags - prevents terminal window from appearing
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use super::types::{Checkpoint, CheckpointError, CheckpointResult};

/// Manages checkpoints using shadow Git repositories
/// Each workspace gets its own shadow repo stored in app data directory
///
/// This implementation uses git CLI for all operations (like kilocode's simple-git approach)
/// because git2's index operations don't properly work with external worktrees.
///
/// SAFETY: This implementation is designed to NEVER delete user files.
/// It only tracks changes made AFTER checkpoint creation.
pub struct CheckpointService {
    /// Directory where shadow repos live (one subdir per workspace hash).
    /// Callers pass the already-final path — the service does not
    /// append any subfolder of its own.
    app_data_dir: PathBuf,
    /// Cache of initialized repositories (workspace_path -> repo path)
    repos: Mutex<HashMap<String, PathBuf>>,
}

impl CheckpointService {
    /// Create a new checkpoint service rooted at `checkpoints_dir`.
    pub fn new(checkpoints_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&checkpoints_dir);

        Self {
            app_data_dir: checkpoints_dir,
            repos: Mutex::new(HashMap::new()),
        }
    }

    /// Create a sanitized environment for git commands
    /// This removes git-specific environment variables that could interfere
    /// (Same approach as kilocode's createSanitizedGit)
    fn get_sanitized_env() -> Vec<(String, String)> {
        std::env::vars()
            .filter(|(key, _)| {
                // Skip git environment variables that would override repository location
                !matches!(
                    key.as_str(),
                    "GIT_DIR"
                        | "GIT_WORK_TREE"
                        | "GIT_INDEX_FILE"
                        | "GIT_OBJECT_DIRECTORY"
                        | "GIT_ALTERNATE_OBJECT_DIRECTORIES"
                        | "GIT_CEILING_DIRECTORIES"
                )
            })
            .collect()
    }

    /// Run a git command with sanitized environment
    fn run_git_command(&self, repo_path: &Path, args: &[&str]) -> CheckpointResult<String> {
        let mut cmd = Command::new("git");
        cmd.args(["-C", repo_path.to_str().unwrap_or("")])
            .args(args)
            .envs(Self::get_sanitized_env());

        // On Windows, hide the console window to prevent popup
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| CheckpointError::RestoreError(format!("Failed to run git: {}", e)))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(CheckpointError::RestoreError(format!(
                "git {} failed: {}",
                args.join(" "),
                stderr
            )))
        }
    }

    /// Run a git command that may fail (used for operations that are ok to fail)
    fn run_git_command_allow_fail(&self, repo_path: &Path, args: &[&str]) -> Option<String> {
        let mut cmd = Command::new("git");
        cmd.args(["-C", repo_path.to_str().unwrap_or("")])
            .args(args)
            .envs(Self::get_sanitized_env());

        // On Windows, hide the console window to prevent popup
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd.output().ok()?;

        if output.status.success() {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            None
        }
    }

    /// Get or create the shadow repository for a workspace
    fn get_or_create_repo(&self, workspace_path: &str) -> CheckpointResult<PathBuf> {
        let workspace_hash = Self::hash_workspace_path(workspace_path);
        let repo_path = self.app_data_dir.join(&workspace_hash);

        // Check if we already have this repo cached
        // Use unwrap_or_else to recover from poisoned mutex (previous panic)
        {
            let repos = self
                .repos
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if repos.contains_key(workspace_path) {
                if repo_path.join(".git").exists() {
                    return Ok(repo_path);
                }
            }
        }

        // Create or open the repository
        if repo_path.exists() && repo_path.join(".git").exists() {
            // Verify the worktree config matches
            let config_worktree =
                self.run_git_command_allow_fail(&repo_path, &["config", "core.worktree"]);
            if let Some(wt) = config_worktree {
                if wt != workspace_path {
                    return Err(CheckpointError::InitializationFailed(format!(
                        "Checkpoint repo worktree mismatch: {} != {}",
                        wt, workspace_path
                    )));
                }
            }
        } else {
            self.init_shadow_repo(workspace_path, &repo_path)?;
        }

        // Cache the repo path
        {
            let mut repos = self
                .repos
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            repos.insert(workspace_path.to_string(), repo_path.clone());
        }

        Ok(repo_path)
    }

    /// Initialize a new shadow repository for a workspace using git CLI
    fn init_shadow_repo(&self, workspace_path: &str, repo_path: &Path) -> CheckpointResult<()> {
        // Create the repo directory
        fs::create_dir_all(repo_path)?;

        // Initialize git repository
        let mut cmd = Command::new("git");
        cmd.args(["init"])
            .current_dir(repo_path)
            .envs(Self::get_sanitized_env());

        // On Windows, hide the console window to prevent popup
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd.output().map_err(|e| {
            CheckpointError::InitializationFailed(format!("Failed to run git init: {}", e))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CheckpointError::InitializationFailed(format!(
                "git init failed: {}",
                stderr
            )));
        }

        // Configure the repository
        self.run_git_command(repo_path, &["config", "core.worktree", workspace_path])?;
        self.run_git_command(repo_path, &["config", "commit.gpgSign", "false"])?;
        self.run_git_command(repo_path, &["config", "user.name", "Aurora Checkpoints"])?;
        self.run_git_command(
            repo_path,
            &["config", "user.email", "checkpoints@aurora.local"],
        )?;

        // Create .git/info/exclude file
        self.write_exclude_file(repo_path)?;

        // Create initial commit with ALL current files
        self.create_initial_commit(repo_path)?;

        Ok(())
    }

    /// Write exclude patterns to .git/info/exclude
    fn write_exclude_file(&self, repo_path: &Path) -> CheckpointResult<()> {
        let exclude_path = repo_path.join(".git").join("info");
        fs::create_dir_all(&exclude_path)?;

        let exclude_content = r#"# Aurora Checkpoint Excludes
# Node.js
node_modules/
.npm/
.pnpm/
.yarn/

# Build outputs
dist/
build/
out/
target/

# IDE
.idea/
.vscode/
.vs/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Git (the actual project's git)
.git/

# Logs
*.log
logs/

# Cache
.cache/
__pycache__/
*.pyc

# Environment
.env
.env.local
*.local

# Aurora
.aurora/

# Large files
*.zip
*.tar
*.gz
*.rar
*.7z
*.exe
*.dll
*.so
*.dylib
"#;

        fs::write(exclude_path.join("exclude"), exclude_content)?;
        Ok(())
    }

    /// Create the initial commit for a new shadow repo using git CLI
    fn create_initial_commit(&self, repo_path: &Path) -> CheckpointResult<()> {
        // Stage all files from workspace (git add respects core.worktree)
        // Use --ignore-errors to skip files that can't be added
        let _ = self.run_git_command_allow_fail(repo_path, &["add", ".", "--ignore-errors"]);

        // Create initial commit (allow empty in case workspace is empty)
        self.run_git_command(
            repo_path,
            &[
                "commit",
                "--allow-empty",
                "-m",
                "Initial checkpoint - baseline state",
            ],
        )?;

        Ok(())
    }

    /// Create a checkpoint for the current workspace state using git CLI
    pub fn ensure_initialized(&self, workspace_path: &str) -> CheckpointResult<()> {
        self.get_or_create_repo(workspace_path).map(|_| ())
    }

    /// Create a checkpoint for the current workspace state using git CLI
    pub fn create_checkpoint(
        &self,
        workspace_path: &str,
        thread_id: &str,
        message_id: &str,
    ) -> CheckpointResult<Checkpoint> {
        let repo_path = self.get_or_create_repo(workspace_path)?;

        // Stage all changes (git add respects core.worktree)
        let _ = self.run_git_command_allow_fail(&repo_path, &["add", ".", "--ignore-errors"]);

        let commit_message = format!(
            "Checkpoint for message {}\nThread: {}\nTimestamp: {}",
            message_id,
            thread_id,
            chrono::Utc::now().to_rfc3339()
        );

        // Create commit (allow empty if no changes)
        self.run_git_command(
            &repo_path,
            &["commit", "--allow-empty", "-m", &commit_message],
        )?;

        // Get the commit hash
        let commit_hash = self.run_git_command(&repo_path, &["rev-parse", "HEAD"])?;

        let checkpoint = Checkpoint {
            id: commit_hash,
            message_id: message_id.to_string(),
            thread_id: thread_id.to_string(),
            workspace_path: workspace_path.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        Ok(checkpoint)
    }

    /// Restore workspace to a specific checkpoint using git CLI
    ///
    /// This matches kilocode's approach: git clean + git reset --hard
    pub fn restore_checkpoint(
        &self,
        workspace_path: &str,
        checkpoint_id: &str,
    ) -> CheckpointResult<()> {
        let repo_path = self.get_or_create_repo(workspace_path)?;

        // Verify the checkpoint exists
        let verify_result = self.run_git_command(&repo_path, &["cat-file", "-t", checkpoint_id]);
        match verify_result {
            Ok(ref obj_type) if obj_type == "commit" => {}
            _ => {
                return Err(CheckpointError::CheckpointNotFound(
                    checkpoint_id.to_string(),
                ))
            }
        }

        // Step 1: git clean -fd (remove untracked files/dirs created after checkpoint)
        // This operates on the worktree because of core.worktree config
        let clean_result = self.run_git_command_allow_fail(&repo_path, &["clean", "-fd"]);
        if clean_result.is_none() {
            eprintln!("[Checkpoint] git clean warning - some files may not have been removed");
        }

        // Step 2: git reset --hard <commit> (restore tracked files to checkpoint state)
        // This also operates on the worktree because of core.worktree config
        self.run_git_command(&repo_path, &["reset", "--hard", checkpoint_id])?;

        Ok(())
    }

    /// Get all checkpoints for a workspace (returns commit hashes in order)
    #[allow(dead_code)]
    pub fn list_checkpoints(&self, workspace_path: &str) -> CheckpointResult<Vec<String>> {
        let repo_path = self.get_or_create_repo(workspace_path)?;

        // Get all commits in reverse chronological order
        let log_output = self.run_git_command(&repo_path, &["log", "--format=%H", "--reverse"])?;

        let checkpoints: Vec<String> = log_output.lines().map(|s| s.to_string()).collect();

        Ok(checkpoints)
    }

    /// Hash workspace path to create unique directory name
    fn hash_workspace_path(workspace_path: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        workspace_path.hash(&mut hasher);
        format!("{:x}", hasher.finish())
    }

    /// Delete all checkpoints for a workspace
    pub fn delete_workspace_checkpoints(&self, workspace_path: &str) -> CheckpointResult<()> {
        let workspace_hash = Self::hash_workspace_path(workspace_path);
        let repo_path = self.app_data_dir.join(&workspace_hash);

        if repo_path.exists() {
            fs::remove_dir_all(&repo_path)?;
        }

        // Remove from cache
        {
            let mut repos = self
                .repos
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            repos.remove(workspace_path);
        }

        Ok(())
    }

    /// Check if checkpoint service is initialized for a workspace
    pub fn is_initialized(&self, workspace_path: &str) -> bool {
        let workspace_hash = Self::hash_workspace_path(workspace_path);
        let repo_path = self.app_data_dir.join(&workspace_hash);
        repo_path.join(".git").exists()
    }
}

// Make CheckpointService thread-safe for Tauri
unsafe impl Send for CheckpointService {}
unsafe impl Sync for CheckpointService {}
