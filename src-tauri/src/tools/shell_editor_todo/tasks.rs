//! `TaskCreate` / `TaskUpdate` / `TaskList` — the agent's working checklist.
//!
//! ## Why three tools with these names
//!
//! This replaces a single `todo` tool that took a typed `op` (`set` / `update`
//! / `read`). One tool for three jobs reads well on paper and cost real turns
//! in practice:
//!
//! * `op` is a required field with no default, so forgetting it is a whole
//!   wasted request. It happened on a measured NoteBox build — `todo` called
//!   with a `todos` array and no `op`, rejected, retried in the next message.
//! * `set` replaced the WHOLE list on every call, so adding one task meant
//!   resending every task, and identity was recovered by matching `content`
//!   strings.
//!
//! The shape here is Claude Code's, deliberately and exactly: one task per
//! `TaskCreate`, one task per `TaskUpdate`, `TaskList` to read the list back.
//! Several calls ride in ONE message — four `TaskCreate` calls lay out a plan
//! in a single request, and closing one task while starting the next is two
//! `TaskUpdate` calls side by side, not two round trips. Nothing about the
//! split costs an extra request; it removes the field that could be forgotten.
//!
//! ## What is Aurora's, not the reference's
//!
//! * **Storage.** [`super::todo_store`] keeps the list in
//!   `<sessions>/<thread>.todos.json` and is untouched by the split: the same
//!   ids, the same single-`in_progress` clamp, the same Tauri event that
//!   drives the header checklist. The stored field is still `content`, because
//!   every checklist already on disk and the frontend `Task` type call it that.
//! * **`cancelled`.** The reference has `deleted` (gone for good); Aurora also
//!   has `cancelled` (kept, shown struck through), because work that turned out
//!   to be unnecessary is a thing the user should still be able to see. Both
//!   are accepted.
//! * **No `owner` / `addBlocks` / `addBlockedBy` / `metadata`.** Those belong to
//!   the reference's multi-agent task queue. Aurora's team runtime has its own
//!   coordination tools, so those fields would be schema the model reads on
//!   every request and can never usefully fill.
//!
//! Todos stay independent of plans: a plan carries the coarse phases the user
//! approved, this list carries the concrete steps of the phase being executed.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::ide_event_sink::IdeEventSink;
use super::todo_store::{self, TodoItem, TodoList, TodoStatus};

/// Names of the three tools, in roster order. One place, so the bucket roster,
/// the mode gates and the tests cannot drift from each other.
pub const TASK_TOOL_NAMES: &[&str] = &["TaskCreate", "TaskUpdate", "TaskList"];

// ─── shared helpers ───────────────────────────────────────────────────────

/// Name a task by its title, never by its id alone. This string is read by the
/// model, and "Marked 2 as completed; next up is 3" says nothing about what
/// actually happened.
fn titled(list: &TodoList, id: &str) -> String {
    list.item(id)
        .map(|i| format!("\"{}\" ({})", i.content, i.id))
        .unwrap_or_else(|| id.to_string())
}

/// "So what do I do now" — the same sentence shape from every tool, so the
/// model reads one consistent answer whether it just created a task or is
/// recovering the list after a compaction.
fn whats_next(list: &TodoList) -> String {
    let cursor = list.cursor();
    if list.items.is_empty() {
        return "No tasks are being tracked for this conversation.".to_string();
    }
    if cursor.complete {
        // Read right after the last task is closed — which is a tool call, so
        // the answer the model meant to write next is still unwritten. Say
        // what to do rather than leaving it to re-derive.
        return "Every task is closed. If your written answer to the user is not on screen yet, \
                write it now; if it is, you are done."
            .to_string();
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

/// The state block every one of the three tools returns.
///
/// The list, where the cursor stands, and the same "what now" sentence. A
/// caller that just created its fourth task sees all four, so it never has to
/// call `TaskList` to find out what it just built.
fn state(list: &TodoList) -> Value {
    json!({
        "items": list.items,
        "cursor": list.cursor(),
        "progress": todo_store::progress_line(list),
    })
}

fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(base_map), Some(extra_map)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_map {
            base_map.insert(k.clone(), v.clone());
        }
    }
    base
}

