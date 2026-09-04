//! `recall` and `remember` — Aurora Chat's memory, as the model sees it.
//!
//! ## Two tools, not five
//!
//! Searching past conversations, reading one back, pulling an exact passage out
//! of one, and searching remembered facts are four questions with one shape:
//! "find me something I already have". They are one tool with a typed `op`.
//!
//! Aurora learned this from `todo`, which shipped as `todo_write` /
//! `todo_update` / `todo_read` and was folded into one. Three names for one
//! piece of state made the model choose before it could act, and every one of
//! them spoke the same vocabulary of ids and positions. The same is true here.
//!
//! `remember` is separate because it is the only one that WRITES, and because
//! reading and writing memory are genuinely different acts.
//!
//! ## Escalation is the point
//!
//! `search` is cheap and answers most questions. It returns a conversation id
//! with every hit, which is the handle for `read` and `section` when it did
//! not. A model that always went deep would cost more per answer than the
//! answer is worth; a model that could only search would be stuck the moment a
//! snippet was not enough.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use crate::chat_memory::{facts::INJECTED_FACT_COUNT, ChatMemory};

pub const TOOL_NAMES: &[&str] = &["recall", "remember"];

/// Results per `search` / `facts` call when the model does not say.
const DEFAULT_LIMIT: usize = 8;
/// Ceiling on any one call. A recall that returns fifty snippets has not
/// answered a question, it has moved the searching into the model's context.
const MAX_LIMIT: usize = 25;
/// Messages per `read` page.
const DEFAULT_PAGE: usize = 20;

fn memory() -> Result<&'static ChatMemory, ToolError> {
    crate::chat_memory::service().ok_or_else(|| {
        ToolError::Execution(
            "Aurora's chat memory is unavailable — the index could not be opened. Past \
conversations cannot be searched until Aurora restarts."
                .into(),
        )
    })
}

fn clamp_limit(input: &Value) -> usize {
    input
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| (value as usize).clamp(1, MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT)
}

pub struct RecallTool;

#[async_trait]
impl ToolExecutor for RecallTool {
    fn name(&self) -> &str {
        "recall"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "recall".into(),
            description: "Search everything you and the user have discussed before, and everything \
you have remembered about them.

Use it whenever the user refers to something from earlier that is not in front of you — \"the thing \
we worked out last week\", \"that article I sent you\", \"what did I say I preferred\". Go and look \
instead of saying you do not recall.

Four operations, cheapest first:

- `op: \"search\"` (the default) — a query across every past conversation. Returns ranked snippets, \
each with the conversation's id, title and date. Start here.
- `op: \"facts\"` — search what you have remembered about the user specifically, rather than what \
was said.
- `op: \"read\"` — one whole conversation by `chatId`, a page at a time. Use `offset` to continue.
- `op: \"section\"` — the exact messages between `fromSeq` and `toSeq` of one conversation, in full \
rather than as snippets.

The intended path is `search` first. Its hits carry the `chatId` and the `seq` of the message, so \
when a snippet is not enough you already hold what `read` and `section` need — search again only \
for a different question.

This reaches Aurora Chat conversations only. It cannot see the user's coding work in Aurora Build."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": ["search", "facts", "read", "section"],
                        "description": "Defaults to 'search'."
                    },
                    "query": {
                        "type": "string",
                        "description": "What to look for. Required for 'search' and 'facts'. \
Plain words — punctuation and operators are ignored, so ask it the way you would ask a person."
                    },
                    "chatId": {
                        "type": "string",
                        "description": "Which conversation. Required for 'read' and 'section'; \
comes from a 'search' hit."
                    },
                    "offset": {
                        "type": "number",
                        "description": "For 'read': how many messages to skip. Continue a page by \
passing the previous offset plus the number returned."
                    },
                    "fromSeq": {
                        "type": "number",
                        "description": "For 'section': first message position, inclusive."
                    },
                    "toSeq": {
                        "type": "number",
                        "description": "For 'section': last message position, inclusive."
                    },
                    "limit": {
                        "type": "number",
                        "description": "Results to return. Defaults to 8, capped at 25."
                    }
                }
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        run_recall(memory()?, &input)
    }
}

