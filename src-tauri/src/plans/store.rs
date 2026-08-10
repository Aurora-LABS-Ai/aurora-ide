//! Plan file storage — `<workspace>/.aurora/plans/<nnn>-<slug>.aurora.md`.
//!
//! Disk is the source of truth. Nothing about a plan lives only in memory, so
//! stopping a run, switching workspace, or reopening the app hours later all
//! resolve to the same operation: read the file again.
//!
//! Writes are serialised through a process-wide lock and committed atomically
//! (temp → fsync → rename), the same shape as the Artifact Canvas sidecar, so
//! an agent write racing a user's hand-edit cannot leave a half-written plan.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use super::document::{self, PlanDocument, PlanParseError};
use super::model::{PlanFrontmatter, PlanStatus, PLAN_SCHEMA_VERSION};

/// Extension carried by every plan file. Ends in `.md` deliberately: editors,
/// diff viewers, and GitHub all render it as markdown for free.
pub const PLAN_EXT: &str = ".aurora.md";

const MAX_TITLE_LEN: usize = 120;
const MAX_PLAN_BYTES: usize = 1024 * 1024;

/// Serialises read-modify-write cycles across all plan files. Plan writes are
/// rare and small, so one lock is simpler and safer than risking a lost status
/// flip.
static PLAN_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> Result<MutexGuard<'static, ()>, String> {
    PLAN_LOCK
        .lock()
        .map_err(|_| "Plan storage lock was poisoned".to_string())
}

/// Lightweight listing entry — enough to populate a picker without parsing
/// every body.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub id: String,
    pub title: String,
    pub status: PlanStatus,
    pub updated_at: String,
    pub path: String,
    pub total_steps: usize,
    pub done_steps: usize,
}

/// `<workspace>/.aurora/plans` — sits beside the semantic index in the existing
/// `.aurora/` folder rather than adding a second dotfile at the repo root.
#[must_use]
pub fn plans_dir(workspace: &Path) -> PathBuf {
    workspace.join(".aurora").join("plans")
}

/// Filesystem-safe slug for a plan title.
#[must_use]
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.extend(ch.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let capped: String = trimmed.chars().take(48).collect();
    let capped = capped.trim_matches('-').to_string();
    if capped.is_empty() {
        "plan".to_string()
    } else {
        capped
    }
}

/// Next `nnn-` sequence prefix, one past the highest already on disk.
fn next_sequence(dir: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 1;
    };
    let mut max = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(PLAN_EXT) {
            continue;
        }
        let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(n) = digits.parse::<u32>() {
            max = max.max(n);
        }
    }
    max + 1
}

fn read_document(path: &Path) -> Result<PlanDocument, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Failed to stat plan file: {e}"))?;
    if meta.len() as usize > MAX_PLAN_BYTES {
        return Err(format!(
            "Plan file {} is larger than the {MAX_PLAN_BYTES} byte limit",
            path.display()
        ));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read plan file: {e}"))?;
    document::parse(&raw)
        .map_err(|e: PlanParseError| format!("{} could not be read as a plan: {e}", path.display()))
}

