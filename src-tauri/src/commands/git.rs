//! Git commands for Aurora IDE
//! Provides native git integration via shell commands

use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    pub untracked: Vec<GitFileChange>,
    pub conflicted: Vec<GitFileChange>,
    pub ahead: i32,
    pub behind: i32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub last_commit: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchResult {
    pub branches: Vec<GitBranch>,
    pub current: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileVersions {
    pub original_content: String,
    pub modified_content: String,
}

// ============================================================================
// Helper Functions
// ============================================================================

async fn run_git_command(workspace_path: &str, args: &[&str]) -> Result<String, String> {
    let path = Path::new(workspace_path);
    if !path.exists() {
        return Err(format!("Workspace path does not exist: {}", workspace_path));
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(path).args(args);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(stderr.trim().to_string())
    }
}

fn parse_status_code(code: &str) -> String {
    match code {
        "M" => "modified".to_string(),
        "A" => "added".to_string(),
        "D" => "deleted".to_string(),
        "R" => "renamed".to_string(),
        "C" => "copied".to_string(),
        "U" => "conflicted".to_string(),
        "?" => "untracked".to_string(),
        "!" => "ignored".to_string(),
        _ => "modified".to_string(),
    }
}

async fn read_file_lossy(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", path.display(), e))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

// ============================================================================
// Commands
// ============================================================================

/// Check if directory is a git repository
#[tauri::command]
pub async fn git_is_repository(workspace_path: String) -> Result<bool, String> {
    let git_dir = Path::new(&workspace_path).join(".git");
    Ok(git_dir.exists())
}

/// Get current git status
#[tauri::command]
pub async fn git_get_status(workspace_path: String) -> Result<GitStatus, String> {
    // Get porcelain status
    let status_output =
        run_git_command(&workspace_path, &["status", "--porcelain=v1", "-uall"]).await?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted = Vec::new();

    for line in status_output.lines() {
        if line.len() < 3 {
            continue;
        }

        let index_status = &line[0..1];
        let worktree_status = &line[1..2];
        let path = line[3..].trim();

        // Handle renames (format: "R  old_path -> new_path")
        let (file_path, old_path) = if path.contains(" -> ") {
            let parts: Vec<&str> = path.split(" -> ").collect();
            (parts[1].to_string(), Some(parts[0].to_string()))
        } else {
            (path.to_string(), None)
        };

        // Untracked files
        if index_status == "?" {
            untracked.push(GitFileChange {
                path: file_path,
                old_path: None,
                status: "untracked".to_string(),
                staged: false,
            });
            continue;
        }

        // Conflicted files (both modified)
        if index_status == "U"
            || worktree_status == "U"
            || (index_status == "A" && worktree_status == "A")
            || (index_status == "D" && worktree_status == "D")
        {
            conflicted.push(GitFileChange {
                path: file_path,
                old_path,
                status: "conflicted".to_string(),
                staged: false,
            });
            continue;
        }

        // Staged changes
        if index_status != " " && index_status != "?" {
            staged.push(GitFileChange {
                path: file_path.clone(),
                old_path: old_path.clone(),
                status: parse_status_code(index_status),
                staged: true,
            });
        }

        // Unstaged changes
        if worktree_status != " " && worktree_status != "?" {
            unstaged.push(GitFileChange {
                path: file_path,
                old_path,
                status: parse_status_code(worktree_status),
                staged: false,
            });
        }
    }

    // Get ahead/behind count
    let (ahead, behind) = get_ahead_behind(&workspace_path).await.unwrap_or((0, 0));

    Ok(GitStatus {
        staged,
        unstaged,
        untracked,
        conflicted,
        ahead,
        behind,
    })
}

async fn get_ahead_behind(workspace_path: &str) -> Result<(i32, i32), String> {
    let output = run_git_command(
        workspace_path,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    )
    .await?;
    let parts: Vec<&str> = output.split_whitespace().collect();

    if parts.len() >= 2 {
        let behind = parts[0].parse().unwrap_or(0);
        let ahead = parts[1].parse().unwrap_or(0);
        Ok((ahead, behind))
    } else {
        Ok((0, 0))
    }
}

/// Get all branches
#[tauri::command]
pub async fn git_get_branches(workspace_path: String) -> Result<BranchResult, String> {
    // Get current branch
    let current = run_git_command(&workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await?
        .trim()
        .to_string();

    // Get all branches with details
    let output = run_git_command(
        &workspace_path,
        &[
            "branch",
            "-a",
            "--format=%(refname:short)|%(upstream:short)|%(objectname:short)",
        ],
    )
    .await?;

    let mut branches = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        let name = parts.first().unwrap_or(&"").trim().to_string();

        if name.is_empty() {
            continue;
        }

        let is_remote = name.starts_with("remotes/") || name.starts_with("origin/");
        let upstream = parts.get(1).and_then(|s| {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        });
        let last_commit = parts.get(2).map(|s| s.trim().to_string());

        branches.push(GitBranch {
            name: name.clone(),
            is_remote,
            is_current: name == current,
            upstream,
            last_commit,
        });
    }

    Ok(BranchResult { branches, current })
}

/// Get commit history
#[tauri::command]
pub async fn git_get_commits(workspace_path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    let format = "%H|%h|%s|%an|%ae|%ci|%D";
    let output = run_git_command(
        &workspace_path,
        &[
            "log",
            &format!("--format={}", format),
            &format!("-{}", limit),
        ],
    )
    .await?;

    let mut commits = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.splitn(7, '|').collect();
        if parts.len() < 6 {
            continue;
        }

        let refs_str = parts.get(6).unwrap_or(&"");
        let refs: Vec<String> = if refs_str.is_empty() {
            Vec::new()
        } else {
            refs_str
                .split(", ")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };

        commits.push(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            message: parts[2].to_string(),
            author: parts[3].to_string(),
            email: parts[4].to_string(),
            date: parts[5].to_string(),
            refs,
        });
    }

    Ok(commits)
}

