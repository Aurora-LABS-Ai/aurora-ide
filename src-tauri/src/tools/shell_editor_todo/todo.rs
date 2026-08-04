//! `todo` — the agent's working checklist, as ONE tool with a typed operation.
//!
//! This replaces the former `todo_write` / `todo_update` / `todo_read` trio.
//! Three tool names for one piece of state cost the model a choice on every
//! call and cost the roster three slots, and the split was not carrying its
//! weight: the shared vocabulary (ids, statuses, the cursor) was identical in
//! all three, and the only real difference was which fields were required.
//! `op` names the intent explicitly, so the schema stays a discriminated union
//! rather than a bag of optional fields whose combination decides the action.
//!
//! Operations:
//!   * `set`    — replace the list. Ids carry forward by `content`, so a resend
//!                cannot re-map statuses onto the wrong task.
//!   * `update` — flip ONE item by id, without resending the rest.
//!   * `read`   — recover the list and the cursor from disk.
//!
//! Todos are independent of plans by design: a plan carries the coarse phases
//! the user approved, a todo list carries the concrete steps of the phase being
//! executed. See [`super::todo_store`] for why an earlier "a plan takes over the
//! todo tools" rule was removed.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::ide_event_sink::IdeEventSink;
use super::todo_store::{self, TodoItem, TodoList, TodoStatus};

pub struct TodoTool {
    sink: Arc<dyn IdeEventSink>,
}

impl TodoTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

/// The three things this tool can do. Parsed up front so an unknown `op` fails
/// with the list of valid ones rather than falling through to a confusing
/// missing-field error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Set,
    Update,
    Read,
}

impl Op {
    fn parse(raw: &str) -> Result<Self, ToolError> {
        match raw {
            "set" => Ok(Self::Set),
            "update" => Ok(Self::Update),
            "read" => Ok(Self::Read),
            other => Err(ToolError::InvalidInput(format!(
                "`op` must be one of [set, update, read], got `{other}`"
            ))),
        }
    }
}

/// Build the new list, carrying ids forward so a re-send cannot re-map statuses
/// onto the wrong task.
///
/// An explicit `id` wins. Otherwise an item is matched to an existing one by
/// its imperative `content`, which is what the model naturally keeps stable
/// across calls.
fn build_list(input: &[Value], existing: &TodoList) -> Result<TodoList, ToolError> {
    let mut out = TodoList::default();
    let mut claimed: Vec<String> = Vec::new();

    for (idx, entry) in input.iter().enumerate() {
        let obj = entry
            .as_object()
            .ok_or_else(|| ToolError::InvalidInput(format!("todos[{idx}] must be an object")))?;
        let field = |name: &str| -> Result<String, ToolError> {
            obj.get(name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!(
                        "todos[{idx}].{name} must be a non-empty string"
                    ))
                })
        };
        let content = field("content")?;
        let active_form = field("activeForm")?;
        let status = TodoStatus::parse(
            obj.get("status")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::InvalidInput(format!("todos[{idx}].status must be a string"))
                })?,
        )
        .map_err(|e| ToolError::InvalidInput(format!("todos[{idx}]: {e}")))?;

        let explicit = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let id = explicit
            .filter(|id| existing.item(id).is_some())
            .or_else(|| {
                existing
                    .items
                    .iter()
                    .find(|i| i.content == content && !claimed.contains(&i.id))
                    .map(|i| i.id.clone())
            })
            .unwrap_or_else(|| out.next_id());
        claimed.push(id.clone());

        out.items.push(TodoItem {
            id,
            content,
            active_form,
            status,
        });
    }
    Ok(out)
}

/// Name a task by its title, never by its id alone. This string is read by the
/// model, and "Marked t2 as completed; next up is t3" says nothing about what
/// actually happened.
fn titled(list: &TodoList, id: &str) -> String {
    list.item(id)
        .map(|i| format!("\"{}\" ({})", i.content, i.id))
        .unwrap_or_else(|| id.to_string())
}

