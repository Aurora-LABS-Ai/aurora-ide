//! Reading the index back — what `recall` is built on.
//!
//! Four operations, escalating. `search` is cheap and answers most questions;
//! `read` and `section` go back to the same conversation for exact text when it
//! did not. The model is expected to start cheap, which is why `search` returns
//! the conversation id alongside every hit: the id is the handle for going
//! deeper without searching again.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::ChatMemory;
use crate::db::DbResult;

/// How much of a matching message comes back in a search hit.
///
/// Enough to judge relevance, not enough to answer from. A hit that carried the
/// whole message would blow the model's context on three results, which is
/// exactly the situation `read` and `section` exist to handle deliberately.
pub const SNIPPET_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatRow {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub message_count: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub chat_id: String,
    pub chat_title: String,
    pub seq: i64,
    pub role: String,
    /// The matching text, clipped to [`SNIPPET_CHARS`].
    pub snippet: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub seq: i64,
    pub role: String,
    pub text: String,
    pub created_at: String,
}

fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

impl ChatMemory {
    /// Every conversation, newest first. The rail's list.
    pub fn list_chats(&self) -> DbResult<Vec<ChatRow>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, preview, message_count, updated_at
                 FROM chats
                 WHERE archived_at IS NULL
                 ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ChatRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    preview: row.get(2)?,
                    message_count: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// `recall op: "search"` — ranked snippets across every conversation.
    ///
    /// Ordered by FTS5's own `rank`, which is relevance rather than recency.
    /// Recency is already how the rail is sorted; someone asking `recall` a
    /// question wants the best answer, not the newest one.
    pub fn search_messages(&self, query: &str, limit: usize) -> DbResult<Vec<MessageHit>> {
        let Some(match_expr) = super::search::to_match_expression(query) else {
            return Ok(Vec::new());
        };
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT m.chat_id, c.title, m.seq, m.role, m.text, m.created_at
                 FROM messages_fts
                 JOIN messages m ON m.rowid = messages_fts.rowid
                 JOIN chats c ON c.id = m.chat_id
                 WHERE messages_fts MATCH ?1
                 ORDER BY rank
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![match_expr, limit as i64], |row| {
                let text: String = row.get(4)?;
                Ok(MessageHit {
                    chat_id: row.get(0)?,
                    chat_title: row.get(1)?,
                    seq: row.get(2)?,
                    role: row.get(3)?,
                    snippet: clip(&text, SNIPPET_CHARS),
                    created_at: row.get(5)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// `recall op: "read"` — one conversation's messages, paged.
    ///
    /// Paged rather than whole: a research conversation can be hundreds of
    /// messages, and returning all of them is how a `recall` call costs more
    /// than the answer is worth.
    pub fn read_chat(
        &self,
        chat_id: &str,
        offset: usize,
        limit: usize,
    ) -> DbResult<Vec<MessageRow>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT seq, role, text, created_at
                 FROM messages
                 WHERE chat_id = ?1
                 ORDER BY seq
                 LIMIT ?3 OFFSET ?2",
            )?;
            let rows = stmt.query_map(params![chat_id, offset as i64, limit as i64], |row| {
                Ok(MessageRow {
                    seq: row.get(0)?,
                    role: row.get(1)?,
                    text: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// `recall op: "section"` — an exact range of one conversation, inclusive.
    ///
    /// This is the deep end: the model has a conversation id and knows roughly
    /// where in it the thing was, and wants the real text rather than a
    /// snippet. Bounds are clamped rather than rejected, so an off-by-one guess
    /// returns what is there instead of an error.
    pub fn read_section(
        &self,
        chat_id: &str,
        from_seq: i64,
        to_seq: i64,
    ) -> DbResult<Vec<MessageRow>> {
        let (lo, hi) = if from_seq <= to_seq {
            (from_seq, to_seq)
        } else {
            // A reversed range is a mistake with an obvious intent. Swapping is
            // kinder than an error message the model has to interpret.
            (to_seq, from_seq)
        };
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT seq, role, text, created_at
                 FROM messages
                 WHERE chat_id = ?1 AND seq BETWEEN ?2 AND ?3
                 ORDER BY seq",
            )?;
            let rows = stmt.query_map(params![chat_id, lo.max(0), hi], |row| {
                Ok(MessageRow {
                    seq: row.get(0)?,
                    role: row.get(1)?,
                    text: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Does the index know this conversation? Used to tell a real "not found"
    /// apart from a conversation that simply has no matching messages.
    pub fn chat_exists(&self, chat_id: &str) -> DbResult<bool> {
        self.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT count(*) FROM chats WHERE id = ?1",
                params![chat_id],
                |row| row.get(0),
            )?;
            Ok(count > 0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> ChatMemory {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, preview, message_count, created_at, updated_at)
                     VALUES ('c1', 'Steel tariffs', 'p', 4, '2026-09-01', '2026-09-01')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO chats (id, title, preview, message_count, created_at, updated_at)
                     VALUES ('c2', 'Kitchen', 'p', 1, '2026-09-02', '2026-09-02')",
                    [],
                )?;
                let rows = [
                    ("c1", 0, "user", "what are the tariffs on imported steel"),
                    ("c1", 1, "assistant", "The rate is 25 percent as of 2026"),
                    ("c1", 2, "user", "and on aluminium"),
                    ("c1", 3, "assistant", "Aluminium is 10 percent"),
                    ("c2", 0, "user", "the kitchen tap drips"),
                ];
                for (chat, seq, role, text) in rows {
                    conn.execute(
                        "INSERT INTO messages (chat_id, seq, role, text, created_at)
                         VALUES (?1, ?2, ?3, ?4, '2026-09-01')",
                        params![chat, seq, role, text],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        memory
    }

    #[test]
    fn search_returns_the_conversation_id_so_the_model_can_go_deeper() {
        let memory = seeded();
        let hits = memory.search_messages("aluminium", 10).unwrap();
        assert_eq!(hits.len(), 2, "the question and the answer both match");
        assert!(hits.iter().all(|hit| hit.chat_id == "c1"));
        assert!(hits.iter().all(|hit| hit.chat_title == "Steel tariffs"));
    }

    #[test]
    fn search_requires_every_word() {
        let memory = seeded();
        assert_eq!(memory.search_messages("tariffs steel", 10).unwrap().len(), 1);
        // "steel" is in c1 and "kitchen" in c2, so nothing has both.
        assert!(memory.search_messages("steel kitchen", 10).unwrap().is_empty());
    }

    #[test]
    fn search_honours_its_limit() {
        let memory = seeded();
        assert_eq!(memory.search_messages("percent", 1).unwrap().len(), 1);
    }

    #[test]
    fn a_query_with_no_searchable_words_returns_nothing_rather_than_erroring() {
        let memory = seeded();
        assert!(memory.search_messages("???", 10).unwrap().is_empty());
        assert!(memory.search_messages("", 10).unwrap().is_empty());
    }

    #[test]
    fn snippets_are_clipped() {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, created_at, updated_at)
                     VALUES ('c1', 't', '2026-09-01', '2026-09-01')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO messages (chat_id, seq, role, text, created_at)
                     VALUES ('c1', 0, 'user', ?1, '2026-09-01')",
                    params![format!("needle {}", "x".repeat(SNIPPET_CHARS * 3))],
                )?;
                Ok(())
            })
            .unwrap();

        let hit = &memory.search_messages("needle", 10).unwrap()[0];
        assert!(hit.snippet.chars().count() <= SNIPPET_CHARS + 1);
        assert!(hit.snippet.ends_with('…'));
    }

    #[test]
    fn reading_a_chat_is_paged_and_in_order() {
        let memory = seeded();
        let page = memory.read_chat("c1", 0, 2).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].seq, 0);
        assert_eq!(page[1].seq, 1);

        let next = memory.read_chat("c1", 2, 2).unwrap();
        assert_eq!(next[0].seq, 2);
    }

    #[test]
    fn reading_past_the_end_returns_nothing_rather_than_erroring() {
        let memory = seeded();
        assert!(memory.read_chat("c1", 500, 10).unwrap().is_empty());
        assert!(memory.read_chat("no-such-chat", 0, 10).unwrap().is_empty());
    }

    #[test]
    fn a_section_returns_the_exact_range_inclusive() {
        let memory = seeded();
        let section = memory.read_section("c1", 1, 2).unwrap();
        assert_eq!(section.len(), 2);
        assert_eq!(section[0].seq, 1);
        assert_eq!(section[1].seq, 2);
        // The real text, not a snippet — that is what `section` is for.
        assert!(section[0].text.contains("25 percent"));
    }

    /// An off-by-one guess should return what is there, not an error the model
    /// has to interpret and retry around.
    #[test]
    fn a_section_clamps_instead_of_failing() {
        let memory = seeded();
        assert_eq!(memory.read_section("c1", -5, 99).unwrap().len(), 4);
        // Reversed bounds are a mistake with an obvious intent.
        assert_eq!(memory.read_section("c1", 2, 1).unwrap().len(), 2);
    }

    #[test]
    fn archived_chats_stay_out_of_the_list() {
        let memory = seeded();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE chats SET archived_at = '2026-09-03' WHERE id = 'c2'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let listed = memory.list_chats().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "c1");
    }

    /// …but an archived chat is still SEARCHABLE. Archiving means "out of my
    /// way", not "forget it happened", and the whole point of recall is finding
    /// something you are no longer looking at.
    #[test]
    fn archived_chats_remain_searchable() {
        let memory = seeded();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE chats SET archived_at = '2026-09-03' WHERE id = 'c2'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(memory.search_messages("kitchen", 10).unwrap().len(), 1);
    }

    #[test]
    fn chats_are_listed_newest_first() {
        let memory = seeded();
        let listed = memory.list_chats().unwrap();
        assert_eq!(listed[0].id, "c2", "updated 09-02");
        assert_eq!(listed[1].id, "c1", "updated 09-01");
    }

    #[test]
    fn existence_is_answerable() {
        let memory = seeded();
        assert!(memory.chat_exists("c1").unwrap());
        assert!(!memory.chat_exists("nope").unwrap());
    }
}
