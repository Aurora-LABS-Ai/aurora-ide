//! Looking back and looking in: usage, project and conversation stats, the
//! Memory page, the code index panel, and Settings → Diagnostics (the log and
//! the agent's issue reports). Bodies in [`crate::agent_runtime::stats`],
//! [`crate::chat_memory::commands`], [`crate::code_index::commands`] and
//! [`crate::tools::diagnostics::commands`]; the window calls the same ones.

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::agent_runtime::stats;
use crate::chat_memory::commands as memory;
use crate::code_index::commands as code_index;
use crate::code_index::jobs::IndexSettings;
use crate::tools::diagnostics::commands as diagnostics;

pub const COMMANDS: &[&str] = &[
    "usage_stats_get",
    "project_stats_get",
    "conversation_stats_get",
    "chat_memory_list_facts",
    "chat_memory_add_fact",
    "chat_memory_update_fact",
    "chat_memory_set_fact_pinned",
    "chat_memory_forget_fact",
    "chat_memory_search_facts",
    "chat_memory_stats",
    "chat_memory_rebuild_index",
    "code_index_status",
    "code_index_probe",
    "code_index_rebuild",
    "code_index_build_status",
    "code_index_save_settings",
    "code_index_start_build",
    "code_index_cancel_build",
    "code_index_list_storage",
    "code_index_delete_storage",
    "logs_recent",
    "logs_report",
    "logs_clear",
    "aurora_issues_read",
    "aurora_issues_clear",
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
    let registry = ctx.registry.clone();
    Some(match name {
        "usage_stats_get" => done(stats::usage::usage_stats_get(registry).await),
        "project_stats_get" => {
            done(stats::project::project_stats_get(registry, get!("workspaceRoot")).await)
        }
        "conversation_stats_get" => {
            done(stats::conversation::conversation_stats_get(registry, get!("threadId")).await)
        }

        "chat_memory_list_facts" => done(memory::chat_memory_list_facts().await),
        "chat_memory_add_fact" => done(memory::chat_memory_add_fact(get!("text")).await),
        "chat_memory_update_fact" => {
            let id: String = get!("id");
            let text: String = get!("text");
            done(memory::chat_memory_update_fact(id, text).await)
        }
        "chat_memory_set_fact_pinned" => {
            let id: String = get!("id");
            let pinned: bool = get!("pinned");
            done(memory::chat_memory_set_fact_pinned(id, pinned).await)
        }
        "chat_memory_forget_fact" => done(memory::chat_memory_forget_fact(get!("id")).await),
        "chat_memory_search_facts" => {
            let query: String = get!("query");
            let limit: Option<u32> = get!("limit");
            done(memory::chat_memory_search_facts(query, limit).await)
        }
        "chat_memory_stats" => done(memory::chat_memory_stats().await),
        "chat_memory_rebuild_index" => done(memory::chat_memory_rebuild_index().await),

        "code_index_status" => done(code_index::code_index_status(get!("workspacePath")).await),
        "code_index_probe" => done(code_index::code_index_probe(get!("workspacePath")).await),
        "code_index_rebuild" => done(code_index::code_index_rebuild(get!("workspacePath")).await),
        "code_index_build_status" => {
            done(code_index::code_index_build_status(get!("workspacePath")).await)
        }
        "code_index_save_settings" => {
            let workspace_path: String = get!("workspacePath");
            let settings: IndexSettings = get!("settings");
            done(code_index::code_index_save_settings(workspace_path, settings).await)
        }
        "code_index_start_build" => {
            done(code_index::code_index_start_build(get!("workspacePath")).await)
        }
        "code_index_cancel_build" => {
            done(code_index::code_index_cancel_build(get!("workspacePath")).await)
        }
        "code_index_list_storage" => done(code_index::code_index_list_storage().await),
        "code_index_delete_storage" => {
            done(code_index::code_index_delete_storage(get!("projectId")).await)
        }

        "logs_recent" => done(diagnostics::logs_recent(get!("limit")).await),
        "logs_report" => {
            let level: String = get!("level");
            let component: String = get!("component");
            let message: String = get!("message");
            diagnostics::logs_report(level, component, message).await;
            done(Ok(()))
        }
        "logs_clear" => done(diagnostics::logs_clear().await),
        "aurora_issues_read" => done(diagnostics::aurora_issues_read().await),
        "aurora_issues_clear" => done(diagnostics::aurora_issues_clear().await),
        _ => return None,
    })
}