/// `recall`'s whole behaviour, against a memory handed in.
///
/// Split from `execute` so it can be tested against an in-memory database.
/// Reaching the process-wide service from a test would create and write to the
/// user's REAL `%LOCALAPPDATA%\AuroraIDE\Chats`, which is not a thing a test
/// suite may do.
pub(crate) fn run_recall(memory: &ChatMemory, input: &Value) -> Result<String, ToolError> {
    {
        let op = input.get("op").and_then(Value::as_str).unwrap_or("search");

        let query = || -> Result<String, ToolError> {
            input
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!("`query` is required for op '{op}'."))
                })
        };
        let chat_id = || -> Result<String, ToolError> {
            input
                .get("chatId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!(
                        "`chatId` is required for op '{op}'. It comes back with every search hit."
                    ))
                })
        };

        let payload = match op {
            "search" => {
                let hits = memory
                    .search_messages(&query()?, clamp_limit(&input))
                    .map_err(|err| ToolError::Execution(format!("recall failed: {err}")))?;
                // An empty result is stated plainly rather than returned as an
                // empty array. "Nothing found" is an answer; `[]` invites the
                // model to try three more phrasings of the same query.
                if hits.is_empty() {
                    json!({
                        "op": "search",
                        "found": 0,
                        "note": "Nothing in past conversations matches that. Say so rather than \
guessing, and do not retry with a reworded version of the same query."
                    })
                } else {
                    json!({ "op": "search", "found": hits.len(), "hits": hits })
                }
            }
            "facts" => {
                let facts = memory
                    .search_facts(&query()?, clamp_limit(&input))
                    .map_err(|err| ToolError::Execution(format!("recall failed: {err}")))?;
                json!({ "op": "facts", "found": facts.len(), "facts": facts })
            }
            "read" => {
                let id = chat_id()?;
                if !memory
                    .chat_exists(&id)
                    .map_err(|err| ToolError::Execution(format!("recall failed: {err}")))?
                {
                    return Err(ToolError::InvalidInput(format!(
                        "No conversation with id '{id}'. Use op 'search' to find one."
                    )));
                }
                let offset = input
                    .get("offset")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let limit = input
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| (value as usize).clamp(1, MAX_LIMIT))
                    .unwrap_or(DEFAULT_PAGE);
                // One MORE than asked for, so "is there another page" is
                // answered exactly rather than guessed.
                //
                // The obvious version — "a full page means there is more" — is
                // wrong precisely when the conversation's length is a multiple
                // of the page size, which is not a rare case at a page size of
                // 20. It advertised a page that did not exist and the model
                // spent a call finding out. Reading one extra row costs
                // nothing and is never wrong.
                let mut messages = memory
                    .read_chat(&id, offset, limit + 1)
                    .map_err(|err| ToolError::Execution(format!("recall failed: {err}")))?;
                let has_more = messages.len() > limit;
                messages.truncate(limit);
                let next = has_more.then_some(offset + messages.len());
                json!({
                    "op": "read",
                    "chatId": id,
                    "offset": offset,
                    "returned": messages.len(),
                    "nextOffset": next,
                    "messages": messages
                })
            }
            "section" => {
                let id = chat_id()?;
                let from = input.get("fromSeq").and_then(Value::as_i64).ok_or_else(|| {
                    ToolError::InvalidInput("`fromSeq` is required for op 'section'.".into())
                })?;
                let to = input.get("toSeq").and_then(Value::as_i64).unwrap_or(from);
                let messages = memory
                    .read_section(&id, from, to)
                    .map_err(|err| ToolError::Execution(format!("recall failed: {err}")))?;
                json!({
                    "op": "section",
                    "chatId": id,
                    "returned": messages.len(),
                    "messages": messages
                })
            }
            other => {
                return Err(ToolError::InvalidInput(format!(
                    "Unknown op '{other}'. Use 'search', 'facts', 'read' or 'section'."
                )))
            }
        };

        serde_json::to_string(&payload)
            .map_err(|err| ToolError::Execution(format!("could not serialize recall: {err}")))
    }
}