/// "So what do I do now" — the same sentence shape for every operation, so the
/// model reads one consistent answer whether it just wrote the list or is
/// recovering it after a compaction.
fn whats_next(list: &TodoList) -> String {
    let cursor = list.cursor();
    if list.items.is_empty() {
        return "No tasks are being tracked for this conversation.".to_string();
    }
    if cursor.complete {
        return "Every task is closed.".to_string();
    }
    match (&cursor.active_id, &cursor.next_id) {
        (Some(active), _) => format!("Now working on {}.", titled(list, active)),
        (None, Some(next)) => format!(
            "Nothing is in progress — mark {} in_progress when you start it.",
            titled(list, next)
        ),
        (None, None) => "Nothing left to start.".to_string(),
    }
}

#[async_trait]
impl ToolExecutor for TodoTool {
    fn name(&self) -> &str {
        "todo"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "todo".into(),
            description: "Track your progress through multi-step work. One tool, three operations \
selected with `op`.

`op: \"set\"` — lay out the task list. Send `todos`, the complete list. Each call replaces it, but \
ids carry forward by `content`, so an item keeps its identity across calls.

`op: \"update\"` — the one you will use most. Send `id` and `status` to change a single task \
without resending the others. Mark a task in_progress BEFORE starting it and completed as soon as \
it is done. Use `cancelled` for work that turned out to be unnecessary — never mark something \
completed that is not.

`op: \"read\"` — recover the list from disk. Call this whenever you are unsure where you stand: \
resuming an old conversation, after a compaction, or before choosing what to work on next. It reads \
from disk, so it is right even when the list has left your context. Never re-invent a task list \
from memory; read it.

Exactly one task may be in_progress at a time, and starting a new one does not close the previous \
one, so close it first.

Skip this entirely for small, single-step requests — a checklist for a one-line change is noise.

If this project has a plan, the plan's steps are PHASES and this list is the concrete work inside \
the ONE phase you are executing now. Set the todos for that phase, work them, close the phase with \
`plan_step_update`, then set a fresh list for the next phase. The two never compete: the plan is \
what the user approved, this is how you are delivering the current part of it.

This drives the checklist the user is watching live, so a stale mark is visibly wrong to them.

Every operation returns the full list with a cursor naming the active and next item, so you always \
know where you are."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": ["set", "update", "read"],
                        "description": "set = replace the list; update = change one task's status; read = recover the list."
                    },
                    "todos": {
                        "type": "array",
                        "description": "op=set only. The complete task list; each call replaces it.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Existing item id to update in place. Omit for a new item."
                                },
                                "content": {
                                    "type": "string",
                                    "description": "Imperative form, e.g. 'Fix the bug'."
                                },
                                "activeForm": {
                                    "type": "string",
                                    "description": "Present continuous form shown while running, e.g. 'Fixing the bug'."
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed", "cancelled"]
                                }
                            },
                            "required": ["content", "activeForm", "status"]
                        }
                    },
                    "id": {
                        "type": "string",
                        "description": "op=update only. Task id from a previous set or read, e.g. 't2'."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed", "cancelled"],
                        "description": "op=update only. The task's new status."
                    }
                },
                "required": ["op"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let op = Op::parse(
            input
                .get("op")
                .and_then(Value::as_str)
                .map(str::trim)
                .ok_or_else(|| {
                    ToolError::InvalidInput(
                        "`op` is required and must be one of [set, update, read]".into(),
                    )
                })?,
        )?;

        match op {
            Op::Read => self.read(ctx),
            Op::Set => self.set(&input, ctx),
            Op::Update => self.update(&input, ctx).await,
        }
    }
}

impl TodoTool {
    /// Push the new list at the UI. Every mutating op does this, so the
    /// checklist on screen is always what is on disk.
    fn publish(&self, thread_id: &str, list: &TodoList) -> Result<(), ToolError> {
        self.sink
            .emit_todo_write(thread_id, &list.to_event_payload())
            .map_err(|e| ToolError::Execution(format!("failed to emit todo event: {e}")))
    }

    fn read(&self, ctx: &ToolContext) -> Result<String, ToolError> {
        let list = todo_store::read(&ctx.thread_id).map_err(ToolError::Execution)?;
        Ok(json!({
            "success": true,
            "op": "read",
            "items": list.items,
            "cursor": list.cursor(),
            "progress": todo_store::progress_line(&list),
            "message": whats_next(&list),
        })
        .to_string())
    }

