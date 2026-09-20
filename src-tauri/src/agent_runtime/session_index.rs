//! `index.db` — a listing cache for a conversation store.
//!
//! **The conversation files are the truth. This is an index built from them.**
//! Every row can be rebuilt by reading the file it describes, so a corrupt or
//! deleted index costs a slow first listing, never history. Same rule
//! `chats.db` states for itself in [`crate::chat_memory::schema`], and the same
//! rule `sessions/` already lives by, where the `.jsonl` is canonical and
//! `.meta.json` is a sidecar.
//!
//! ## Why it exists
//!
//! Listing used to read **every conversation end to end** on every call:
//! `summarize_thread` walked each `.jsonl` line by line for two values, the
//! message count and the last user line. That is work proportional to the
//! total size of every conversation ever held, repeated on every listing, and
//! it is the boot path that draws the chat rail. At 1204 threads it took
//! 611 ms and got slower with every message sent.
//!
//! With this, a listing reads one database and opens no conversation at all.
//!
//! ## Staying honest
//!
//! A cache that can be wrong is worse than no cache, so every row carries the
//! size and modified time of the two files it was built from. A listing
//! compares those against what is on disk and re-reads only the threads that
//! actually changed. Edit a file outside Aurora, delete one by hand, restore a
//! backup — the next listing notices and corrects itself.
//!
//! Getting those stamps is free in the flat layout: one directory read returns
//! the metadata for every file in it, so checking 1204 threads costs one
//! syscall batch rather than 1204 opens. See [`super::session_store`].

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::session_store::SessionSummary;

/// Bumped when the shape below changes. On a mismatch the file is deleted and
/// rebuilt rather than migrated — migrating a derived index is never worth
/// writing.
const INDEX_VERSION: i32 = 1;

/// Sits beside the conversations. In the flat layout the listing walk only
/// counts `.jsonl` files, and in the folder layout only directories, so this
/// file and SQLite's `-wal`/`-shm` companions are ignored by both.
pub const INDEX_FILE: &str = "index.db";

/// Size and modified time of the files a row was built from. Two files,
/// because the conversation carries the message count and preview while the
/// sidecar carries the title, pin and archive state — renaming a chat never
/// touches the conversation, so watching only that would go stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Fingerprint {
    pub log_size: u64,
    pub log_mtime: i64,
    pub meta_size: u64,
    pub meta_mtime: i64,
}

/// A cached listing row and the stamps that say whether it is still true.
pub struct CachedSummary {
    pub summary: SessionSummary,
    pub fingerprint: Fingerprint,
}

/// The listing cache for one store directory.
pub struct SessionIndex {
    conn: Mutex<Connection>,
}

impl SessionIndex {
    /// Open or create the index beside `dir`.
    ///
    /// A version mismatch or an unreadable file rebuilds from empty, which
    /// costs one slow listing. Returns `None` when even that fails; the caller
    /// then reads conversations directly, exactly as it did before this
    /// existed. Nothing here is allowed to stop a listing.
    pub fn open(dir: &Path) -> Option<Self> {
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
        let path = dir.join(INDEX_FILE);
        let conn = match Self::connect(&path) {
            Ok(conn) => conn,
            Err(err) => {
                crate::logging::log_warn(
                    "threads.index",
                    &format!("{} could not be opened ({err}); rebuilding it", path.display()),
                );
                let _ = std::fs::remove_file(&path);
                Self::connect(&path).ok()?
            }
        };
        Some(Self {
            conn: Mutex::new(conn),
        })
    }

