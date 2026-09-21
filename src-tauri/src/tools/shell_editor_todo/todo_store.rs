//! Durable per-thread todo state — the agent's working tracker for the chunk
//! of execution it is on right now.
//!
//! ## Why this module exists
//!
//! The original `todo_write` emitted a Tauri event and forgot. There was no
//! read-back, no persistence, no ids, and every call replaced the whole list.
//! An agent could write ten todos and then have no way to discover which one it
//! was on — after a compaction it would re-invent the list from a summary, and
//! after a restart the list was gone entirely. "Make todos, then get todo
//! details so you know where you are" was simply not expressible.
//!
//! This store fixes each of those:
//!
//! - **Durable** — `<project>/<thread>/todos.json`, so the list survives a
//!   stop, a reload, and coming back hours later.
//! - **Stable ids** — statuses can never re-map onto the wrong task.
//! - **Readable** — [`TodoList::cursor`] answers "where am I".
//! - **Incrementally updatable** — closing one item does not require resending
//!   the other nine verbatim.
//!
//! ## Todos are not plans
//!
//! A **plan** is the coarse, per-project artifact a Plan-mode conversation
//! produces: phases the user reads and approves, rendered in the Canvas, marked
//! with `plan_step_update`. A **todo list** is the fine-grained per-thread
//! tracker the agent keeps while executing — typically the concrete steps of
//! the ONE plan phase it is working through right now.
//!
//! They are different granularities of different things, so they coexist and
//! neither suppresses the other. An earlier design made a plan take over the
//! todo tools ("one system"); that produced a task panel frozen at 0/N while
//! the agent was told to use a tool that refused to run, and is exactly the
//! confusion this note exists to prevent recurring.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

static TODO_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> Result<MutexGuard<'static, ()>, String> {
    TODO_LOCK
        .lock()
        .map_err(|_| "Todo storage lock was poisoned".to_string())
}

/// Mirrors the frontend `Task` union so the existing task panel renders these
/// without translation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    /// Every task starts here — `TaskCreate` has no status field at all, which
    /// is the reference's shape and one fewer thing to get wrong.
    #[default]
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl TodoStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "pending" => Ok(Self::Pending),
            "in_progress" => Ok(Self::InProgress),
            "completed" => Ok(Self::Completed),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(format!(
                "status `{other}` is not one of [pending, in_progress, completed, cancelled]"
            )),
        }
    }

    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    /// Imperative form — "Fix the bug". This is `TaskCreate`'s `subject`; the
    /// field keeps its storage name because the checklist on disk, the Tauri
    /// event and the frontend `Task` type have all called it `content` since
    /// before the tools were split, and renaming it would break every
    /// conversation already saved.
    pub content: String,
    /// What the task actually involves — `TaskCreate`'s `description`.
    ///
    /// Optional on disk: every checklist written before the split has no such
    /// field, and a missing description is an empty one, never a parse error.
    #[serde(default)]
    pub description: String,
    /// Present continuous — "Fixing the bug".
    pub active_form: String,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoList {
    #[serde(default)]
    pub items: Vec<TodoItem>,
}

/// "Where am I" for a plain todo list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCursor {
    pub active_id: Option<String>,
    pub next_id: Option<String>,
    pub completed: usize,
    pub cancelled: usize,
    pub pending: usize,
    pub total: usize,
    pub complete: bool,
}

impl TodoList {
    #[must_use]
    pub fn cursor(&self) -> TodoCursor {
        let mut completed = 0;
        let mut cancelled = 0;
        let mut pending = 0;
        for item in &self.items {
            match item.status {
                TodoStatus::Completed => completed += 1,
                TodoStatus::Cancelled => cancelled += 1,
                TodoStatus::Pending => pending += 1,
                TodoStatus::InProgress => {}
            }
        }
        let active_id = self
            .items
            .iter()
            .find(|i| i.status == TodoStatus::InProgress)
            .map(|i| i.id.clone());
        let next_id = self
            .items
            .iter()
            .find(|i| i.status == TodoStatus::Pending)
            .map(|i| i.id.clone());
        TodoCursor {
            complete: !self.items.is_empty() && active_id.is_none() && pending == 0,
            active_id,
            next_id,
            completed,
            cancelled,
            pending,
            total: self.items.len(),
        }
    }

