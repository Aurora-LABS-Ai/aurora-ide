//! Keeping the index in step with the conversation folders.
//!
//! Two ways in, and the second is what makes the first safe to get wrong:
//!
//! - [`ChatMemory::index_chat`] updates one conversation, called after a turn
//!   writes to it.
//! - [`ChatMemory::rebuild_from_folders`] walks the whole store and rebuilds
//!   from scratch.
//!
//! Because a rebuild exists, an incremental update that fails is a stale row
//! rather than lost history — so every path here is best-effort by design and
//! logs rather than failing a turn the user is watching.

use std::path::Path;

use rusqlite::params;

use super::ChatMemory;
use crate::agent_runtime::session::Session;
use crate::agent_runtime::session_store::SessionStore;
use crate::agent_runtime::types::{ContentBlock, MessageRole};
use crate::db::DbResult;

/// Longest single message text kept in the index, in characters.
///
/// The index exists to FIND a message, not to store it — the conversation
/// folder already has the full text and `recall`'s `read` and `section`
/// operations go there for it. A research chat can hold a fetched page of tens
/// of thousands of characters, and indexing those whole would make `chats.db`
/// a second, worse copy of the transcript.
pub const MAX_INDEXED_CHARS: usize = 4_000;

/// What the rail shows under a conversation's title.
const PREVIEW_CHARS: usize = 120;

/// A message's epoch-millisecond timestamp as RFC3339.
///
/// An out-of-range value falls back to now rather than failing the index. A
/// nonsense timestamp on one message is not worth losing a conversation's
/// searchability over, and RFC3339 is what every other timestamp in the index
/// is, so a mixed format would break sorting far more visibly.
fn epoch_ms_to_rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

