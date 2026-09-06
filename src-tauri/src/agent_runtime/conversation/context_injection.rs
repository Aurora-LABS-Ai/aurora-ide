//! Agent runtime — What Aurora adds to a request beyond the transcript, and where.
//!
//! One rule, taken from the three reference agents vendored in `thirdparty/`
//! (Claude Code, OpenCode, pi), which all agree on it: **write a fact into the
//! request once, at the place whose cost matches how often it changes, and
//! never rebuild it per request.**
//!
//! | what | where | changes |
//! |---|---|---|
//! | behaviour, `<env>`, `<machine_tools>`, project rules, skills | system prompt | per turn at most |
//! | `<repo_map>` / `<memory>` | first user message | never in a conversation |
//! | open files, selection, checklist at send time | `aurora_context` on the user's message | never, once written |
//! | "you have not touched the checklist in a while" | inside a tool result, rarely | never, once written |
//!
//! There is no live state block. Aurora used to render one from the store on
//! every request, and then had to find somewhere to put a block whose bytes
//! changed every time: its own user turn (the model spent the opening of every
//! turn working out what that message was), then the tail of the newest tool
//! result (correct, but the whole `<ide_context>` — project rules and the skill
//! catalogue included — was re-frozen into history every time the checklist
//! moved). Everything below is the shape that needs neither.
//!
//! Split out of `conversation.rs`; see `mod.rs` for the map.

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

/// One `<machine_tools>` block per conversation, kept for the same reason as
/// [`REPO_MAP_BY_THREAD`]: it rides in the system prompt, so its bytes must
/// not change between requests. A tool installed mid-conversation shows up in
/// the next conversation — the block says it is a start-of-conversation
/// snapshot, and the shell's PATH itself is re-read on every command.
static MACHINE_TOOLS_BY_THREAD: RwLock<Option<HashMap<String, Option<String>>>> =
    RwLock::new(None);

/// The `<machine_tools>` block for this conversation: which well-known
/// command-line tools are on the PATH the agent's shells run with. Presence
/// only — see [`crate::shell::toolchain`] for what it is for and why it
/// carries no versions or paths.
pub(super) fn machine_tools_block(thread_id: &str) -> Option<String> {
    if let Ok(guard) = MACHINE_TOOLS_BY_THREAD.read() {
        if let Some(kept) = guard.as_ref().and_then(|blocks| blocks.get(thread_id)) {
            return kept.clone();
        }
    }
    let rendered = crate::shell::toolchain::context_block(&crate::shell::toolchain::inventory());
    if let Ok(mut guard) = MACHINE_TOOLS_BY_THREAD.write() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(thread_id.to_string(), rendered.clone());
    }
    rendered
}

impl ConversationRuntime {
    /// The system prompt every request of this conversation carries: the
    /// composed prompt from the frontend, plus `<machine_tools>` for a project
    /// conversation.
    ///
    /// The machine's tools sit here, beside `<env>`, because they are the same
    /// kind of fact — fixed for the whole conversation and about the machine
    /// rather than the request. Every reference puts platform facts in the
    /// system prompt; Aurora used to put this one at the head of the first user
    /// message, which worked but described the shape wrongly ("context the user
    /// sent") and left the prompt's `<env>` describing a machine with no tools.
    ///
    /// Memoized per thread, so the bytes never move within a conversation. The
    /// same string feeds the live request and the cache-sharing compaction
    /// request; the two must never differ or the shared prefix is lost.
    pub(super) fn request_system_prompt(&self, thread_id: &str) -> Option<String> {
        let base = self.config.system_prompt.as_deref().filter(|s| !s.is_empty());
        if self.config.execution_mode_is_chat {
            return base.map(str::to_string);
        }
        match (base, machine_tools_block(thread_id)) {
            (Some(prompt), Some(tools)) => Some(format!("{prompt}\n\n{tools}")),
            (Some(prompt), None) => Some(prompt.to_string()),
            (None, Some(tools)) => Some(tools),
            (None, None) => None,
        }
    }

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

