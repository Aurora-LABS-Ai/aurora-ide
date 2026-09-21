//! Tauri command backing the Agent Window's task checklist.
//!
//! The checklist used to be rebuilt on the frontend by parsing `todo_write`
//! tool-call arguments as they streamed. That copy could only ever be as good
//! as the one tool it watched — `todo_update` (the tool the agent actually uses
//! for progress) moved nothing, and reopening a conversation showed an empty
//! panel while the list sat on disk. Rust owns the list; the UI reads it.
//!
//! Pairs with the `agent_todo_write` event: this command is the cold-start /
//! reconcile path, the event is the live path.

use crate::tools::shell_editor_todo::todo_store;

/// The checklist for one conversation, straight from its sidecar file.
///
/// An unknown thread is an empty list, not an error — a conversation that never
/// tracked anything is the normal case, and a panel is not worth failing a
/// window open over.
#[tauri::command]
pub async fn todo_list_for_thread(thread_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = thread_id.trim();
        if trimmed.is_empty() {
            return Err("thread_id must not be empty".into());
        }
        Ok(todo_store::read(trimmed)?.to_event_payload())
    })
    .await
    .map_err(|e| format!("Checklist loading failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use todo_store::{TodoItem, TodoList, TodoStatus};

    #[tokio::test]
    async fn reads_the_list_a_tool_wrote() {
        let thread = format!("cmd-todos-{}", uuid::Uuid::new_v4());
        crate::agent_runtime::project_dir::test_thread(&thread);
        todo_store::write(
            &thread,
            &TodoList {
                items: vec![TodoItem {
                    id: "1".into(),
                    content: "Wire auth".into(),
                    description: "Add the login redirect".into(),
                    active_form: "Wiring auth".into(),
                    status: TodoStatus::InProgress,
                }],
            },
        )
        .expect("seed");

        let payload = todo_list_for_thread(thread.clone()).await.expect("read");
        // Ids are plain numbers since the checklist took `TaskCreate`'s shape.
        let items = payload.as_array().expect("array");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "1");
        assert_eq!(items[0]["content"], "Wire auth");
        assert_eq!(items[0]["description"], "Add the login redirect");
        assert_eq!(items[0]["activeForm"], "Wiring auth");
        assert_eq!(items[0]["status"], "in_progress");

        todo_store::clear(&thread).ok();
    }

    #[tokio::test]
    async fn an_untracked_thread_is_an_empty_list_not_an_error() {
        let payload = todo_list_for_thread(format!("never-{}", uuid::Uuid::new_v4()))
            .await
            .expect("must not error");
        assert!(payload.as_array().expect("array").is_empty());
    }

    #[tokio::test]
    async fn an_empty_thread_id_is_rejected() {
        assert!(todo_list_for_thread("   ".into()).await.is_err());
    }
}
