//! Thread Tauri commands — agent_v2 Session edition.
//!
//! Every chat-list / thread-load / persistence command in Aurora goes
//! through here. The single source of truth is the
//! [`crate::agent_runtime::session_store::SessionStore`] — there is no
//! other persistence layer. The legacy event-sourced `ThreadEventLog`
//! and SQLite `threads` table have both been retired.
//!
//! ## Wire shape
//!
//! The frontend's `threadService` still consumes `DbThread` /
//! `DbMessage` / `ThreadSummary`. We synthesize those from the
//! canonical [`Session`] so the React layer doesn't have to learn the
//! Anthropic-style content-block model.
//!
//! Mapping:
//!
//! - `Session.thread_id` / `metadata.title` / `metadata.created_at` /
//!   `metadata.updated_at` → top-level `DbThread` fields.
//! - `Vec<ConversationMessage>` → `Vec<Message>` via
//!   [`session_to_db_messages`]: each `User` message becomes a flat
//!   `Message { role: "user", content }`; each `Assistant` message
//!   produces one `Message { role: "assistant" }` whose
//!   `content` is the joined text blocks, `thinking` is the joined
//!   thinking blocks, and `tool_calls` is a `Vec<ToolCall>` populated
//!   from the `ToolUse` blocks. `Tool` messages are folded into the
//!   prior assistant message's `tool_calls[].result` so the UI sees
//!   tool calls as paired with their results, the way the chat
//!   bubbles render.
//!
//! ## Lifecycle
//!
//! 1. Frontend creates a UUID and calls `thread_save({ id, title:
//!    "New Chat" })` — this calls `SessionStore::ensure_thread`,
//!    materialising an empty `<id>.jsonl` + `<id>.meta.json` pair.
//! 2. `agent_chat_v2` runs a turn; `TurnDriver` appends messages to
//!    the JSONL via `Session::save_to_path`, then calls
//!    `SessionStore::touch` and (on the first turn) `set_title` so
//!    the chat list re-orders.
//! 3. Frontend periodically calls `thread_update_usage` after each
//!    turn completes so the modal can render token / context bars.
//! 4. Reload / open: frontend calls `thread_load(id)`; we read the
//!    JSONL + sidecar and synthesise the `DbThread`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::agent_runtime::session_store::{ContextUsageMeta, SessionStore, TokenUsageMeta};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};
use crate::commands::agent_v2::AgentRegistry;
use crate::db::{ContextUsage, Message, ThreadState, TokenUsage, ToolCall as DbToolCall};
use crate::services::api_converter::{ApiMessage, ApiToolCall, ApiToolFunction};

// ============================================================================
// Wire-format adapters
// ============================================================================

/// Lightweight summary shipped to the chat list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub message_count: usize,
    pub preview: String,
    /// Project scope (the thread's `workspace_root`). `None` for legacy
    /// unscoped threads, which a project-filtered list omits entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// The model this conversation is on (`"providerId:modelKey"`), or `None`
    /// when it has never run a turn and was never pinned to one — the composer
    /// then falls back to the user's default model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Whether the chat is pinned to the top of the rail.
    #[serde(default)]
    pub pinned: bool,
    /// RFC3339 instant the chat was archived, or `None` when active. Archived
    /// chats live in the rail's "Archived" view and are purged after 15 days.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    /// Aurora Chat: started in deep research. Fixed at creation.
    #[serde(default)]
    pub deep_research: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Convert a stored `Vec<ConversationMessage>` into the flat
/// `Vec<Message>` shape the React layer renders. `Tool` messages are
/// folded back into the prior assistant message's `tool_calls[].result`
/// so the UI sees tool calls paired with their results.
#[cfg(test)]
fn session_to_db_messages(messages: &[ConversationMessage]) -> Vec<Message> {
    session_to_db_messages_rich(messages, &std::collections::HashMap::new())
}

/// Same conversion, overlaying full-fidelity results from the
/// `.rich.jsonl` sidecar: when a `ToolResult`'s history copy was clamped
/// at persist time, the sidecar carries the complete (UI-shaped) payload
/// keyed by `tool_use_id` — the reloaded card then renders the FULL diff
/// instead of a truncated head. Errors never have rich copies.
fn session_to_db_messages_rich(
    messages: &[ConversationMessage],
    rich: &std::collections::HashMap<String, String>,
) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());

    for msg in messages {
        let timestamp = millis_to_rfc3339(msg.timestamp);
        match msg.role {
            MessageRole::System => {
                // A compaction marker surfaces as a dedicated card the UI
                // renders inline (greyed, "Context compacted · before → after").
                // The summary itself is NEVER sent to the frontend. Every other
                // System message is internal scaffolding and stays hidden.
                if let Some((before, after)) = msg.blocks.iter().find_map(|b| match b {
                    ContentBlock::Compaction {
                        before_tokens,
                        after_tokens,
                        ..
                    } => Some((*before_tokens, *after_tokens)),
                    _ => None,
                }) {
                    out.push(Message {
                        id: synthetic_message_id("compaction", msg.timestamp, out.len()),
                        role: "compaction".to_string(),
                        content: serde_json::json!({
                            "beforeTokens": before,
                            "afterTokens": after,
                            "status": "completed",
                        })
                        .to_string(),
                        // Cloned: a System message carries either a compaction
                        // marker or a notice, and the notice arm below needs the
                        // same stamp.
                        timestamp: timestamp.clone(),
                        tool_calls: None,
                        thinking: None,
                        is_thinking: None,
                        tools: None,
                        timeline: None,
                        tool_proposal: None,
                        attached_selected_elements: None,
                        attached_prompt_chips: None,
                    });
                }
                // A runtime notice ("this reply is cut off at the output
                // limit") surfaces as its own row the UI folds into the
                // assistant turn it describes, so a reloaded thread explains
                // its truncated reply instead of just showing one.
                if let Some(message) = msg.blocks.iter().find_map(|b| match b {
                    ContentBlock::Notice { message, .. } => Some(message.clone()),
                    _ => None,
                }) {
                    out.push(Message {
                        id: synthetic_message_id("notice", msg.timestamp, out.len()),
                        role: "notice".to_string(),
                        content: message,
                        timestamp,
                        tool_calls: None,
                        thinking: None,
                        is_thinking: None,
                        tools: None,
                        timeline: None,
                        tool_proposal: None,
                        attached_selected_elements: None,
                        attached_prompt_chips: None,
                    });
                }
            }
            MessageRole::User => {
                let content = collect_text_blocks(&msg.blocks);
                out.push(Message {
                    id: synthetic_message_id("user", msg.timestamp, out.len()),
                    role: "user".to_string(),
                    // The text blocks hold the user's own words only —
                    // what Aurora attached for the model rides in the
                    // message's separate `aurora_context` field, never in
                    // the blocks. So whatever we read back is already
                    // display-clean.
                    content,
                    timestamp,
                    tool_calls: None,
                    thinking: None,
                    is_thinking: None,
                    tools: None,
                    timeline: None,
                    tool_proposal: None,
                    // Browser-inspector chips persisted with this turn —
                    // re-rendered above the user bubble on reopen.
                    attached_selected_elements: msg.attached_selected_elements.clone(),
                    attached_prompt_chips: msg.attached_prompt_chips.clone(),
                });
            }
            MessageRole::Assistant => {
                let message_id = synthetic_message_id("assistant", msg.timestamp, out.len());
                let mut content = String::new();
                let mut thinking = String::new();
                let mut tool_calls: Vec<DbToolCall> = Vec::new();
                // The order the model actually emitted this turn's parts in.
                // A real turn INTERLEAVES — it speaks, calls a tool, speaks
                // again, calls more — and `blocks` is the only record of that.
                // Dropping it made every reloaded turn render as "thought,
                // spoke, then ran every tool", which is not what happened and
                // put anything positional (a chapter marker, a notice) in the
                // wrong place the moment the chat was reopened.
                let mut timeline: Vec<serde_json::Value> = Vec::new();
                for block in &msg.blocks {
                    match block {
                        ContentBlock::Text { text } => {
                            push_with_newline(&mut content, text);
                            push_timeline_text(&mut timeline, &message_id, "content", text, None);
                        }
                        ContentBlock::Thinking {
                            text, duration_ms, ..
                        } => {
                            push_with_newline(&mut thinking, text);
                            push_timeline_text(
                                &mut timeline,
                                &message_id,
                                "thinking",
                                text,
                                *duration_ms,
                            );
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            let arguments =
                                serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string());
                            tool_calls.push(DbToolCall {
                                id: id.clone(),
                                name: name.clone(),
                                arguments,
                                result: None,
                            });
                            // ORDER ONLY. The call — and the result a later
                            // Tool message folds in below — lives in
                            // `tool_calls`; a second copy here would be a
                            // second truth that can disagree with it.
                            timeline.push(serde_json::json!({ "kind": "tool", "id": id }));
                        }
                        ContentBlock::ToolResult { .. } => {
                            // Defensive — tool results live on Tool
                            // messages, not Assistant. Ignore.
                        }
                        ContentBlock::Image {
                            asset,
                            path,
                            media_type,
                            width,
                            height,
                            prompt,
                            model,
                            artifact,
                        } => {
                            // A picture made directly. The transcript renders
                            // it as the picture; `content` (the copy text)
                            // gets the same one line a model would read.
                            if let Some(line) = block.image_as_text() {
                                push_with_newline(&mut content, &line);
                            }
                            timeline.push(serde_json::json!({
                                "kind": "image",
                                "id": format!("{message_id}-image-{}", timeline.len()),
                                "asset": asset,
                                "path": path,
                                "mediaType": media_type,
                                "width": width,
                                "height": height,
                                "prompt": prompt,
                                "model": model,
                                "artifactId": artifact,
                                "status": "ready",
                            }));
                        }
                        ContentBlock::Compaction { .. } | ContentBlock::Notice { .. } => {
                            // Compaction markers and runtime notices live on
                            // System messages and are surfaced as their own
                            // rows; never on Assistant.
                        }
                    }
                }
                let thinking_opt = if thinking.is_empty() {
                    None
                } else {
                    Some(thinking)
                };
                out.push(Message {
                    id: message_id,
                    role: "assistant".to_string(),
                    content,
                    timestamp,
                    tool_calls: if tool_calls.is_empty() {
                        None
                    } else {
                        Some(tool_calls)
                    },
                    thinking: thinking_opt,
                    is_thinking: Some(false),
                    tools: None,
                    timeline: if timeline.is_empty() {
                        None
                    } else {
                        Some(serde_json::Value::Array(timeline))
                    },
                    tool_proposal: None,
                    attached_selected_elements: None,
                    attached_prompt_chips: None,
                });
            }
            MessageRole::Tool => {
                // Fold every ToolResult block into the prior
                // assistant message's matching tool_call entry.
                if let Some(prev) = out.iter_mut().rev().find(|m| m.role == "assistant") {
                    if let Some(calls) = prev.tool_calls.as_mut() {
                        for block in &msg.blocks {
                            if let ContentBlock::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
                            } = block
                            {
                                if let Some(call) = calls.iter_mut().find(|c| c.id == *tool_use_id)
                                {
                                    let formatted = if is_error.unwrap_or(false) {
                                        format!("[error] {content}")
                                    } else {
                                        rich.get(tool_use_id).unwrap_or(content).clone()
                                    };
                                    call.result = Some(formatted);
                                }
                            }
                        }
                    }
                }

                // A mid-turn user message rides beside the tool results as a
                // Text block. Preserve it as a tiny assistant timeline segment
                // so the frontend merges it at the exact tool→next-response
                // boundary instead of losing it on thread reload.
                //
                // Display fidelity: the persisted block is the MODEL copy —
                // the typed text plus any `<steering_context>` directive
                // block the composer resolved from `/` commands. The row
                // shows only the typed part; the chips (persisted on this
                // tool message) re-render the pills that stood for the rest.
                for (index, text) in msg
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        // Aurora's own note to the model is not a message from
                        // anyone. It rides here as a text block — the same
                        // shape a mid-turn user message uses — so without this
                        // filter the transcript draws `<aurora_task_reminder>`
                        // as a row in the person's chat, tags and all. The
                        // checklist it describes is already on screen, live, in
                        // the header indicator.
                        ContentBlock::Text { text }
                            if !text.is_empty() && !is_runtime_note(text) =>
                        {
                            Some(text)
                        }
                        _ => None,
                    })
                    .enumerate()
                {
                    let display = strip_steering_context(strip_mid_turn_preamble(text));
                    let mut event = serde_json::json!({
                        "kind": "user_injection",
                        "id": format!("injection-{}-{index}", msg.timestamp),
                        "text": display,
                    });
                    if let Some(chips) = msg.attached_prompt_chips.as_ref() {
                        if let Ok(chips_json) = serde_json::to_value(chips) {
                            event["chips"] = chips_json;
                        }
                    }
                    out.push(Message {
                        id: synthetic_message_id("injection", msg.timestamp, out.len()),
                        role: "assistant".to_string(),
                        content: String::new(),
                        timestamp: timestamp.clone(),
                        tool_calls: None,
                        thinking: None,
                        is_thinking: Some(false),
                        tools: None,
                        timeline: Some(serde_json::Value::Array(vec![event])),
                        tool_proposal: None,
                        attached_selected_elements: None,
                        attached_prompt_chips: None,
                    });
                }
            }
        }
    }

    out
}