    /// The block for the head of the FIRST user message, or `None` when there
    /// is nothing to say: `<repo_map>` for a project conversation, `<memory>`
    /// for Aurora Chat.
    ///
    /// A message, not the system prompt — and the reason is size and
    /// volatility, not category. The workspace root, the file-access rules and
    /// the machine's tools ARE in the system prompt, and they are facts about
    /// one machine too, so "data, not instruction" is not the line. The line
    /// is what a change costs: Anthropic's breakpoints run tools → system →
    /// last stable message, so anything in the system prompt sits inside the
    /// cache covering the TOOL SCHEMAS, the largest fixed payload Aurora sends.
    /// `<env>` is five lines that cannot change while a conversation runs.
    /// This is five thousand tokens that can be rebuilt when the index goes
    /// stale — and a rebuilt map in the system prompt would re-bill every tool
    /// schema with it. Claude Code places CLAUDE.md the same way, for the same
    /// reason.
    pub(super) fn head_context_block(
        &self,
        workspace_root: Option<&str>,
        thread_id: &str,
    ) -> Option<String> {
        // Aurora Chat gets its memory where Build gets its repo map. The two
        // are mutually exclusive by construction: a chat turn has no
        // workspace, so `repo_map_block` would return `None` anyway. Branching
        // on the mode says that on purpose rather than relying on it.
        if self.config.execution_mode_is_chat {
            return self.memory_block();
        }
        self.repo_map_block(workspace_root, thread_id)
    }

    /// Aurora Chat's head block: what Aurora remembers about the user.
    ///
    /// Memoized per conversation exactly as `<repo_map>` is, and for exactly
    /// the same reason. It rides in the FIRST user message, which is the head
    /// of every request's cacheable prefix — so it has to be written once and
    /// then be byte-identical forever. A fact learned later arrives as a
    /// `remember` tool result at the TAIL; rewriting this block would throw the
    /// whole conversation's cache away every time the model remembered
    /// something.
    ///
    /// `None` when there is nothing remembered: an empty `<memory/>` costs
    /// tokens on every request and tells the model nothing.
    pub(super) fn memory_block(&self) -> Option<String> {
        if let Some(memoized) = self.memory.get() {
            return memoized.clone();
        }
        let rendered = crate::chat_memory::service()
            .and_then(|memory| {
                memory
                    .facts_for_injection(crate::chat_memory::facts::INJECTED_FACT_COUNT)
                    .map_err(|err| {
                        crate::logging::log_warn(
                            "chat_memory",
                            &format!("could not read facts for injection: {err}"),
                        );
                        err
                    })
                    .ok()
            })
            .map(|facts| crate::chat_memory::facts::render_fact_block(&facts))
            .filter(|block| !block.is_empty());
        let _ = self.memory.set(rendered.clone());
        rendered
    }

    /// Everything Aurora attaches to a user message the moment it is sent.
    ///
    /// The frontend's part (open files, a selection, a slash-attached rule) and
    /// the checklist as it stands right now, so a "continue" turn after a break
    /// sees where the work stopped without a tool call. Rendered once here,
    /// stored on the message by the caller, and never rebuilt.
    pub(super) fn user_message_context(
        &self,
        frontend_context: Option<&str>,
        thread_id: &str,
    ) -> Option<String> {
        let mut sections: Vec<String> = Vec::new();
        if let Some(ctx) = frontend_context.map(str::trim).filter(|s| !s.is_empty()) {
            sections.push(ctx.to_string());
        }
        // A checklist only exists where the tool that writes it does. Plan
        // mode and Aurora Chat have no task tools, so a stale list from a Build
        // turn must not follow the user into them.
        if self.tools.get("TaskUpdate").is_some() {
            if let Some(list) = checklist_block(thread_id) {
                sections.push(list);
            }
        }
        if sections.is_empty() {
            return None;
        }
        Some(format!(
            "<aurora_context>\n{}\n</aurora_context>",
            sections.join("\n\n")
        ))
    }
}

