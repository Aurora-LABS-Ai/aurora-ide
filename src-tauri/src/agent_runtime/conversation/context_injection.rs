//! Agent runtime — Blocks Aurora adds to the request but never to the persisted session:
//! the repo map, the IDE context, and the live task checklist.
//!
//! Split out of `conversation.rs` verbatim; see `mod.rs` for the map.

use super::*;
use std::collections::HashMap;
use std::sync::RwLock;

/// One rendered repo map per conversation, kept for the LIFETIME OF THE
/// CONVERSATION rather than the lifetime of a runtime.
///
/// The runtime's own `OnceCell` memo is rebuilt with the runtime — once per
/// turn — so after the agent edited files, the next turn re-rendered the map
/// from the fresher index and got different bytes. Those bytes live inside the
/// FIRST user message, which is the start of the provider's cacheable prefix:
/// a changed map re-billed the entire conversation body as fresh input on the
/// first request of every turn. Measured as the recurring cache-read floor of
/// "system prompt + tools, nothing else".
///
/// A conversation therefore keeps the map it started with — the map is
/// orientation ("what exists and roughly where"), not ground truth, and the
/// agent has `code`/`grep`/`workspace_tree` for anything current. Process
/// restart clears this, which is fine: provider caches expire in minutes, so
/// there is no prefix left to preserve by then. Entries are a few KB each and
/// threads per app run number in the dozens — no eviction needed.
static REPO_MAP_BY_THREAD: RwLock<Option<HashMap<String, Option<String>>>> = RwLock::new(None);

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
/// Same contract as [`trailing_context_message`]: the persisted session stays
/// verbatim, only the request body carries this.
impl ConversationRuntime {
    /// The `<repo_map>` block for this conversation, or `None` when there is
    /// nothing worth sending.
    ///
    /// A missing map is a missing convenience, not a broken turn — the agent
    /// still has `code`, `grep` and `workspace_tree`. But HOW it goes missing
    /// matters, and the first version got it wrong twice at once: a build
    /// failure was swallowed with `.ok()?` (nothing logged, undiagnosable in
    /// the field) and then memoized, so one bad moment at the first request
    /// disabled the map — and the warm index every edit-impact note reads —
    /// for the entire conversation. Measured live: a whole eval session ran
    /// with no index and no note, and the log could not say why.
    ///
    /// Now only a definitive answer is memoized (a rendered map, or a valid
    /// index with nothing worth rendering). An ERROR is logged and retried on
    /// the next request instead — get_or_build re-serves the warm index for
    /// well under a millisecond once one exists, so the retry costs nothing
    /// after it first succeeds.
    pub(super) fn repo_map_block(
        &self,
        workspace_root: Option<&str>,
        thread_id: &str,
    ) -> Option<String> {
        if let Some(memoized) = self.repo_map.get() {
            return memoized.clone();
        }
        // A map this CONVERSATION has already sent wins over a fresh render:
        // its bytes sit at the start of the provider's cached prefix, and
        // re-rendering after an edit would invalidate the whole conversation
        // body — see `REPO_MAP_BY_THREAD`.
        if let Ok(guard) = REPO_MAP_BY_THREAD.read() {
            if let Some(kept) = guard.as_ref().and_then(|maps| maps.get(thread_id)) {
                let _ = self.repo_map.set(kept.clone());
                return kept.clone();
            }
        }
        // No workspace attached YET — not memoized either, so a workspace
        // arriving on a later request still gets its map.
        let root = std::path::PathBuf::from(workspace_root?);
        match crate::code_index::service().get_or_build(&root) {
            Ok(idx) => {
                let rendered = crate::code_index::repo_map::render(
                    &idx,
                    crate::code_index::repo_map::budget_chars(
                        crate::code_index::repo_map::DEFAULT_BUDGET_TOKENS,
                    ),
                );
                let _ = self.repo_map.set(rendered.clone());
                if let Ok(mut guard) = REPO_MAP_BY_THREAD.write() {
                    guard
                        .get_or_insert_with(HashMap::new)
                        .insert(thread_id.to_string(), rendered.clone());
                }
                rendered
            }
            Err(error) => {
                crate::logging::log_warn(
                    "code_index",
                    &format!(
                        "repo map skipped — could not index {}: {error:#}",
                        root.display()
                    ),
                );
                None
            }
        }
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

/// The volatile, present-state context — what the IDE shows right now and
/// where the checklist stands right now — as ONE user message to append at
/// the very END of the API view. `None` when there is nothing to say.
///
/// Position is the whole point. Both blocks used to be spliced into the
/// latest **user** message, which in a long agentic turn sits BEFORE the
/// entire tool loop: every checklist update rewrote that message and
/// invalidated the provider's cached prefix from there on, re-billing the
/// whole turn as fresh input (the measured recurring floor of "system
/// prompt + tools, nothing else"). At the absolute tail, a changed block
/// diverges the prefix only at the previous request's tail position — past
/// everything that was already cached — so an update costs its own tokens
/// and nothing else.
///
/// Same contract as [`inject_repo_map`]: the persisted session stays
/// verbatim, only the request body carries this.
///
/// The envelope is not decoration. Sitting at the tail makes this the most
/// recent USER message the model sees, and a user message with no request in
/// it reads as the user having spoken and asked for nothing. Measured, on
/// thread `d394396f` at 01:34:26: the user asked what the desktop core does
/// that the cloud service does not, the model read two files, and then
/// answered the tail instead — *"I have the workspace context. No new task or
/// question was included, so I haven't changed anything."* The question was
/// never answered. So the block says what it is, and says not to reply to it.
const TRAILING_CONTEXT_PREAMBLE: &str = "\
Automatic state from Aurora — the editor and the checklist as they stand right \
now. Aurora appends it after the conversation on every request, so it is always \
the last message. It is NOT from the user and NOT a new request. Do not reply to \
it, do not acknowledge receiving it, and do not read it as the user having \
spoken. Keep working on the user's most recent message above.";

pub(super) fn trailing_context_message(
    ide_context: Option<&str>,
    task_reminder: Option<&str>,
) -> Option<ConversationMessage> {
    let mut sections: Vec<String> = Vec::new();
    if let Some(ctx) = ide_context.filter(|s| !s.is_empty()) {
        sections.push(format!("<ide_context>\n{ctx}\n</ide_context>"));
    }
    if let Some(reminder) = task_reminder.filter(|s| !s.is_empty()) {
        sections.push(reminder.to_string());
    }
    if sections.is_empty() {
        return None;
    }
    let body = sections.join("\n\n");
    Some(ConversationMessage {
        role: MessageRole::User,
        blocks: vec![ContentBlock::Text {
            text: format!(
                "<aurora_runtime_state>\n{TRAILING_CONTEXT_PREAMBLE}\n\n{body}\n</aurora_runtime_state>"
            ),
        }],
        usage: None,
        // Never persisted, so the timestamp is decoration — same as the
        // synthetic instruction message compaction appends.
        timestamp: 0,
        attached_selected_elements: None,
        attached_prompt_chips: None,
        model: None,
    })
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