/// Is this text block Aurora talking to the model rather than a person
/// talking to anyone?
///
/// A tool message's text blocks are normally an injected mid-turn user message
/// — something a person typed, which belongs on screen. The runtime uses the
/// same slot for its own notes, and those do not: the reader never wrote them,
/// cannot act on them, and in the checklist's case is already looking at what
/// they describe in the header indicator.
///
/// Found the hard way. Moving the stale-checklist reminder out of a tool
/// result's body and into its own block (the right fix — a tool result must
/// hold the tool's output alone) handed it straight to this loop, and the next
/// session drew `<aurora_task_reminder>`, angle brackets and all, as a card in
/// the middle of the conversation.
fn is_runtime_note(text: &str) -> bool {
    text.contains(crate::agent_runtime::conversation::context_injection::CHECKLIST_REMINDER_TAG)
}

/// Drop the runtime's mid-turn framing line from an injected message. The
/// preamble ([`crate::agent_runtime::session::MID_TURN_PREAMBLE`]) tells the
/// MODEL the message arrived while tools were running; the human watched it
/// happen, so displaying it back is noise.
fn strip_mid_turn_preamble(text: &str) -> &str {
    let preamble = crate::agent_runtime::session::MID_TURN_PREAMBLE;
    match text.strip_prefix(preamble) {
        Some(rest) => rest.trim_start_matches('\n'),
        None => text,
    }
}

/// Cut the `<steering_context>…</steering_context>` block out of an injected
/// mid-turn message, leaving what the user typed.
///
/// The composer appends that block when the user attaches `/` directives to
/// a mid-turn send (resolved rule text, skill references, MCP nudges) — the
/// model must see it, the human already saw it as pills. The tag pair is a
/// contract with `useAgentWindowSend`'s mid-turn branch (`STEERING_OPEN` /
/// `STEERING_CLOSE` there); a message without the tags passes through
/// untouched, as does a malformed half-tagged one (showing machinery beats
/// eating the user's words).
fn strip_steering_context(text: &str) -> String {
    const OPEN: &str = "<steering_context>";
    const CLOSE: &str = "</steering_context>";
    let (Some(start), Some(end)) = (text.find(OPEN), text.rfind(CLOSE)) else {
        return text.to_string();
    };
    if end < start {
        return text.to_string();
    }
    let head = text[..start].trim_end();
    let tail = text[end + CLOSE.len()..].trim_start();
    match (head.is_empty(), tail.is_empty()) {
        (false, false) => format!("{head}\n\n{tail}"),
        (false, true) => head.to_string(),
        (true, false) => tail.to_string(),
        (true, true) => String::new(),
    }
}

/// Convert the canonical `Vec<ConversationMessage>` directly into the
/// `Vec<ApiMessage>` shape the LLM-request builder consumes. This is
/// what `thread_get_api_history` returns when the frontend asks for
/// the rebuild-context view of a thread.
fn session_to_api_messages(messages: &[ConversationMessage]) -> Vec<ApiMessage> {
    let mut out: Vec<ApiMessage> = Vec::with_capacity(messages.len());
    for msg in messages {
        match msg.role {
            MessageRole::System => {
                let content = collect_text_blocks(&msg.blocks);
                if !content.is_empty() {
                    out.push(ApiMessage::System { content });
                }
            }
            MessageRole::User => {
                let content = collect_text_blocks(&msg.blocks);
                if !content.is_empty() {
                    out.push(ApiMessage::User { content });
                }
            }
            MessageRole::Assistant => {
                let mut content = String::new();
                let mut reasoning = String::new();
                let mut tool_calls: Vec<ApiToolCall> = Vec::new();
                for block in &msg.blocks {
                    match block {
                        ContentBlock::Text { text } => push_with_newline(&mut content, text),
                        ContentBlock::Thinking { text, .. } => {
                            push_with_newline(&mut reasoning, text);
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            let arguments =
                                serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string());
                            tool_calls.push(ApiToolCall {
                                id: id.clone(),
                                call_type: "function".to_string(),
                                function: ApiToolFunction {
                                    name: name.clone(),
                                    arguments,
                                },
                            });
                        }
                        ContentBlock::Image { .. } => {
                            if let Some(line) = block.image_as_text() {
                                push_with_newline(&mut content, &line);
                            }
                        }
                        ContentBlock::ToolResult { .. } => {}
                        ContentBlock::Compaction { .. } | ContentBlock::Notice { .. } => {}
                    }
                }
                let content_opt = if content.is_empty() {
                    None
                } else {
                    Some(content)
                };
                let reasoning_opt = if reasoning.is_empty() {
                    None
                } else {
                    Some(reasoning)
                };
                let tool_calls_opt = if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                };
                // Skip empty assistant messages entirely.
                if content_opt.is_some() || tool_calls_opt.is_some() {
                    out.push(ApiMessage::Assistant {
                        content: content_opt,
                        reasoning_content: reasoning_opt,
                        tool_calls: tool_calls_opt,
                    });
                }
            }
            MessageRole::Tool => {
                let mut injected_text = String::new();
                for block in &msg.blocks {
                    match block {
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => out.push(ApiMessage::Tool {
                            tool_call_id: tool_use_id.clone(),
                            content: content.clone(),
                        }),
                        ContentBlock::Text { text } => push_with_newline(&mut injected_text, text),
                        _ => {}
                    }
                }
                if !injected_text.is_empty() {
                    out.push(ApiMessage::User {
                        content: injected_text,
                    });
                }
            }
        }
    }
    out
}

fn collect_text_blocks(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } => push_with_newline(&mut out, text),
            // A directly made picture reads as its one-line description
            // wherever the transcript is text (export, API view).
            ContentBlock::Image { .. } => {
                if let Some(line) = block.image_as_text() {
                    push_with_newline(&mut out, &line);
                }
            }
            _ => {}
        }
    }
    out
}

fn push_with_newline(out: &mut String, s: &str) {
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(s);
}

/// Append a text-bearing event to a reconstructed assistant timeline, merging
/// into the previous event when it is already the same kind.
///
/// Adjacent blocks of one kind are ONE segment, which is what the live stream
/// produces (it coalesces its deltas the same way). Without merging, a reply
/// that happened to arrive as three text blocks would reload as three separate
/// paragraphs — and a tool row could then appear between parts of one sentence.
///
/// Empty text is skipped: it contributes nothing to read, and an empty segment
/// renders as a blank gap in the transcript.
/// `duration_ms` is carried for reasoning segments only, and SUMS across a
/// merge: two adjacent thinking blocks become one segment in the UI, so the
/// number the UI prints has to describe the whole thing. Blocks written before
/// the field existed carry `None` and contribute nothing, which correctly
/// leaves a legacy segment with no number rather than a partial one.
fn push_timeline_text(
    timeline: &mut Vec<serde_json::Value>,
    message_id: &str,
    kind: &str,
    text: &str,
    duration_ms: Option<u64>,
) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = timeline.last_mut() {
        if last["kind"] == kind {
            let merged = format!("{}\n{}", last["text"].as_str().unwrap_or_default(), text);
            last["text"] = serde_json::Value::String(merged);
            if let Some(ms) = duration_ms {
                let total = last["durationMs"].as_u64().unwrap_or(0).saturating_add(ms);
                last["durationMs"] = serde_json::json!(total);
            }
            return;
        }
    }
    // Index-derived id: block order on disk is fixed, so this is stable across
    // reloads and unique within the message.
    let id = format!("{message_id}-e{}", timeline.len());
    let mut event = serde_json::json!({ "kind": kind, "id": id, "text": text });
    if let Some(ms) = duration_ms {
        event["durationMs"] = serde_json::json!(ms);
    }
    timeline.push(event);
}

fn duplicate_title(title: &str) -> String {
    let title = title.trim();
    let base = if title.is_empty() { "New Chat" } else { title };
    format!("{base} (copy)")
}