/// Read a required, non-empty string field.
fn required_str(input: &Value, field: &str) -> Result<String, ToolError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ToolError::InvalidInput(format!("`{field}` must be a non-empty string")))
}

/// Read an optional, non-empty string field. A field sent as `""` is treated as
/// absent rather than as an instruction to blank the task out — a model filling
/// in a schema field it did not need must not erase what is already there.
fn optional_str(input: &Value, field: &str) -> Option<String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Push the new list at the UI. Every mutating call does this, so the checklist
/// on screen is always what is on disk.
fn publish(sink: &Arc<dyn IdeEventSink>, thread_id: &str, list: &TodoList) -> Result<(), ToolError> {
    sink.emit_todo_write(thread_id, &list.to_event_payload())
        .map_err(|e| ToolError::Execution(format!("failed to emit todo event: {e}")))
}

// ─── TaskCreate ───────────────────────────────────────────────────────────

pub struct TaskCreateTool {
    sink: Arc<dyn IdeEventSink>,
}

impl TaskCreateTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for TaskCreateTool {
    fn name(&self) -> &str {
        "TaskCreate"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "TaskCreate".into(),
            description: "Create one task in this conversation's task list. It tracks your \
progress through multi-step work and drives the checklist the user watches live in the Aurora \
Agent window's header.

Call it once per task, and put every call for the plan in ONE message — four tasks are four \
`TaskCreate` calls side by side, not four messages.

Use it when the work takes three or more real steps, when the user hands you a list of things to \
do, or when you are about to start something you could lose your place in. Skip it entirely for a \
single straightforward change: a checklist for a one-line edit is noise.

Fields:
  * `subject` — a brief, actionable title in imperative form, e.g. \"Fix the auth redirect\".
  * `description` — what actually has to be done, in enough detail that you could pick it up cold.
  * `activeForm` — optional, present continuous, e.g. \"Fixing the auth redirect\". Shown while the \
task runs; the subject is used if you omit it.

Every task is created `pending`. Use `TaskUpdate` to start and close them.

If this project has a plan, the plan's steps are PHASES and this list is the concrete work inside \
the ONE phase you are executing now."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "subject": {
                        "type": "string",
                        "description": "Brief, actionable title in imperative form, e.g. 'Fix the auth redirect'."
                    },
                    "description": {
                        "type": "string",
                        "description": "What needs to be done."
                    },
                    "activeForm": {
                        "type": "string",
                        "description": "Present continuous form shown while the task runs, e.g. 'Fixing the auth redirect'."
                    }
                },
                "required": ["subject", "description"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let subject = required_str(&input, "subject")?;
        let description = required_str(&input, "description")?;
        // The reference makes `activeForm` optional and falls back to the
        // subject in the spinner. Aurora's header does the same, so the
        // fallback is stored rather than left empty — the UI reads one field.
        let active_form = optional_str(&input, "activeForm").unwrap_or_else(|| subject.clone());

        let mut created_id = String::new();
        let list = todo_store::update(&ctx.thread_id, |list| {
            let id = list.next_id();
            created_id = id.clone();
            list.items.push(TodoItem {
                id,
                content: subject.clone(),
                description: description.clone(),
                active_form: active_form.clone(),
                status: TodoStatus::Pending,
            });
            Ok(())
        })
        .map_err(ToolError::Execution)?;
        publish(&self.sink, &ctx.thread_id, &list)?;

        Ok(merge(
            json!({
                "success": true,
                "task": {
                    "id": created_id,
                    "subject": subject,
                    "status": "pending",
                },
                "message": format!(
                    "Created {} as pending. {}",
                    titled(&list, &created_id),
                    whats_next(&list)
                ),
            }),
            state(&list),
        )
        .to_string())
    }

    fn requires_permission(&self) -> bool {
        false
    }

    fn concurrency_safe(&self) -> bool {
        // Several creates land in one message by design. The store serializes
        // them under its own lock and each appends its own row.
        true
    }
}

// ─── TaskUpdate ───────────────────────────────────────────────────────────

pub struct TaskUpdateTool {
    sink: Arc<dyn IdeEventSink>,
}