/// Every plan file in the workspace, newest-updated first.
///
/// Unreadable files are skipped rather than failing the whole listing — one
/// hand-broken plan must not hide the others.
pub fn list(workspace: &Path) -> Result<Vec<PlanSummary>, String> {
    let dir = plans_dir(workspace);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(PLAN_EXT))
        {
            continue;
        }
        let Ok(doc) = read_document(&path) else {
            continue;
        };
        let cursor = doc.frontmatter.cursor();
        out.push(PlanSummary {
            id: doc.frontmatter.id,
            title: doc.frontmatter.title,
            status: doc.frontmatter.status,
            updated_at: doc.frontmatter.updated_at,
            path: path.to_string_lossy().to_string(),
            total_steps: cursor.total,
            done_steps: cursor.done,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// Locate a plan file by its frontmatter id.
pub fn find_path(workspace: &Path, plan_id: &str) -> Result<Option<PathBuf>, String> {
    let dir = plans_dir(workspace);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(None);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(PLAN_EXT))
        {
            continue;
        }
        if let Ok(doc) = read_document(&path) {
            if doc.frontmatter.id == plan_id {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

pub fn load(workspace: &Path, plan_id: &str) -> Result<Option<(PathBuf, PlanDocument)>, String> {
    let _guard = lock()?;
    let Some(path) = find_path(workspace, plan_id)? else {
        return Ok(None);
    };
    let doc = read_document(&path)?;
    Ok(Some((path, doc)))
}

/// The plan the workspace is currently working from.
///
/// `Active` wins over `Draft`; anything terminal is ignored. Ties break on the
/// most recent `updatedAt`, so the plan the agent last touched is the one the
/// Canvas shows.
pub fn active(workspace: &Path) -> Result<Option<(PathBuf, PlanDocument)>, String> {
    let _guard = lock()?;
    active_unlocked(workspace)
}

fn active_unlocked(workspace: &Path) -> Result<Option<(PathBuf, PlanDocument)>, String> {
    let dir = plans_dir(workspace);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(None);
    };
    let mut best: Option<(u8, String, PathBuf, PlanDocument)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(PLAN_EXT))
        {
            continue;
        }
        let Ok(doc) = read_document(&path) else {
            continue;
        };
        let rank = match doc.frontmatter.status {
            PlanStatus::Active => 2,
            PlanStatus::Draft => 1,
            PlanStatus::Done | PlanStatus::Failed | PlanStatus::Abandoned => continue,
        };
        let updated = doc.frontmatter.updated_at.clone();
        let better = match &best {
            None => true,
            Some((best_rank, best_updated, _, _)) => {
                rank > *best_rank || (rank == *best_rank && updated > *best_updated)
            }
        };
        if better {
            best = Some((rank, updated, path, doc));
        }
    }
    Ok(best.map(|(_, _, path, doc)| (path, doc)))
}

/// Commit `bytes` to `path` without ever leaving a truncated file behind.
fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Plan path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create plans directory: {e}"))?;

    let temp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temp)
            .map_err(|e| format!("Failed to stage plan file: {e}"))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("Failed to flush plan file: {e}"))?;
    }

    if path.exists() {
        match fs::remove_file(&backup) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to prepare plan backup: {e}")),
        }
        fs::rename(path, &backup).map_err(|e| format!("Failed to back up plan file: {e}"))?;
    }
    if let Err(e) = fs::rename(&temp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!("Failed to commit plan file: {e}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

pub fn save(path: &Path, doc: &PlanDocument) -> Result<(), String> {
    let text = document::serialize(doc).map_err(|e| format!("Failed to encode plan: {e}"))?;
    if text.len() > MAX_PLAN_BYTES {
        return Err(format!(
            "Plan is larger than the {MAX_PLAN_BYTES} byte limit"
        ));
    }
    replace_file(path, text.as_bytes())
}

/// Read-modify-write a plan under the storage lock.
///
/// The whole cycle holds the lock so two concurrent status flips cannot read
/// the same base and lose one of the writes.
pub fn update<F>(workspace: &Path, plan_id: &str, mutate: F) -> Result<PlanDocument, String>
where
    F: FnOnce(&mut PlanDocument) -> Result<(), String>,
{
    let _guard = lock()?;
    let path = find_path(workspace, plan_id)?
        .ok_or_else(|| format!("No plan with id `{plan_id}` in this workspace"))?;
    let mut doc = read_document(&path)?;
    mutate(&mut doc)?;
    doc.frontmatter.updated_at = now_iso();
    save(&path, &doc)?;
    Ok(doc)
}

/// Create a new plan file, or overwrite an existing one with the same id.
pub fn create(
    workspace: &Path,
    frontmatter: PlanFrontmatter,
    body: String,
) -> Result<(PathBuf, PlanDocument), String> {
    let _guard = lock()?;
    let dir = plans_dir(workspace);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create plans directory: {e}"))?;

    let path = match find_path(workspace, &frontmatter.id)? {
        Some(existing) => existing,
        None => dir.join(format!(
            "{:03}-{}{}",
            next_sequence(&dir),
            slugify(&frontmatter.title),
            PLAN_EXT
        )),
    };
    let doc = PlanDocument { frontmatter, body };
    save(&path, &doc)?;
    Ok((path, doc))
}

#[must_use]
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[must_use]
pub fn new_plan_id() -> String {
    format!(
        "plan_{}",
        uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
    )
}

/// Validate an agent-supplied plan id.
///
/// Ids reach the filesystem only via `find_path` lookups, but they are compared
/// as strings and shown to the user, so keep them to a readable slug rather
/// than trusting arbitrary model output.
pub fn validate_plan_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Plan id must not be empty".to_string());
    }
    if trimmed.len() > 64 {
        return Err("Plan id must be at most 64 characters".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(
            "Plan id may only contain letters, numbers, dots, dashes, and underscores".to_string(),
        );
    }
    Ok(())
}

/// Validate a user/agent supplied title.
pub fn validate_title(title: &str) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Plan title must not be empty".to_string());
    }
    if trimmed.chars().count() > MAX_TITLE_LEN {
        return Err(format!(
            "Plan title must be at most {MAX_TITLE_LEN} characters"
        ));
    }
    Ok(())
}