/// Produce a clean, portable transcript. Internal system messages, model
/// thinking, tool calls, and tool results are deliberately omitted; only the
/// same user/assistant prose visible in the conversation is exported.
fn render_thread_markdown(title: &str, messages: &[ConversationMessage]) -> String {
    let clean_title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean_title = if clean_title.is_empty() {
        "Chat"
    } else {
        clean_title.as_str()
    };
    let mut markdown = format!("# {clean_title}\n");

    for message in messages {
        let role = match message.role {
            MessageRole::User => "You",
            MessageRole::Assistant => "Aurora",
            MessageRole::System | MessageRole::Tool => continue,
        };
        let visible = collect_text_blocks(&message.blocks);
        let visible = crate::agent_runtime::title::strip_aurora_image_blocks(&visible);
        let visible = visible.trim();
        if visible.is_empty() {
            continue;
        }
        markdown.push_str("\n## ");
        markdown.push_str(role);
        markdown.push_str("\n\n");
        markdown.push_str(visible);
        markdown.push('\n');
    }

    markdown
}

fn millis_to_rfc3339(millis: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

/// Synthesise a stable id for a message reconstructed from the
/// `ConversationMessage` stream. The runtime doesn't carry per-message
/// ids (tool_use ids exist, regular messages don't) — the React layer
/// only needs a unique key for `<List>` rendering, so a deterministic
/// composite is fine.
fn synthetic_message_id(role: &str, timestamp_millis: i64, ordinal: usize) -> String {
    format!("{role}-{timestamp_millis}-{ordinal}")
}

// ============================================================================
// Token / context usage adapters (db ↔ session_store)
// ============================================================================

fn db_token_to_meta(usage: &TokenUsage) -> TokenUsageMeta {
    TokenUsageMeta {
        prompt_tokens: usage.prompt_tokens.max(0) as u32,
        completion_tokens: usage.completion_tokens.max(0) as u32,
        total_tokens: usage.total_tokens.max(0) as u32,
        cache_read_tokens: None,
        cache_write_tokens: None,
        estimated: usage.estimated,
    }
}

fn db_context_to_meta(usage: &ContextUsage) -> ContextUsageMeta {
    ContextUsageMeta {
        used_tokens: usage.used_tokens.max(0) as u32,
        context_window: usage.context_window.max(0) as u32,
        percentage: usage.percentage,
    }
}

fn meta_to_db_token(meta: &TokenUsageMeta) -> TokenUsage {
    TokenUsage {
        prompt_tokens: i64::from(meta.prompt_tokens),
        completion_tokens: i64::from(meta.completion_tokens),
        total_tokens: i64::from(meta.total_tokens),
        estimated: meta.estimated,
    }
}

fn meta_to_db_context(meta: &ContextUsageMeta) -> ContextUsage {
    ContextUsage {
        used_tokens: i64::from(meta.used_tokens),
        context_window: i64::from(meta.context_window),
        percentage: meta.percentage,
    }
}

// ============================================================================
// Tauri events — same wire channels the legacy code shipped so the
// React layer doesn't need a migration.
// ============================================================================

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: &S) {
    if let Err(e) = app.emit(event, payload) {
        eprintln!("[threads] failed to emit {event}: {e}");
    }
}

#[derive(Serialize, Clone)]
struct ThreadCreatedPayload {
    thread: ThreadSummary,
}
#[derive(Serialize, Clone)]
struct ThreadLoadedPayload {
    thread: ThreadState,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadDeletedPayload {
    thread_id: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadUsageUpdatedPayload {
    thread_id: String,
    token_usage: TokenUsage,
    context_usage: ContextUsage,
}

// ============================================================================
// Helpers — shared between commands
// ============================================================================

/// Which store owns `thread_id`, answered from disk.
///
/// Aurora has two conversation stores — `sessions/` for Build and `Chats/` for
/// Aurora Chat — and almost every command here already names the conversation
/// it is acting on. That name is enough: ids are UUIDs, a conversation exists
/// in exactly one store, and asking the filesystem is one `stat`.
///
/// Deliberately a lookup rather than a parameter on fifteen commands. A
/// parameter is a thing every caller has to remember, and the one that forgets
/// does not fail loudly — it reads or deletes in the wrong store. The disk
/// cannot forget.
///
/// An id in neither store (a brand-new conversation) resolves to Build, which
/// is what every existing caller means. The two commands that genuinely cannot
/// look it up — creating a conversation, and listing them — are told instead.
fn store_for_thread(registry: &Arc<AgentRegistry>, thread_id: &str) -> Arc<SessionStore> {
    registry.store_for_thread(thread_id).clone()
}

/// The store for a named surface. `"chat"` is Aurora Chat; anything else,
/// including `None`, is Build.
fn store_for_surface(registry: &Arc<AgentRegistry>, surface: Option<&str>) -> Arc<SessionStore> {
    if surface == Some("chat") {
        registry.chat_store().clone()
    } else {
        registry.store().clone()
    }
}

fn build_thread_state(
    store: &SessionStore,
    thread_id: &str,
) -> Result<Option<ThreadState>, String> {
    let loaded = store
        .load(thread_id)
        .map_err(|e| format!("Failed to load thread {thread_id}: {e}"))?;
    let Some(loaded) = loaded else {
        return Ok(None);
    };
    let rich = store.load_rich_results(thread_id);
    let messages = session_to_db_messages_rich(loaded.session.messages(), &rich);
    Ok(Some(ThreadState {
        id: thread_id.to_string(),
        title: loaded.metadata.title,
        summary: None,
        messages,
        token_usage: loaded.metadata.token_usage.as_ref().map(meta_to_db_token),
        context_usage: loaded
            .metadata
            .context_usage
            .as_ref()
            .map(meta_to_db_context),
        created_at: loaded.metadata.created_at,
        updated_at: loaded.metadata.updated_at,
    }))
}

fn build_thread_summary(
    summary: crate::agent_runtime::session_store::SessionSummary,
) -> ThreadSummary {
    ThreadSummary {
        id: summary.id,
        title: summary.title,
        message_count: summary.message_count,
        preview: summary.preview,
        workspace_root: summary.workspace_root,
        model: summary.model,
        pinned: summary.pinned,
        archived_at: summary.archived_at,
        deep_research: summary.deep_research,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
    }
}

// ============================================================================
// Commands
// ============================================================================

/// Upsert thread metadata. Frontend calls this immediately after
/// generating a UUID for a new chat (optimistic create) and again
/// whenever a stored `Thread` is mutated client-side. Only the
/// `title` field is persisted — message history is owned exclusively
/// by the agent runtime.
#[tauri::command]
pub fn thread_save(
    thread: ThreadState,
    workspace_root: Option<String>,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &thread.id);
    store
        .ensure_thread(&thread.id, Some(thread.title.clone()), workspace_root)
        .map_err(|e| format!("Failed to ensure thread {}: {e}", thread.id))?;
    if !thread.title.is_empty() {
        store
            .set_title(&thread.id, thread.title.clone())
            .map_err(|e| format!("Failed to update title: {e}"))?;
    }

    if let Some(state) = build_thread_state(&store, &thread.id)? {
        emit(
            &app,
            "thread-loaded",
            &ThreadLoadedPayload { thread: state },
        );
    }
    Ok(())
}

/// Materialise an empty thread and return the freshly-bootstrapped
/// `ThreadState`. The frontend currently generates UUIDs itself and
/// uses `thread_save` to upsert, so this command is rarely called —
/// kept for symmetry with the historic API surface.
#[tauri::command]
pub fn thread_create(
    title: Option<String>,
    workspace_root: Option<String>,
    // `surface`: `"chat"` creates the conversation in Aurora Chat's store;
    // anything else, including omitting it, creates a Build conversation. One
    // of the two commands that cannot look the store up, because the
    // conversation does not exist yet.
    surface: Option<String>,
    // `deep_research`: stamped ONCE, here, and never changed. This is the only
    // place it can be set — see `SessionMetadata::deep_research`.
    deep_research: Option<bool>,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<ThreadState, String> {
    let store = store_for_surface(registry.inner(), surface.as_deref());
    let thread_id = uuid::Uuid::new_v4().to_string();
    let meta = store
        .ensure_thread(&thread_id, title, workspace_root)
        .map_err(|e| format!("Failed to create thread: {e}"))?;

    // Best-effort: a conversation that failed to record its framing is still a
    // conversation, and refusing to create it would be the worse outcome.
    if deep_research.unwrap_or(false) {
        if let Err(err) = store.mark_deep_research(&thread_id) {
            crate::logging::log_warn(
                "threads",
                &format!("could not mark {thread_id} as deep research: {err}"),
            );
        }
    }

    let ws_root = meta.workspace_root.clone();
    let state = ThreadState {
        id: thread_id,
        title: meta.title,
        summary: None,
        messages: Vec::new(),
        token_usage: None,
        context_usage: None,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
    };
    emit(
        &app,
        "thread-created",
        &ThreadCreatedPayload {
            thread: ThreadSummary {
                id: state.id.clone(),
                title: state.title.clone(),
                message_count: 0,
                preview: String::new(),
                workspace_root: ws_root,
                // A brand-new chat has no model yet — the composer resolves the
                // user's default until a pick or a turn writes one.
                model: None,
                pinned: false,
                archived_at: None,
                deep_research: deep_research.unwrap_or(false),
                created_at: state.created_at.clone(),
                updated_at: state.updated_at.clone(),
            },
        },
    );
    Ok(state)
}

/// Duplicate a persisted conversation as a new, active chat. The Rust store
/// owns the full operation so the frontend never reconstructs or rewrites
/// transcript data.
#[tauri::command]
pub async fn thread_duplicate(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<ThreadSummary, String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    let new_thread_id = uuid::Uuid::new_v4().to_string();
    let source_thread_id = thread_id.clone();
    let worker_store = store.clone();
    let worker_new_thread_id = new_thread_id.clone();

    let summary = tokio::task::spawn_blocking(move || {
        let source = worker_store
            .load(&source_thread_id)
            .map_err(|error| format!("Failed to load chat for duplication: {error}"))?
            .ok_or_else(|| "The chat no longer exists".to_string())?;
        let title = duplicate_title(&source.metadata.title);
        drop(source);

        worker_store
            .duplicate(&source_thread_id, &worker_new_thread_id, title)
            .map_err(|error| format!("Failed to duplicate chat: {error}"))?;

        if let Err(error) = crate::commands::artifacts::duplicate_thread_artifacts(
            &worker_store,
            &source_thread_id,
            &worker_new_thread_id,
        ) {
            let _ = worker_store.delete(&worker_new_thread_id);
            return Err(format!("Failed to duplicate chat artifacts: {error}"));
        }

        worker_store
            .list_summaries()
            .map_err(|error| format!("Failed to read duplicated chat: {error}"))?
            .into_iter()
            .find(|entry| entry.id == worker_new_thread_id)
            .map(build_thread_summary)
            .ok_or_else(|| "The duplicated chat could not be found after saving".to_string())
    })
    .await
    .map_err(|error| format!("Chat duplication task failed: {error}"))??;

    emit(
        &app,
        "thread-created",
        &ThreadCreatedPayload {
            thread: summary.clone(),
        },
    );
    Ok(summary)
}

/// Render the visible conversation as Markdown and write it to the native
/// clipboard. Clipboard ownership stays in Rust; the React layer only invokes
/// the command and presents feedback.
#[tauri::command]
pub async fn thread_copy_markdown(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    let markdown = tokio::task::spawn_blocking(move || {
        let loaded = store
            .load(&thread_id)
            .map_err(|error| format!("Failed to load chat for export: {error}"))?
            .ok_or_else(|| "The chat no longer exists".to_string())?;
        let markdown = render_thread_markdown(&loaded.metadata.title, loaded.session.messages());
        if !markdown.contains("\n## ") {
            return Err("This chat has no visible messages to copy".to_string());
        }
        Ok(markdown)
    })
    .await
    .map_err(|error| format!("Chat export task failed: {error}"))??;

    app.clipboard()
        .write_text(markdown)
        .map_err(|error| format!("Failed to write chat to the clipboard: {error}"))
}

// ============================================================================
// Cost accounting
// ============================================================================

/// Token totals for every request in a thread that ran on ONE model.
///
/// Grouped rather than summed flat because price is a property of the model,
/// and a conversation can move between models freely — start on a cheap one,
/// switch to a frontier model mid-task, switch back. Summing all tokens and
/// pricing them once at whatever model happens to be selected now would
/// misprice every request that ran under a different one, in either direction.
/// The caller prices each group with ITS model and adds up the money.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageGroup {
    /// `"{provider_id}:{model}"`, or `None` for requests recorded before the
    /// model was persisted per message. Those are reported separately rather
    /// than folded into a priced group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Fresh (uncached) input tokens.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// API requests in this group.
    pub requests: u32,
    /// How many of those requests carry Aurora's own estimate rather than
    /// provider-reported usage. Non-zero means the group's cost is
    /// approximate and must be presented that way.
    pub estimated_requests: u32,
    /// Total USD the PROVIDER reported for these requests.
    ///
    /// `Some` means every request here came with its own price from the
    /// provider, and that figure is used verbatim — no token arithmetic. That
    /// is the honest ordering: a reported cost already includes gateway
    /// markup, BYOK rates and account discounts that a published list price
    /// cannot know about.
    ///
    /// Groups are SPLIT on whether cost was reported (see the grouping key),
    /// so this is never a partial sum sitting next to tokens that also need
    /// pricing — a group is entirely reported or entirely computed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reported_cost_usd: Option<f64>,
}

/// A thread's complete cost basis, derived from the transcript on disk.
///
/// Deliberately computed from the JSONL rather than accumulated in the UI:
/// the transcript is the only record that survives a reload, a second window,
/// or a crash mid-turn, and a frontend running total would drift from it the
/// first time any of those happened.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsageBreakdown {
    pub thread_id: String,
    /// Every request in the thread.
    pub by_model: Vec<ModelUsageGroup>,
    /// Only the most recent turn (everything after the last user message).
    pub last_turn: Vec<ModelUsageGroup>,
    /// User messages — i.e. how many times the user asked for something.
    pub turns: u32,
    /// API requests across the thread. Always >= `turns`, usually far more:
    /// one turn makes one request per tool iteration.
    pub requests: u32,
}

