//! Checkpoints: the snapshot of the workspace taken with each message, and
//! restoring to one. The bodies are [`crate::checkpoints::commands`]; this
//! host keeps its own checkpoint service on the [`CommandContext`].

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::checkpoints::commands as checkpoints;

pub const COMMANDS: &[&str] = &[
    "checkpoint_init",
    "checkpoint_ensure_initialized",
    "checkpoint_create",
    "checkpoint_restore",
    "checkpoint_list",
    "checkpoint_get_by_message",
    "checkpoint_delete_thread",
    "checkpoint_delete_workspace",
    "checkpoint_is_initialized",
    "checkpoint_get_enabled",
    "checkpoint_set_enabled",
];

/// Run `name` if it is one of these; `None` hands it on.
pub(super) async fn dispatch(
    ctx: &CommandContext,
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
    let state = &ctx.checkpoints;
    let db = ctx.db.clone();
    Some(match name {
        "checkpoint_init" => {
            state.init(crate::paths::checkpoints_dir());
            done(Ok(()))
        }
        "checkpoint_ensure_initialized" => {
            done(checkpoints::ensure_initialized(state, get!("workspacePath")).await)
        }
        "checkpoint_create" => {
            let workspace_path: String = get!("workspacePath");
            let thread_id: String = get!("threadId");
            let message_id: String = get!("messageId");
            done(checkpoints::create(state, db, workspace_path, thread_id, message_id).await)
        }
        "checkpoint_restore" => {
            let workspace_path: String = get!("workspacePath");
            let thread_id: String = get!("threadId");
            let checkpoint_id: String = get!("checkpointId");
            done(checkpoints::restore(state, db, workspace_path, thread_id, checkpoint_id).await)
        }
        "checkpoint_list" => done(checkpoints::list(db, get!("threadId")).await),
        "checkpoint_get_by_message" => done(checkpoints::get_by_message(db, get!("messageId")).await),
        "checkpoint_delete_thread" => {
            let thread_id: String = get!("threadId");
            let workspace_path: Option<String> = get!("workspacePath");
            done(checkpoints::delete_thread(state, db, thread_id, workspace_path).await)
        }
        "checkpoint_delete_workspace" => {
            done(checkpoints::delete_workspace(state, db, get!("workspacePath")).await)
        }
        "checkpoint_is_initialized" => {
            done(checkpoints::is_initialized(state, get!("workspacePath")).await)
        }
        "checkpoint_get_enabled" => done(checkpoints::get_enabled(db, get!("workspacePath")).await),
        "checkpoint_set_enabled" => {
            let workspace_path: String = get!("workspacePath");
            let enabled: bool = get!("enabled");
            done(checkpoints::set_enabled(db, workspace_path, enabled).await)
        }
        _ => return None,
    })
}