    fn connect(path: &Path) -> rusqlite::Result<Connection> {
        let conn = Connection::open(path)?;
        // WAL so appending to a conversation never blocks the rail's listing,
        // and NORMAL because a lost transaction on a derived index is repaired
        // by re-reading a file, not by an fsync.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or(0);
        if version != INDEX_VERSION {
            conn.execute("DROP TABLE IF EXISTS threads", [])?;
        }
        conn.execute(
            "CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                preview TEXT NOT NULL DEFAULT '',
                message_count INTEGER NOT NULL DEFAULT 0,
                workspace_root TEXT,
                model TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                archived_at TEXT,
                deep_research INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                log_size INTEGER NOT NULL DEFAULT 0,
                log_mtime INTEGER NOT NULL DEFAULT 0,
                meta_size INTEGER NOT NULL DEFAULT 0,
                meta_mtime INTEGER NOT NULL DEFAULT 0
            )",
            [],
        )?;
        conn.pragma_update(None, "user_version", INDEX_VERSION)?;
        Ok(conn)
    }

    /// Every cached row, keyed by thread id. A read failure returns an empty
    /// map, which simply means everything looks new and gets re-read.
    pub fn load_all(&self) -> HashMap<String, CachedSummary> {
        let Ok(conn) = self.conn.lock() else {
            return HashMap::new();
        };
        let Ok(mut statement) = conn.prepare(
            "SELECT id, title, preview, message_count, workspace_root, model, pinned,
                    archived_at, deep_research, created_at, updated_at,
                    log_size, log_mtime, meta_size, meta_mtime
             FROM threads",
        ) else {
            return HashMap::new();
        };
        let rows = statement.query_map([], |row| {
            Ok(CachedSummary {
                summary: SessionSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    preview: row.get(2)?,
                    message_count: row.get::<_, i64>(3)?.max(0) as usize,
                    workspace_root: row.get(4)?,
                    model: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    archived_at: row.get(7)?,
                    deep_research: row.get::<_, i64>(8)? != 0,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                },
                fingerprint: Fingerprint {
                    log_size: row.get::<_, i64>(11)?.max(0) as u64,
                    log_mtime: row.get(12)?,
                    meta_size: row.get::<_, i64>(13)?.max(0) as u64,
                    meta_mtime: row.get(14)?,
                },
            })
        });
        let Ok(rows) = rows else {
            return HashMap::new();
        };
        rows.flatten()
            .map(|cached| (cached.summary.id.clone(), cached))
            .collect()
    }

    /// Write the rows that were re-read, and drop the ones whose files are
    /// gone, in one transaction.
    ///
    /// Every failure here is swallowed. The listing it belongs to has already
    /// produced the right answer from the files themselves; losing the cache
    /// write only means doing that work again next time.
    pub fn apply(&self, changed: &[(SessionSummary, Fingerprint)], removed: &[String]) {
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        let Ok(mut conn) = self.conn.lock() else {
            return;
        };
        let Ok(tx) = conn.transaction() else {
            return;
        };
        for (summary, fingerprint) in changed {
            let _ = tx.execute(
                "INSERT INTO threads (
                    id, title, preview, message_count, workspace_root, model, pinned,
                    archived_at, deep_research, created_at, updated_at,
                    log_size, log_mtime, meta_size, meta_mtime
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    preview = excluded.preview,
                    message_count = excluded.message_count,
                    workspace_root = excluded.workspace_root,
                    model = excluded.model,
                    pinned = excluded.pinned,
                    archived_at = excluded.archived_at,
                    deep_research = excluded.deep_research,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    log_size = excluded.log_size,
                    log_mtime = excluded.log_mtime,
                    meta_size = excluded.meta_size,
                    meta_mtime = excluded.meta_mtime",
                params![
                    summary.id,
                    summary.title,
                    summary.preview,
                    summary.message_count as i64,
                    summary.workspace_root,
                    summary.model,
                    i64::from(summary.pinned),
                    summary.archived_at,
                    i64::from(summary.deep_research),
                    summary.created_at,
                    summary.updated_at,
                    fingerprint.log_size as i64,
                    fingerprint.log_mtime,
                    fingerprint.meta_size as i64,
                    fingerprint.meta_mtime,
                ],
            );
        }
        for id in removed {
            let _ = tx.execute("DELETE FROM threads WHERE id = ?1", params![id]);
        }
        let _ = tx.commit();
    }

    /// Drop one row. Used when a thread is deleted through Aurora, so the next
    /// listing does not have to notice the absence for itself.
    pub fn forget(&self, thread_id: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute("DELETE FROM threads WHERE id = ?1", params![thread_id]);
        }
    }

    /// How many rows are cached. Only used by tests and diagnostics.
    pub fn len(&self) -> usize {
        let Ok(conn) = self.conn.lock() else {
            return 0;
        };
        conn.query_row("SELECT COUNT(*) FROM threads", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0)
        .max(0) as usize
    }
}

