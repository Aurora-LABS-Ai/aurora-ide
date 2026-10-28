//! Sub-agents a conversation started: the list, one's transcript, the reports
//! waiting to wake the parent, the pinned cards beside the icon rail, and
//! Stop. The window's `#[tauri::command]`s (`commands/agent_v2/tauri_layer.rs`)
//! are wrappers over these.

use std::sync::Arc;

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::agent_runtime::host::{list_agents_for, AgentRegistry};
use crate::agent_runtime::subagents::outbox::PendingWake;
use crate::agent_runtime::subagents::rail_state::{self, RailState};
use crate::agent_runtime::subagents::record::{StopBy, TaskSnapshot};
use crate::agent_runtime::types::ConversationMessage;

pub const COMMANDS: &[&str] = &[
    "agent_subagent_list",
    "agent_subagent_load",
    "agent_subagent_pending",
    "agent_subagent_claim",
    "agent_subagent_rail_get",
    "agent_subagent_rail_set",
    "agent_subagent_kill",
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
        "agent_subagent_list" => done(list(registry, get!("parentThreadId")).await),
        "agent_subagent_load" => {
            let parent: String = get!("parentThreadId");
            let agent_id: String = get!("agentId");
            done(load(registry, parent, agent_id).await)
        }
        "agent_subagent_pending" => {
            let parent: String = get!("parentThreadId");
            done(Ok(pending(&registry, &parent)))
        }
        "agent_subagent_claim" => {
            let parent: String = get!("parentThreadId");
            let wake_id: u64 = get!("wakeId");
            done(Ok(claim(&registry, &parent, wake_id)))
        }
        "agent_subagent_rail_get" => done(rail_get(registry, get!("parentThreadId")).await),
        "agent_subagent_rail_set" => {
            let parent: String = get!("parentThreadId");
            let pinned: Vec<String> = get!("pinned");
            let expanded: Vec<String> = get!("expanded");
            done(rail_set(registry, parent, pinned, expanded).await)
        }
        "agent_subagent_kill" => {
            let agent_id: String = get!("agentId");
            done(Ok(kill(&registry, &agent_id)))
        }
        _ => return None,
    })
}

/// Every sub-agent a conversation has started, oldest first: the files are
/// the list, the live records are the state of whichever are running now.
/// Empty for a conversation that never delegated.
pub async fn list(
    registry: Arc<AgentRegistry>,
    parent_thread_id: String,
) -> Result<Vec<TaskSnapshot>, String> {
    tokio::task::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(Vec::new());
        };
        Ok(list_agents_for(&registry, &store, &parent_thread_id))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A sub-agent's transcript, for the read-only view in the Agents panel.
/// The same shape `agent_load_thread` returns for a conversation.
pub async fn load(
    registry: Arc<AgentRegistry>,
    parent_thread_id: String,
    agent_id: String,
) -> Result<Vec<ConversationMessage>, String> {
    let loaded = tokio::task::spawn_blocking(move || {
        let Some(parent_store) = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok::<_, String>(None);
        };
        let store = crate::agent_runtime::subagents::store::child_store_for(
            &parent_store,
            &parent_thread_id,
        );
        if !store.exists(&agent_id) {
            return Ok(None);
        }
        registry
            .load_session_from_store(&agent_id, &store)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(session) = loaded else {
        return Ok(Vec::new());
    };
    let guard = session.lock().await;
    Ok(guard.messages().to_vec())
}

/// Sub-agent reports waiting to wake this conversation, oldest first. The
/// window reads this on its list poll as well as on the `report` event, so a
/// report reaches the parent within one poll even when the event channel is
/// backed up (2026-10-08: four reports, 58 s late). Cheap: in memory.
pub fn pending(registry: &AgentRegistry, parent_thread_id: &str) -> Vec<PendingWake> {
    registry.wake_outbox().pending(parent_thread_id)
}

/// The window opened a turn carrying wake `wake_id`: take it out of the
/// outbox. `false` when it was already claimed, which tells a second claimant
/// (two drains racing for one idle moment) that the report is on its way and
/// must not be sent again.
pub fn claim(registry: &AgentRegistry, parent_thread_id: &str, wake_id: u64) -> bool {
    let claimed = registry.wake_outbox().claim(parent_thread_id, wake_id);
    crate::logging::log_info(
        "subagents.events",
        &format!(
            "wake {wake_id} for {parent_thread_id} {}",
            if claimed.is_some() { "claimed" } else { "already claimed" }
        ),
    );
    claimed.is_some()
}

/// Which of a conversation's agent cards are pinned beside the icon rail, and
/// which are grown. Empty for a conversation that never pinned one, or one
/// that is not on disk.
pub async fn rail_get(registry: Arc<AgentRegistry>, parent_thread_id: String) -> Result<RailState, String> {
    tokio::task::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(Default::default());
        };
        rail_state::read(&store, &parent_thread_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save which agent cards are pinned and grown, and return what was stored
/// (repeats dropped, pins held to three). Fails for a conversation that is not
/// on disk rather than creating one.
pub async fn rail_set(
    registry: Arc<AgentRegistry>,
    parent_thread_id: String,
    pinned: Vec<String>,
    expanded: Vec<String>,
) -> Result<RailState, String> {
    tokio::task::spawn_blocking(move || {
        let store = registry
            .store_for_thread(&parent_thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("conversation {parent_thread_id} does not exist; its pinned agents were not saved")
            })?;
        rail_state::write(&store, &parent_thread_id, RailState { pinned, expanded })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop a running sub-agent. Returns whether it was running. Its transcript
/// and record stay; it can be resumed later with `send_message`.
pub fn kill(registry: &AgentRegistry, agent_id: &str) -> bool {
    registry
        .subagent_tasks()
        .get(agent_id)
        // Only a client calls this, and only for a person's Stop: the
        // parent's own stops go through `stop_agent`.
        .is_some_and(|record| record.kill(StopBy::User))
}
