//! Append-only thread summary index.
//!
//! `threads-index.jsonl` powers the chat list in the UI: one line per thread,
//! holding the title, last activity timestamp, message count, and a short
//! preview. Renaming a thread or deleting one only requires appending a new
//! line; we never rewrite history mid-file.
#![allow(dead_code)]
//
// `compact()` and `CompactionStats` fields are wired up by the writer's
// background-compaction path; the read-only helpers (`load_active`, etc.)
// are consumed by commands that haven't migrated yet.
//!
//! The cost of latest-wins is duplication. To stop the file from growing
//! without bound, the writer triggers compaction when:
//!
//! - the file exceeds [`COMPACT_AFTER_BYTES`], **and**
//! - more than half of all entries are duplicates of an earlier line.
//!
//! Compaction folds the file in memory, writes the canonical state to a
//! sibling temp file, and atomically renames it over the live file so other
//! readers always see a consistent snapshot.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::threads::paths;

/// Compaction threshold: only consider compacting once the file is at least
/// this big. Below this size the duplicate footprint is negligible.
const COMPACT_AFTER_BYTES: u64 = 256 * 1024; // 256 KiB

/// Compaction trigger ratio: if duplicates make up more than this fraction
/// of total lines, rewrite the file. 0.5 means "at least half of the lines
/// are stale".
const COMPACT_DUP_RATIO: f64 = 0.5;

// ============================================================================
// ERRORS
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to (de)serialize index entry: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("could not resolve agent paths: {0}")]
    Path(#[from] paths::PathError),
}

impl IndexError {
    fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type IndexResult<T> = Result<T, IndexError>;

// ============================================================================
// ENTRY
// ============================================================================

/// One row in the index. `deleted` is a tombstone — the entry stays in the
/// file (so we can recover from accidental deletion in a future schema) but
/// is filtered out by [`load_active`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIndexEntry {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub message_count: usize,
    pub created_at: String,
    pub updated_at: String,
    /// `true` once the thread has been deleted. Latest-wins semantics mean
    /// any later non-tombstone entry "undeletes" the thread.
    #[serde(default)]
    pub deleted: bool,
}

impl ThreadIndexEntry {
    /// Build a tombstone for `id` with the current timestamp.
    pub fn tombstone(id: impl Into<String>) -> Self {
        let now = crate::threads::events::now_rfc3339_ms();
        Self {
            id: id.into(),
            title: String::new(),
            preview: String::new(),
            message_count: 0,
            created_at: now.clone(),
            updated_at: now,
            deleted: true,
        }
    }
}

// ============================================================================
// API
// ============================================================================

/// Append (or upsert) one entry. Latest-wins folding happens at read time.
///
/// After every successful append, considers whether to compact the file.
pub fn upsert(path: impl AsRef<Path>, entry: &ThreadIndexEntry) -> IndexResult<()> {
    let path = path.as_ref().to_path_buf();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| IndexError::io(parent.to_path_buf(), e))?;
    }
    append_line(&path, entry)?;
    maybe_compact(&path)?;
    Ok(())
}

/// Append a tombstone marking the thread as deleted (does not remove the
/// per-thread JSONL file — that's the caller's responsibility).
pub fn delete(path: impl AsRef<Path>, thread_id: &str) -> IndexResult<()> {
    upsert(path, &ThreadIndexEntry::tombstone(thread_id))
}

/// Load the index and return all *active* (non-deleted) threads, sorted by
/// `updated_at` descending (most recent first).
pub fn load_active(path: impl AsRef<Path>) -> IndexResult<Vec<ThreadIndexEntry>> {
    let folded = load_folded(path)?;
    let mut active: Vec<_> = folded.into_values().filter(|e| !e.deleted).collect();
    active.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(active)
}

/// Load the index, returning the latest entry for *every* thread id including
/// tombstones. Useful for diagnostics / repair tooling.
pub fn load_folded(path: impl AsRef<Path>) -> IndexResult<HashMap<String, ThreadIndexEntry>> {
    let path = path.as_ref();
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(IndexError::io(path.to_path_buf(), e)),
    };
    let reader = BufReader::new(file);

    let mut out: HashMap<String, ThreadIndexEntry> = HashMap::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => return Err(IndexError::io(path.to_path_buf(), e)),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: ThreadIndexEntry = match serde_json::from_str(trimmed) {
            Ok(e) => e,
            Err(_) => continue, // tolerate corrupt rows; matches reader policy
        };
        // Latest wins.
        out.insert(entry.id.clone(), entry);
    }
    Ok(out)
}

/// Force a compaction now (mainly for tests / shutdown hook).
pub fn compact(path: impl AsRef<Path>) -> IndexResult<CompactionStats> {
    let path = path.as_ref();
    let folded = load_folded(path)?;
    write_folded(path, &folded)
}

// ============================================================================
// INTERNALS
// ============================================================================

#[derive(Debug, Clone, Copy)]
pub struct CompactionStats {
    pub lines_before: u64,
    pub lines_after: u64,
}

fn append_line(path: &Path, entry: &ThreadIndexEntry) -> IndexResult<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| IndexError::io(path.to_path_buf(), e))?;
    let mut line = serde_json::to_vec(entry)?;
    line.push(b'\n');
    file.write_all(&line)
        .map_err(|e| IndexError::io(path.to_path_buf(), e))?;
    file.flush()
        .map_err(|e| IndexError::io(path.to_path_buf(), e))?;
    Ok(())
}