impl TaskUpdateTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for TaskUpdateTool {
    fn name(&self) -> &str {
        "TaskUpdate"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "TaskUpdate".into(),
            description: "Update one task in this conversation's task list — its status, or its \
wording.

Mark a task `in_progress` BEFORE you start it and `completed` the moment that work is actually \
done. Closing one task and starting the next is two calls in the SAME message, never two messages.

Only mark `completed` what you have genuinely finished. If tests are failing, the implementation is \
partial, or you hit an error you have not resolved, the task stays `in_progress` and you say what \
is blocking. Use `cancelled` for work that turned out to be unnecessary, and `deleted` to remove a \
task created in error — `deleted` takes it off the list for good.

Exactly one task may be `in_progress` at a time. Starting a new one does not close the previous \
one, so send both calls together.

Fields: `taskId` (required), then any of `status`, `subject`, `description`, `activeForm`. Call \
`TaskList` first if you are not sure of the ids or where you stand.

This drives the checklist the user is watching live, so a stale mark is visibly wrong to them."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "taskId": {
                        "type": "string",
                        "description": "Id of the task to update, as returned by TaskCreate or TaskList, e.g. '2'."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed", "cancelled", "deleted"],
                        "description": "New status. 'deleted' removes the task from the list."
                    },
                    "subject": {
                        "type": "string",
                        "description": "New title, imperative form."
                    },
                    "description": {
                        "type": "string",
                        "description": "New description of what needs to be done."
                    },
                    "activeForm": {
                        "type": "string",
                        "description": "New present continuous form shown while the task runs."
                    }
                },
                "required": ["taskId"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let task_id = required_str(&input, "taskId")?;
        let raw_status = optional_str(&input, "status");
        let subject = optional_str(&input, "subject");
        let description = optional_str(&input, "description");
        let active_form = optional_str(&input, "activeForm");

        // A call that names a task and changes nothing is a mistake worth
        // naming: silently succeeding would let the model believe it had
        // closed something.
        if raw_status.is_none() && subject.is_none() && description.is_none() && active_form.is_none()
        {
            return Err(ToolError::InvalidInput(
                "nothing to update — send `status`, or one of `subject` / `description` / `activeForm`, alongside `taskId`".into(),
            ));
        }

        // `deleted` is an action, not a stored state: the reference removes the
        // task, and a status enum that could hold it would leak a ghost row
        // into the header checklist.
        let deleting = raw_status.as_deref() == Some("deleted");
        let status = match raw_status.as_deref() {
            Some("deleted") | None => None,
            Some(other) => Some(TodoStatus::parse(other).map_err(ToolError::InvalidInput)?),
        };

        let mut previous_status = None;
        let mut demoted = Vec::new();
        let mut removed_title = None;
        let list = todo_store::update(&ctx.thread_id, |list| {
            let Some(item) = list.item_mut(&task_id) else {
                return Err(format!(
                    "No task `{task_id}` in this conversation — nothing was changed. Call TaskList for the ids."
                ));
            };
            if deleting {
                removed_title = Some(format!("\"{}\" ({})", item.content, item.id));
                list.items.retain(|i| i.id != task_id);
                return Ok(());
            }
            previous_status = Some(item.status);
            if let Some(status) = status {
                item.status = status;
            }
            if let Some(subject) = &subject {
                item.content = subject.clone();
            }
            if let Some(description) = &description {
                item.description = description.clone();
            }
            if let Some(active_form) = &active_form {
                item.active_form = active_form.clone();
            }
            // Starting a task the model has just named must actually start it.
            // Only one may run at a time, and the one it asked for is the one
            // that wins — demoting the NEW task instead (which is what a
            // position-ordered clamp does on its own) would leave the model
            // believing it had moved on while the header still showed the old
            // task. The one it left behind is named in the result.
            if status == Some(TodoStatus::InProgress) {
                for other in list.items.iter_mut() {
                    if other.id != task_id && other.status == TodoStatus::InProgress {
                        other.status = TodoStatus::Pending;
                        demoted.push(other.id.clone());
                    }
                }
            }
            demoted.extend(list.clamp_single_in_progress());
            Ok(())
        })
        .map_err(ToolError::Execution)?;
        publish(&self.sink, &ctx.thread_id, &list)?;

        if let Some(title) = removed_title {
            return Ok(merge(
                json!({
                    "success": true,
                    "taskId": task_id,
                    "deleted": true,
                    "message": format!("Deleted {title}. {}", whats_next(&list)),
                }),
                state(&list),
            )
            .to_string());
        }

        let now = list
            .item(&task_id)
            .map(|i| i.status.as_str())
            .unwrap_or("pending");
        let mut result = merge(
            json!({
                "success": true,
                "taskId": task_id,
                // Flat `id` / `status` / `title` as well: the transcript card
                // reads these, and it predates the split.
                "id": task_id,
                "status": now,
                "title": list.item(&task_id).map(|i| i.content.clone()),
                "previousStatus": previous_status.map(TodoStatus::as_str),
                "message": format!(
                    "Marked {} as {now}. {}",
                    titled(&list, &task_id),
                    whats_next(&list)
                ),
            }),
            state(&list),
        );
        if !demoted.is_empty() {
            result["warning"] = Value::String(format!(
                "Only one task may be in_progress at a time, so {} was reset to pending.",
                demoted.join(", ")
            ));
        }
        Ok(result.to_string())
    }

    fn requires_permission(&self) -> bool {
        false
    }

    fn concurrency_safe(&self) -> bool {
        // Closing one task and starting the next arrive together. Each call
        // takes the store lock for its own row, and the single-in_progress
        // clamp runs inside that lock, so the pair cannot interleave badly.
        true
    }
}

