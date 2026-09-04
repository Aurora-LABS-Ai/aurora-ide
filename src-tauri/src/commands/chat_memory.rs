//! IPC for the Memory page — what Aurora remembers about the user.
//!
//! Every one of these is `async` + `spawn_blocking`. A sync `#[tauri::command]`
//! runs on the UI thread in Tauri v2, and these all touch SQLite; the same
//! mistake froze the whole window during boot when the chat listing was
//! synchronous. `commands/command_thread_safety.rs` has the test that pins the
//! rule.
//!
//! Errors are strings rather than a typed error because that is what every
//! other command family here returns, and the page shows them verbatim.

use crate::chat_memory::facts::Fact;

/// The service, or a message the page can show.
///
/// Named once so all seven commands fail the same way. "Unavailable" is a real
/// state — the index is a file that can fail to open — and it should read as an
/// explanation rather than as a blank list.
fn memory() -> Result<&'static crate::chat_memory::ChatMemory, String> {
    crate::chat_memory::service().ok_or_else(|| {
        "Aurora's memory index could not be opened. Restart Aurora to try again.".to_string()
    })
}

/// Everything Aurora has remembered, pinned first then newest.
#[tauri::command]
pub async fn chat_memory_list_facts() -> Result<Vec<Fact>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        memory()?
            .all_facts()
            .map_err(|err| format!("Could not read what Aurora remembers: {err}"))
    })
    .await
    .map_err(|err| format!("Reading memory failed: {err}"))?
}

/// Add a fact by hand.
///
/// The quickest way to fix a fact the model got wrong is to write the right one
/// yourself, which is why this exists alongside editing.
#[tauri::command]
pub async fn chat_memory_add_fact(text: String) -> Result<Option<Fact>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory()?
            .add_fact_manually(&text)
            .map_err(|err| format!("Could not save that: {err}"))
    })
    .await
    .map_err(|err| format!("Saving failed: {err}"))?
}

/// Rewrite a fact.
#[tauri::command]
pub async fn chat_memory_update_fact(id: String, text: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory()?
            .update_fact(&id, &text)
            .map_err(|err| format!("Could not update that: {err}"))
    })
    .await
    .map_err(|err| format!("Updating failed: {err}"))?
}

/// Pin or unpin. Pinned facts are the ones injected first.
#[tauri::command]
pub async fn chat_memory_set_fact_pinned(id: String, pinned: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory()?
            .set_fact_pinned(&id, pinned)
            .map_err(|err| format!("Could not pin that: {err}"))
    })
    .await
    .map_err(|err| format!("Pinning failed: {err}"))?
}

/// Forget one fact, permanently.
#[tauri::command]
pub async fn chat_memory_forget_fact(id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory()?
            .forget_fact(&id)
            .map_err(|err| format!("Could not forget that: {err}"))
    })
    .await
    .map_err(|err| format!("Forgetting failed: {err}"))?
}

/// Search what Aurora remembers. Powers the Memory page's filter once the list
/// is long enough to need one.
#[tauri::command]
pub async fn chat_memory_search_facts(query: String, limit: Option<u32>) -> Result<Vec<Fact>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory()?
            .search_facts(&query, limit.unwrap_or(50) as usize)
            .map_err(|err| format!("Could not search memory: {err}"))
    })
    .await
    .map_err(|err| format!("Searching failed: {err}"))?
}

/// What the Memory page shows above the list.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    /// Conversations currently in the search index.
    pub indexed_chats: usize,
    /// Facts Aurora is holding.
    pub facts: usize,
}

/// How much Aurora is actually remembering.
///
/// The page needs this for the rebuild button to mean anything: "Rebuild" with
/// no number beside it is a button whose effect you cannot see, and the whole
/// point of exposing a rebuild is that you can tell whether it did something.
#[tauri::command]
pub async fn chat_memory_stats() -> Result<MemoryStats, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let memory = memory()?;
        let indexed_chats = memory
            .list_chats()
            .map_err(|err| format!("Could not read the index: {err}"))?
            .len();
        let facts = memory
            .all_facts()
            .map_err(|err| format!("Could not read what Aurora remembers: {err}"))?
            .len();
        Ok(MemoryStats {
            indexed_chats,
            facts,
        })
    })
    .await
    .map_err(|err| format!("Reading memory failed: {err}"))?
}

/// Rebuild the conversation index from the folders on disk.
///
/// Exposed because the index is derived and therefore repairable by hand. If
/// search ever disagrees with what is plainly in a conversation, this is the
/// answer, and it cannot lose anything: the folders are the truth, and facts
/// are not touched by a rebuild.
///
/// Returns how many conversations were indexed.
#[tauri::command]
pub async fn chat_memory_rebuild_index() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = crate::paths::chats_dir();
        let store = crate::agent_runtime::session_store::SessionStore::new_folder(dir);
        memory()?
            .rebuild_from_folders(&store)
            .map_err(|err| format!("Could not rebuild the index: {err}"))
    })
    .await
    .map_err(|err| format!("Rebuilding failed: {err}"))?
}
