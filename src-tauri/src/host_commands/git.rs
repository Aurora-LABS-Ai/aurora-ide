//! Git: status, branches, commits, staging, commit, pull/push and diffs for
//! the Changes view. The bodies are [`crate::workspace::git`], which the
//! window registers directly.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::workspace::git;

pub const COMMANDS: &[&str] = &[
    "git_is_repository",
    "git_get_status",
    "git_get_branches",
    "git_get_commits",
    "git_current_branch",
    "git_stage_file",
    "git_unstage_file",
    "git_stage_all",
    "git_unstage_all",
    "git_discard_changes",
    "git_commit",
    "git_checkout",
    "git_create_branch",
    "git_pull",
    "git_push",
    "git_get_diff",
    "git_get_file_versions",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    _ctx: &CommandContext,
    name: &str,
    args: &Value,
) -> Option<Result<Value, CommandError>> {
    let n = name;
    macro_rules! get {
        ($key:literal) => {
            match arg(n, args, $key) {
                Ok(v) => v,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    // Every git command names the workspace first.
    if !COMMANDS.contains(&name) {
        return None;
    }
    let ws: String = get!("workspacePath");
    Some(match name {
        "git_is_repository" => done(git::git_is_repository(ws).await),
        "git_get_status" => done(git::git_get_status(ws).await),
        "git_get_branches" => done(git::git_get_branches(ws).await),
        "git_get_commits" => done(git::git_get_commits(ws, get!("limit")).await),
        "git_current_branch" => done(git::git_current_branch(ws).await),
        "git_stage_file" => done(git::git_stage_file(ws, get!("filePath")).await),
        "git_unstage_file" => done(git::git_unstage_file(ws, get!("filePath")).await),
        "git_stage_all" => done(git::git_stage_all(ws).await),
        "git_unstage_all" => done(git::git_unstage_all(ws).await),
        "git_discard_changes" => done(git::git_discard_changes(ws, get!("filePath")).await),
        "git_commit" => done(git::git_commit(ws, get!("message")).await),
        "git_checkout" => done(git::git_checkout(ws, get!("branch")).await),
        "git_create_branch" => done(git::git_create_branch(ws, get!("name")).await),
        "git_pull" => done(git::git_pull(ws).await),
        "git_push" => done(git::git_push(ws).await),
        "git_get_diff" => {
            let file_path: String = get!("filePath");
            let staged: bool = get!("staged");
            done(git::git_get_diff(ws, file_path, staged).await)
        }
        "git_get_file_versions" => {
            let file_path: String = get!("filePath");
            let staged: bool = get!("staged");
            let old_path: Option<String> = get!("oldPath");
            done(git::git_get_file_versions(ws, file_path, staged, old_path).await)
        }
        _ => return None,
    })
}