// ─── TaskList ─────────────────────────────────────────────────────────────

pub struct TaskListTool;

#[async_trait]
impl ToolExecutor for TaskListTool {
    fn name(&self) -> &str {
        "TaskList"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "TaskList".into(),
            description: "Read this conversation's task list back — every task, its status, and \
where you currently stand.

Call it whenever you are unsure: resuming an old conversation, after a compaction, before choosing \
what to work on next, or before updating a task whose id you are not certain of. It reads from \
disk, so it is right even when the list has scrolled out of your context.

Never re-invent a task list from memory. Read it."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        }
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let list = todo_store::read(&ctx.thread_id).map_err(ToolError::Execution)?;
        Ok(merge(
            json!({
                "success": true,
                "message": whats_next(&list),
            }),
            state(&list),
        )
        .to_string())
    }

    fn requires_permission(&self) -> bool {
        false
    }

    fn concurrency_safe(&self) -> bool {
        true
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
            workspace_access: Default::default(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            thread_id: session.into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    fn thread() -> String {
        format!("tasks-{}", uuid::Uuid::new_v4())
    }

    fn create_tool() -> TaskCreateTool {
        TaskCreateTool::new(Arc::new(NoopIdeEventSink))
    }

    fn update_tool() -> TaskUpdateTool {
        TaskUpdateTool::new(Arc::new(NoopIdeEventSink))
    }

    fn parse(raw: &str) -> Value {
        serde_json::from_str(raw).expect("tool result is json")
    }

    async fn create(thread: &str, subject: &str) -> Value {
        parse(
            &create_tool()
                .execute(
                    json!({"subject": subject, "description": format!("Do {subject}")}),
                    &ctx(thread),
                )
                .await
                .expect("create"),
        )
    }

    async fn update(thread: &str, input: Value) -> Result<Value, ToolError> {
        update_tool().execute(input, &ctx(thread)).await.map(|r| parse(&r))
    }

    #[tokio::test]
    async fn the_roster_advertises_three_task_tools() {
        assert_eq!(create_tool().name(), "TaskCreate");
        assert_eq!(update_tool().name(), "TaskUpdate");
        assert_eq!(TaskListTool.name(), "TaskList");
        assert_eq!(TASK_TOOL_NAMES, ["TaskCreate", "TaskUpdate", "TaskList"]);
    }

    /// The whole point of the split: nothing that has to be remembered beyond
    /// the two words the task is made of.
    #[tokio::test]
    async fn creating_a_task_needs_only_a_subject_and_a_description() {
        let thread = thread();
        let out = create(&thread, "Write the parser").await;
        assert_eq!(out["success"], true);
        assert_eq!(out["task"]["id"], "1");
        assert_eq!(out["task"]["subject"], "Write the parser");
        assert_eq!(out["task"]["status"], "pending");
        assert_eq!(out["items"].as_array().unwrap().len(), 1);
    }

    /// Four calls in one message is the shape this exists for, and ids must
    /// come out in order rather than colliding.
    #[tokio::test]
    async fn several_creates_build_the_list_in_order() {
        let thread = thread();
        for subject in ["One", "Two", "Three", "Four"] {
            create(&thread, subject).await;
        }
        let list = todo_store::read(&thread).unwrap();
        let ids: Vec<_> = list.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["1", "2", "3", "4"]);
        let subjects: Vec<_> = list.items.iter().map(|i| i.content.as_str()).collect();
        assert_eq!(subjects, ["One", "Two", "Three", "Four"]);
    }

    #[tokio::test]
    async fn activeform_falls_back_to_the_subject() {
        let thread = thread();
        create(&thread, "Ship it").await;
        let list = todo_store::read(&thread).unwrap();
        assert_eq!(list.items[0].active_form, "Ship it");
        assert_eq!(list.items[0].description, "Do Ship it");
    }

    #[tokio::test]
    async fn a_create_missing_its_description_says_which_field() {
        let err = create_tool()
            .execute(json!({"subject": "Only a subject"}), &ctx(&thread()))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidInput(m) if m.contains("`description`")),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn update_moves_one_task_and_reports_the_previous_status() {
        let thread = thread();
        create(&thread, "First").await;
        let out = update(&thread, json!({"taskId": "1", "status": "in_progress"}))
            .await
            .expect("update");
        assert_eq!(out["status"], "in_progress");
        assert_eq!(out["previousStatus"], "pending");
        assert_eq!(out["title"], "First");
    }

    /// Closing one and starting the next is two calls in one message. They must
    /// compose without the clamp undoing the first.
    #[tokio::test]
    async fn closing_one_and_starting_the_next_leaves_exactly_one_in_progress() {
        let thread = thread();
        create(&thread, "First").await;
        create(&thread, "Second").await;
        update(&thread, json!({"taskId": "1", "status": "in_progress"}))
            .await
            .unwrap();
        update(&thread, json!({"taskId": "1", "status": "completed"}))
            .await
            .unwrap();
        let out = update(&thread, json!({"taskId": "2", "status": "in_progress"}))
            .await
            .unwrap();
        assert_eq!(out["cursor"]["activeId"], "2");
        assert_eq!(out["cursor"]["completed"], 1);
        assert!(out.get("warning").is_none(), "{out}");
    }

    /// Two in_progress at once is the one state the header cannot show, so the
    /// store demotes the older one and the model is told.
    #[tokio::test]
    async fn starting_a_second_task_without_closing_the_first_demotes_it() {
        let thread = thread();
        create(&thread, "First").await;
        create(&thread, "Second").await;
        update(&thread, json!({"taskId": "1", "status": "in_progress"}))
            .await
            .unwrap();
        let out = update(&thread, json!({"taskId": "2", "status": "in_progress"}))
            .await
            .unwrap();
        assert_eq!(out["cursor"]["activeId"], "2");
        assert!(
            out["warning"].as_str().unwrap_or_default().contains("1"),
            "{out}"
        );
    }

    #[tokio::test]
    async fn an_unknown_id_changes_nothing_and_names_the_tool_that_lists_them() {
        let thread = thread();
        create(&thread, "First").await;
        let err = update(&thread, json!({"taskId": "9", "status": "completed"}))
            .await
            .unwrap_err();
        let message = format!("{err:?}");
        assert!(message.contains("TaskList"), "{message}");
        let list = todo_store::read(&thread).unwrap();
        assert_eq!(list.items[0].status, TodoStatus::Pending);
    }

    #[tokio::test]
    async fn an_update_that_changes_nothing_is_an_error_not_a_silent_success() {
        let thread = thread();
        create(&thread, "First").await;
        let err = update(&thread, json!({"taskId": "1"})).await.unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidInput(m) if m.contains("nothing to update")),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn update_can_rewrite_the_wording_without_touching_the_status() {
        let thread = thread();
        create(&thread, "Vague title").await;
        update(&thread, json!({"taskId": "1", "status": "in_progress"}))
            .await
            .unwrap();
        update(
            &thread,
            json!({"taskId": "1", "subject": "Exact title", "description": "Now specific"}),
        )
        .await
        .unwrap();
        let list = todo_store::read(&thread).unwrap();
        assert_eq!(list.items[0].content, "Exact title");
        assert_eq!(list.items[0].description, "Now specific");
        assert_eq!(list.items[0].status, TodoStatus::InProgress);
    }

    #[tokio::test]
    async fn deleted_removes_the_task_from_the_list() {
        let thread = thread();
        create(&thread, "Keep").await;
        create(&thread, "Drop").await;
        let out = update(&thread, json!({"taskId": "2", "status": "deleted"}))
            .await
            .unwrap();
        assert_eq!(out["deleted"], true);
        let list = todo_store::read(&thread).unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].content, "Keep");
    }

    #[tokio::test]
    async fn cancelled_keeps_the_task_visible() {
        let thread = thread();
        create(&thread, "Not needed after all").await;
        update(&thread, json!({"taskId": "1", "status": "cancelled"}))
            .await
            .unwrap();
        let list = todo_store::read(&thread).unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].status, TodoStatus::Cancelled);
    }

    #[tokio::test]
    async fn tasklist_reads_the_list_back_from_disk() {
        let thread = thread();
        create(&thread, "First").await;
        create(&thread, "Second").await;
        update(&thread, json!({"taskId": "1", "status": "in_progress"}))
            .await
            .unwrap();

        let out = parse(
            &TaskListTool
                .execute(json!({}), &ctx(&thread))
                .await
                .expect("list"),
        );
        assert_eq!(out["items"].as_array().unwrap().len(), 2);
        assert_eq!(out["cursor"]["activeId"], "1");
        assert!(out["message"].as_str().unwrap().contains("First"), "{out}");
    }

    #[tokio::test]
    async fn tasklist_on_an_untouched_conversation_says_so_rather_than_failing() {
        let out = parse(
            &TaskListTool
                .execute(json!({}), &ctx(&thread()))
                .await
                .expect("list"),
        );
        assert_eq!(out["items"].as_array().unwrap().len(), 0);
        assert!(
            out["message"].as_str().unwrap().contains("No tasks"),
            "{out}"
        );
    }

    /// The header checklist is driven by the event, not by the tool result, so
    /// every mutating call has to fire one.
    #[tokio::test]
    async fn create_and_update_both_publish_the_list_to_the_ui() {
        let thread = thread();
        let sink = Arc::new(RecordingIdeEventSink::default());
        let create = TaskCreateTool::new(sink.clone());
        let update = TaskUpdateTool::new(sink.clone());

        create
            .execute(
                json!({"subject": "One", "description": "Do one"}),
                &ctx(&thread),
            )
            .await
            .unwrap();
        update
            .execute(json!({"taskId": "1", "status": "completed"}), &ctx(&thread))
            .await
            .unwrap();

        let writes = sink
            .events()
            .into_iter()
            .filter(|e| matches!(e, RecordedEvent::TodoWrite { .. }))
            .count();
        assert_eq!(writes, 2);
    }

    /// None of the three touches the workspace, so none of them may sit behind
    /// the approval gate — a checklist that needs clicking is a stalled turn.
    #[tokio::test]
    async fn no_task_tool_requires_permission() {
        assert!(!create_tool().requires_permission());
        assert!(!update_tool().requires_permission());
        assert!(!TaskListTool.requires_permission());
    }

    /// A conversation that already has `t1`-style ids keeps working, and the
    /// next id continues the numbering rather than colliding with it.
    #[tokio::test]
    async fn a_checklist_written_before_the_split_still_updates() {
        let thread = thread();
        let mut list = TodoList::default();
        list.items.push(TodoItem {
            id: "t1".into(),
            content: "Legacy task".into(),
            description: String::new(),
            active_form: "Doing the legacy task".into(),
            status: TodoStatus::InProgress,
        });
        todo_store::write(&thread, &list).unwrap();

        let out = update(&thread, json!({"taskId": "t1", "status": "completed"}))
            .await
            .expect("legacy id resolves");
        assert_eq!(out["status"], "completed");

        create(&thread, "New task").await;
        let list = todo_store::read(&thread).unwrap();
        assert_eq!(list.items[1].id, "2");
    }
}
