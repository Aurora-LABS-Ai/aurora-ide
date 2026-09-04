//! Aurora Chat's memory — the searchable index over its conversations, and the
//! facts it has been asked to remember.
//!
//! Two things live here, and they are not the same kind of thing:
//!
//! - **The index** (`chats`, `messages`) is DERIVED from the conversation
//!   folders under `paths::chats_dir()`. Losing it costs a rebuild.
//! - **The facts** are not derivable from anything. They are judgements the
//!   model made when it called `remember`, and they are the one thing in this
//!   file that a rebuild cannot reconstruct.
//!
//! That asymmetry decides the recovery story: a corrupt or version-mismatched
//! database is deleted and rebuilt, and the facts inside it are the only loss.
//! See [`open`].

pub mod facts;
pub mod index;
pub mod query;
pub mod schema;
pub mod search;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::db::DbResult;

/// The database file inside `paths::chats_dir()`.
///
/// Beside the conversation folders rather than in `data/`, so that deleting
/// Aurora Chat's history is deleting one directory and cannot leave an index
/// pointing at conversations that no longer exist.
pub const CHAT_DB_FILE: &str = "chats.db";

/// A handle to `chats.db`.
///
/// Cheap to clone; the connection is shared behind a mutex. SQLite serialises
/// writers anyway, and every operation here is short — a search, a row append,
/// a fact write — so a connection pool would be machinery without a problem.
#[derive(Clone)]
pub struct ChatMemory {
    conn: Arc<Mutex<Connection>>,
    dir: PathBuf,
}

impl std::fmt::Debug for ChatMemory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatMemory").field("dir", &self.dir).finish()
    }
}

impl ChatMemory {
    /// Open (or create) the index for the chat store rooted at `dir`.
    ///
    /// **A database that cannot be opened, or that was written by a different
    /// schema version, is deleted and recreated rather than repaired.** That is
    /// the licence the derived-index design buys: repairing an index nobody can
    /// read is a lot of code to preserve something a directory walk
    /// reconstructs. The caller is expected to follow a fresh open with
    /// [`Self::rebuild_from_folders`].
    ///
    /// Returns whether the file was (re)created, so the caller knows a rebuild
    /// is owed rather than having to guess.
    pub fn open(dir: &Path) -> DbResult<(Self, bool)> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(CHAT_DB_FILE);

        let mut fresh = !path.exists();
        let conn = match Self::open_at(&path) {
            Ok(conn) => conn,
            Err(err) => {
                crate::logging::log_warn(
                    "chat_memory",
                    &format!(
                        "chats.db could not be opened ({err}); rebuilding it from the conversation folders"
                    ),
                );
                let _ = std::fs::remove_file(&path);
                // WAL leaves these beside the database; a stale pair against a
                // fresh file is how a "corrupt" database comes straight back.
                let _ = std::fs::remove_file(path.with_extension("db-wal"));
                let _ = std::fs::remove_file(path.with_extension("db-shm"));
                fresh = true;
                Self::open_at(&path)?
            }
        };

        Ok((
            Self {
                conn: Arc::new(Mutex::new(conn)),
                dir: dir.to_path_buf(),
            },
            fresh,
        ))
    }

    /// Open in memory. Tests only — nothing persists.
    ///
    /// `cfg(test)` rather than always compiled: production must never get a
    /// memory that silently forgets everything, and the compiler is a better
    /// guarantee of that than a comment.
    #[cfg(test)]
    pub fn in_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory()?;
        schema::initialize(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            dir: PathBuf::from(":memory:"),
        })
    }

    fn open_at(path: &Path) -> DbResult<Connection> {
        let conn = Connection::open(path)?;
        let version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        // Version 0 is a database this code has never touched — either brand
        // new, or created before the pragma was set. Initialising is safe
        // either way because every statement is `IF NOT EXISTS`.
        if version != 0 && version != schema::CHAT_DB_VERSION {
            return Err(crate::db::DbError::Migration(format!(
                "chats.db is version {version}, this build expects {}",
                schema::CHAT_DB_VERSION
            )));
        }
        schema::initialize(&conn)?;
        Ok(conn)
    }

    /// Run `f` against the connection.
    ///
    /// (Kept below the service accessor so the file reads top-down: how you get
    /// a handle, then what you can do with one.)
    ///
    /// A poisoned mutex is recovered rather than propagated: it means some
    /// other thread panicked mid-query, and refusing every later read because
    /// of it would turn one failure into a dead feature.
    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> DbResult<T>) -> DbResult<T> {
        let guard = match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&guard)
    }
}

/// The process-wide handle, so a tool can reach the index without threading it
/// through `ToolContext`.
///
/// Same shape as `code_index::service()`, and for the same reason: this is one
/// file on disk belonging to one application, not per-turn state. Threading it
/// through the tool context would put a field on every tool call in Aurora for
/// the benefit of two of them.
///
/// Initialised lazily against `paths::chats_dir()` on first use, and rebuilt
/// from the conversation folders when the database was missing or unreadable.
/// `None` only if that fails outright, in which case the memory tools report a
/// clear error instead of the whole window failing to start.
static SERVICE: std::sync::OnceLock<Option<ChatMemory>> = std::sync::OnceLock::new();