    #[must_use]
    pub fn item(&self, id: &str) -> Option<&TodoItem> {
        self.items.iter().find(|i| i.id == id)
    }

    pub fn item_mut(&mut self, id: &str) -> Option<&mut TodoItem> {
        self.items.iter_mut().find(|i| i.id == id)
    }

    /// Keep at most one `in_progress` item; returns the ids demoted to pending.
    pub fn clamp_single_in_progress(&mut self) -> Vec<String> {
        let mut demoted = Vec::new();
        let mut seen = false;
        for item in &mut self.items {
            if item.status != TodoStatus::InProgress {
                continue;
            }
            if seen {
                item.status = TodoStatus::Pending;
                demoted.push(item.id.clone());
            } else {
                seen = true;
            }
        }
        demoted
    }

    #[must_use]
    /// The id the next task gets: one past the highest number in use.
    ///
    /// Plain numbers — `"1"`, `"2"` — matching what `TaskCreate` hands back and
    /// what the model then quotes as `taskId`. Checklists written before the
    /// split used `"t1"`, so both spellings are read when working out the
    /// highest; only the new spelling is written. A thread carrying both is
    /// fine: ids are looked up by string, and neither form can collide with the
    /// other's number.
    pub fn next_id(&self) -> String {
        let max = self
            .items
            .iter()
            .filter_map(|i| i.id.strip_prefix('t').unwrap_or(&i.id).parse::<u32>().ok())
            .max()
            .unwrap_or(0);
        format!("{}", max + 1)
    }

    /// The Tauri event payload, shaped exactly like the frontend `Task` type.
    #[must_use]
    pub fn to_event_payload(&self) -> Value {
        json!(self
            .items
            .iter()
            .map(|i| json!({
                "id": i.id,
                "content": i.content,
                "description": i.description,
                "activeForm": i.active_form,
                "status": i.status.as_str(),
            }))
            .collect::<Vec<_>>())
    }
}

fn path_for(thread_id: &str) -> Result<Option<PathBuf>, String> {
    crate::agent_runtime::project_dir::locate(thread_id)
        .map(|dir| dir.map(|dir| dir.join(thread_id).join("todos.json")))
        .map_err(|e| format!("Failed to locate checklist for {thread_id}: {e}"))
}

fn read_unlocked(thread_id: &str) -> Result<TodoList, String> {
    let Some(path) = path_for(thread_id)? else {
        return Ok(TodoList::default());
    };
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TodoList::default()),
        Err(e) => return Err(format!("Failed to read checklist {}: {e}", path.display())),
    };
    // A corrupt sidecar must not break the turn; an empty list is recoverable,
    // a hard error is not.
    match serde_json::from_slice(&bytes) {
        Ok(list) => Ok(list),
        Err(e) => {
            crate::logging::log_warn(
                "todos",
                &format!("Invalid checklist {}: {e}", path.display()),
            );
            Ok(TodoList::default())
        }
    }
}

fn write_unlocked(thread_id: &str, list: &TodoList) -> Result<(), String> {
    let path = path_for(thread_id)?.ok_or_else(|| {
        format!("Conversation {thread_id} does not exist; checklist was not saved")
    })?;
    let parent = path
        .parent()
        .ok_or_else(|| "Todo storage path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create todo storage: {e}"))?;
    let bytes =
        serde_json::to_vec_pretty(list).map_err(|e| format!("Failed to encode todos: {e}"))?;

    let temp = path.with_extension("json.tmp");
    {
        let mut file =
            fs::File::create(&temp).map_err(|e| format!("Failed to stage todos: {e}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("Failed to flush todos: {e}"))?;
    }
    fs::rename(&temp, &path).map_err(|e| format!("Failed to commit todos: {e}"))
}

pub fn read(thread_id: &str) -> Result<TodoList, String> {
    let _guard = lock()?;
    read_unlocked(thread_id)
}

pub fn write(thread_id: &str, list: &TodoList) -> Result<(), String> {
    let _guard = lock()?;
    write_unlocked(thread_id, list)
}

/// Read-modify-write under the lock so concurrent updates cannot lose one.
pub fn update<F>(thread_id: &str, mutate: F) -> Result<TodoList, String>
where
    F: FnOnce(&mut TodoList) -> Result<(), String>,
{
    let _guard = lock()?;
    let mut list = read_unlocked(thread_id)?;
    mutate(&mut list)?;
    write_unlocked(thread_id, &list)?;
    Ok(list)
}

pub fn clear(thread_id: &str) -> Result<(), String> {
    let _guard = lock()?;
    let Some(path) = path_for(thread_id)? else {
        return Ok(());
    };
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to clear todos: {e}")),
    }
}