/// Size and modified time of one file, as `(size, milliseconds since epoch)`.
///
/// Milliseconds rather than seconds on purpose. Size alone misses a rename
/// from "Draft" to "Notes", and a second-resolution clock would miss it too
/// whenever the rename and the listing land in the same second — the cached
/// title would then be served as truth until something else about the thread
/// changed. NTFS records far finer than a millisecond, so keeping that
/// precision costs nothing and closes the case.
///
/// A file that cannot be read stamps as zero, which never matches a real
/// stamp, so the thread is re-read rather than served from a guess.
pub fn stamp(metadata: &std::fs::Metadata) -> (u64, i64) {
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (metadata.len(), mtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, count: usize) -> SessionSummary {
        SessionSummary {
            id: id.to_string(),
            title: format!("{id} title"),
            message_count: count,
            preview: "hello".into(),
            workspace_root: Some("C:/proj".into()),
            model: Some("p:m".into()),
            pinned: false,
            archived_at: None,
            deep_research: false,
            created_at: "2026-09-20T00:00:00Z".into(),
            updated_at: "2026-09-20T00:00:01Z".into(),
        }
    }

    fn fingerprint(size: u64) -> Fingerprint {
        Fingerprint {
            log_size: size,
            log_mtime: 1_700_000_000,
            meta_size: 120,
            meta_mtime: 1_700_000_001,
        }
    }

    #[test]
    fn a_row_comes_back_exactly_as_it_went_in() {
        // The listing serves these rows verbatim, so a field that does not
        // survive the round trip is a field the rail silently shows wrong.
        let dir = tempfile::tempdir().unwrap();
        let index = SessionIndex::open(dir.path()).expect("open");
        let want = summary("t1", 7);
        index.apply(&[(want.clone(), fingerprint(4096))], &[]);

        let loaded = index.load_all();
        let got = &loaded.get("t1").expect("row").summary;
        assert_eq!(
            serde_json::to_value(&want).unwrap(),
            serde_json::to_value(got).unwrap(),
        );
        assert_eq!(loaded["t1"].fingerprint, fingerprint(4096));
    }

    #[test]
    fn writing_the_same_thread_again_replaces_it_rather_than_duplicating() {
        let dir = tempfile::tempdir().unwrap();
        let index = SessionIndex::open(dir.path()).expect("open");
        index.apply(&[(summary("t1", 1), fingerprint(10))], &[]);
        index.apply(&[(summary("t1", 9), fingerprint(99))], &[]);

        assert_eq!(index.len(), 1);
        let loaded = index.load_all();
        assert_eq!(loaded["t1"].summary.message_count, 9);
        assert_eq!(loaded["t1"].fingerprint.log_size, 99);
    }

    #[test]
    fn a_removed_thread_leaves_no_row_behind() {
        let dir = tempfile::tempdir().unwrap();
        let index = SessionIndex::open(dir.path()).expect("open");
        index.apply(&[(summary("a", 1), fingerprint(1))], &[]);
        index.apply(&[(summary("b", 1), fingerprint(1))], &[]);
        index.apply(&[], &["a".to_string()]);

        let loaded = index.load_all();
        assert!(!loaded.contains_key("a"));
        assert!(loaded.contains_key("b"));
    }

    #[test]
    fn an_index_from_an_older_shape_is_thrown_away_not_migrated() {
        // The rebuild path is the whole reason this file is allowed to exist.
        // If a stale table ever survived a version bump, its rows would be
        // served as truth with columns that no longer mean what they did.
        let dir = tempfile::tempdir().unwrap();
        {
            let conn = Connection::open(dir.path().join(INDEX_FILE)).unwrap();
            conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, junk TEXT)", [])
                .unwrap();
            conn.execute("INSERT INTO threads VALUES ('old', 'x')", [])
                .unwrap();
            conn.pragma_update(None, "user_version", INDEX_VERSION - 1)
                .unwrap();
        }

        let index = SessionIndex::open(dir.path()).expect("open");
        assert_eq!(index.len(), 0, "the old table should have been dropped");
        index.apply(&[(summary("new", 2), fingerprint(5))], &[]);
        assert_eq!(index.load_all()["new"].summary.message_count, 2);
    }

    #[test]
    fn a_corrupt_file_is_replaced_instead_of_failing_the_listing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(INDEX_FILE), b"this is not a database").unwrap();

        let index = SessionIndex::open(dir.path()).expect("a corrupt index must still open");
        assert_eq!(index.len(), 0);
    }
}
