//! Where a child lives on disk, and the sidecar that says what it is.
//!
//! A child's store is a project-layout [`SessionStore`] rooted at
//! `<parent thread dir>/agents/`. Inside it the child is an ordinary
//! conversation — `conversation.jsonl`, `meta.json`, `rich.jsonl`, a
//! `tool-results/` spill directory — so every piece of the runtime that
//! knows how to journal, load, repair and spill a conversation works on it
//! unchanged. The one thing the runtime does not know about a conversation,
//! "which agent is this and who started it", is the [`AgentSidecar`] next to
//! it.
//!
//! Children never appear in a project's thread listing: the listing looks
//! one level deep for `<id>/conversation.jsonl`, and `agents/` has none.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::catalog::DefinitionSource;
use super::host::SubagentUsage;
use super::record::TaskStatus;
use crate::agent_runtime::error::RuntimeError;
use crate::agent_runtime::session_store::SessionStore;

/// Folder under a parent's thread directory that holds its agents.
pub const AGENTS_DIR: &str = "agents";
/// The sidecar's filename inside a child's directory.
pub const SIDECAR_FILE: &str = "agent.json";

/// The store that owns `parent_thread_id`'s children.
///
/// Built fresh each time rather than cached: it is a `PathBuf` and a flag,
/// and the parent store already carries the usage ledger to inherit.
#[must_use]
pub fn child_store_for(parent_store: &SessionStore, parent_thread_id: &str) -> SessionStore {
    let dir = parent_store.thread_dir(parent_thread_id).join(AGENTS_DIR);
    SessionStore::new_project(dir).with_usage_ledger(parent_store.usage_ledger())
}

/// What a child is, written when it is started and updated when it ends.
///
/// This is the durable half of the task record: the registry in memory can
/// be emptied, this file cannot. `agent_type` is what a resume routes on;
/// the rest is what the Agents list shows when the parent is reopened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecar {
    pub agent_id: String,
    pub parent_thread_id: String,
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub description: String,
    /// The first task, verbatim.
    pub prompt: String,
    /// `providerId:modelKey` the child ran on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub background: bool,
    #[serde(default)]
    pub source: Option<DefinitionSource>,
    /// Last known state. `running` on disk after a crash means the run was
    /// interrupted; a load treats it as `failed` with that explanation.
    pub status: TaskStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// The final message of the most recent run, capped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub usage: SubagentUsage,
    /// How many times this agent has been run (1 for the first, +1 per
    /// resume).
    #[serde(default = "one")]
    pub runs: u32,
    /// The prompt size of its latest model call: how full its context was
    /// when it stopped. Shown in the Agents list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
}

fn one() -> u32 {
    1
}

/// How much of a result the sidecar keeps. The transcript has all of it;
/// this is for the list and the notification.
const RESULT_CAP_CHARS: usize = 4_000;

impl AgentSidecar {
    #[must_use]
    pub fn path_in(child_store: &SessionStore, agent_id: &str) -> PathBuf {
        child_store.thread_dir(agent_id).join(SIDECAR_FILE)
    }

    pub fn save(&self, child_store: &SessionStore) -> Result<(), RuntimeError> {
        let path = Self::path_in(child_store, &self.agent_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| RuntimeError::InvalidState(format!("agent sidecar: {e}")))?;
        // Write-then-rename so a crash mid-write leaves the old sidecar, not
        // half of a new one.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn load(child_store: &SessionStore, agent_id: &str) -> Result<Self, RuntimeError> {
        let path = Self::path_in(child_store, agent_id);
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str(&raw).map_err(|e| {
            RuntimeError::InvalidState(format!("{} is malformed: {e}", path.display()))
        })
    }

