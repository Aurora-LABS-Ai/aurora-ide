//! The facts Aurora was asked to remember.
//!
//! Written only by the model calling `remember` — there is no automatic
//! extraction pass. That was a deliberate choice: extraction costs a model call
//! on every turn and accumulates facts nobody asked for, which then pollute
//! every later recall. A tool call happens at the moment of noticing, is
//! visible in the transcript, and costs nothing on the turns where nothing was
//! learned.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::ChatMemory;
use crate::db::DbResult;

/// How many facts ride in a conversation's first message.
///
/// Five, not "all of them". The whole list would grow without bound and be
/// re-sent on every request of every conversation forever; five plus a
/// searchable `recall` gives the same "it knows me" feeling at a fixed cost.
pub const INJECTED_FACT_COUNT: usize = 5;

/// Longest a single fact may be, in characters.
///
/// A fact is a sentence about the user, not a transcript. Without a cap the
/// model can write a paragraph, and five paragraphs is no longer a small
/// injected prefix. Enforced on write so the cap cannot be exceeded by
/// something already on disk.
pub const MAX_FACT_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub text: String,
    pub pinned: bool,
    pub source_chat_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_fact(row: &rusqlite::Row<'_>) -> rusqlite::Result<Fact> {
    Ok(Fact {
        id: row.get("id")?,
        text: row.get("text")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        source_chat_id: row.get("source_chat_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Trim, collapse runs of whitespace, and clamp to [`MAX_FACT_CHARS`].
///
/// Clamping counts CHARACTERS, not bytes: slicing a UTF-8 string at a byte
/// offset panics mid-codepoint, and a fact about a person's name is exactly
/// where that would happen.
fn normalize(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_FACT_CHARS {
        return collapsed;
    }
    collapsed.chars().take(MAX_FACT_CHARS).collect()
}

impl ChatMemory {
    /// Record a fact. Returns the stored row.
    ///
    /// **Remembering the same thing twice updates the existing fact rather than
    /// adding a second copy.** Models restate what they know, and without this
    /// a long conversation ends with four spellings of one fact crowding out
    /// the other four slots. Matching is on the normalized text, so a
    /// difference of spacing or trailing punctuation-free whitespace is not a
    /// new fact.
    pub fn remember(
        &self,
        text: &str,
        source_chat_id: Option<&str>,
    ) -> DbResult<Option<Fact>> {
        let text = normalize(text);
        // An empty fact is not a fact. Silently ignoring it is right: the model
        // called the tool, and failing the turn over a blank string helps
        // nobody.
        if text.is_empty() {
            return Ok(None);
        }
        let now = chrono::Utc::now().to_rfc3339();

        self.with_conn(|conn| {
            if let Some(existing) = conn
                .query_row(
                    "SELECT * FROM facts WHERE text = ?1",
                    params![text],
                    row_to_fact,
                )
                .optional()?
            {
                // Touch it so restating a fact counts as recent, which is what
                // decides whether it rides in the injected five.
                conn.execute(
                    "UPDATE facts SET updated_at = ?2 WHERE id = ?1",
                    params![existing.id, now],
                )?;
                return Ok(Some(Fact {
                    updated_at: now.clone(),
                    ..existing
                }));
            }

            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO facts (id, text, pinned, source_chat_id, created_at, updated_at)
                 VALUES (?1, ?2, 0, ?3, ?4, ?4)",
                params![id, text, source_chat_id, now],
            )?;
            Ok(Some(Fact {
                id,
                text,
                pinned: false,
                source_chat_id: source_chat_id.map(str::to_string),
                created_at: now.clone(),
                updated_at: now,
            }))
        })
    }

    /// The facts that ride in a conversation's first message.
    ///
    /// **Pinned first, then most recently written, up to `limit`.** Pure
    /// recency was the alternative and it buries the thing you care about the
    /// moment the model learns three things about something else — at which
    /// point your only recourse is deleting the newer ones.
    pub fn facts_for_injection(&self, limit: usize) -> DbResult<Vec<Fact>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT * FROM facts
                 ORDER BY pinned DESC, created_at DESC, id
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], row_to_fact)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Every fact, newest first, pinned on top. Powers the Memory panel.
    pub fn all_facts(&self) -> DbResult<Vec<Fact>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT * FROM facts ORDER BY pinned DESC, created_at DESC, id",
            )?;
            let rows = stmt.query_map([], row_to_fact)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Full-text search over facts, best match first.
    pub fn search_facts(&self, query: &str, limit: usize) -> DbResult<Vec<Fact>> {
        let Some(match_expr) = super::search::to_match_expression(query) else {
            return Ok(Vec::new());
        };
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT f.* FROM facts f
                 JOIN facts_fts ON facts_fts.rowid = f.rowid
                 WHERE facts_fts MATCH ?1
                 ORDER BY rank
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![match_expr, limit as i64], row_to_fact)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Rewrite a fact's text. The fastest way to fix a wrong one.
    pub fn update_fact(&self, id: &str, text: &str) -> DbResult<bool> {
        let text = normalize(text);
        if text.is_empty() {
            return Ok(false);
        }
        let now = chrono::Utc::now().to_rfc3339();
        self.with_conn(|conn| {
            let changed = conn.execute(
                "UPDATE facts SET text = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, text, now],
            )?;
            Ok(changed > 0)
        })
    }

    pub fn set_fact_pinned(&self, id: &str, pinned: bool) -> DbResult<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        self.with_conn(|conn| {
            let changed = conn.execute(
                "UPDATE facts SET pinned = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, i64::from(pinned), now],
            )?;
            Ok(changed > 0)
        })
    }

    pub fn forget_fact(&self, id: &str) -> DbResult<bool> {
        self.with_conn(|conn| {
            let changed = conn.execute("DELETE FROM facts WHERE id = ?1", params![id])?;
            Ok(changed > 0)
        })
    }

    /// Add a fact by hand, from the Memory panel.
    ///
    /// Separate from [`Self::remember`] only in that it is the user speaking,
    /// so it has no source conversation. Worth having: the quickest fix for a
    /// fact the model got wrong is writing the right one yourself.
    pub fn add_fact_manually(&self, text: &str) -> DbResult<Option<Fact>> {
        self.remember(text, None)
    }
}