pub struct RememberTool;


#[async_trait]
impl ToolExecutor for RememberTool {
    fn name(&self) -> &str {
        "remember"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "remember".into(),
            description: format!(
                "Save something durable you have learned about the user, so it is still known in \
later conversations.

Call it when you learn something that will still be true next week and that would change how you \
answer: what they are building, how they want to be spoken to, a preference they have stated, a \
constraint they work under, a decision they have made.

Do NOT save the conversation. Anything you could find again with `recall` does not belong here — \
this is for the handful of things worth knowing before a conversation starts, not a log of what \
happened in one.

Write one fact per call, as a complete sentence that will still make sense on its own in six \
months. \"Prefers plain language over jargon\" is a fact. \"Said the thing about the report\" is \
not.

Saving the same fact twice updates the existing one rather than adding a copy, so restating \
something is harmless. The user sees everything you save, and can edit, pin or delete any of it. \
The {INJECTED_FACT_COUNT} most relevant facts are shown to you at the start of every conversation \
without you asking."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "fact": {
                        "type": "string",
                        "description": "One durable fact about the user, as a complete sentence."
                    }
                },
                "required": ["fact"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        run_remember(memory()?, &input, &ctx.thread_id)
    }
}

/// `remember`'s whole behaviour, against a memory handed in. See
/// [`run_recall`] for why this is split out.
pub(crate) fn run_remember(
    memory: &ChatMemory,
    input: &Value,
    thread_id: &str,
) -> Result<String, ToolError> {
    {
        let fact = input
            .get("fact")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`fact` is required: one durable thing about the user, as a sentence.".into(),
                )
            })?;

        let stored = memory
            .remember(fact, Some(thread_id))
            .map_err(|err| ToolError::Execution(format!("could not save that: {err}")))?;

        let payload = match stored {
            Some(fact) => json!({ "saved": true, "id": fact.id, "fact": fact.text }),
            None => json!({
                "saved": false,
                "note": "Nothing was saved — the fact was empty once trimmed."
            }),
        };
        serde_json::to_string(&payload)
            .map_err(|err| ToolError::Execution(format!("could not serialize result: {err}")))
    }
}

