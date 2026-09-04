//! `chats.db` — the schema, and the reason it is allowed to be lost.
//!
//! Aurora Chat's conversations live as folders under `paths::chats_dir()`.
//! **The folders are the truth. This database is an index built from them**,
//! and every table here can be rebuilt by walking those folders (see
//! [`super::rebuild`]).
//!
//! That is not a detail. If the database were the only copy, one bad write
//! would cost you your history; because it is derived, a corrupt or deleted
//! `chats.db` costs a rebuild. The same rule already governs `sessions/`, where
//! the `.jsonl` is canonical and `.meta.json` is a listing sidecar.
//!
//! ## Why a second database
//!
//! `aurora.db` holds configuration: providers, models, settings, tool
//! approvals. Losing it means reconfiguring the app. `chats.db` holds a
//! rebuildable index over conversation text. They have different lifetimes,
//! different recovery stories, and different sizes — a person with a thousand
//! research chats should not be carrying that in the file that also stores
//! which theme they picked. Deleting Aurora Chat's history is deleting one
//! folder, and that has to include its index.
//!
//! ## Full-text search
//!
//! FTS5 is available with no extra dependency: `libsqlite3-sys` compiles the
//! bundled SQLite with `-DSQLITE_ENABLE_FTS5` unconditionally (verified in its
//! `build.rs`). The `_fts` tables are `contentless-delete` external-content
//! tables mirroring their base table through triggers, so the text is stored
//! once rather than twice.

use rusqlite::Connection;

use crate::db::DbResult;

/// Bumped when the shape below changes. On a mismatch the file is deleted and
/// rebuilt from the conversation folders rather than migrated — the whole
/// point of a derived index is that migrating it is never worth writing.
pub const CHAT_DB_VERSION: i32 = 1;

pub fn initialize(conn: &Connection) -> DbResult<()> {
    // WAL so a long research turn appending messages does not block the rail's
    // listing query, and `NORMAL` because a lost transaction on a derived index
    // is recovered by a rebuild rather than by a fsync.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    create_chats(conn)?;
    create_messages(conn)?;
    create_facts(conn)?;
    conn.pragma_update(None, "user_version", CHAT_DB_VERSION)?;
    Ok(())
}

/// The rail's list. Exists so opening the window does not read a thousand
/// JSONL files to draw a sidebar.
fn create_chats(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,                 -- conversation id = its folder name
            title TEXT NOT NULL DEFAULT '',
            preview TEXT NOT NULL DEFAULT '',    -- first line of the last user message
            message_count INTEGER NOT NULL DEFAULT 0,
            model TEXT,                          -- the model this conversation is on
            pinned INTEGER NOT NULL DEFAULT 0,
            archived_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC)",
        [],
    )?;
    Ok(())
}

/// Every message, so `recall` can find one. `seq` is its position in the
/// conversation, which is what `op: \"section\"` reads back a range of.
fn create_messages(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            chat_id TEXT NOT NULL,
            seq INTEGER NOT NULL,                -- 0-based position in the conversation
            role TEXT NOT NULL,                  -- user | assistant | system
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (chat_id, seq),
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // External-content FTS: the text lives in `messages` and this table indexes
    // it, rather than storing a second copy of every research transcript.
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            text,
            content='messages',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )",
        [],
    )?;

    // Triggers rather than hand-written index maintenance: a write path that
    // forgets to update the index produces a search that silently misses, which
    // is the worst failure this feature has.
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END",
        [],
    )?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END",
        [],
    )?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
            INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END",
        [],
    )?;
    Ok(())
}

/// What Aurora remembered, written by the model calling `remember`.
///
/// The one table here that is NOT rebuildable from the conversation folders:
/// a fact is a judgement the model made, not text it can be re-derived from.
/// It is therefore also the one that survives the deletion of the chat that
/// taught it — `source_chat_id` is deliberately not a foreign key, so removing
/// a conversation cannot cascade a fact away. A fact is about the user, not
/// about the conversation that happened to produce it.
fn create_facts(conn: &Connection) -> DbResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS facts (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,   -- pinned facts are injected first
            source_chat_id TEXT,                 -- where it was learned; NOT a foreign key
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_facts_recent ON facts(pinned DESC, created_at DESC)",
        [],
    )?;
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
            text,
            content='facts',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )",
        [],
    )?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
            INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
        END",
        [],
    )?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
            INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END",
        [],
    )?;
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
            INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
            INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
        END",
        [],
    )?;
    Ok(())
}
