//! What a reader left open or filled in a conversation: work cards and answer
//! boxes, saved per conversation on disk. Storage and its rules live in
//! [`crate::agent_runtime::work_cards`] and [`crate::agent_runtime::answer_boxes`];
//! the window's commands (`commands/agent_v2/{work_card,answer_box}_commands.rs`)
//! are wrappers over these.

use std::sync::Arc;

use serde_json::Value;

use super::{arg, done, CommandContext, CommandError};
use crate::agent_runtime::answer_boxes::{self, AnswerBoxes, BoxValues};
use crate::agent_runtime::host::AgentRegistry;
use crate::agent_runtime::work_cards::{self, WorkCards};

pub const COMMANDS: &[&str] = &[
    "agent_work_cards_get",
    "agent_work_card_set",
    "agent_answer_boxes_get",
    "agent_answer_box_set",
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
        "agent_work_cards_get" => done(work_cards_get(registry, get!("threadId")).await),
        "agent_work_card_set" => {
            let thread_id: String = get!("threadId");
            let card_id: String = get!("cardId");
            let open: bool = get!("open");
            done(work_card_set(registry, thread_id, card_id, open).await)
        }
        "agent_answer_boxes_get" => done(answer_boxes_get(registry, get!("threadId")).await),
        "agent_answer_box_set" => {
            let thread_id: String = get!("threadId");
            let key: String = get!("key");
            let values: BoxValues = get!("values");
            done(answer_box_set(registry, thread_id, key, values).await)
        }
        _ => return None,
    })
}

/// The work cards the reader opened in a conversation. Empty for a
/// conversation that never opened one, or one that is not on disk.
pub async fn work_cards_get(registry: Arc<AgentRegistry>, thread_id: String) -> Result<WorkCards, String> {
    tokio::task::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(WorkCards::default());
        };
        work_cards::read(&store, &thread_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open or close one work card. Returns the conversation's open cards. Fails
/// for a conversation that is not on disk rather than creating one.
pub async fn work_card_set(
    registry: Arc<AgentRegistry>,
    thread_id: String,
    card_id: String,
    open: bool,
) -> Result<WorkCards, String> {
    tokio::task::spawn_blocking(move || {
        let store = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("conversation {thread_id} does not exist; the work card was not saved")
            })?;
        work_cards::set(&store, &thread_id, &card_id, open).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every answer box value saved in a conversation. Empty for a conversation
/// that never changed one, or one that is not on disk.
pub async fn answer_boxes_get(registry: Arc<AgentRegistry>, thread_id: String) -> Result<AnswerBoxes, String> {
    tokio::task::spawn_blocking(move || {
        let Some(store) = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(AnswerBoxes::default());
        };
        answer_boxes::read(&store, &thread_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save one box's values, or forget the box when `values` is empty. Returns
/// everything stored for the conversation. Fails for a conversation that is
/// not on disk rather than creating one.
pub async fn answer_box_set(
    registry: Arc<AgentRegistry>,
    thread_id: String,
    key: String,
    values: BoxValues,
) -> Result<AnswerBoxes, String> {
    tokio::task::spawn_blocking(move || {
        let store = registry
            .store_for_thread(&thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!("conversation {thread_id} does not exist; its answer box was not saved")
            })?;
        answer_boxes::set(&store, &thread_id, &key, values).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