/// Render facts as the XML block that rides in a conversation's first message.
///
/// Empty when there are no facts — an empty `<memory/>` element still costs
/// tokens on every request and tells the model nothing.
#[must_use]
pub fn render_fact_block(facts: &[Fact]) -> String {
    if facts.is_empty() {
        return String::new();
    }
    let mut out = String::from("<memory>\n");
    for fact in facts {
        // Escaped, because a fact is text the model wrote and a stray `<` would
        // otherwise open a tag inside Aurora's own block.
        out.push_str("  <fact>");
        for ch in fact.text.chars() {
            match ch {
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '&' => out.push_str("&amp;"),
                _ => out.push(ch),
            }
        }
        out.push_str("</fact>\n");
    }
    out.push_str("</memory>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembering_the_same_fact_twice_does_not_duplicate_it() {
        let memory = ChatMemory::in_memory().unwrap();
        memory.remember("Alvan prefers plain language", Some("c1")).unwrap();
        memory.remember("Alvan prefers plain language", Some("c2")).unwrap();

        let facts = memory.all_facts().unwrap();
        assert_eq!(facts.len(), 1, "models restate what they know");
        // The ORIGINAL source is kept: it is where the fact was actually
        // learned, and the restatement taught nothing new.
        assert_eq!(facts[0].source_chat_id.as_deref(), Some("c1"));
    }

    #[test]
    fn whitespace_differences_are_not_a_new_fact() {
        let memory = ChatMemory::in_memory().unwrap();
        memory.remember("Alvan prefers plain language", None).unwrap();
        memory.remember("  Alvan   prefers\nplain language  ", None).unwrap();
        assert_eq!(memory.all_facts().unwrap().len(), 1);
    }

    #[test]
    fn an_empty_fact_is_ignored_rather_than_stored() {
        let memory = ChatMemory::in_memory().unwrap();
        assert!(memory.remember("   ", None).unwrap().is_none());
        assert!(memory.all_facts().unwrap().is_empty());
    }

    /// Clamping counts characters. Slicing UTF-8 at a byte offset panics
    /// mid-codepoint, and a fact about someone's name is exactly where that
    /// would happen.
    #[test]
    fn a_very_long_fact_is_clamped_without_splitting_a_character() {
        let memory = ChatMemory::in_memory().unwrap();
        let long = "é".repeat(MAX_FACT_CHARS + 200);
        let fact = memory.remember(&long, None).unwrap().unwrap();
        assert_eq!(fact.text.chars().count(), MAX_FACT_CHARS);
    }

    #[test]
    fn injection_puts_pinned_facts_first() {
        let memory = ChatMemory::in_memory().unwrap();
        for text in ["one", "two", "three", "four", "five", "six"] {
            memory.remember(text, None).unwrap();
        }
        // "one" is the OLDEST, so pure recency would drop it entirely.
        let oldest = memory
            .all_facts()
            .unwrap()
            .into_iter()
            .find(|f| f.text == "one")
            .unwrap();
        memory.set_fact_pinned(&oldest.id, true).unwrap();

        let injected = memory.facts_for_injection(INJECTED_FACT_COUNT).unwrap();
        assert_eq!(injected.len(), INJECTED_FACT_COUNT);
        assert_eq!(injected[0].text, "one", "pinned outranks recent");
    }

    #[test]
    fn injection_is_capped() {
        let memory = ChatMemory::in_memory().unwrap();
        for i in 0..40 {
            memory.remember(&format!("fact number {i}"), None).unwrap();
        }
        assert_eq!(
            memory.facts_for_injection(INJECTED_FACT_COUNT).unwrap().len(),
            INJECTED_FACT_COUNT
        );
    }

    #[test]
    fn facts_are_searchable() {
        let memory = ChatMemory::in_memory().unwrap();
        memory.remember("Alvan is building Aurora, an AI code editor", None).unwrap();
        memory.remember("The kitchen tap drips", None).unwrap();

        let hits = memory.search_facts("aurora", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.contains("Aurora"));
    }

    #[test]
    fn editing_and_forgetting_work_and_reindex() {
        let memory = ChatMemory::in_memory().unwrap();
        let fact = memory.remember("Alvan likes verbose prose", None).unwrap().unwrap();

        memory.update_fact(&fact.id, "Alvan wants plain language").unwrap();
        assert!(memory.search_facts("verbose", 10).unwrap().is_empty());
        assert_eq!(memory.search_facts("plain", 10).unwrap().len(), 1);

        assert!(memory.forget_fact(&fact.id).unwrap());
        assert!(memory.all_facts().unwrap().is_empty());
        assert!(memory.search_facts("plain", 10).unwrap().is_empty());
    }

    #[test]
    fn updating_or_forgetting_something_that_is_gone_says_so() {
        let memory = ChatMemory::in_memory().unwrap();
        assert!(!memory.update_fact("nope", "text").unwrap());
        assert!(!memory.forget_fact("nope").unwrap());
        assert!(!memory.set_fact_pinned("nope", true).unwrap());
    }

    #[test]
    fn the_block_is_empty_when_there_is_nothing_to_say() {
        assert_eq!(render_fact_block(&[]), "");
    }

    #[test]
    fn the_block_escapes_what_the_model_wrote() {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .remember("Alvan uses <script> tags & ampersands", None)
            .unwrap();
        let block = render_fact_block(&memory.all_facts().unwrap());
        assert!(block.contains("&lt;script&gt;"));
        assert!(block.contains("&amp;"));
        assert!(!block.contains("<script>"), "no raw tag may reach the model");
    }
}