#[must_use]
pub fn empty_frontmatter(title: &str, thread_id: Option<String>) -> PlanFrontmatter {
    let now = now_iso();
    PlanFrontmatter {
        aurora_plan: PLAN_SCHEMA_VERSION,
        id: new_plan_id(),
        title: title.trim().to_string(),
        status: PlanStatus::Draft,
        created_at: now.clone(),
        updated_at: now,
        thread_id,
        steps: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::model::{PlanStep, StepStatus};

    fn temp_workspace(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aurora-plans-test-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp workspace");
        dir
    }

    fn seed(workspace: &Path, title: &str, status: PlanStatus, updated: &str) -> String {
        let mut fm = empty_frontmatter(title, None);
        fm.status = status;
        fm.updated_at = updated.to_string();
        fm.steps = vec![PlanStep::new("s1", "Only step")];
        let id = fm.id.clone();
        create(workspace, fm, "## 1. Only step {#s1}\n\nBody.\n".into()).expect("create");
        id
    }

    #[test]
    fn slugify_produces_safe_filenames() {
        assert_eq!(slugify("API Building"), "api-building");
        assert_eq!(slugify("  Fix: the/thing!  "), "fix-the-thing");
        assert_eq!(slugify("///"), "plan");
        assert_eq!(slugify(""), "plan");
        assert!(slugify(&"x".repeat(200)).len() <= 48);
    }

    #[test]
    fn create_then_load_round_trips_through_disk() {
        let ws = temp_workspace("roundtrip");
        let id = seed(
            &ws,
            "API Building",
            PlanStatus::Active,
            "2026-07-28T10:00:00Z",
        );

        let (path, doc) = load(&ws, &id).expect("load").expect("present");
        assert!(path
            .to_string_lossy()
            .contains("001-api-building.aurora.md"));
        assert_eq!(doc.frontmatter.title, "API Building");
        assert_eq!(doc.body, "## 1. Only step {#s1}\n\nBody.\n");

        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn sequence_numbers_increment_across_plans() {
        let ws = temp_workspace("sequence");
        seed(&ws, "First", PlanStatus::Draft, "2026-07-28T10:00:00Z");
        seed(&ws, "Second", PlanStatus::Draft, "2026-07-28T11:00:00Z");

        let names: Vec<String> = fs::read_dir(plans_dir(&ws))
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(PLAN_EXT))
            .collect();
        assert!(names.iter().any(|n| n.starts_with("001-first")));
        assert!(names.iter().any(|n| n.starts_with("002-second")));

        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn active_prefers_active_over_draft_and_ignores_finished_plans() {
        let ws = temp_workspace("active");
        seed(&ws, "Old draft", PlanStatus::Draft, "2026-07-28T23:00:00Z");
        let active_id = seed(&ws, "Running", PlanStatus::Active, "2026-07-28T09:00:00Z");
        seed(&ws, "Finished", PlanStatus::Done, "2026-07-28T23:59:00Z");

        let (_, doc) = active(&ws).expect("active").expect("present");
        assert_eq!(
            doc.frontmatter.id, active_id,
            "an Active plan outranks a newer Draft and any Done plan"
        );

        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn active_is_none_when_every_plan_is_finished() {
        let ws = temp_workspace("all-done");
        seed(&ws, "Finished", PlanStatus::Done, "2026-07-28T10:00:00Z");
        assert!(active(&ws).expect("query").is_none());
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn active_is_none_for_a_workspace_with_no_plans_dir() {
        let ws = temp_workspace("empty");
        assert!(active(&ws).expect("query").is_none());
        assert!(list(&ws).expect("list").is_empty());
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn update_mutates_frontmatter_and_bumps_updated_at() {
        let ws = temp_workspace("update");
        let id = seed(&ws, "Work", PlanStatus::Active, "2026-01-01T00:00:00Z");

        let doc = update(&ws, &id, |doc| {
            doc.frontmatter.step_mut("s1").unwrap().status = StepStatus::Done;
            Ok(())
        })
        .expect("update");

        assert_eq!(doc.frontmatter.step("s1").unwrap().status, StepStatus::Done);
        assert_ne!(doc.frontmatter.updated_at, "2026-01-01T00:00:00Z");
        // And it is actually on disk, not just in the returned value.
        let (_, reloaded) = load(&ws, &id).expect("load").expect("present");
        assert_eq!(
            reloaded.frontmatter.step("s1").unwrap().status,
            StepStatus::Done
        );
        assert_eq!(
            reloaded.body, "## 1. Only step {#s1}\n\nBody.\n",
            "prose untouched"
        );

        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn update_reports_a_missing_plan_rather_than_creating_one() {
        let ws = temp_workspace("missing");
        let err = update(&ws, "plan_nope", |_| Ok(())).expect_err("must fail");
        assert!(err.contains("plan_nope"), "error names the id: {err}");
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn create_with_an_existing_id_overwrites_in_place_without_a_new_file() {
        let ws = temp_workspace("overwrite");
        let id = seed(&ws, "Work", PlanStatus::Draft, "2026-07-28T10:00:00Z");
        let (_, doc) = load(&ws, &id).expect("load").expect("present");

        let mut fm = doc.frontmatter.clone();
        fm.title = "Work (revised)".into();
        create(&ws, fm, "## New body\n".into()).expect("recreate");

        let files: Vec<_> = fs::read_dir(plans_dir(&ws))
            .expect("dir")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(PLAN_EXT))
            .collect();
        assert_eq!(files.len(), 1, "revision must not spawn a second file");

        let (_, reloaded) = load(&ws, &id).expect("load").expect("present");
        assert_eq!(reloaded.frontmatter.title, "Work (revised)");

        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn a_corrupt_plan_file_is_skipped_not_fatal() {
        let ws = temp_workspace("corrupt");
        seed(&ws, "Good", PlanStatus::Active, "2026-07-28T10:00:00Z");
        fs::write(
            plans_dir(&ws).join("999-broken.aurora.md"),
            "no frontmatter here",
        )
        .expect("write junk");

        let listed = list(&ws).expect("list");
        assert_eq!(listed.len(), 1, "the readable plan still lists");
        assert_eq!(listed[0].title, "Good");
        assert!(active(&ws).expect("active").is_some());

        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn validate_title_rejects_empty_and_overlong() {
        assert!(validate_title("ok").is_ok());
        assert!(validate_title("   ").is_err());
        assert!(validate_title(&"x".repeat(MAX_TITLE_LEN + 1)).is_err());
    }

    #[test]
    fn plan_ids_are_unique() {
        let a = new_plan_id();
        let b = new_plan_id();
        assert_ne!(a, b);
        assert!(a.starts_with("plan_"));
    }
}