/// Prepend the head block to the FIRST user message of the request.
///
/// Two decisions worth keeping:
///
/// 1. **First message, not latest.** Anchoring it to the head means it sits
///    inside the provider's cached prefix and is billed once. Attaching it to
///    the newest message instead would re-send several thousand tokens on every
///    single turn, which would cost more than the file reads it exists to avoid.
/// 2. **API view only.** The persisted session stays verbatim; only the request
///    body carries this. Same contract as [`fold_message_context`].
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

/// Put each user message's saved [`ConversationMessage::aurora_context`] after
/// its text, for the API view.
///
/// The transcript keeps the user's words and Aurora's context in two fields,
/// so the UI can show one and not the other. The model reads them as one
/// message: the words, a blank line, then the context. Deterministic and
/// per-message, so every request renders the same bytes for the same history
/// — which is what lets the whole conversation stay a cacheable prefix.
///
/// The two reference shapes are the same thing under other names: OpenCode's
/// synthetic text part on the user message, Claude Code's meta user message
/// merged into the user turn by `normalizeMessagesForAPI`.
pub(super) fn fold_message_context(messages: &[ConversationMessage]) -> Vec<ConversationMessage> {
    let mut owned = messages.to_vec();
    for message in owned.iter_mut() {
        let Some(context) = message.aurora_context.take() else {
            continue;
        };
        if context.trim().is_empty() {
            continue;
        }
        match message
            .blocks
            .iter_mut()
            .rev()
            .find(|b| matches!(b, ContentBlock::Text { .. }))
        {
            Some(ContentBlock::Text { text }) => {
                text.push_str("\n\n");
                text.push_str(&context);
            }
            _ => message.blocks.push(ContentBlock::Text { text: context }),
        }
    }
    owned
}

/// The checklist as a `<checklist>` block, or `None` when this conversation is
/// tracking nothing.
///
/// Rendered from the store, so it is the same list the user's header shows.
/// Written in exactly two places, both frozen: on a user message as it is sent
/// (`user_message_context`), and inside the rare stale-checklist reminder
/// below. It is NOT re-sent per request — the `todo` tool's own result already
/// carries the whole list every time it changes.
pub(super) fn checklist_block(thread_id: &str) -> Option<String> {
    // A failure here is a missing convenience, never a broken turn.
    let list = crate::tools::shell_editor_todo::todo_store::read(thread_id).ok()?;
    if list.items.is_empty() {
        return None;
    }
    Some(format!(
        "<checklist>\n{}\n</checklist>",
        render_checklist(&list)
    ))
}

fn render_checklist(list: &crate::tools::shell_editor_todo::todo_store::TodoList) -> String {
    use crate::tools::shell_editor_todo::todo_store::TodoStatus;

    let cursor = list.cursor();
    let mut out = String::new();
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
        "{} closed of {}.",
        cursor.completed + cursor.cancelled,
        cursor.total
    ));
    out
}

/// Assistant messages a checklist may go untouched before Aurora says so.
///
/// Claude Code's number (`TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE`, and the
/// same again between reminders). Ten is long enough that a model working a
/// list normally never sees this at all, and short enough that a list left
/// stale by a long detour gets one nudge before the user notices it is wrong.
pub(super) const CHECKLIST_REMINDER_TURNS: usize = 10;

/// The tag the reminder ships under. Counted, so it must stay stable.
///
/// `pub(crate)` because `commands::threads` has to recognise it too: the
/// reminder rides as a text block in a tool message, and that is the same
/// shape a mid-turn user message uses, so without this the transcript would
/// draw Aurora's note to the model as a row in the person's chat.
pub(crate) const CHECKLIST_REMINDER_TAG: &str = "<aurora_task_reminder>";