/// Fold every message that carries usage into per-model token groups.
///
/// Keyed on the PRESENCE OF USAGE rather than on the role, because an
/// assistant reply is not the only thing Aurora pays for: a compaction marker
/// is a `System` message and the summarization request behind it is often the
/// largest single request in a conversation. Anything that cost money records
/// usage; anything that records usage is counted here.
///
/// A message with no usage (a turn that errored before the provider answered)
/// is not counted as a request — `requests` sits next to a dollar figure, and
/// a request with no measurement would imply a cost basis that does not exist.
fn group_usage_by_model(messages: &[ConversationMessage]) -> Vec<ModelUsageGroup> {
    let mut groups: Vec<ModelUsageGroup> = Vec::new();
    for message in messages {
        let Some(usage) = message.usage.as_ref() else {
            continue;
        };
        // Grouped by (model, did the provider price it). Splitting on the
        // second half is what keeps a group entirely reported or entirely
        // computed: mixing them would leave a partial dollar sum sitting next
        // to tokens that still need pricing, and any consumer would either
        // double-count or drop one of the two.
        let reported = usage.cost_usd.is_some();
        let slot = match groups
            .iter_mut()
            .find(|g| g.model == message.model && g.reported_cost_usd.is_some() == reported)
        {
            Some(existing) => existing,
            None => {
                groups.push(ModelUsageGroup {
                    model: message.model.clone(),
                    reported_cost_usd: if reported { Some(0.0) } else { None },
                    ..Default::default()
                });
                groups.last_mut().expect("just pushed")
            }
        };
        if let Some(cost) = usage.cost_usd {
            slot.reported_cost_usd = Some(slot.reported_cost_usd.unwrap_or(0.0) + cost);
        }
        slot.input_tokens = slot
            .input_tokens
            .saturating_add(u64::from(usage.input_tokens));
        slot.output_tokens = slot
            .output_tokens
            .saturating_add(u64::from(usage.output_tokens));
        slot.cache_read_tokens = slot
            .cache_read_tokens
            .saturating_add(u64::from(usage.cache_read_input_tokens.unwrap_or(0)));
        slot.cache_write_tokens = slot
            .cache_write_tokens
            .saturating_add(u64::from(usage.cache_creation_input_tokens.unwrap_or(0)));
        slot.requests = slot.requests.saturating_add(1);
        if usage.estimated == Some(true) {
            slot.estimated_requests = slot.estimated_requests.saturating_add(1);
        }
    }
    groups
}

/// The slice of the transcript belonging to the most recent turn: everything
/// after the last user message.
///
/// A "turn" is one user request and all the work it caused, which is exactly
/// what the cost card labels "Last turn" — not the last API call, which is
/// what the old snapshot showed and why a long tool-using turn under-reported
/// its cost by an order of magnitude.
fn last_turn_slice(messages: &[ConversationMessage]) -> &[ConversationMessage] {
    match messages.iter().rposition(|m| m.role == MessageRole::User) {
        Some(index) => &messages[index..],
        // No user message: either an empty thread or a synthesized one. The
        // whole transcript is the only honest answer.
        None => messages,
    }
}

/// Build a thread's cost basis from its transcript.
fn usage_breakdown(thread_id: &str, messages: &[ConversationMessage]) -> ThreadUsageBreakdown {
    let by_model = group_usage_by_model(messages);
    let requests = by_model.iter().map(|g| g.requests).sum();
    ThreadUsageBreakdown {
        thread_id: thread_id.to_string(),
        last_turn: group_usage_by_model(last_turn_slice(messages)),
        by_model,
        turns: messages
            .iter()
            .filter(|m| m.role == MessageRole::User)
            .count() as u32,
        requests,
    }
}

/// Token totals for a thread, grouped by the model that produced them.
///
/// The frontend applies pricing (which lives in the settings store) and sums
/// the resulting money. Tokens are Rust's truth, prices are the settings
/// store's truth — neither layer guesses at the other's.
#[tauri::command]
pub fn thread_usage_breakdown(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Option<ThreadUsageBreakdown>, String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    let loaded = store
        .load(&thread_id)
        .map_err(|e| format!("Failed to load thread {thread_id}: {e}"))?;
    Ok(loaded.map(|loaded| usage_breakdown(&thread_id, loaded.session.messages())))
}

/// Read a full thread (metadata + transcript) for the chat panel.
#[tauri::command]
pub fn thread_load(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<Option<ThreadState>, String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    let state = build_thread_state(&store, &thread_id)?;
    if let Some(s) = state.as_ref() {
        emit(
            &app,
            "thread-loaded",
            &ThreadLoadedPayload { thread: s.clone() },
        );
    }
    Ok(state)
}

/// Drop both files and clear any in-memory context for the thread.
#[tauri::command]
pub fn thread_delete(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    // Drop it from the search index BEFORE the folder goes. Left behind, the
    // index would keep returning hits for a conversation that can no longer be
    // opened — a worse failure than a missing one, because it looks like a bug
    // in `recall` rather than like a deleted chat.
    //
    // Its FACTS are deliberately untouched: a fact is about the user, not about
    // the conversation that happened to teach it.
    if store.dir() == registry.chat_store().dir() {
        if let Some(memory) = crate::chat_memory::service() {
            let _ = memory.forget_chat(&thread_id);
        }
    }
    store
        .delete(&thread_id)
        .map_err(|e| format!("Failed to delete thread {thread_id}: {e}"))?;
    // Best-effort: drop any in-memory context engine state so a
    // recreated thread with the same id starts fresh.
    crate::context::manager::remove_context(&thread_id);
    emit(
        &app,
        "thread-deleted",
        &ThreadDeletedPayload {
            thread_id: thread_id.clone(),
        },
    );
    Ok(())
}

/// List threads newest-first.
///
/// When `workspace_root` is provided, only threads belonging to that
/// project are returned (legacy unscoped threads are omitted) — this
/// powers the agent window's project-scoped chat list. Omit it (the
/// IDE's global history) to get every thread.
/// Async + `spawn_blocking`: listing walks every session file on disk, and
/// synchronous commands run on the main thread (Tauri v2), where a large
/// store froze the whole app into "Not Responding" during boot.
#[tauri::command]
pub async fn thread_list_summaries(
    workspace_root: Option<String>,
    // `surface`: `"chat"` lists Aurora Chat's conversations instead of Build's.
    // The other command that has to be told, because a listing has no
    // conversation to look up.
    //
    // `workspace_root` is meaningless alongside it and callers should omit it:
    // chat conversations carry no workspace, so a filter returns nothing.
    surface: Option<String>,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<ThreadSummary>, String> {
    let store = store_for_surface(registry.inner(), surface.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let entries = store
            .list_summaries_filtered(workspace_root.as_deref())
            .map_err(|e| format!("Failed to list threads: {e}"))?;
        // A slow listing is exactly what the boot-time "Not Responding"
        // freeze looked like before this ran off the main thread — keep a
        // trace so a regression names itself in the log.
        let elapsed_ms = started.elapsed().as_millis();
        if elapsed_ms > 300 {
            crate::logging::log_warn(
                "threads.list",
                &format!("thread_list_summaries scanned {} threads in {elapsed_ms}ms (expected <300ms; this is the boot chat-list path)", entries.len()),
            );
        }
        Ok(entries.into_iter().map(build_thread_summary).collect())
    })
    .await
    .map_err(|e| format!("Thread listing task failed: {e}"))?
}