fn maybe_compact(path: &Path) -> IndexResult<()> {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(IndexError::io(path.to_path_buf(), e)),
    };
    if metadata.len() < COMPACT_AFTER_BYTES {
        return Ok(());
    }

    let (total_lines, unique_ids) = count_lines_and_unique_ids(path)?;
    if total_lines == 0 {
        return Ok(());
    }
    let dup_ratio = 1.0 - (unique_ids as f64 / total_lines as f64);
    if dup_ratio < COMPACT_DUP_RATIO {
        return Ok(());
    }

    let folded = load_folded(path)?;
    let _ = write_folded(path, &folded)?;
    Ok(())
}

fn count_lines_and_unique_ids(path: &Path) -> IndexResult<(u64, u64)> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(IndexError::io(path.to_path_buf(), e)),
    };
    let reader = BufReader::new(file);
    let mut total = 0u64;
    let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in reader.lines() {
        let line = line.map_err(|e| IndexError::io(path.to_path_buf(), e))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        total += 1;
        if let Ok(entry) = serde_json::from_str::<ThreadIndexEntry>(trimmed) {
            ids.insert(entry.id);
        }
    }
    Ok((total, ids.len() as u64))
}

fn write_folded(
    path: &Path,
    folded: &HashMap<String, ThreadIndexEntry>,
) -> IndexResult<CompactionStats> {
    let lines_before = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let tmp = path.with_extension("jsonl.tmp");
    {
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| IndexError::io(tmp.clone(), e))?;
        let mut buf = BufWriter::new(file);
        // Stable order on disk so a `git diff` of the agent dir is readable.
        let mut entries: Vec<&ThreadIndexEntry> = folded.values().collect();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        for entry in entries {
            let mut line = serde_json::to_vec(entry)?;
            line.push(b'\n');
            buf.write_all(&line)
                .map_err(|e| IndexError::io(tmp.clone(), e))?;
        }
        buf.flush().map_err(|e| IndexError::io(tmp.clone(), e))?;
    }

    std::fs::rename(&tmp, path).map_err(|e| IndexError::io(path.to_path_buf(), e))?;

    Ok(CompactionStats {
        lines_before,
        lines_after: folded.len() as u64,
    })
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str, updated_at: &str) -> ThreadIndexEntry {
        ThreadIndexEntry {
            id: id.into(),
            title: title.into(),
            preview: "preview".into(),
            message_count: 1,
            created_at: "2026-05-03T11:00:00.000Z".into(),
            updated_at: updated_at.into(),
            deleted: false,
        }
    }

    /// Latest-wins: the most recent line for an id is what shows up in
    /// `load_active`.
    #[test]
    fn latest_entry_wins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads-index.jsonl");

        upsert(&path, &entry("a", "Original", "2026-05-03T11:00:00.000Z")).unwrap();
        upsert(&path, &entry("a", "Renamed", "2026-05-03T11:01:00.000Z")).unwrap();
        upsert(&path, &entry("b", "Other", "2026-05-03T10:00:00.000Z")).unwrap();

        let active = load_active(&path).unwrap();
        assert_eq!(active.len(), 2);
        let by_id: HashMap<_, _> = active.iter().map(|e| (e.id.clone(), e)).collect();
        assert_eq!(by_id["a"].title, "Renamed");
        assert_eq!(by_id["b"].title, "Other");
        // Sort order: most recently updated first.
        assert_eq!(active[0].id, "a");
        assert_eq!(active[1].id, "b");
    }

    /// Tombstones hide threads from `load_active` but the row still exists.
    #[test]
    fn tombstone_hides_thread_from_active_view() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads-index.jsonl");

        upsert(&path, &entry("a", "Active", "2026-05-03T11:00:00.000Z")).unwrap();
        delete(&path, "a").unwrap();

        let active = load_active(&path).unwrap();
        assert!(active.is_empty(), "deleted thread should not appear");

        let folded = load_folded(&path).unwrap();
        assert!(folded["a"].deleted);
    }

    /// A later non-tombstone entry effectively undeletes a thread (useful
    /// for crash recovery: if delete and recreate race, the recreate wins).
    #[test]
    fn later_entry_undeletes_a_tombstoned_thread() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads-index.jsonl");

        upsert(&path, &entry("a", "v1", "2026-05-03T11:00:00.000Z")).unwrap();
        delete(&path, "a").unwrap();
        upsert(&path, &entry("a", "v2", "2026-05-03T12:00:00.000Z")).unwrap();

        let active = load_active(&path).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].title, "v2");
    }

    /// Compaction folds all duplicates into one canonical row per id.
    #[test]
    fn compact_collapses_duplicate_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads-index.jsonl");

        // 50 duplicate writes for the same thread.
        for i in 0..50 {
            upsert(
                &path,
                &entry(
                    "a",
                    &format!("v{i}"),
                    &format!("2026-05-03T11:{:02}:00.000Z", i),
                ),
            )
            .unwrap();
        }
        let stats = compact(&path).unwrap();
        assert_eq!(stats.lines_after, 1, "all 50 rows fold into 1");
        let active = load_active(&path).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].title, "v49");
    }

    /// Corrupt rows are skipped silently — they don't poison the load.
    #[test]
    fn corrupt_row_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads-index.jsonl");

        upsert(&path, &entry("a", "ok", "2026-05-03T11:00:00.000Z")).unwrap();
        // Append junk.
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"this is not json\n").unwrap();

        let active = load_active(&path).unwrap();
        assert_eq!(active.len(), 1);
    }

    /// Reading a missing index file returns an empty list (not an error).
    #[test]
    fn missing_index_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.jsonl");
        assert!(load_active(&path).unwrap().is_empty());
    }
}