pub fn service() -> Option<&'static ChatMemory> {
    SERVICE
        .get_or_init(|| {
            let dir = crate::paths::chats_dir();
            let store =
                crate::agent_runtime::session_store::SessionStore::new_folder(dir.clone());
            match ChatMemory::open_for_store(&dir, &store) {
                Ok(memory) => Some(memory),
                Err(err) => {
                    crate::logging::log_error(
                        "chat_memory",
                        &format!("chat memory is unavailable: {err}"),
                    );
                    None
                }
            }
        })
        .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_database_reports_itself_as_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let (_memory, fresh) = ChatMemory::open(dir.path()).unwrap();
        assert!(fresh, "a database that did not exist owes a rebuild");
        assert!(dir.path().join(CHAT_DB_FILE).exists());
    }

    #[test]
    fn reopening_an_existing_database_does_not_ask_for_a_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let (_first, fresh) = ChatMemory::open(dir.path()).unwrap();
        assert!(fresh);
        let (_second, fresh_again) = ChatMemory::open(dir.path()).unwrap();
        assert!(!fresh_again, "the file was already there");
    }

    /// The licence the derived-index design buys. A file that cannot be read is
    /// replaced, and the caller is told to rebuild — rather than the whole
    /// feature failing because one file went bad.
    #[test]
    fn a_corrupt_database_is_replaced_rather_than_fatal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CHAT_DB_FILE), b"this is not a database").unwrap();

        let (memory, fresh) = ChatMemory::open(dir.path()).expect("must not fail");
        assert!(fresh, "a replaced database owes a rebuild");
        memory
            .with_conn(|conn| {
                let count: i64 =
                    conn.query_row("SELECT count(*) FROM chats", [], |row| row.get(0))?;
                assert_eq!(count, 0);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn a_database_from_a_future_version_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        {
            let conn = Connection::open(dir.path().join(CHAT_DB_FILE)).unwrap();
            schema::initialize(&conn).unwrap();
            conn.pragma_update(None, "user_version", schema::CHAT_DB_VERSION + 99)
                .unwrap();
        }
        let (_memory, fresh) = ChatMemory::open(dir.path()).unwrap();
        assert!(fresh);
    }

    #[test]
    fn full_text_search_is_actually_available() {
        // If this ever fails, the bundled SQLite stopped compiling FTS5 in and
        // every `recall` becomes a table scan or an error. Worth its own test:
        // the availability was established by reading libsqlite3-sys's build.rs
        // rather than by running anything.
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, created_at, updated_at)
                     VALUES ('c1', 'a chat', '2026-09-04', '2026-09-04')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO messages (chat_id, seq, role, text, created_at)
                     VALUES ('c1', 0, 'user', 'tariffs on imported steel', '2026-09-04')",
                    [],
                )?;
                let hits: i64 = conn.query_row(
                    "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'tariffs'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(hits, 1);
                Ok(())
            })
            .unwrap();
    }

    /// The FTS index is maintained by triggers, not by the write path. A write
    /// path that forgets to update the index produces a search that silently
    /// misses, which is the worst failure this feature has.
    #[test]
    fn deleting_a_message_removes_it_from_the_search_index() {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, created_at, updated_at)
                     VALUES ('c1', 'a chat', '2026-09-04', '2026-09-04')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO messages (chat_id, seq, role, text, created_at)
                     VALUES ('c1', 0, 'user', 'quantum widgets', '2026-09-04')",
                    [],
                )?;
                conn.execute("DELETE FROM messages WHERE chat_id = 'c1'", [])?;
                let hits: i64 = conn.query_row(
                    "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'quantum'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(hits, 0, "the index must not outlive the row");
                Ok(())
            })
            .unwrap();
    }

    /// Deleting a conversation takes its messages, by cascade.
    #[test]
    fn deleting_a_chat_takes_its_messages() {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, created_at, updated_at)
                     VALUES ('c1', 'a chat', '2026-09-04', '2026-09-04')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO messages (chat_id, seq, role, text, created_at)
                     VALUES ('c1', 0, 'user', 'hello', '2026-09-04')",
                    [],
                )?;
                conn.execute("DELETE FROM chats WHERE id = 'c1'", [])?;
                let left: i64 =
                    conn.query_row("SELECT count(*) FROM messages", [], |row| row.get(0))?;
                assert_eq!(left, 0);
                Ok(())
            })
            .unwrap();
    }

    /// A fact outlives the conversation that taught it. `source_chat_id` is
    /// deliberately not a foreign key, so this is the test that stops someone
    /// "fixing" that later.
    #[test]
    fn a_fact_survives_the_deletion_of_its_chat() {
        let memory = ChatMemory::in_memory().unwrap();
        memory
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chats (id, title, created_at, updated_at)
                     VALUES ('c1', 'a chat', '2026-09-04', '2026-09-04')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO facts (id, text, source_chat_id, created_at, updated_at)
                     VALUES ('f1', 'Alvan prefers plain language', 'c1', '2026-09-04', '2026-09-04')",
                    [],
                )?;
                conn.execute("DELETE FROM chats WHERE id = 'c1'", [])?;

                let left: i64 =
                    conn.query_row("SELECT count(*) FROM facts", [], |row| row.get(0))?;
                assert_eq!(left, 1, "a fact is about the user, not about the chat");
                // …and it is still findable.
                let hits: i64 = conn.query_row(
                    "SELECT count(*) FROM facts_fts WHERE facts_fts MATCH 'plain'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(hits, 1);
                Ok(())
            })
            .unwrap();
    }
}