/// Get current branch name
#[tauri::command]
pub async fn git_current_branch(workspace_path: String) -> Result<String, String> {
    run_git_command(&workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
}

/// Stage a file
#[tauri::command]
pub async fn git_stage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    run_git_command(&workspace_path, &["add", &file_path]).await?;
    Ok(())
}

/// Unstage a file
#[tauri::command]
pub async fn git_unstage_file(workspace_path: String, file_path: String) -> Result<(), String> {
    run_git_command(&workspace_path, &["reset", "HEAD", &file_path]).await?;
    Ok(())
}

/// Stage all changes
#[tauri::command]
pub async fn git_stage_all(workspace_path: String) -> Result<(), String> {
    run_git_command(&workspace_path, &["add", "-A"]).await?;
    Ok(())
}

/// Unstage all changes
#[tauri::command]
pub async fn git_unstage_all(workspace_path: String) -> Result<(), String> {
    run_git_command(&workspace_path, &["reset", "HEAD"]).await?;
    Ok(())
}

/// Discard changes in a file
#[tauri::command]
pub async fn git_discard_changes(workspace_path: String, file_path: String) -> Result<(), String> {
    // First try checkout for tracked files
    let result = run_git_command(&workspace_path, &["checkout", "--", &file_path]).await;
    if result.is_ok() {
        return Ok(());
    }

    // If that fails, try clean for untracked files
    run_git_command(&workspace_path, &["clean", "-f", &file_path]).await?;
    Ok(())
}

/// Create a commit
#[tauri::command]
pub async fn git_commit(workspace_path: String, message: String) -> Result<String, String> {
    let output = run_git_command(&workspace_path, &["commit", "-m", &message]).await?;
    Ok(output)
}

/// Checkout a branch
/// If the branch doesn't exist locally but exists remotely, creates a tracking branch
#[tauri::command]
pub async fn git_checkout(workspace_path: String, branch: String) -> Result<(), String> {
    // First, try normal checkout
    let result = run_git_command(&workspace_path, &["checkout", &branch]).await;

    if result.is_ok() {
        return Ok(());
    }

    // If normal checkout failed, try to create a tracking branch from remote
    // This handles the case where we're checking out a remote branch for the first time
    let track_result = run_git_command(
        &workspace_path,
        &["checkout", "-b", &branch, &format!("origin/{}", branch)],
    )
    .await;

    if track_result.is_ok() {
        return Ok(());
    }

    // Return the original error if both attempts failed
    result?;
    Ok(())
}

/// Create a new branch
#[tauri::command]
pub async fn git_create_branch(workspace_path: String, name: String) -> Result<(), String> {
    run_git_command(&workspace_path, &["checkout", "-b", &name]).await?;
    Ok(())
}

/// Pull from remote
#[tauri::command]
pub async fn git_pull(workspace_path: String) -> Result<(), String> {
    run_git_command(&workspace_path, &["pull"]).await?;
    Ok(())
}

/// Push to remote
#[tauri::command]
pub async fn git_push(workspace_path: String) -> Result<(), String> {
    run_git_command(&workspace_path, &["push"]).await?;
    Ok(())
}

/// Get diff for a file
#[tauri::command]
pub async fn git_get_diff(
    workspace_path: String,
    file_path: String,
    staged: bool,
) -> Result<String, String> {
    if staged {
        run_git_command(&workspace_path, &["diff", "--cached", &file_path]).await
    } else {
        run_git_command(&workspace_path, &["diff", &file_path]).await
    }
}

/// Get full file versions for split diff view.
/// For staged files: compares HEAD -> index.
/// For unstaged files: compares index -> working tree.
#[tauri::command]
pub async fn git_get_file_versions(
    workspace_path: String,
    file_path: String,
    staged: bool,
    old_path: Option<String>,
) -> Result<GitFileVersions, String> {
    let normalized_file_path = file_path.replace('\\', "/");
    let normalized_old_path = old_path.map(|value| value.replace('\\', "/"));
    let head_lookup_path = normalized_old_path
        .as_deref()
        .unwrap_or(&normalized_file_path)
        .to_string();

    let working_file_path = Path::new(&workspace_path).join(&file_path);

    if staged {
        let original_content = run_git_command(
            &workspace_path,
            &["show", &format!("HEAD:{}", head_lookup_path)],
        )
        .await
        .unwrap_or_default();

        let modified_content = match run_git_command(
            &workspace_path,
            &["show", &format!(":{}", normalized_file_path)],
        )
        .await
        {
            Ok(content) => content,
            Err(_) => {
                if working_file_path.exists() {
                    read_file_lossy(&working_file_path)
                        .await
                        .unwrap_or_default()
                } else {
                    String::new()
                }
            }
        };

        return Ok(GitFileVersions {
            original_content,
            modified_content,
        });
    }

    let original_content = match run_git_command(
        &workspace_path,
        &["show", &format!(":{}", normalized_file_path)],
    )
    .await
    {
        Ok(content) => content,
        Err(_) => run_git_command(
            &workspace_path,
            &["show", &format!("HEAD:{}", head_lookup_path)],
        )
        .await
        .unwrap_or_default(),
    };

    let modified_content = if working_file_path.exists() {
        read_file_lossy(&working_file_path)
            .await
            .unwrap_or_default()
    } else {
        String::new()
    };

    Ok(GitFileVersions {
        original_content,
        modified_content,
    })
}