/// The one reminder Aurora still sends about the checklist, and only when it
/// has gone quiet: [`CHECKLIST_REMINDER_TURNS`] assistant messages since the
/// last `todo` call, and as many again since the last reminder.
///
/// This replaces a per-request live block, a second block for when the list
/// was complete, a dedup guard for the request that already carried the list,
/// an unchanged guard for the copies frozen into tool results, and two prompt
/// rules about ordering — six mechanisms managing one progress indicator. The
/// tool's own result is the list; the model reads it when it writes it. What
/// remains is the one case that needs a word from outside: a model that has
/// stopped writing it.
///
/// Wording matters here as much as cadence. It says what to do — update or
/// clean up the list — and never what not to do; a list of prohibitions is a
/// list of things for the model to think about, measured at 49 of 80 thinking
/// blocks when this codebase last shipped one.
pub(super) fn stale_checklist_reminder(
    messages: &[ConversationMessage],
    thread_id: &str,
) -> Option<String> {
    let (since_write, since_reminder) = checklist_silence(messages);
    if since_write < CHECKLIST_REMINDER_TURNS || since_reminder < CHECKLIST_REMINDER_TURNS {
        return None;
    }
    let list = crate::tools::shell_editor_todo::todo_store::read(thread_id).ok()?;
    let body = if list.items.is_empty() {
        "You have not used the checklist in this conversation. If the work has \
         several steps, lay them out with `TaskCreate` so the user can follow your progress; if it \
         does not, carry on."
            .to_string()
    } else {
        format!(
            "Your checklist has not been updated for a while. If the work has moved on, bring \
             it up to date with `TaskUpdate`; if some of it no longer applies, cancel those items. \
             Here it is as it stands:\n\n{}",
            render_checklist(&list)
        )
    };
    Some(format!(
        "{CHECKLIST_REMINDER_TAG}\n{body}\n</aurora_task_reminder>"
    ))
}

/// How many assistant messages have passed since the last `todo` call and
/// since the last reminder, counting back from the end of the transcript.
///
/// A count that reaches the start of the transcript is the whole transcript:
/// a conversation that never wrote a list has been silent since its first
/// message. Both counts stop at a compaction marker — whatever happened before
/// it is a summary now, and the model reads that summary as its past.
pub(super) fn checklist_silence(messages: &[ConversationMessage]) -> (usize, usize) {
    let mut since_write = 0usize;
    let mut since_reminder = 0usize;
    let mut write_seen = false;
    let mut reminder_seen = false;
    for message in messages.iter().rev() {
        if write_seen && reminder_seen {
            break;
        }
        if message
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Compaction { .. }))
        {
            break;
        }
        match message.role {
            MessageRole::Assistant => {
                let writes_todo = message.blocks.iter().any(|b| {
                    matches!(
                        b,
                        ContentBlock::ToolUse { name, .. }
                            if name == "TaskCreate" || name == "TaskUpdate"
                    )
                });
                if writes_todo {
                    write_seen = true;
                }
                if !write_seen {
                    since_write += 1;
                }
                if !reminder_seen {
                    since_reminder += 1;
                }
            }
            MessageRole::Tool => {
                // Its own text block since 2026-09-06 — see `tool_exec`. The
                // `ToolResult` arm stays for threads written before that, where
                // the reminder was appended to the last result's body; drop it
                // and every one of those conversations reads as never having
                // been reminded, so the next turn sends another one.
                let carries_reminder = message.blocks.iter().any(|b| match b {
                    ContentBlock::Text { text } => text.contains(CHECKLIST_REMINDER_TAG),
                    ContentBlock::ToolResult { content, .. } => {
                        content.contains(CHECKLIST_REMINDER_TAG)
                    }
                    _ => false,
                });
                if carries_reminder {
                    reminder_seen = true;
                }
            }
            MessageRole::User | MessageRole::System => {}
        }
    }
    (since_write, since_reminder)
}