    fn set(&self, input: &Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let todos = input
            .get("todos")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ToolError::InvalidInput("`todos` must be an array when op is `set`".into())
            })?;

        let existing = todo_store::read(&ctx.thread_id).map_err(ToolError::Execution)?;
        let mut list = build_list(todos, &existing)?;
        let demoted = list.clamp_single_in_progress();
        todo_store::write(&ctx.thread_id, &list).map_err(ToolError::Execution)?;
        self.publish(&ctx.thread_id, &list)?;

        let cursor = list.cursor();
        let mut result = json!({
            "success": true,
            "op": "set",
            "items": list.items,
            "cursor": cursor,
            "progress": todo_store::progress_line(&list),
            "message": format!("Recorded {} task(s). {}", list.items.len(), whats_next(&list)),
        });
        if !demoted.is_empty() {
            result["warning"] = Value::String(format!(
                "Only one task may be in_progress at a time; {} was kept and {} reset to pending.",
                cursor.active_id.clone().unwrap_or_else(|| "none".into()),
                demoted.join(", ")
            ));
        }
        Ok(result.to_string())
    }

    async fn update(&self, input: &Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let id = input
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput(
                    "`id` must be a non-empty string when op is `update`".into(),
                )
            })?
            .to_string();
        let status = TodoStatus::parse(
            input
                .get("status")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ToolError::InvalidInput("`status` must be a string when op is `update`".into())
                })?,
        )
        .map_err(ToolError::InvalidInput)?;

        let mut demoted = Vec::new();
        let mut previous = None;
        let list = todo_store::update(&ctx.thread_id, |list| {
            let item = list.item_mut(&id).ok_or_else(|| {
                format!(
                    "No task `{id}` in this conversation. Call todo with op `read` for the ids."
                )
            })?;
            previous = Some(item.status);
            item.status = status;
            demoted = list.clamp_single_in_progress();
            Ok(())
        })
        .map_err(ToolError::Execution)?;
        self.publish(&ctx.thread_id, &list)?;

        let mut result = json!({
            "success": true,
            "op": "update",
            "id": id,
            "title": list.item(&id).map(|i| i.content.clone()),
            "status": status.as_str(),
            "previousStatus": previous.map(TodoStatus::as_str).unwrap_or("unknown"),
            "items": list.items,
            "cursor": list.cursor(),
            "progress": todo_store::progress_line(&list),
            "message": format!(
                "Marked {} as {}. {}",
                titled(&list, &id),
                status.as_str(),
                whats_next(&list)
            ),
        });
        if !demoted.is_empty() {
            result["warning"] = Value::String(format!(
                "Only one task may be in_progress at a time, so {} was reset to pending.",
                demoted.join(", ")
            ));
        }
        Ok(result.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::shell_editor_todo::ide_event_sink::{
        NoopIdeEventSink, RecordedEvent, RecordingIdeEventSink,
    };
    use tokio_util::sync::CancellationToken;

    fn ctx(session: &str) -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: session.into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
        }
    }

    fn thread() -> String {
        format!("todo-{}", uuid::Uuid::new_v4())
    }

    fn tool() -> TodoTool {
        TodoTool::new(Arc::new(NoopIdeEventSink))
    }

    fn sample() -> Value {
        json!([
            {"content":"Step 1","activeForm":"Doing step 1","status":"in_progress"},
            {"content":"Step 2","activeForm":"Doing step 2","status":"pending"},
        ])
    }

    async fn seed(tool: &TodoTool, thread: &str) {
        tool.execute(json!({"op": "set", "todos": sample()}), &ctx(thread))
            .await
            .expect("seed");
    }

    #[tokio::test]
    async fn requires_permission_is_false() {
        assert!(!tool().requires_permission());
    }

    #[tokio::test]
    async fn the_roster_advertises_one_tool_named_todo() {
        // The whole point of the consolidation: one name, one piece of state.
        assert_eq!(tool().name(), "todo");
        let schema = tool().schema();
        let ops = schema.input_schema["properties"]["op"]["enum"]
            .as_array()
            .expect("op is an enum so an unknown value fails at the API layer");
        assert_eq!(ops.len(), 3);
        assert_eq!(schema.input_schema["required"], json!(["op"]));
    }

    #[tokio::test]
    async fn an_unknown_op_names_the_valid_ones() {
        let err = tool()
            .execute(json!({"op": "delete"}), &ctx(&thread()))
            .await
            .expect_err("must fail");
        let msg = format!("{err:?}");
        assert!(msg.contains("set"), "{msg}");
        assert!(msg.contains("update"), "{msg}");
        assert!(msg.contains("read"), "{msg}");
    }

    #[tokio::test]
    async fn a_missing_op_is_rejected_rather_than_guessed() {
        // Guessing the operation from which fields happen to be present is
        // exactly the loose union `op` exists to avoid.
        assert!(tool()
            .execute(json!({"todos": sample()}), &ctx(&thread()))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn set_assigns_ids_and_echoes_the_list_with_a_cursor() {
        let thread = thread();
        let out = tool()
            .execute(json!({"op": "set", "todos": sample()}), &ctx(&thread))
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["op"], "set");
        let items = parsed["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], "t1", "ids are assigned, not left to chance");
        assert_eq!(parsed["cursor"]["activeId"], "t1");
        assert_eq!(parsed["cursor"]["nextId"], "t2");
        assert!(parsed["progress"].as_str().unwrap().contains("0/2 closed"));

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn the_list_survives_and_is_readable_after_the_call() {
        // The core failure of the original system: nothing persisted, so the
        // agent could never discover where it was.
        let thread = thread();
        seed(&tool(), &thread).await;

        let out = tool()
            .execute(json!({"op": "read"}), &ctx(&thread))
            .await
            .expect("read");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["op"], "read");
        assert_eq!(parsed["items"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["cursor"]["activeId"], "t1");
        assert!(parsed["message"].as_str().unwrap().contains("Step 1"));

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn reading_an_untracked_conversation_is_a_normal_answer_not_an_error() {
        let out = tool()
            .execute(json!({"op": "read"}), &ctx(&thread()))
            .await
            .expect("empty is not a failure");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["items"].as_array().unwrap().len(), 0);
        assert!(parsed["message"]
            .as_str()
            .unwrap()
            .contains("No tasks are being tracked"));
    }

    #[tokio::test]
    async fn a_resend_keeps_ids_stable_so_statuses_cannot_re_map() {
        let thread = thread();
        seed(&tool(), &thread).await;

        // The model re-sends with step 1 finished and a new task appended.
        let out = tool()
            .execute(
                json!({"op": "set", "todos": [
                    {"content":"Step 1","activeForm":"Doing step 1","status":"completed"},
                    {"content":"Step 2","activeForm":"Doing step 2","status":"in_progress"},
                    {"content":"Step 3","activeForm":"Doing step 3","status":"pending"},
                ]}),
                &ctx(&thread),
            )
            .await
            .expect("second");
        let items = serde_json::from_str::<Value>(&out).unwrap()["items"]
            .as_array()
            .unwrap()
            .clone();

        assert_eq!(items[0]["id"], "t1", "Step 1 kept its identity");
        assert_eq!(items[0]["status"], "completed");
        assert_eq!(items[1]["id"], "t2");
        assert_eq!(items[2]["id"], "t3", "the new task got a fresh id");

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn update_flips_one_task_without_resending_the_others() {
        let thread = thread();
        seed(&tool(), &thread).await;

        let out = tool()
            .execute(
                json!({"op": "update", "id": "t1", "status": "completed"}),
                &ctx(&thread),
            )
            .await
            .expect("update");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["op"], "update");
        assert_eq!(parsed["status"], "completed");
        assert_eq!(parsed["previousStatus"], "in_progress");
        assert_eq!(parsed["title"], "Step 1");
        assert_eq!(
            parsed["items"].as_array().unwrap().len(),
            2,
            "the rest of the list is intact"
        );
        // The message names the task, not just its id — this is read by a human
        // as well as by the model.
        assert!(parsed["message"].as_str().unwrap().contains("Step 1"));

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn updating_an_unknown_id_says_how_to_recover() {
        let thread = thread();
        seed(&tool(), &thread).await;

        let err = tool()
            .execute(
                json!({"op": "update", "id": "t99", "status": "completed"}),
                &ctx(&thread),
            )
            .await
            .expect_err("must fail");
        let msg = format!("{err:?}");
        assert!(msg.contains("read"), "the error points at the recovery: {msg}");

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn clamps_multi_in_progress_and_warns_instead_of_failing_the_turn() {
        let thread = thread();
        let out = tool()
            .execute(
                json!({"op": "set", "todos": [
                    {"content":"a","activeForm":"a","status":"in_progress"},
                    {"content":"b","activeForm":"b","status":"in_progress"},
                ]}),
                &ctx(&thread),
            )
            .await
            .expect("ok — clamps rather than erroring");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["cursor"]["activeId"], "t1");
        assert!(parsed["warning"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("only one"));

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn every_mutating_op_pushes_the_list_at_the_ui() {
        // The checklist lives in the window header now, so it is only ever as
        // correct as this event. Both mutating ops must emit it.
        let thread = thread();
        let sink = RecordingIdeEventSink::new();
        let tool = TodoTool::new(sink.clone());

        seed(&tool, &thread).await;
        tool.execute(
            json!({"op": "update", "id": "t1", "status": "completed"}),
            &ctx(&thread),
        )
        .await
        .expect("update");
        tool.execute(json!({"op": "read"}), &ctx(&thread))
            .await
            .expect("read");

        let events = sink.events();
        assert_eq!(events.len(), 2, "read must not emit — nothing changed");
        for event in &events {
            match event {
                RecordedEvent::TodoWrite { thread_id, todos } => {
                    assert_eq!(thread_id, &thread, "the event names its conversation");
                    assert!(!todos.as_array().unwrap().is_empty());
                }
                other => panic!("unexpected: {other:?}"),
            }
        }
        match &events[1] {
            RecordedEvent::TodoWrite { todos, .. } => {
                assert_eq!(todos.as_array().unwrap()[0]["status"], "completed");
            }
            other => panic!("unexpected: {other:?}"),
        }

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn rejects_malformed_entries_with_a_pointed_message() {
        let tool = tool();
        let thread = thread();

        for (bad, expect) in [
            (json!([{"content":"a","status":"pending"}]), "activeForm"),
            (json!([{"content":"a","activeForm":"a","status":"blocked"}]), "status"),
            (json!(["nope"]), "object"),
        ] {
            let err = tool
                .execute(json!({"op": "set", "todos": bad}), &ctx(&thread))
                .await
                .expect_err("must fail");
            assert!(
                format!("{err:?}").contains(expect),
                "expected {expect} in {err:?}"
            );
        }
        assert!(tool
            .execute(json!({"op": "set", "todos": {"x": 1}}), &ctx(&thread))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn setting_an_empty_list_clears_it() {
        let thread = thread();
        seed(&tool(), &thread).await;
        let out = tool()
            .execute(json!({"op": "set", "todos": []}), &ctx(&thread))
            .await
            .expect("clear");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["items"].as_array().unwrap().len(), 0);
        assert!(todo_store::read(&thread).expect("read").items.is_empty());

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn a_plan_and_a_working_checklist_coexist() {
        // The user's model: the plan is the phases they approved, the todo list
        // is how the agent is delivering the phase it is on. Refusing to write
        // todos because a plan exists froze the checklist the user watches and
        // told the model to use a tool it had not been given.
        let ws = std::env::temp_dir().join(format!("aurora-todo-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws).expect("ws");
        let thread = thread();

        let writer = crate::tools::plan::plan_write::PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let mut plan_ctx = ctx(&thread);
        plan_ctx.workspace_root = Some(ws.clone());
        writer
            .execute(
                json!({"title": "Plan", "steps": [{"title": "Phase 1"}, {"title": "Phase 2"}]}),
                &plan_ctx,
            )
            .await
            .expect("plan");

        let out = tool()
            .execute(json!({"op": "set", "todos": sample()}), &plan_ctx)
            .await
            .expect("must not error");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["success"], json!(true));
        assert!(parsed.get("usePlanInstead").is_none(), "no hijack");
        let items = parsed["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "the agent's own todos were recorded");
        assert_eq!(items[0]["id"], "t1", "todos keep their own id space");
        assert_eq!(
            todo_store::read(&thread).expect("read").items.len(),
            2,
            "and they reached disk"
        );

        std::fs::remove_dir_all(&ws).ok();
        todo_store::clear(&thread).ok();
    }
}