/// Human-facing progress summary for a todo list.
///
/// Counts CLOSED items, so a cancelled task does not hold the number below
/// `N/N` forever — `cursor.complete` already treats it as closed, and the
/// user's checklist counts the same way. Cancellations are then named
/// separately, because "3/3 closed" must never be read as "3 done".
#[must_use]
pub fn progress_line(list: &TodoList) -> String {
    let cursor = list.cursor();
    let active = cursor
        .active_id
        .as_ref()
        .and_then(|id| list.item(id))
        .map(|i| format!("; in progress: {} ({})", i.content, i.id));
    let next = if active.is_some() {
        None
    } else {
        cursor
            .next_id
            .as_ref()
            .and_then(|id| list.item(id))
            .map(|i| format!("; next up: {} ({})", i.content, i.id))
    };
    let cancelled = if cursor.cancelled > 0 {
        format!(" ({} cancelled)", cursor.cancelled)
    } else {
        String::new()
    };
    format!(
        "{}/{} closed{cancelled}{}{}",
        cursor.completed + cursor.cancelled,
        cursor.total,
        active.unwrap_or_default(),
        next.unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checklist_lives_and_dies_with_its_conversation() {
        let id = format!("checklist-{}", uuid::Uuid::new_v4());
        let store = crate::agent_runtime::project_dir::test_thread(&id);
        write(&id, &list(vec![item("1", TodoStatus::Pending)])).unwrap();
        let path = store.thread_dir(&id).join("todos.json");
        assert!(path.is_file());
        assert_eq!(read(&id).unwrap().items.len(), 1);
        store.delete(&id).unwrap();
        assert!(!path.exists());
        assert!(read(&id).unwrap().items.is_empty());
        assert!(write(&id, &TodoList::default()).is_err());
        assert!(
            !store.thread_dir(&id).exists(),
            "writing a deleted checklist must not resurrect its conversation"
        );
    }

    fn item(id: &str, status: TodoStatus) -> TodoItem {
        TodoItem {
            id: id.into(),
            content: format!("Task {id}"),
            description: format!("What task {id} involves"),
            active_form: format!("Doing task {id}"),
            status,
        }
    }

    fn list(items: Vec<TodoItem>) -> TodoList {
        TodoList { items }
    }

    #[test]
    fn cursor_answers_where_am_i() {
        let l = list(vec![
            item("t1", TodoStatus::Completed),
            item("t2", TodoStatus::InProgress),
            item("t3", TodoStatus::Pending),
            item("t4", TodoStatus::Cancelled),
        ]);
        let c = l.cursor();
        assert_eq!(c.active_id.as_deref(), Some("t2"));
        assert_eq!(c.next_id.as_deref(), Some("t3"));
        assert_eq!((c.completed, c.cancelled, c.pending, c.total), (1, 1, 1, 4));
        assert!(!c.complete);
    }

    #[test]
    fn cursor_is_complete_only_when_nothing_is_open() {
        assert!(
            list(vec![
                item("t1", TodoStatus::Completed),
                item("t2", TodoStatus::Cancelled)
            ])
            .cursor()
            .complete
        );
        assert!(
            !list(vec![]).cursor().complete,
            "an empty list is not complete"
        );
    }

    #[test]
    fn clamp_keeps_the_first_in_progress_item() {
        let mut l = list(vec![
            item("t1", TodoStatus::InProgress),
            item("t2", TodoStatus::InProgress),
        ]);
        let demoted = l.clamp_single_in_progress();
        assert_eq!(demoted, vec!["t2".to_string()]);
        assert_eq!(l.items[0].status, TodoStatus::InProgress);
        assert_eq!(l.items[1].status, TodoStatus::Pending);
    }

    #[test]
    fn next_id_walks_past_the_maximum_so_ids_are_never_reused() {
        let l = list(vec![
            item("1", TodoStatus::Pending),
            item("7", TodoStatus::Pending),
        ]);
        assert_eq!(l.next_id(), "8");
        assert_eq!(list(vec![]).next_id(), "1");
    }

    /// A checklist written before the tools were split numbers its tasks `t1`,
    /// `t2`. Those threads keep working, and the next id must continue past
    /// them rather than land on a number the list is already using.
    #[test]
    fn next_id_reads_the_old_t_prefixed_ids_too() {
        let l = list(vec![
            item("t1", TodoStatus::Pending),
            item("t4", TodoStatus::Pending),
        ]);
        assert_eq!(l.next_id(), "5");
    }

    #[test]
    fn event_payload_matches_the_frontend_task_shape() {
        let payload = list(vec![item("t1", TodoStatus::InProgress)]).to_event_payload();
        let first = &payload.as_array().unwrap()[0];
        assert_eq!(first["id"], "t1");
        assert_eq!(first["content"], "Task t1");
        assert_eq!(first["activeForm"], "Doing task t1");
        assert_eq!(first["status"], "in_progress");
    }

    #[test]
    fn parse_rejects_a_status_outside_the_set() {
        assert!(
            TodoStatus::parse("done").is_err(),
            "plan vocabulary is not todo vocabulary"
        );
        assert_eq!(
            TodoStatus::parse("completed").unwrap(),
            TodoStatus::Completed
        );
    }

    #[test]
    fn progress_line_names_active_then_next() {
        let running = progress_line(&list(vec![
            item("t1", TodoStatus::Completed),
            item("t2", TodoStatus::InProgress),
        ]));
        assert!(running.contains("1/2 closed"), "{running}");
        assert!(running.contains("in progress: Task t2 (t2)"), "{running}");
        assert!(!running.contains("next up"));

        let idle = progress_line(&list(vec![item("t1", TodoStatus::Pending)]));
        assert!(idle.contains("next up: Task t1 (t1)"), "{idle}");
    }

    #[test]
    fn progress_line_counts_cancelled_as_closed_but_names_it() {
        // A cancelled task is not outstanding work, so it must not hold the
        // counter below N/N — but "2/2 closed" must never read as "2 done".
        let line = progress_line(&list(vec![
            item("t1", TodoStatus::Completed),
            item("t2", TodoStatus::Cancelled),
        ]));
        assert!(line.contains("2/2 closed"), "{line}");
        assert!(line.contains("1 cancelled"), "{line}");
    }

    #[test]
    fn persists_across_reads_and_survives_a_corrupt_sidecar() {
        let thread = format!("test-thread-{}", uuid::Uuid::new_v4());
        crate::agent_runtime::project_dir::test_thread(&thread);
        write(&thread, &list(vec![item("t1", TodoStatus::InProgress)])).expect("write");

        let back = read(&thread).expect("read");
        assert_eq!(back.items.len(), 1, "the list survived the round trip");
        assert_eq!(back.cursor().active_id.as_deref(), Some("t1"));

        // A hand-corrupted sidecar degrades to empty rather than failing a turn.
        fs::write(path_for(&thread).unwrap().unwrap(), b"{not json").expect("corrupt it");
        assert!(read(&thread).expect("still reads").items.is_empty());

        clear(&thread).expect("clear");
        assert!(read(&thread).expect("read").items.is_empty());
    }

    #[test]
    fn update_is_read_modify_write() {
        let thread = format!("test-thread-{}", uuid::Uuid::new_v4());
        crate::agent_runtime::project_dir::test_thread(&thread);
        write(&thread, &list(vec![item("t1", TodoStatus::Pending)])).expect("seed");

        let after = update(&thread, |l| {
            l.item_mut("t1").unwrap().status = TodoStatus::Completed;
            Ok(())
        })
        .expect("update");

        assert_eq!(after.items[0].status, TodoStatus::Completed);
        assert_eq!(
            read(&thread).expect("reread").items[0].status,
            TodoStatus::Completed,
            "the change reached disk"
        );

        clear(&thread).ok();
    }
}