pub fn register(reg: &mut ToolRegistry) {
    reg.register(Arc::new(RecallTool));
    reg.register(Arc::new(RememberTool));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::session_store::SessionStore;

    /// A memory with two conversations in it, indexed from real folders — so
    /// these exercise the same path a live turn does.
    fn seeded() -> (tempfile::TempDir, ChatMemory) {
        use crate::agent_runtime::session::Session;
        use crate::agent_runtime::types::{ContentBlock, ConversationMessage};

        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new_folder(dir.path().join("Chats"));
        let memory = ChatMemory::in_memory().unwrap();

        let chats: [(&str, &str, &[(&str, &str)]); 2] = [
            (
                "c1",
                "Steel tariffs",
                &[
                    ("user", "what are the tariffs on imported steel"),
                    ("assistant", "The rate is 25 percent as of 2026"),
                    ("user", "and aluminium"),
                    ("assistant", "Aluminium sits at 10 percent"),
                ],
            ),
            ("c2", "Kitchen", &[("user", "the kitchen tap drips")]),
        ];
        for (id, title, messages) in chats {
            store.ensure_thread(id, Some(title.to_string()), None).unwrap();
            let mut session = Session::new(id);
            for (index, (role, text)) in messages.iter().enumerate() {
                let ts = 1_788_000_000_000 + index as i64;
                session.append_message(match *role {
                    "user" => ConversationMessage::user_text(*text, ts),
                    _ => ConversationMessage::assistant(
                        vec![ContentBlock::Text {
                            text: (*text).to_string(),
                        }],
                        ts,
                    ),
                });
            }
            session.save_to_path(store.session_path(id)).unwrap();
            memory.index_chat(&store, id).unwrap();
        }
        (dir, memory)
    }

    fn recall(memory: &ChatMemory, input: Value) -> Value {
        let raw = run_recall(memory, &input).expect("recall succeeded");
        serde_json::from_str(&raw).expect("valid json")
    }

    #[test]
    fn search_is_the_default_operation() {
        let (_g, memory) = seeded();
        // No `op` at all — the model should not have to name the common case.
        let out = recall(&memory, json!({ "query": "aluminium" }));
        assert_eq!(out["op"], "search");
        assert!(out["found"].as_u64().unwrap() >= 1);
    }

    /// Every hit carries the handle for going deeper. This is what makes the
    /// escalation work without a second search.
    #[test]
    fn a_hit_carries_the_conversation_id_and_position() {
        let (_g, memory) = seeded();
        let out = recall(&memory, json!({ "op": "search", "query": "aluminium" }));
        let hit = &out["hits"][0];
        assert_eq!(hit["chatId"], "c1");
        assert_eq!(hit["chatTitle"], "Steel tariffs");
        assert!(hit["seq"].is_number());
        assert!(!hit["snippet"].as_str().unwrap().is_empty());
    }

    /// An empty result is a sentence, not `[]`. A bare empty array invites the
    /// model to try three rewordings of a query that already had no answer.
    #[test]
    fn nothing_found_says_so_in_words() {
        let (_g, memory) = seeded();
        let out = recall(&memory, json!({ "query": "submarines" }));
        assert_eq!(out["found"], 0);
        let note = out["note"].as_str().unwrap();
        assert!(note.contains("Nothing"));
        assert!(note.contains("do not retry"), "it must discourage rewording");
    }

    #[test]
    fn reading_a_conversation_pages_and_reports_where_to_continue() {
        let (_g, memory) = seeded();
        let first = recall(&memory, json!({ "op": "read", "chatId": "c1", "limit": 2 }));
        assert_eq!(first["returned"], 2);
        assert_eq!(first["nextOffset"], 2);

        let second = recall(
            &memory,
            json!({ "op": "read", "chatId": "c1", "offset": 2, "limit": 2 }),
        );
        assert_eq!(second["returned"], 2);
        // c1 has exactly 4 messages, so this page is full AND final. Guessing
        // from "the page was full" advertises a fifth message that does not
        // exist — which is the bug this test caught.
        assert!(
            second["nextOffset"].is_null(),
            "a full LAST page must not advertise another one"
        );
    }

    /// The same boundary from the other side: a conversation longer than the
    /// page really does report more.
    #[test]
    fn a_page_with_more_behind_it_reports_where_to_continue() {
        let (_g, memory) = seeded();
        let out = recall(&memory, json!({ "op": "read", "chatId": "c1", "limit": 3 }));
        assert_eq!(out["returned"], 3);
        assert_eq!(out["nextOffset"], 3);
    }

    #[test]
    fn a_section_returns_full_text_rather_than_snippets() {
        let (_g, memory) = seeded();
        let out = recall(
            &memory,
            json!({ "op": "section", "chatId": "c1", "fromSeq": 1, "toSeq": 1 }),
        );
        assert_eq!(out["returned"], 1);
        let text = out["messages"][0]["text"].as_str().unwrap();
        assert!(text.contains("25 percent"));
        assert!(!text.ends_with('…'), "a section is not clipped");
    }

    #[test]
    fn a_section_with_only_a_start_returns_that_one_message() {
        let (_g, memory) = seeded();
        let out = recall(&memory, json!({ "op": "section", "chatId": "c1", "fromSeq": 0 }));
        assert_eq!(out["returned"], 1);
    }

    #[test]
    fn facts_are_searchable_through_the_same_tool() {
        let (_g, memory) = seeded();
        memory.remember("Alvan prefers plain language", Some("c1")).unwrap();
        let out = recall(&memory, json!({ "op": "facts", "query": "language" }));
        assert_eq!(out["op"], "facts");
        assert_eq!(out["found"], 1);
    }

    #[test]
    fn a_missing_conversation_is_named_rather_than_returning_nothing() {
        let (_g, memory) = seeded();
        let err = run_recall(&memory, &json!({ "op": "read", "chatId": "nope" }))
            .expect_err("must not pretend an unknown chat is empty");
        assert!(format!("{err}").contains("nope"));
    }

    #[test]
    fn missing_arguments_say_which_one_and_for_which_op() {
        let (_g, memory) = seeded();
        for (input, expected) in [
            (json!({ "op": "search" }), "query"),
            (json!({ "op": "facts" }), "query"),
            (json!({ "op": "read" }), "chatId"),
            (json!({ "op": "section", "chatId": "c1" }), "fromSeq"),
        ] {
            let err = run_recall(&memory, &input).expect_err("must reject");
            assert!(
                format!("{err}").contains(expected),
                "{input} should have named {expected}"
            );
        }
    }

    #[test]
    fn an_unknown_op_lists_the_real_ones() {
        let (_g, memory) = seeded();
        let err = run_recall(&memory, &json!({ "op": "delete", "query": "x" }))
            .expect_err("must reject");
        let message = format!("{err}");
        for op in ["search", "facts", "read", "section"] {
            assert!(message.contains(op), "the error should name '{op}'");
        }
    }

    /// A model asking for fifty results has moved the searching into its own
    /// context rather than answering a question.
    #[test]
    fn the_result_count_is_capped() {
        let (_g, memory) = seeded();
        let out = recall(
            &memory,
            json!({ "op": "search", "query": "percent", "limit": 5000 }),
        );
        assert!(out["hits"].as_array().unwrap().len() <= MAX_LIMIT);
    }

    #[test]
    fn a_query_that_is_all_punctuation_returns_nothing_rather_than_failing() {
        let (_g, memory) = seeded();
        let out = recall(&memory, json!({ "query": "???" }));
        assert_eq!(out["found"], 0);
    }

    // ── remember ──────────────────────────────────────────────────────

    fn remember(memory: &ChatMemory, fact: &str) -> Value {
        let raw = run_remember(memory, &json!({ "fact": fact }), "c1").expect("remember succeeded");
        serde_json::from_str(&raw).expect("valid json")
    }

    #[test]
    fn remembering_saves_and_confirms() {
        let (_g, memory) = seeded();
        let out = remember(&memory, "Alvan is building Aurora");
        assert_eq!(out["saved"], true);
        assert!(!out["id"].as_str().unwrap().is_empty());
        assert_eq!(memory.all_facts().unwrap().len(), 1);
    }

    #[test]
    fn remembering_records_which_conversation_taught_it() {
        let (_g, memory) = seeded();
        remember(&memory, "Alvan is building Aurora");
        assert_eq!(
            memory.all_facts().unwrap()[0].source_chat_id.as_deref(),
            Some("c1")
        );
    }

    #[test]
    fn remembering_the_same_thing_twice_does_not_add_a_copy() {
        let (_g, memory) = seeded();
        remember(&memory, "Alvan prefers plain language");
        remember(&memory, "Alvan prefers plain language");
        assert_eq!(memory.all_facts().unwrap().len(), 1);
    }

    #[test]
    fn an_empty_fact_is_refused_with_a_reason() {
        let (_g, memory) = seeded();
        let err = run_remember(&memory, &json!({ "fact": "   " }), "c1")
            .expect_err("must reject");
        assert!(format!("{err}").contains("fact"));
        let err = run_remember(&memory, &json!({}), "c1").expect_err("must reject");
        assert!(format!("{err}").contains("fact"));
    }

    #[test]
    fn a_remembered_fact_is_immediately_findable() {
        let (_g, memory) = seeded();
        remember(&memory, "Alvan works on Windows 11");
        let out = recall(&memory, json!({ "op": "facts", "query": "windows" }));
        assert_eq!(out["found"], 1);
    }
}