    /// Every child of a parent, by reading its `agents/` folder. Sorted
    /// oldest first by `created_at`, so the list reads in the order the
    /// parent started them. A folder without a readable sidecar is skipped.
    #[must_use]
    pub fn list_in(child_store: &SessionStore) -> Vec<Self> {
        let Ok(entries) = std::fs::read_dir(child_store.dir()) else {
            return Vec::new();
        };
        let mut found: Vec<Self> = entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let id = e.file_name().to_string_lossy().into_owned();
                Self::load(child_store, &id).ok()
            })
            .collect();
        found.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        found
    }

    /// Mark the end of a run.
    pub fn record_finish(
        &mut self,
        status: TaskStatus,
        result: Option<&str>,
        error: Option<&str>,
        usage: &SubagentUsage,
    ) {
        let now = chrono::Utc::now().to_rfc3339();
        self.status = status;
        self.updated_at = now.clone();
        self.ended_at = Some(now);
        if let Some(result) = result.map(str::trim).filter(|r| !r.is_empty()) {
            self.result = Some(cap(result, RESULT_CAP_CHARS));
        }
        self.error = error.map(str::to_string);
        self.usage.add(usage);
    }

    /// Mark the start of another run under the same id.
    pub fn record_resume(&mut self, prompt_hint: &str) {
        let now = chrono::Utc::now().to_rfc3339();
        self.status = TaskStatus::Running;
        self.updated_at = now;
        self.ended_at = None;
        self.error = None;
        self.runs = self.runs.saturating_add(1);
        // The description stays; the latest task is only a hint in the file.
        let _ = prompt_hint;
    }

    /// A sidecar found saying `running` after the process that ran it is
    /// gone. Nothing is running it now.
    #[must_use]
    pub fn as_loaded(mut self) -> Self {
        if self.status == TaskStatus::Running {
            self.status = TaskStatus::Failed;
            self.error = Some(
                "Aurora closed while this agent was running; its transcript holds \
                 everything it did up to that point."
                    .to_string(),
            );
        }
        self
    }
}

fn cap(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let kept: String = text.chars().take(max_chars).collect();
    format!("{kept}\n… (truncated; the transcript has the rest)")
}

/// Path of a child's transcript, for the parent to read with `file_read`.
#[must_use]
pub fn output_file(child_store: &SessionStore, agent_id: &str) -> PathBuf {
    child_store.session_path(agent_id)
}

/// Does `dir` look like a parent thread folder that has children?
#[must_use]
pub fn has_children(parent_thread_dir: &Path) -> bool {
    std::fs::read_dir(parent_thread_dir.join(AGENTS_DIR))
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar(id: &str) -> AgentSidecar {
        let now = chrono::Utc::now().to_rfc3339();
        AgentSidecar {
            agent_id: id.to_string(),
            parent_thread_id: "parent-1".into(),
            agent_type: "explore".into(),
            name: Some("scout".into()),
            description: "Find the auth code".into(),
            prompt: "Where is login handled?".into(),
            model: Some("mock:model".into()),
            background: false,
            source: Some(DefinitionSource::BuiltIn),
            status: TaskStatus::Running,
            created_at: now.clone(),
            updated_at: now,
            ended_at: None,
            result: None,
            error: None,
            usage: SubagentUsage::default(),
            runs: 1,
            context_tokens: None,
        }
    }

    #[test]
    fn children_live_under_the_parent_and_stay_out_of_its_listing() {
        let root = tempfile::tempdir().unwrap();
        let parent_store = SessionStore::new_project(root.path().to_path_buf());
        parent_store.ensure_thread("parent-1", None, None).unwrap();

        let child_store = child_store_for(&parent_store, "parent-1");
        assert_eq!(
            child_store.dir(),
            root.path().join("parent-1").join(AGENTS_DIR)
        );
        child_store.ensure_thread("agent_x", None, None).unwrap();
        sidecar("agent_x").save(&child_store).unwrap();

        assert!(output_file(&child_store, "agent_x").ends_with("agent_x/conversation.jsonl"));
        assert!(has_children(&parent_store.thread_dir("parent-1")));

        let listed = parent_store.list_summaries().unwrap();
        assert_eq!(listed.len(), 1, "the child is not a conversation of the project");
        assert_eq!(listed[0].id, "parent-1");
    }

    #[test]
    fn sidecar_round_trips_and_a_crashed_run_loads_as_failed() {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::new_project(root.path().to_path_buf());
        let mut s = sidecar("agent_x");
        s.save(&store).unwrap();
        let loaded = AgentSidecar::load(&store, "agent_x").unwrap();
        assert_eq!(loaded, s);

        let after_crash = loaded.as_loaded();
        assert_eq!(after_crash.status, TaskStatus::Failed);
        assert!(after_crash.error.as_deref().unwrap().contains("closed"));

        s.record_finish(
            TaskStatus::Completed,
            Some(&"x".repeat(5_000)),
            None,
            &SubagentUsage {
                input_tokens: 1,
                ..SubagentUsage::default()
            },
        );
        assert_eq!(s.status, TaskStatus::Completed);
        assert!(s.result.as_deref().unwrap().ends_with("the rest)"));
        assert!(s.ended_at.is_some());
        s.save(&store).unwrap();
        let listed = AgentSidecar::list_in(&store);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, TaskStatus::Completed);

        s.record_resume("more");
        assert_eq!(s.status, TaskStatus::Running);
        assert_eq!(s.runs, 2);
        assert!(s.result.is_some(), "the previous result stays readable");
    }
}