/// Update the user-facing title without touching message history.
#[tauri::command]
pub fn thread_update_title(
    thread_id: String,
    title: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    store
        .set_title(&thread_id, title)
        .map(|_| ())
        .map_err(|e| format!("Failed to update title: {e}"))
}

/// Pin / unpin a chat. Pinned chats sort to a dedicated section at the
/// top of the rail. Persisted in the metadata sidecar; does not bump
/// `updated_at` (pinning shouldn't reorder by recency).
#[tauri::command]
pub fn thread_set_pinned(
    thread_id: String,
    pinned: bool,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    store
        .set_pinned(&thread_id, pinned)
        .map(|_| ())
        .map_err(|e| format!("Failed to set pinned: {e}"))
}

/// Archive / unarchive a chat. Archived chats leave the rail tree for the
/// "Archived" view and are automatically purged 15 days after archiving.
/// Persisted in the metadata sidecar; does not bump `updated_at`.
#[tauri::command]
pub fn thread_set_archived(
    thread_id: String,
    archived: bool,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    store
        .set_archived(&thread_id, archived)
        .map(|_| ())
        .map_err(|e| format!("Failed to set archived: {e}"))
}

/// Pin a conversation to a model (`"providerId:modelKey"`), or clear it with
/// `None` so it falls back to the user's default.
///
/// Written when the user picks a model for an OPEN chat — before any turn has
/// run with it. The runtime writes the same field per turn, so the two agree:
/// whichever happened last is what the conversation is on. Persisted in the
/// metadata sidecar; does not bump `updated_at` (choosing a model isn't
/// activity and must not reorder the rail).
#[tauri::command]
pub fn thread_set_model(
    thread_id: String,
    model: Option<String>,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    store
        .set_model(&thread_id, model)
        .map(|_| ())
        .map_err(|e| format!("Failed to set model: {e}"))
}

/// Persist usage metadata after a turn so the chat list can show
/// token + context bars.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUsageRequest {
    pub thread_id: String,
    pub token_usage: TokenUsage,
    pub context_usage: ContextUsage,
}

