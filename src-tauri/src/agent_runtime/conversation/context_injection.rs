//! Agent runtime — Blocks Aurora adds to the request but never to the persisted session:
//! the repo map, the IDE context, and the live task checklist.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

use super::*;

/// Clone the message list and prepend the IDE context block to the
/// **last** `MessageRole::User` message. The block is wrapped in
/// `<ide_context>…</ide_context>` to mirror Aurora's existing
/// TS behaviour. If no user message is found, or the user's first
/// block is not a `Text` block, the helper falls back to inserting a
/// fresh leading text block.
/// Prepend the `<repo_map>` block to the FIRST user message of the request.
///
/// Two decisions worth keeping:
///
/// 1. **Data, not instruction.** It is not part of the system prompt. The system
///    prompt is behaviour and is identical for every project; this is facts
///    about one workspace, so it belongs in the conversation — the same split
///    `<ide_context>` and `<steering_context>` already observe.
/// 2. **First message, not latest.** Anchoring it to the head means it sits
///    inside the provider's cached prefix and is billed once. Attaching it to
///    the newest message instead would re-send several thousand tokens on every
///    single turn, which would cost more than the file reads it exists to avoid.
///
/// Same contract as [`inject_ide_context`]: the persisted session stays
/// verbatim, only the request body carries this.
impl ConversationRuntime {
    /// The `<repo_map>` block for this conversation, or `None` when there is
    /// nothing worth sending.
    ///
    /// Every failure path returns `None` on purpose. An index that cannot be
    /// built (no workspace, unreadable tree, a language nobody here parses) is
    /// a missing convenience, not a broken turn — the agent still has `code`,
    /// `grep` and `workspace_tree`.
    pub(super) fn repo_map_block(&self, workspace_root: Option<&str>) -> Option<String> {
        self.repo_map
            .get_or_init(|| {
                let root = std::path::PathBuf::from(workspace_root?);
                let idx = crate::code_index::service().get_or_build(&root).ok()?;
                crate::code_index::repo_map::render(
                    &idx,
                    crate::code_index::repo_map::budget_chars(
                        crate::code_index::repo_map::DEFAULT_BUDGET_TOKENS,
                    ),
                )
            })
            .clone()
    }
}

pub(super) fn inject_repo_map(
    messages: &[ConversationMessage],
    repo_map: &str,
) -> Vec<ConversationMessage> {
    let mut owned = messages.to_vec();
    let Some(idx) = owned.iter().position(|m| m.role == MessageRole::User) else {
        return owned;
    };
    match owned[idx].blocks.first_mut() {
        Some(ContentBlock::Text { text }) => {
            *text = format!("{repo_map}\n\n{text}");
        }
        _ => {
            owned[idx].blocks.insert(
                0,
                ContentBlock::Text {
                    text: repo_map.to_string(),
                },
            );
        }
    }
    owned
}

pub(super) fn inject_ide_context(
    messages: &[ConversationMessage],
    ide_context: &str,
) -> Vec<ConversationMessage> {
    let mut owned = messages.to_vec();
    let Some(idx) = owned.iter().rposition(|m| m.role == MessageRole::User) else {
        return owned;
    };
    let wrapped = format!("<ide_context>\n{ide_context}\n</ide_context>");
    match owned[idx].blocks.first_mut() {
        Some(ContentBlock::Text { text }) => {
            *text = format!("{wrapped}\n\n{text}");
        }
        _ => {
            // First block is not text (or message has no blocks) —
            // insert the IDE context as a new leading text block so
            // the model still sees it.
            owned[idx]
                .blocks
                .insert(0, ContentBlock::Text { text: wrapped });
        }
    }
    owned
}

/// Render the live checklist as an `<aurora_task_reminder>` block, or `None`
/// when this conversation is not tracking any tasks.
///
/// Read from the STORE on every request rather than remembered, so the block
/// is the same truth the user's checklist panel is drawing. The model
/// therefore never has to call `op: "read"` to find out where it stands, and a
/// list that scrolled out of its context — or was written before a compaction
/// — is still in front of it.
pub(super) fn task_reminder_block(thread_id: &str) -> Option<String> {
    // A failure here is a missing convenience, never a broken turn: the `todo`
    // tool's own results still carry the list.
    let list = crate::tools::shell_editor_todo::todo_store::read(thread_id).ok()?;
    if list.items.is_empty() {
        return None;
    }

    use crate::tools::shell_editor_todo::todo_store::TodoStatus;

    let cursor = list.cursor();
    let mut out = String::from("<aurora_task_reminder>\n");
    out.push_str(
        "This is your checklist for this conversation, as it stands right now. The user is \
watching it live, so keep it current with the `todo` tool — close a task the moment it is done, \
and close one and start the next in a SINGLE call.\n",
    );
    for item in &list.items {
        let mark = match item.status {
            TodoStatus::Completed => "x",
            TodoStatus::InProgress => ">",
            TodoStatus::Cancelled => "-",
            TodoStatus::Pending => " ",
        };
        out.push_str(&format!(
            "- [{mark}] {} {} ({})\n",
            item.id,
            item.content,
            item.status.as_str()
        ));
    }
    out.push_str(&format!(
        "{} closed of {}. ",
        cursor.completed + cursor.cancelled,
        cursor.total
    ));
    out.push_str(&match (&cursor.active_id, &cursor.next_id) {
        _ if cursor.complete => "Every task is closed.".to_string(),
        (Some(active), _) => format!("Now working on {active}."),
        (None, Some(next)) => {
            format!("Nothing is in progress — mark {next} in_progress when you start it.")
        }
        (None, None) => "Nothing left to start.".to_string(),
    });
    out.push_str("\n</aurora_task_reminder>");
    Some(out)
}

/// Attach the checklist to the LATEST user message.
///
/// Deliberately the opposite placement from [`inject_repo_map`], for the
/// opposite reason. The repo map is static, so it rides at the head where the
/// provider caches it once. This list changes every few tool calls; putting it
/// at the head would rewrite the cached prefix on each turn and re-bill the
/// whole conversation. Appended at the end, it costs its own ~15 tokens per
/// task and invalidates nothing.
///
/// Same contract as [`inject_ide_context`]: the persisted session stays
/// verbatim, only the request body carries this.
pub(super) fn inject_task_reminder(
    messages: &[ConversationMessage],
    reminder: &str,
) -> Vec<ConversationMessage> {
    let mut owned = messages.to_vec();
    let Some(idx) = owned.iter().rposition(|m| m.role == MessageRole::User) else {
        return owned;
    };
    match owned[idx].blocks.last_mut() {
        Some(ContentBlock::Text { text }) => {
            *text = format!("{text}\n\n{reminder}");
        }
        _ => {
            owned[idx].blocks.push(ContentBlock::Text {
                text: reminder.to_string(),
            });
        }
    }
    owned
}