fn clamp(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

/// The plain text of a message, with everything that is not prose dropped.
///
/// Tool calls, tool results and images are deliberately excluded. `recall`
/// answers "what did we say about X", and a transcript full of base64 and JSON
/// arguments would both bloat the index and match queries for reasons nobody
/// would recognise.
fn message_text(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for block in blocks {
        if let ContentBlock::Text { text } = block {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    out.trim().to_string()
}

impl ChatMemory {
    /// Re-index one conversation from its folder.
    ///
    /// Replaces every row for it rather than diffing. A conversation is at most
    /// a few hundred messages, a delete-and-insert inside one transaction is
    /// microseconds, and a diff would be the only place a subtle "the index
    /// disagrees with the transcript" bug could live.
    pub fn index_chat(&self, store: &SessionStore, thread_id: &str) -> DbResult<()> {
        let path = store.session_path(thread_id);
        let session = match Session::load_from_path(thread_id, &path) {
            Ok(session) => session,
            // No transcript yet is not an error: a conversation exists from the
            // moment it is created, and its first turn has not landed.
            Err(_) => return Ok(()),
        };
        let meta = store.load_metadata(thread_id).ok();

        let mut rows: Vec<(i64, String, String, String)> = Vec::new();
        let mut preview = String::new();
        for (seq, message) in session.messages().iter().enumerate() {
            let text = message_text(&message.blocks);
            if text.is_empty() {
                continue;
            }
            let role = match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
                MessageRole::System => "system",
                // A tool message carries results, not conversation. Its text
                // blocks are already excluded by `message_text` in practice,
                // but skipping the row outright keeps `recall` answering
                // "what did we SAY about X" rather than surfacing a fetched
                // page nobody would recognise as an answer.
                MessageRole::Tool => continue,
            };
            // The rail shows the LAST thing the user said, which is what a
            // person scanning for a conversation is looking for.
            if message.role == MessageRole::User {
                preview = clamp(text.lines().next().unwrap_or_default().trim(), PREVIEW_CHARS);
            }
            rows.push((
                seq as i64,
                role.to_string(),
                clamp(&text, MAX_INDEXED_CHARS),
                // `timestamp` is epoch milliseconds; the index stores RFC3339
                // so its rows sort and compare the same way every other
                // timestamp in Aurora does.
                epoch_ms_to_rfc3339(message.timestamp),
            ));
        }

        let (title, model, pinned, archived_at, created_at, updated_at) = match &meta {
            Some(meta) => (
                meta.title.clone(),
                meta.model.clone(),
                meta.pinned,
                meta.archived_at.clone(),
                meta.created_at.clone(),
                meta.updated_at.clone(),
            ),
            None => {
                let now = chrono::Utc::now().to_rfc3339();
                (String::new(), None, false, None, now.clone(), now)
            }
        };
        let message_count = rows.len() as i64;

        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO chats (id, title, preview, message_count, model, pinned, archived_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title,
                   preview = excluded.preview,
                   message_count = excluded.message_count,
                   model = excluded.model,
                   pinned = excluded.pinned,
                   archived_at = excluded.archived_at,
                   updated_at = excluded.updated_at",
                params![
                    thread_id,
                    title,
                    preview,
                    message_count,
                    model,
                    i64::from(pinned),
                    archived_at,
                    created_at,
                    updated_at
                ],
            )?;
            // The triggers keep `messages_fts` in step with this, so the
            // delete removes the old text from the search index too.
            tx.execute("DELETE FROM messages WHERE chat_id = ?1", params![thread_id])?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO messages (chat_id, seq, role, text, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )?;
                for (seq, role, text, created_at) in &rows {
                    stmt.execute(params![thread_id, seq, role, text, created_at])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Drop a conversation from the index. Its messages go by cascade; its
    /// facts deliberately do not.
    pub fn forget_chat(&self, thread_id: &str) -> DbResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM chats WHERE id = ?1", params![thread_id])?;
            Ok(())
        })
    }

    /// Rebuild the whole index by walking the conversation folders.
    ///
    /// This is the method that makes `chats.db` disposable, and therefore the
    /// method that makes every other write path here allowed to be
    /// best-effort. Run after a fresh or replaced database.
    ///
    /// Returns how many conversations were indexed.
    pub fn rebuild_from_folders(&self, store: &SessionStore) -> DbResult<usize> {
        let started = std::time::Instant::now();
        self.with_conn(|conn| {
            // Not a `DROP`: the tables and their triggers stay, so the FTS
            // index is maintained by the same rules during a rebuild as during
            // normal use. `facts` is untouched — it is not derived from
            // anything and a rebuild must never take it.
            conn.execute("DELETE FROM chats", [])?;
            Ok(())
        })?;

        let mut indexed = 0usize;
        for summary in store.list_summaries().unwrap_or_default() {
            match self.index_chat(store, &summary.id) {
                Ok(()) => indexed += 1,
                Err(err) => {
                    // One unreadable conversation must not abort the rebuild
                    // and leave every LATER conversation unsearchable.
                    crate::logging::log_warn(
                        "chat_memory",
                        &format!("could not index chat {}: {err}", summary.id),
                    );
                }
            }
        }
        crate::logging::log_info(
            "chat_memory",
            &format!(
                "rebuilt the chat index: {indexed} conversation(s) in {}ms",
                started.elapsed().as_millis()
            ),
        );
        Ok(indexed)
    }

    /// Open the index for a chat store, rebuilding it when the file was
    /// missing or had to be replaced.
    ///
    /// The one entry point production should use — it is what ties "a corrupt
    /// database is deleted" to "and then it comes back".
    pub fn open_for_store(dir: &Path, store: &SessionStore) -> DbResult<Self> {
        let (memory, fresh) = Self::open(dir)?;
        if fresh {
            memory.rebuild_from_folders(store)?;
        }
        Ok(memory)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::types::ConversationMessage;

    fn store_with_chats() -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new_folder(dir.path().join("Chats"));
        (dir, store)
    }

    fn write_chat(store: &SessionStore, id: &str, title: &str, texts: &[(&str, &str)]) {
        store.ensure_thread(id, Some(title.to_string()), None).unwrap();
        let mut session = Session::new(id);
        for (index, (role, text)) in texts.iter().enumerate() {
            // Ascending timestamps so ordering in the index is meaningful.
            let ts = 1_788_000_000_000 + index as i64;
            let message = match *role {
                "user" => ConversationMessage::user_text(*text, ts),
                _ => ConversationMessage::assistant(
                    vec![ContentBlock::Text {
                        text: (*text).to_string(),
                    }],
                    ts,
                ),
            };
            session.append_message(message);
        }
        session.save_to_path(store.session_path(id)).unwrap();
    }

    #[test]
    fn indexing_a_chat_makes_its_messages_searchable() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        write_chat(
            &store,
            "c1",
            "Tariff research",
            &[
                ("user", "what are the tariffs on imported steel"),
                ("assistant", "As of 2026 the rate is 25 percent"),
            ],
        );

        memory.index_chat(&store, "c1").unwrap();

        let hits = memory.search_messages("steel", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chat_id, "c1");
        assert_eq!(hits[0].chat_title, "Tariff research");
    }

    #[test]
    fn the_preview_is_the_last_thing_the_user_said() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        write_chat(
            &store,
            "c1",
            "t",
            &[
                ("user", "first question"),
                ("assistant", "an answer"),
                ("user", "second question"),
                ("assistant", "another answer"),
            ],
        );
        memory.index_chat(&store, "c1").unwrap();

        let chats = memory.list_chats().unwrap();
        assert_eq!(chats[0].preview, "second question");
        assert_eq!(chats[0].message_count, 4);
    }

    /// Re-indexing replaces rather than accumulates. Without this, every turn
    /// would add a second copy of the whole conversation to the search index.
    #[test]
    fn re_indexing_replaces_rather_than_duplicates() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        write_chat(&store, "c1", "t", &[("user", "hello there")]);

        memory.index_chat(&store, "c1").unwrap();
        memory.index_chat(&store, "c1").unwrap();
        memory.index_chat(&store, "c1").unwrap();

        assert_eq!(memory.search_messages("hello", 10).unwrap().len(), 1);
        assert_eq!(memory.list_chats().unwrap()[0].message_count, 1);
    }

    /// A message removed from the transcript must leave the search index, or
    /// `recall` returns a hit that cannot be opened.
    #[test]
    fn re_indexing_a_shortened_chat_drops_the_missing_text() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        write_chat(
            &store,
            "c1",
            "t",
            &[("user", "keep this"), ("assistant", "forget this")],
        );
        memory.index_chat(&store, "c1").unwrap();
        assert_eq!(memory.search_messages("forget", 10).unwrap().len(), 1);

        write_chat(&store, "c1", "t", &[("user", "keep this")]);
        memory.index_chat(&store, "c1").unwrap();
        assert!(memory.search_messages("forget", 10).unwrap().is_empty());
    }

    #[test]
    fn a_conversation_with_no_transcript_yet_is_not_an_error() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        store.ensure_thread("c1", Some("brand new".into()), None).unwrap();
        memory.index_chat(&store, "c1").expect("a new chat is normal");
    }

    /// A fetched web page is tens of thousands of characters. The index exists
    /// to find a message, not to be a second copy of the transcript.
    #[test]
    fn a_very_long_message_is_clamped_in_the_index() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        let huge = format!("needle {}", "padding ".repeat(20_000));
        write_chat(&store, "c1", "t", &[("assistant", &huge)]);
        memory.index_chat(&store, "c1").unwrap();

        memory
            .with_conn(|conn| {
                let len: i64 = conn.query_row(
                    "SELECT length(text) FROM messages WHERE chat_id = 'c1'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(len as usize <= MAX_INDEXED_CHARS);
                Ok(())
            })
            .unwrap();
        // …and the beginning is still findable.
        assert_eq!(memory.search_messages("needle", 10).unwrap().len(), 1);
    }

    #[test]
    fn rebuilding_indexes_every_conversation_in_the_store() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        write_chat(&store, "c1", "one", &[("user", "alpha")]);
        write_chat(&store, "c2", "two", &[("user", "beta")]);
        write_chat(&store, "c3", "three", &[("user", "gamma")]);

        assert_eq!(memory.rebuild_from_folders(&store).unwrap(), 3);
        assert_eq!(memory.list_chats().unwrap().len(), 3);
        assert_eq!(memory.search_messages("beta", 10).unwrap().len(), 1);
    }

    /// The claim the whole design rests on: throw the index away and it comes
    /// back from the folders.
    #[test]
    fn a_rebuild_restores_an_index_that_was_wiped() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        write_chat(&store, "c1", "one", &[("user", "findable text")]);
        memory.rebuild_from_folders(&store).unwrap();

        memory.with_conn(|conn| {
            conn.execute("DELETE FROM chats", [])?;
            Ok(())
        })
        .unwrap();
        assert!(memory.search_messages("findable", 10).unwrap().is_empty());

        memory.rebuild_from_folders(&store).unwrap();
        assert_eq!(memory.search_messages("findable", 10).unwrap().len(), 1);
    }

    /// Facts are NOT derived from the folders, so a rebuild must not take them.
    /// This is the test that stops someone turning the rebuild into a `DROP`.
    #[test]
    fn a_rebuild_does_not_touch_the_facts() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        memory.remember("Alvan prefers plain language", Some("c1")).unwrap();
        write_chat(&store, "c1", "one", &[("user", "hello")]);

        memory.rebuild_from_folders(&store).unwrap();

        assert_eq!(memory.all_facts().unwrap().len(), 1);
    }

    #[test]
    fn forgetting_a_chat_removes_it_and_its_messages() {
        let (_g, store) = store_with_chats();
        let memory = ChatMemory::in_memory().unwrap();
        write_chat(&store, "c1", "one", &[("user", "disappearing")]);
        memory.index_chat(&store, "c1").unwrap();

        memory.forget_chat("c1").unwrap();

        assert!(memory.list_chats().unwrap().is_empty());
        assert!(memory.search_messages("disappearing", 10).unwrap().is_empty());
    }
}