#[tauri::command]
pub fn thread_update_usage(
    request: UpdateUsageRequest,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<(), String> {
    let store = store_for_thread(registry.inner(), &request.thread_id);
    store
        .set_usage(
            &request.thread_id,
            Some(db_token_to_meta(&request.token_usage)),
            Some(db_context_to_meta(&request.context_usage)),
        )
        .map_err(|e| format!("Failed to persist usage: {e}"))?;
    emit(
        &app,
        "thread-usage-updated",
        &ThreadUsageUpdatedPayload {
            thread_id: request.thread_id,
            token_usage: request.token_usage,
            context_usage: request.context_usage,
        },
    );
    Ok(())
}

/// Rebuild the API-shaped message list for a thread. Used by the
/// frontend when reseeding the in-memory context engine on
/// thread-switch.
#[tauri::command]
pub fn thread_get_api_history(
    thread_id: String,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<Vec<ApiMessage>, String> {
    let store = store_for_thread(registry.inner(), &thread_id);
    let loaded = store
        .load(&thread_id)
        .map_err(|e| format!("Failed to load thread {thread_id}: {e}"))?;
    let Some(loaded) = loaded else {
        return Ok(Vec::new());
    };
    Ok(session_to_api_messages(loaded.session.messages()))
}

/// Cancel any in-flight turn on a thread. The new agent runtime owns
/// turn lifecycle through `agent_cancel(turn_id)` — this command
/// keeps the frontend's existing "Stop" button working by clearing
/// the thread's in-memory context manager so the next request starts
/// from the persisted JSONL only.
///
/// Returns `Some("session")` when context was cleared, `None` when
/// the thread had no live state. The exact return shape doesn't
/// matter; the frontend treats it as a fire-and-forget.
#[tauri::command]
pub fn thread_cancel_current_turn(
    thread_id: String,
    _reason: Option<String>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    crate::context::manager::remove_context(&thread_id);
    emit(
        &app,
        "thread-cancelled",
        &serde_json::json!({
            "threadId": thread_id,
            "reason": "user_stop",
        }),
    );
    Ok(Some("session".to_string()))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::TokenUsage as RuntimeTokenUsage;

    fn user_msg(text: &str, ts: i64) -> ConversationMessage {
        ConversationMessage::user_text(text, ts)
    }

    fn assistant_text(text: &str, ts: i64) -> ConversationMessage {
        ConversationMessage::assistant(
            vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            ts,
        )
    }

    /// A runtime notice must reload as its own `notice` row so a thread
    /// reopened after a truncated turn still explains why the reply stops.
    /// Before this it was a live-only UI event: the cut-off reply persisted,
    /// the reason for it did not.
    #[test]
    fn notice_marker_reloads_as_its_own_row() {
        let messages = vec![
            user_msg("build it", 1),
            assistant_text("half an ans", 2),
            ConversationMessage {
                role: MessageRole::System,
                blocks: vec![ContentBlock::Notice {
                    message: "This reply is cut off.".into(),
                    created_at: 3,
                }],
                usage: None,
                timestamp: 3,
                attached_selected_elements: None,
                attached_prompt_chips: None,
                aurora_context: None,
                model: None,
            },
        ];

        let out = session_to_db_messages(&messages);
        let roles: Vec<&str> = out.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "notice"]);
        let notice = out.last().expect("notice row");
        assert_eq!(notice.content, "This reply is cut off.");
    }

    #[test]
    fn markdown_export_contains_only_visible_conversation_text() {
        let messages = vec![
            user_msg("Please inspect this", 1),
            ConversationMessage::assistant(
                vec![
                    ContentBlock::Thinking {
                        text: "private reasoning".into(),
                        signature: None,
                        duration_ms: None,
                    },
                    ContentBlock::Text {
                        text: "Here is the answer".into(),
                    },
                    ContentBlock::ToolUse {
                        id: "call-1".into(),
                        name: "read_file".into(),
                        input: serde_json::json!({ "path": "secret.txt" }),
                    },
                ],
                2,
            ),
            tool_result("call-1", "private tool output", 3),
        ];

        let markdown = render_thread_markdown("  Export   test  ", &messages);

        assert!(markdown.starts_with("# Export test\n"));
        assert!(markdown.contains("## You\n\nPlease inspect this"));
        assert!(markdown.contains("## Aurora\n\nHere is the answer"));
        assert!(!markdown.contains("private reasoning"));
        assert!(!markdown.contains("private tool output"));
        assert!(!markdown.contains("secret.txt"));
    }

    #[test]
    fn duplicate_title_uses_a_customer_ready_suffix() {
        assert_eq!(
            duplicate_title("Architecture review"),
            "Architecture review (copy)"
        );
        assert_eq!(duplicate_title("  "), "New Chat (copy)");
    }

    fn assistant_with_tool(
        tool_id: &str,
        name: &str,
        input: serde_json::Value,
        ts: i64,
    ) -> ConversationMessage {
        ConversationMessage::assistant(
            vec![
                ContentBlock::Text {
                    text: "running tool".into(),
                },
                ContentBlock::ToolUse {
                    id: tool_id.to_string(),
                    name: name.to_string(),
                    input,
                },
            ],
            ts,
        )
    }

    fn tool_result(tool_id: &str, content: &str, ts: i64) -> ConversationMessage {
        ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: tool_id.to_string(),
                content: content.to_string(),
                is_error: None,
            }],
            usage: None,
            timestamp: ts,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }
    }

    #[test]
    fn user_message_round_trips_text_only() {
        let messages = vec![user_msg("hello", 1)];
        let db = session_to_db_messages(&messages);
        assert_eq!(db.len(), 1);
        assert_eq!(db[0].role, "user");
        assert_eq!(db[0].content, "hello");
        assert!(db[0].tool_calls.is_none());
    }

    #[test]
    fn user_prompt_chips_survive_db_projection() {
        let mut message = user_msg("check @src/main.ts", 1);
        message.attached_prompt_chips =
            Some(vec![crate::agent_runtime::types::AttachedPromptChip {
                kind: "file".into(),
                title: "main.ts".into(),
                value: Some("src/main.ts".into()),
                path: Some("E:/work/src/main.ts".into()),
            }]);
        let db = session_to_db_messages(&[message]);
        let chips = db[0].attached_prompt_chips.as_ref().expect("prompt chips");
        assert_eq!(chips[0].title, "main.ts");
        assert_eq!(chips[0].value.as_deref(), Some("src/main.ts"));
    }

    #[test]
    fn assistant_message_collapses_text_and_thinking() {
        let assistant = ConversationMessage::assistant(
            vec![
                ContentBlock::Thinking {
                    text: "reasoning step".into(),
                    signature: None,
                    duration_ms: Some(7_000),
                },
                ContentBlock::Text {
                    text: "answer".into(),
                },
            ],
            10,
        );
        let db = session_to_db_messages(&[assistant]);
        assert_eq!(db[0].role, "assistant");
        assert_eq!(db[0].content, "answer");
        assert_eq!(db[0].thinking.as_deref(), Some("reasoning step"));
    }

    /// The UI prints "Thought · 7s" from this field. A live turn measures its
    /// own reasoning, so a regression here is invisible until a chat is
    /// REOPENED — at which point the number silently disappears.
    #[test]
    fn reloaded_thinking_segment_carries_its_duration() {
        let assistant = ConversationMessage::assistant(
            vec![ContentBlock::Thinking {
                text: "reasoning step".into(),
                signature: None,
                duration_ms: Some(7_000),
            }],
            10,
        );
        let db = session_to_db_messages(&[assistant]);
        let timeline = db[0].timeline.as_ref().expect("ordered timeline");
        let event = &timeline.as_array().expect("array")[0];
        assert_eq!(event["kind"], "thinking");
        assert_eq!(event["durationMs"], 7_000);
    }

    /// Adjacent reasoning blocks render as ONE segment, so the number has to
    /// describe the whole thing rather than only its last part.
    #[test]
    fn merged_thinking_segments_sum_their_durations() {
        let assistant = ConversationMessage::assistant(
            vec![
                ContentBlock::Thinking {
                    text: "first".into(),
                    signature: None,
                    duration_ms: Some(4_000),
                },
                ContentBlock::Thinking {
                    text: "second".into(),
                    signature: None,
                    duration_ms: Some(3_500),
                },
            ],
            10,
        );
        let db = session_to_db_messages(&[assistant]);
        let timeline = db[0].timeline.as_ref().expect("ordered timeline");
        let events = timeline.as_array().expect("array");
        assert_eq!(events.len(), 1, "adjacent thinking blocks merge");
        assert_eq!(events[0]["durationMs"], 7_500);
    }

    // ── Cost accounting ─────────────────────────────────────────────────

    /// Assistant message with usage attributed to a model.
    fn priced(
        model: Option<&str>,
        input: u32,
        output: u32,
        cache_read: u32,
        cache_write: u32,
        estimated: bool,
    ) -> ConversationMessage {
        let mut m = ConversationMessage::assistant_with_usage(
            vec![ContentBlock::Text { text: "x".into() }],
            crate::agent_runtime::types::TokenUsage {
                input_tokens: input,
                output_tokens: output,
                cache_read_input_tokens: Some(cache_read),
                cache_creation_input_tokens: Some(cache_write),
                estimated: if estimated { Some(true) } else { None },
                cost_usd: None,
            },
            0,
        );
        m.model = model.map(str::to_string);
        m
    }

    /// The reported bug: a turn makes one API request per tool iteration, and
    /// the card showed only the last one. Cost has to cover the whole turn.
    #[test]
    fn a_turn_costs_every_request_it_made_not_just_the_last() {
        let messages = vec![
            user_msg("do the thing", 1),
            priced(Some("openai:gpt-5.6"), 1_000, 500, 0, 0, false),
            priced(Some("openai:gpt-5.6"), 2_000, 300, 0, 0, false),
            priced(Some("openai:gpt-5.6"), 3_000, 200, 0, 0, false),
        ];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.last_turn.len(), 1);
        assert_eq!(out.last_turn[0].input_tokens, 6_000);
        assert_eq!(out.last_turn[0].output_tokens, 1_000);
        assert_eq!(out.last_turn[0].requests, 3);
        assert_eq!(out.turns, 1);
        assert_eq!(out.requests, 3);
    }

    /// A conversation can move between models freely, and their prices differ.
    /// Tokens must stay in separate groups so each is priced with the model
    /// that actually produced it — merging them would misprice both.
    #[test]
    fn a_model_switch_mid_conversation_keeps_the_groups_apart() {
        let messages = vec![
            user_msg("start cheap", 1),
            priced(Some("openai:gpt-5.6-mini"), 1_000, 100, 0, 0, false),
            user_msg("now think hard", 2),
            priced(Some("anthropic:claude-opus-5"), 5_000, 4_000, 0, 0, false),
            priced(Some("anthropic:claude-opus-5"), 6_000, 1_000, 0, 0, false),
            user_msg("back to cheap", 3),
            priced(Some("openai:gpt-5.6-mini"), 2_000, 200, 0, 0, false),
        ];
        let out = usage_breakdown("t", &messages);

        assert_eq!(out.by_model.len(), 2, "one group per model");
        let mini = out
            .by_model
            .iter()
            .find(|g| g.model.as_deref() == Some("openai:gpt-5.6-mini"))
            .expect("mini group");
        let opus = out
            .by_model
            .iter()
            .find(|g| g.model.as_deref() == Some("anthropic:claude-opus-5"))
            .expect("opus group");
        // Non-adjacent requests on the same model fold into ONE group.
        assert_eq!(mini.input_tokens, 3_000);
        assert_eq!(mini.requests, 2);
        assert_eq!(opus.input_tokens, 11_000);
        assert_eq!(opus.output_tokens, 5_000);
        assert_eq!(out.turns, 3);
        assert_eq!(out.requests, 4);

        // The last turn is only the final model's work.
        assert_eq!(out.last_turn.len(), 1);
        assert_eq!(
            out.last_turn[0].model.as_deref(),
            Some("openai:gpt-5.6-mini")
        );
        assert_eq!(out.last_turn[0].input_tokens, 2_000);
    }

    /// Cache tokens are billed. Dropping them (as the old card did for cache
    /// writes) understates the real spend.
    #[test]
    fn cache_read_and_write_tokens_are_carried_separately() {
        let messages = vec![
            user_msg("go", 1),
            priced(Some("m"), 400, 100, 250_000, 12_000, false),
        ];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.by_model[0].cache_read_tokens, 250_000);
        assert_eq!(out.by_model[0].cache_write_tokens, 12_000);
        assert_eq!(
            out.by_model[0].input_tokens, 400,
            "fresh input stays distinct from cached input"
        );
    }

    /// Estimated requests are counted so the UI can mark the total approximate
    /// instead of presenting a guess as a measurement.
    #[test]
    fn estimated_requests_are_counted_within_their_group() {
        let messages = vec![
            user_msg("go", 1),
            priced(Some("ollama:llama"), 100, 50, 0, 0, true),
            priced(Some("ollama:llama"), 200, 60, 0, 0, true),
        ];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.by_model[0].requests, 2);
        assert_eq!(out.by_model[0].estimated_requests, 2);
    }

    /// Requests written before the model was recorded cannot be priced against
    /// any particular model. They get their own group so the UI can disclose
    /// them rather than silently pricing them at today's selection.
    #[test]
    fn unattributed_requests_get_their_own_group() {
        let messages = vec![
            user_msg("go", 1),
            priced(None, 900, 90, 0, 0, false),
            priced(Some("openai:gpt-5.6"), 100, 10, 0, 0, false),
        ];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.by_model.len(), 2);
        let unknown = out
            .by_model
            .iter()
            .find(|g| g.model.is_none())
            .expect("unattributed group");
        assert_eq!(unknown.input_tokens, 900);
    }

    /// Assistant message whose cost the PROVIDER reported.
    fn provider_priced(model: &str, input: u32, output: u32, cost: f64) -> ConversationMessage {
        let mut m = ConversationMessage::assistant_with_usage(
            vec![ContentBlock::Text { text: "x".into() }],
            crate::agent_runtime::types::TokenUsage {
                input_tokens: input,
                output_tokens: output,
                cache_read_input_tokens: None,
                cache_creation_input_tokens: None,
                estimated: None,
                cost_usd: Some(cost),
            },
            0,
        );
        m.model = Some(model.to_string());
        m
    }

    /// A provider-reported cost is the number on the bill. It is summed
    /// verbatim and never re-derived from tokens.
    #[test]
    fn provider_reported_costs_are_summed_verbatim() {
        let messages = vec![
            user_msg("go", 1),
            provider_priced("gw:m", 1_000, 100, 0.0123),
            provider_priced("gw:m", 2_000, 200, 0.0456),
        ];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.by_model.len(), 1);
        let reported = out.by_model[0].reported_cost_usd.expect("reported");
        assert!((reported - 0.0579).abs() < 1e-9, "got {reported}");
        assert_eq!(out.by_model[0].requests, 2);
    }

    /// A conversation can mix a reporting provider with a non-reporting one.
    /// The two must NOT share a group: one is priced from its own dollars and
    /// the other from tokens, and merging them would either double-count the
    /// reported half or silently drop the computed half.
    #[test]
    fn reported_and_computed_requests_never_share_a_group() {
        let messages = vec![
            user_msg("go", 1),
            provider_priced("gw:m", 1_000, 100, 0.05),
            priced(Some("gw:m"), 3_000, 300, 0, 0, false),
        ];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.by_model.len(), 2, "same model, split by cost source");

        let reported = out
            .by_model
            .iter()
            .find(|g| g.reported_cost_usd.is_some())
            .expect("reported group");
        let computed = out
            .by_model
            .iter()
            .find(|g| g.reported_cost_usd.is_none())
            .expect("computed group");

        assert_eq!(reported.requests, 1);
        assert_eq!(computed.requests, 1);
        assert_eq!(
            computed.input_tokens, 3_000,
            "the computed group carries only its own tokens"
        );
        assert_eq!(out.requests, 2);
    }

    /// `cost: 0` is a claim ("this request was free"), not an absence. It must
    /// stay reported rather than falling through to catalog pricing, which
    /// would invent a charge the provider says it did not make.
    #[test]
    fn a_reported_zero_cost_is_kept_as_reported() {
        let messages = vec![user_msg("go", 1), provider_priced("gw:m", 5_000, 500, 0.0)];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.by_model[0].reported_cost_usd, Some(0.0));
    }

    /// Compaction summarizes the whole head of a conversation — often the
    /// largest single request in the thread — and it is a `System` message,
    /// not an assistant reply. Counting only assistant messages hid it.
    #[test]
    fn a_compaction_request_is_counted_toward_the_cost() {
        let mut marker = ConversationMessage {
            role: MessageRole::System,
            blocks: vec![ContentBlock::Compaction {
                summary: "…".into(),
                before_tokens: 100_000,
                after_tokens: 20_000,
                created_at: 0,
            }],
            usage: Some(crate::agent_runtime::types::TokenUsage {
                input_tokens: 90_000,
                output_tokens: 1_200,
                cache_read_input_tokens: None,
                cache_creation_input_tokens: None,
                estimated: None,
                cost_usd: None,
            }),
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: Some("openai:gpt-5.6".into()),
        };
        marker.model = Some("openai:gpt-5.6".into());

        let messages = vec![
            user_msg("go", 1),
            priced(Some("openai:gpt-5.6"), 1_000, 100, 0, 0, false),
            marker,
        ];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.by_model.len(), 1, "same model, one group");
        assert_eq!(
            out.by_model[0].input_tokens, 91_000,
            "the summarization request's input is part of the bill"
        );
        assert_eq!(out.requests, 2);
    }

    /// A turn that died before the provider answered has no cost basis. It
    /// must not inflate the request count, which the UI shows next to a
    /// dollar figure.
    #[test]
    fn messages_without_usage_are_not_counted_as_requests() {
        let mut no_usage = ConversationMessage::assistant(
            vec![ContentBlock::Text {
                text: "partial".into(),
            }],
            0,
        );
        no_usage.model = Some("openai:gpt-5.6".into());
        let messages = vec![user_msg("go", 1), no_usage];
        let out = usage_breakdown("t", &messages);
        assert_eq!(out.requests, 0);
        assert!(out.by_model.is_empty());
        assert_eq!(out.turns, 1);
    }

    /// An empty thread reports zeros rather than failing — the card renders
    /// nothing at all in that state, and a panic here would take the whole
    /// chat load with it.
    #[test]
    fn an_empty_thread_reports_a_zero_breakdown() {
        let out = usage_breakdown("t", &[]);
        assert_eq!(out.turns, 0);
        assert_eq!(out.requests, 0);
        assert!(out.by_model.is_empty());
        assert!(out.last_turn.is_empty());
    }

    /// A session written before `duration_ms` existed must render NO number,
    /// never a zero — "measured as instant" and "never measured" are
    /// different facts and the UI shows them differently.
    #[test]
    fn legacy_thinking_segment_emits_no_duration() {
        let assistant = ConversationMessage::assistant(
            vec![ContentBlock::Thinking {
                text: "old reasoning".into(),
                signature: None,
                duration_ms: None,
            }],
            10,
        );
        let db = session_to_db_messages(&[assistant]);
        let timeline = db[0].timeline.as_ref().expect("ordered timeline");
        assert!(timeline.as_array().expect("array")[0]
            .get("durationMs")
            .is_none());
    }

    #[test]
    fn tool_result_folds_into_prior_assistant_tool_call() {
        let messages = vec![
            user_msg("ls", 1),
            assistant_with_tool("call-1", "list_dir", serde_json::json!({"path": "."}), 2),
            tool_result("call-1", "FILES: a.rs b.rs", 3),
        ];
        let db = session_to_db_messages(&messages);
        // user + assistant only — Tool messages are folded.
        assert_eq!(db.len(), 2);
        let assistant = &db[1];
        let calls = assistant.tool_calls.as_ref().expect("tool_calls present");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "list_dir");
        assert_eq!(calls[0].result.as_deref(), Some("FILES: a.rs b.rs"));
    }

    #[test]
    fn rich_sidecar_overlays_clamped_tool_result() {
        let messages = vec![
            assistant_with_tool(
                "call-1",
                "file_edit",
                serde_json::json!({"path": "a.ts"}),
                1,
            ),
            tool_result(
                "call-1",
                "{\"oldContent\":\"head\\n\\n[truncated 4923 bytes in persisted history]\"}",
                2,
            ),
        ];
        let mut rich = std::collections::HashMap::new();
        rich.insert(
            "call-1".to_string(),
            "{\"oldContent\":\"the full before\",\"newContent\":\"the full after\"}".to_string(),
        );

        let db = session_to_db_messages_rich(&messages, &rich);
        let calls = db[0].tool_calls.as_ref().expect("tool_calls present");
        assert_eq!(
            calls[0].result.as_deref(),
            Some("{\"oldContent\":\"the full before\",\"newContent\":\"the full after\"}"),
        );

        // Without a sidecar entry the clamped copy still renders.
        let plain = session_to_db_messages(&messages);
        let plain_calls = plain[0].tool_calls.as_ref().unwrap();
        assert!(plain_calls[0]
            .result
            .as_deref()
            .unwrap()
            .contains("[truncated 4923 bytes in persisted history]"));
    }

    #[test]
    fn tool_result_error_is_prefixed_in_db_shape() {
        let messages = vec![
            assistant_with_tool("c", "x", serde_json::json!({}), 1),
            ConversationMessage {
                role: MessageRole::Tool,
                blocks: vec![ContentBlock::ToolResult {
                    tool_use_id: "c".into(),
                    content: "boom".into(),
                    is_error: Some(true),
                }],
                usage: None,
                timestamp: 2,
                attached_selected_elements: None,
                attached_prompt_chips: None,
                aurora_context: None,
                model: None,
            },
        ];
        let db = session_to_db_messages(&messages);
        let assistant = &db[0];
        let calls = assistant.tool_calls.as_ref().unwrap();
        assert_eq!(calls[0].result.as_deref(), Some("[error] boom"));
    }

    #[test]
    fn mid_turn_injection_survives_db_and_api_reload_shapes() {
        let tool_message = ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "c".into(),
                    content: "pong".into(),
                    is_error: None,
                },
                ContentBlock::Text {
                    text: "use the returned id".into(),
                },
            ],
            usage: None,
            timestamp: 2,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        };
        let messages = vec![
            assistant_with_tool("c", "ping", serde_json::json!({}), 1),
            tool_message,
        ];

        let db = session_to_db_messages(&messages);
        assert_eq!(db.len(), 2);
        assert_eq!(db[1].role, "assistant");
        let timeline = db[1]
            .timeline
            .as_ref()
            .and_then(|value| value.as_array())
            .expect("injection timeline");
        assert_eq!(timeline[0]["kind"], "user_injection");
        assert_eq!(timeline[0]["text"], "use the returned id");

        let api = session_to_api_messages(&messages);
        assert!(matches!(
            api.last(),
            Some(ApiMessage::User { content }) if content == "use the returned id"
        ));
    }

    /// A steered injection persists the MODEL copy (typed text + directive
    /// block) and the composer chips. The reload row must show only the
    /// typed part, with the chips riding on the timeline event — while the
    /// API view keeps the full model copy.
    #[test]
    fn steered_injection_reloads_display_text_and_chips() {
        use crate::agent_runtime::types::AttachedPromptChip;
        let tool_message = ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "c".into(),
                    content: "pong".into(),
                    is_error: None,
                },
                ContentBlock::Text {
                    text: "check @src/app.ts\n\n<steering_context>\n<project_rules>be careful</project_rules>\n</steering_context>".into(),
                },
            ],
            usage: None,
            timestamp: 2,
            attached_selected_elements: None,
            attached_prompt_chips: Some(vec![AttachedPromptChip {
                kind: "file".into(),
                title: "app.ts".into(),
                value: Some("src/app.ts".into()),
                path: Some("E:/proj/src/app.ts".into()),
            }]),
            model: None,
            aurora_context: None,
        };
        let messages = vec![
            assistant_with_tool("c", "ping", serde_json::json!({}), 1),
            tool_message,
        ];

        let db = session_to_db_messages(&messages);
        let timeline = db[1]
            .timeline
            .as_ref()
            .and_then(|value| value.as_array())
            .expect("injection timeline");
        assert_eq!(timeline[0]["text"], "check @src/app.ts");
        assert_eq!(timeline[0]["chips"][0]["kind"], "file");
        assert_eq!(timeline[0]["chips"][0]["value"], "src/app.ts");

        // The model-facing view keeps the directive block verbatim.
        let api = session_to_api_messages(&messages);
        assert!(matches!(
            api.last(),
            Some(ApiMessage::User { content }) if content.contains("<steering_context>")
        ));
    }

    /// The runtime prepends the mid-turn framing line for the model; the
    /// reload row must show only what the user typed.
    #[test]
    fn injected_row_drops_the_mid_turn_preamble() {
        let framed = format!(
            "{}\nwait, don't run pnpm",
            crate::agent_runtime::session::MID_TURN_PREAMBLE
        );
        let tool_message = ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "c".into(),
                    content: "pong".into(),
                    is_error: None,
                },
                ContentBlock::Text { text: framed },
            ],
            usage: None,
            timestamp: 2,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        };
        let messages = vec![
            assistant_with_tool("c", "ping", serde_json::json!({}), 1),
            tool_message,
        ];
        let db = session_to_db_messages(&messages);
        let timeline = db[1]
            .timeline
            .as_ref()
            .and_then(|value| value.as_array())
            .expect("injection timeline");
        assert_eq!(timeline[0]["text"], "wait, don't run pnpm");

        // The API view keeps the framing — that's what it exists for.
        let api = session_to_api_messages(&messages);
        assert!(matches!(
            api.last(),
            Some(ApiMessage::User { content })
                if content.contains("while your tool calls were running")
        ));
    }

    /// Aurora's note to the model never becomes a row in the person's chat.
    ///
    /// Regression, and one I shipped: the stale-checklist reminder moved out of
    /// a tool result's body into its own text block — correct, a tool result
    /// must carry the tool's output alone — which is the same slot a mid-turn
    /// user message uses. The very next reloaded thread drew
    /// `<aurora_task_reminder>`, angle brackets and all, as a card mid-conversation.
    #[test]
    fn the_checklist_reminder_never_becomes_a_transcript_row() {
        let reminder = format!(
            "{}\nYou have not used the checklist in this conversation.\n</aurora_task_reminder>",
            crate::agent_runtime::conversation::context_injection::CHECKLIST_REMINDER_TAG
        );
        let tool_message = ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "c".into(),
                    content: "pong".into(),
                    is_error: None,
                },
                ContentBlock::Text { text: reminder },
            ],
            usage: None,
            timestamp: 2,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        };
        let messages = vec![
            assistant_with_tool("c", "ping", serde_json::json!({}), 1),
            tool_message,
        ];
        let db = session_to_db_messages(&messages);
        // No row, and no message to hold one: a tool message whose only text
        // block is a runtime note contributes nothing to the transcript beyond
        // the tool result it already folded into the assistant above it.
        assert_eq!(db.len(), 1, "no extra transcript message: {db:?}");
        assert!(
            !format!("{:?}", db[0].timeline).contains("aurora_task_reminder"),
            "the reminder must appear nowhere in the timeline: {:?}",
            db[0].timeline
        );

        // The MODEL still gets it — this is a display filter, not a deletion.
        // Stripping it from the API view would restart the ten-turn cadence on
        // every reload and nag someone who was already reminded.
        let api = session_to_api_messages(&messages);
        assert!(
            matches!(api.last(), Some(ApiMessage::User { content }) if content.contains("aurora_task_reminder")),
            "the reminder must survive into the API view"
        );
    }

    /// A real mid-turn message riding beside a reminder still shows. The filter
    /// is per BLOCK, so one runtime note must not silence what a person typed.
    #[test]
    fn a_reminder_beside_a_typed_message_hides_only_the_reminder() {
        let tool_message = ConversationMessage {
            role: MessageRole::Tool,
            blocks: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "c".into(),
                    content: "pong".into(),
                    is_error: None,
                },
                ContentBlock::Text {
                    text: format!(
                        "{}\nlist as it stands\n</aurora_task_reminder>",
                        crate::agent_runtime::conversation::context_injection::CHECKLIST_REMINDER_TAG
                    ),
                },
                ContentBlock::Text {
                    text: format!(
                        "{}\nstop, wrong folder",
                        crate::agent_runtime::session::MID_TURN_PREAMBLE
                    ),
                },
            ],
            usage: None,
            timestamp: 2,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        };
        let messages = vec![
            assistant_with_tool("c", "ping", serde_json::json!({}), 1),
            tool_message,
        ];
        let db = session_to_db_messages(&messages);
        let timeline = db[1]
            .timeline
            .as_ref()
            .and_then(|value| value.as_array())
            .expect("the typed message still has a row");
        assert_eq!(timeline.len(), 1, "exactly one row: {timeline:?}");
        assert_eq!(timeline[0]["text"], "stop, wrong folder");
    }

    #[test]
    fn strip_steering_context_variants() {
        assert_eq!(strip_steering_context("plain note"), "plain note");
        assert_eq!(
            strip_steering_context("note\n\n<steering_context>\nrules\n</steering_context>"),
            "note"
        );
        assert_eq!(
            strip_steering_context("<steering_context>rules</steering_context>\n\ntail"),
            "tail"
        );
        assert_eq!(
            strip_steering_context("a\n<steering_context>x</steering_context>\nb"),
            "a\n\nb"
        );
        // Malformed half-tags pass through rather than eating words.
        assert_eq!(
            strip_steering_context("note <steering_context> unclosed"),
            "note <steering_context> unclosed"
        );
    }

    #[test]
    fn api_history_emits_role_tagged_messages() {
        let messages = vec![
            user_msg("hi", 1),
            assistant_text("hello", 2),
            assistant_with_tool("c", "ping", serde_json::json!({}), 3),
            tool_result("c", "pong", 4),
        ];
        let api = session_to_api_messages(&messages);
        assert_eq!(
            api.len(),
            4,
            "user / assistant text / assistant tool_use / tool result"
        );
        match &api[0] {
            ApiMessage::User { content } => assert_eq!(content, "hi"),
            other => panic!("expected user, got {other:?}"),
        }
        match &api[3] {
            ApiMessage::Tool {
                tool_call_id,
                content,
            } => {
                assert_eq!(tool_call_id, "c");
                assert_eq!(content, "pong");
            }
            other => panic!("expected tool, got {other:?}"),
        }
    }

    #[test]
    fn api_history_skips_empty_assistant_messages() {
        let messages = vec![ConversationMessage::assistant(vec![], 1)];
        let api = session_to_api_messages(&messages);
        assert!(api.is_empty(), "empty assistant blocks should be skipped");
    }

    #[test]
    fn token_meta_round_trips_through_db_shape() {
        let original = TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            estimated: Some(true),
        };
        let meta = db_token_to_meta(&original);
        let back = meta_to_db_token(&meta);
        assert_eq!(back.prompt_tokens, 100);
        assert_eq!(back.completion_tokens, 50);
        assert_eq!(back.total_tokens, 150);
        assert_eq!(back.estimated, Some(true));

        // Use the runtime-side TokenUsage just to make sure the
        // metadata layer doesn't accidentally collide with it.
        let _ = RuntimeTokenUsage::default();
    }

    #[test]
    fn synthetic_message_id_is_deterministic() {
        let id1 = synthetic_message_id("user", 42, 0);
        let id2 = synthetic_message_id("user", 42, 0);
        assert_eq!(id1, id2);
        assert_ne!(synthetic_message_id("user", 42, 1), id1);
    }

    /// Read the `kind` of every event in a reloaded message's timeline.
    fn timeline_kinds(message: &Message) -> Vec<String> {
        message
            .timeline
            .as_ref()
            .and_then(|value| value.as_array())
            .expect("assistant messages carry an ordered timeline")
            .iter()
            .map(|event| event["kind"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn a_reloaded_turn_keeps_the_order_the_model_emitted() {
        // The whole point: a real turn interleaves. Before this, reload
        // flattened every turn to thinking → content → all tools, so anything
        // positional landed somewhere the model never put it.
        let messages = vec![ConversationMessage::assistant(
            vec![
                ContentBlock::Thinking {
                    text: "let me look".into(),
                    signature: None,
                    duration_ms: None,
                },
                ContentBlock::Text {
                    text: "Reading the hook first.".into(),
                },
                ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "file_read".into(),
                    input: serde_json::json!({"path": "a.ts"}),
                },
                ContentBlock::Text {
                    text: "Now the fix.".into(),
                },
                ContentBlock::ToolUse {
                    id: "t2".into(),
                    name: "search_replace".into(),
                    input: serde_json::json!({"path": "a.ts"}),
                },
            ],
            1,
        )];

        let db = session_to_db_messages(&messages);
        assert_eq!(
            timeline_kinds(&db[0]),
            vec!["thinking", "content", "tool", "content", "tool"],
        );
    }

    #[test]
    fn a_reloaded_tool_event_carries_only_its_id() {
        // Order lives in the timeline, the payload lives in `tool_calls`. Two
        // copies of the call would be two truths that can drift apart.
        let messages = vec![assistant_with_tool(
            "c",
            "ping",
            serde_json::json!({"x": 1}),
            1,
        )];

        let db = session_to_db_messages(&messages);
        let events = db[0].timeline.as_ref().unwrap().as_array().unwrap();
        let tool = events.iter().find(|e| e["kind"] == "tool").expect("tool");

        assert_eq!(tool["id"], "c");
        assert!(
            tool.get("call").is_none(),
            "the call is not duplicated here"
        );
        assert!(tool.get("name").is_none(), "nor is its name");

        let calls = db[0].tool_calls.as_ref().expect("tool_calls");
        assert_eq!(calls[0].id, "c");
        assert_eq!(calls[0].name, "ping");
        assert_eq!(calls[0].arguments, r#"{"x":1}"#);
    }

    #[test]
    fn adjacent_text_blocks_merge_into_one_segment() {
        // Otherwise a reply split across blocks reloads as separate paragraphs
        // that a tool row can slot between — mid-sentence.
        let messages = vec![ConversationMessage::assistant(
            vec![
                ContentBlock::Text { text: "one".into() },
                ContentBlock::Text { text: "two".into() },
                ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "grep".into(),
                    input: serde_json::json!({}),
                },
            ],
            1,
        )];

        let db = session_to_db_messages(&messages);
        assert_eq!(timeline_kinds(&db[0]), vec!["content", "tool"]);
        let events = db[0].timeline.as_ref().unwrap().as_array().unwrap();
        assert_eq!(events[0]["text"], "one\ntwo");
        assert_eq!(db[0].content, "one\ntwo", "content stays the joined prose");
    }

    #[test]
    fn empty_text_blocks_do_not_become_blank_segments() {
        let messages = vec![ConversationMessage::assistant(
            vec![
                ContentBlock::Text {
                    text: String::new(),
                },
                ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "grep".into(),
                    input: serde_json::json!({}),
                },
            ],
            1,
        )];

        assert_eq!(
            timeline_kinds(&session_to_db_messages(&messages)[0]),
            vec!["tool"]
        );
    }

    #[test]
    fn a_result_reaches_the_call_the_timeline_points_at() {
        // The timeline references by id, so folding the result into
        // `tool_calls` is enough for the reloaded card to render it.
        let messages = vec![
            assistant_with_tool("c", "ping", serde_json::json!({}), 1),
            tool_result("c", "pong", 2),
        ];

        let db = session_to_db_messages(&messages);
        let events = db[0].timeline.as_ref().unwrap().as_array().unwrap();
        let referenced = events
            .iter()
            .find(|e| e["kind"] == "tool")
            .and_then(|e| e["id"].as_str())
            .expect("tool event");
        let call = db[0]
            .tool_calls
            .as_ref()
            .unwrap()
            .iter()
            .find(|c| c.id == referenced)
            .expect("the referenced call exists");

        assert_eq!(call.result.as_deref(), Some("pong"));
    }

    #[test]
    fn a_message_with_no_renderable_blocks_has_no_timeline() {
        // `None` keeps the frontend on its synthesis fallback rather than
        // handing it an empty array to render.
        let messages = vec![ConversationMessage::assistant(vec![], 1)];
        assert!(session_to_db_messages(&messages)[0].timeline.is_none());
    }

    // ------------------------------------------------------------------
    // Which store a command acts on
    //
    // Aurora has two conversation stores and almost every command here is
    // handed only a thread id. Resolving the wrong one does not fail loudly —
    // it reads, renames, or DELETES in the wrong place — so the resolution is
    // pinned rather than trusted.
    // ------------------------------------------------------------------

    fn two_stores() -> (tempfile::TempDir, SessionStore, SessionStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let build = SessionStore::new(dir.path().join("sessions"));
        let chat = SessionStore::new_folder(dir.path().join("Chats"));
        (dir, build, chat)
    }

    /// Mirrors `store_for_thread`'s rule without needing a Tauri `State`.
    fn resolve<'a>(
        build: &'a SessionStore,
        chat: &'a SessionStore,
        thread_id: &str,
    ) -> &'a SessionStore {
        if chat.exists(thread_id) {
            chat
        } else {
            build
        }
    }

    #[test]
    fn a_chat_conversation_resolves_to_the_chat_store() {
        let (_g, build, chat) = two_stores();
        chat.ensure_thread("c1", Some("a chat".into()), None).unwrap();

        let resolved = resolve(&build, &chat, "c1");
        assert_eq!(resolved.dir(), chat.dir());
        assert_eq!(resolved.load_metadata("c1").unwrap().title, "a chat");
    }

    #[test]
    fn a_build_conversation_resolves_to_the_build_store() {
        let (_g, build, chat) = two_stores();
        build
            .ensure_thread("b1", Some("a build thread".into()), None)
            .unwrap();

        let resolved = resolve(&build, &chat, "b1");
        assert_eq!(resolved.dir(), build.dir());
        assert_eq!(
            resolved.load_metadata("b1").unwrap().title,
            "a build thread"
        );
    }

    /// A conversation that exists in neither is a brand-new one, and every
    /// existing caller means Build by it. Chat's own creation path is told
    /// explicitly instead (`thread_create`'s `surface`).
    #[test]
    fn an_unknown_id_resolves_to_build() {
        let (_g, build, chat) = two_stores();
        assert_eq!(resolve(&build, &chat, "never-existed").dir(), build.dir());
    }

    /// The failure this whole design avoids: deleting a chat by id must not
    /// reach into Build, and vice versa. Ids are UUIDs so a real collision
    /// cannot happen — this proves the resolution, not the id space.
    #[test]
    fn resolving_never_crosses_between_the_two_stores() {
        let (_g, build, chat) = two_stores();
        build.ensure_thread("b1", Some("build".into()), None).unwrap();
        chat.ensure_thread("c1", Some("chat".into()), None).unwrap();

        resolve(&build, &chat, "c1").delete("c1").unwrap();

        assert!(chat.list_summaries().unwrap().is_empty(), "the chat is gone");
        assert_eq!(
            build.list_summaries().unwrap().len(),
            1,
            "the build thread was not touched"
        );
    }
}
