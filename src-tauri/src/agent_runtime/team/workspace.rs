//! `ProjectWorkspace` — the read/write layer over the Agent Team shared
//! brain on disk (`~/.aurora/projects/<projectId>/`, ground truth §6).
//!
//! This is the **project workspace store** the impact map (§12) calls
//! for: it scaffolds the brain's directory tree, reads/writes the
//! whole-file JSON documents (`project.json`, `team.json`,
//! `scope-map.json`, `board/tasks.json`, `integration/status.json`),
//! and appends/tails the one append-only stream (`channel/events.jsonl`).
//!
//! Writes for whole-file documents are atomic (write `*.tmp`, then
//! rename) so a crash mid-write can never leave a half-serialized brain.
//! The channel is append-only, mirroring the existing JSONL session
//! persistence (`session.rs`) — state is reconstructable by replay (§15).
//!
//! This layer is deliberately **agent-free**: it only moves bytes to and
//! from disk. The TeamBus ([`super::bus`]) wraps it to add live
//! broadcast; the team loop (Phase 2+) drives what gets written.

#![allow(dead_code)]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::agent_runtime::error::RuntimeError;

use super::ids::project_id_for;
use super::types::{
    BoardTasks, ChannelEvent, IntegrationStatus, ProjectMeta, ScopeMap, TeamManifest,
    TeamProjectState, TEAM_SCHEMA_VERSION,
};

/// How many of the most-recent channel events `load_state` returns by
/// default. The full log stays on disk; the UI lazy-loads older history.
pub const DEFAULT_CHANNEL_TAIL: usize = 200;

/// Handle to one project's brain directory. Cheap to construct — it only
/// holds the resolved id and root path; nothing touches disk until a
/// read/write/scaffold method is called.
#[derive(Debug, Clone)]
pub struct ProjectWorkspace {
    project_id: String,
    root: PathBuf,
}

impl ProjectWorkspace {
    /// Resolve the workspace for an opened repo path, rooting it under
    /// the real `~/.aurora/projects/` tree. Does not create anything.
    #[must_use]
    pub fn resolve(repo_path: &str) -> Self {
        let project_id = project_id_for(repo_path);
        let root = crate::paths::team_projects_dir().join(&project_id);
        Self { project_id, root }
    }

    /// Construct a workspace at an explicit root (used by tests to point
    /// at a tempdir, and by callers that already know the id).
    #[must_use]
    pub fn at_root(project_id: impl Into<String>, root: impl Into<PathBuf>) -> Self {
        Self {
            project_id: project_id.into(),
            root: root.into(),
        }
    }

    #[must_use]
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Whether the brain has been scaffolded (i.e. `project.json` exists).
    #[must_use]
    pub fn exists(&self) -> bool {
        self.project_file().exists()
    }

    // ─── path accessors ───────────────────────────────────────────────

    fn project_file(&self) -> PathBuf {
        self.root.join("project.json")
    }
    fn team_file(&self) -> PathBuf {
        self.root.join("team.json")
    }
    fn scope_map_file(&self) -> PathBuf {
        self.root.join("scope-map.json")
    }
    fn channel_file(&self) -> PathBuf {
        self.root.join("channel").join("events.jsonl")
    }
    fn tasks_file(&self) -> PathBuf {
        self.root.join("board").join("tasks.json")
    }
    fn decisions_file(&self) -> PathBuf {
        self.root.join("board").join("decisions.md")
    }
    fn contracts_dir(&self) -> PathBuf {
        self.root.join("board").join("contracts")
    }
    fn agents_dir(&self) -> PathBuf {
        self.root.join("agents")
    }
    fn integration_dir(&self) -> PathBuf {
        self.root.join("integration")
    }
    fn reviews_dir(&self) -> PathBuf {
        self.integration_dir().join("reviews")
    }
    fn status_file(&self) -> PathBuf {
        self.integration_dir().join("status.json")
    }

    // ─── scaffolding ──────────────────────────────────────────────────

    /// Create the full brain directory tree and seed empty documents the
    /// first time. Idempotent: re-running never clobbers existing
    /// content — `project.json` is only written when absent, and seeded
    /// documents are only written when missing.
    ///
    /// Returns the project metadata (existing one if already scaffolded,
    /// otherwise the freshly created one).
    pub fn ensure_scaffold(
        &self,
        repo_path: &str,
        lead_model: Option<String>,
    ) -> Result<ProjectMeta, RuntimeError> {
        // Directory skeleton (§6). Per-agent dirs under `agents/` are
        // created on demand when an agent first runs (Phase 2+).
        for dir in [
            self.root.clone(),
            self.root.join("channel"),
            self.root.join("board"),
            self.contracts_dir(),
            self.agents_dir(),
            self.integration_dir(),
            self.reviews_dir(),
        ] {
            std::fs::create_dir_all(&dir)?;
        }

        let now = now_rfc3339();

        // project.json — identity. Only written once.
        let project = match self.read_project()? {
            Some(existing) => existing,
            None => {
                let meta = ProjectMeta {
                    project_id: self.project_id.clone(),
                    repo_path: repo_path.to_string(),
                    stack: None,
                    created_at: now.clone(),
                    lead_model,
                    schema_version: TEAM_SCHEMA_VERSION,
                };
                self.write_project(&meta)?;
                meta
            }
        };

        // Seed the remaining documents if missing.
        if self.read_team()?.is_none() {
            self.write_team(&TeamManifest::empty(&self.project_id, &now))?;
        }
        if self.read_scope_map()?.is_none() {
            self.write_scope_map(&ScopeMap::empty(&now))?;
        }
        if self.read_tasks()?.is_none() {
            self.write_tasks(&BoardTasks::empty(&now))?;
        }
        if self.read_status()?.is_none() {
            self.write_status(&IntegrationStatus::empty(&now))?;
        }
        // decisions.md + the channel log start empty; create the channel
        // file so tailing a fresh team returns `[]` rather than erroring.
        ensure_file(&self.decisions_file())?;
        ensure_file(&self.channel_file())?;

        Ok(project)
    }

    // ─── whole-file documents ─────────────────────────────────────────

    pub fn read_project(&self) -> Result<Option<ProjectMeta>, RuntimeError> {
        read_json(&self.project_file())
    }
    pub fn write_project(&self, value: &ProjectMeta) -> Result<(), RuntimeError> {
        write_json_atomic(&self.project_file(), value)
    }

    pub fn read_team(&self) -> Result<Option<TeamManifest>, RuntimeError> {
        read_json(&self.team_file())
    }
    pub fn write_team(&self, value: &TeamManifest) -> Result<(), RuntimeError> {
        write_json_atomic(&self.team_file(), value)
    }

    pub fn read_scope_map(&self) -> Result<Option<ScopeMap>, RuntimeError> {
        read_json(&self.scope_map_file())
    }
    pub fn write_scope_map(&self, value: &ScopeMap) -> Result<(), RuntimeError> {
        write_json_atomic(&self.scope_map_file(), value)
    }

    pub fn read_tasks(&self) -> Result<Option<BoardTasks>, RuntimeError> {
        read_json(&self.tasks_file())
    }
    pub fn write_tasks(&self, value: &BoardTasks) -> Result<(), RuntimeError> {
        write_json_atomic(&self.tasks_file(), value)
    }

    pub fn read_status(&self) -> Result<Option<IntegrationStatus>, RuntimeError> {
        read_json(&self.status_file())
    }
    pub fn write_status(&self, value: &IntegrationStatus) -> Result<(), RuntimeError> {
        write_json_atomic(&self.status_file(), value)
    }

    // ─── channel (append-only) ────────────────────────────────────────

    /// Append one event to `channel/events.jsonl`. Creates the file (and
    /// `channel/` dir) if needed. Durable as soon as the OS flushes.
    pub fn append_channel_event(&self, event: &ChannelEvent) -> Result<(), RuntimeError> {
        let path = self.channel_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file =
            with_io_retry(|| OpenOptions::new().create(true).append(true).open(&path))?;
        let line = serde_json::to_string(event)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        Ok(())
    }

    /// Read channel events oldest-first. When `limit` is `Some(n)` only
    /// the last `n` events are returned (the UI's "tail"); `None` returns
    /// the whole log. A missing file is treated as an empty channel.
    /// Blank lines are tolerated; a malformed line aborts with the line
    /// number so corruption is diagnosable.
    pub fn read_channel(&self, limit: Option<usize>) -> Result<Vec<ChannelEvent>, RuntimeError> {
        let path = self.channel_file();
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let reader = BufReader::new(file);
        let mut events = Vec::new();
        for (idx, line_res) in reader.lines().enumerate() {
            let line = line_res?;
            if line.trim().is_empty() {
                continue;
            }
            let ev: ChannelEvent = serde_json::from_str(&line).map_err(|e| {
                RuntimeError::InvalidState(format!("channel events.jsonl line {}: {}", idx + 1, e))
            })?;
            events.push(ev);
        }
        if let Some(n) = limit {
            if events.len() > n {
                events.drain(0..events.len() - n);
            }
        }
        Ok(events)
    }

    // ─── integration reviews (append-only threads) ────────────────────

    /// Append a peer-review note to
    /// `integration/reviews/<reviewer>--<target>.md`. Ids are sanitized to
    /// safe filename characters. Creates the file (and `reviews/` dir) if
    /// needed; mirrors the channel's append-only durability (§6, §9 step 5).
    pub fn append_review(
        &self,
        reviewer: &str,
        target: &str,
        content: &str,
    ) -> Result<(), RuntimeError> {
        let path = self.reviews_dir().join(format!(
            "{}--{}.md",
            sanitize_filename(reviewer),
            sanitize_filename(target)
        ));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(content.as_bytes())?;
        file.write_all(b"\n")?;
        Ok(())
    }

    // ─── published contracts (board/contracts/) ──────────────────────────

    /// Persist a published contract's **body** as
    /// `board/contracts/<safeName>.md` so dependents can read the actual
    /// interface, not just its name (§6, §8). Overwrites an existing contract
    /// of the same name (the latest definition wins).
    pub fn write_contract(&self, name: &str, body: &str) -> Result<(), RuntimeError> {
        let dir = self.contracts_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.md", sanitize_filename(name)));
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)?;
        file.write_all(format!("# {name}\n\n{body}\n").as_bytes())?;
        file.sync_all()?;
        Ok(())
    }

    /// Read every published contract as `(name, body)`, sorted by name, for
    /// injecting into a dependent agent's build context. A missing directory
    /// is treated as "no contracts".
    pub fn read_contracts(&self) -> Result<Vec<(String, String)>, RuntimeError> {
        let dir = self.contracts_dir();
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                let name = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push((name, content));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Append an architecture-decision record to `board/decisions.md` (§6).
    pub fn append_decision(&self, text: &str) -> Result<(), RuntimeError> {
        let path = self.decisions_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(text.as_bytes())?;
        file.write_all(b"\n")?;
        Ok(())
    }

    /// Persist an agent's full turn transcript to `agents/<id>/session.jsonl`
    /// (§6, §15) — one serialized message per line. Overwrites: the latest run
    /// is the record, mirroring how a fresh build turn supersedes the prior one.
    pub fn write_agent_session(
        &self,
        agent_id: &str,
        lines: &[String],
    ) -> Result<(), RuntimeError> {
        let dir = self.agents_dir().join(sanitize_filename(agent_id));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("session.jsonl");
        // Truncate-rewritten every IC turn while the frontend polls the
        // transcript — retry the open past any transient reader lock.
        let mut file = with_io_retry(|| {
            OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&path)
        })?;
        for line in lines {
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        Ok(())
    }

    /// Read an agent's persisted transcript (`agents/<id>/session.jsonl`) as
    /// raw JSONL lines; empty when the agent hasn't run yet. Powers the
    /// per-agent view in the team window (what it called + what it got back).
    pub fn read_agent_session(&self, agent_id: &str) -> Result<Vec<String>, RuntimeError> {
        let path = self
            .agents_dir()
            .join(sanitize_filename(agent_id))
            .join("session.jsonl");
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(s
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    // ─── aggregate ────────────────────────────────────────────────────

    /// Read the entire brain into one snapshot for the frontend. Falls
    /// back to empty documents for any file that hasn't been written yet,
    /// so this is safe to call on a freshly-scaffolded (or even
    /// un-scaffolded) workspace.
    pub fn load_state(
        &self,
        channel_limit: Option<usize>,
    ) -> Result<TeamProjectState, RuntimeError> {
        let now = now_rfc3339();
        let project = self.read_project()?;
        let initialized = project.is_some();
        let team = self
            .read_team()?
            .unwrap_or_else(|| TeamManifest::empty(&self.project_id, &now));
        let scope_map = self
            .read_scope_map()?
            .unwrap_or_else(|| ScopeMap::empty(&now));
        let tasks = self
            .read_tasks()?
            .unwrap_or_else(|| BoardTasks::empty(&now));
        let integration = self
            .read_status()?
            .unwrap_or_else(|| IntegrationStatus::empty(&now));
        let channel = self.read_channel(channel_limit)?;

        Ok(TeamProjectState {
            project_id: self.project_id.clone(),
            initialized,
            project,
            team,
            scope_map,
            tasks,
            integration,
            channel,
        })
    }
}

/// RFC-3339 timestamp for "now" — the format every brain document uses.
#[must_use]
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, RuntimeError> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(serde_json::from_str(&s)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Whether a filesystem error is a transient Windows sharing/access violation
/// worth retrying. When another handle briefly holds a brain file open — the
/// frontend polling the live team view, an antivirus scan, or the search
/// indexer — a `rename`-replace or truncating `open` can momentarily fail with
/// `ACCESS_DENIED` (5), `ERROR_SHARING_VIOLATION` (32), or `ERROR_LOCK_VIOLATION`
/// (33). These clear in milliseconds; a UI read must never abort a team run.
fn is_transient_sharing_error(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Run a filesystem op, retrying briefly on transient sharing/access
/// violations (see [`is_transient_sharing_error`]) before surfacing the error.
fn with_io_retry<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    const MAX_ATTEMPTS: usize = 12;
    const BACKOFF: std::time::Duration = std::time::Duration::from_millis(15);
    let mut attempt = 0;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if attempt + 1 < MAX_ATTEMPTS && is_transient_sharing_error(&e) => {
                attempt += 1;
                std::thread::sleep(BACKOFF);
            }
            Err(e) => return Err(e),
        }
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), RuntimeError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value)?;
    {
        let mut file = with_io_retry(|| {
            OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)
        })?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
    }
    // The replace is the real collision point on Windows: MoveFileEx must take
    // DELETE on the destination, which a concurrent reader/scanner can hold.
    with_io_retry(|| std::fs::rename(&tmp, path))?;
    Ok(())
}

/// Sanitize an arbitrary id/name into a safe filename stem (alphanumeric,
/// `-`, `_`; everything else becomes `_`). Shared by the review-thread,
/// contract, and per-agent-session writers.
fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Create an empty file (and parents) if it doesn't already exist.
fn ensure_file(path: &Path) -> Result<(), RuntimeError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if !path.exists() {
        OpenOptions::new().create(true).append(true).open(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::team::types::{
        AgentRecord, AgentStatus, ChannelEventKind, TeamPhase,
    };

    fn ws() -> (tempfile::TempDir, ProjectWorkspace) {
        let dir = tempfile::tempdir().expect("tempdir");
        let ws = ProjectWorkspace::at_root("pid-test", dir.path().join("pid-test"));
        (dir, ws)
    }

    fn event(id: &str, body: &str) -> ChannelEvent {
        ChannelEvent {
            id: id.into(),
            ts: now_rfc3339(),
            author: "agent-a".into(),
            kind: ChannelEventKind::Message,
            body: body.into(),
            meta: None,
        }
    }

    #[test]
    fn scaffold_creates_tree_and_seeds_documents() {
        let (_d, ws) = ws();
        assert!(!ws.exists());
        let meta = ws
            .ensure_scaffold("/repo/path", Some("anthropic:claude".into()))
            .unwrap();
        assert!(ws.exists());
        assert_eq!(meta.repo_path, "/repo/path");
        assert_eq!(meta.lead_model.as_deref(), Some("anthropic:claude"));
        assert!(ws.root().join("channel").join("events.jsonl").exists());
        assert!(ws.root().join("board").join("contracts").is_dir());
        assert!(ws.root().join("integration").join("reviews").is_dir());
        assert!(ws.read_team().unwrap().is_some());
        assert!(ws.read_scope_map().unwrap().is_some());
    }

    #[test]
    fn scaffold_is_idempotent_and_preserves_created_at() {
        let (_d, ws) = ws();
        let first = ws.ensure_scaffold("/repo", None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = ws.ensure_scaffold("/repo-changed", None).unwrap();
        // project.json is written only once — created_at and repo_path
        // from the first scaffold survive.
        assert_eq!(first.created_at, second.created_at);
        assert_eq!(second.repo_path, "/repo");
    }

    #[test]
    fn channel_append_and_tail() {
        let (_d, ws) = ws();
        ws.ensure_scaffold("/repo", None).unwrap();
        for i in 0..5 {
            ws.append_channel_event(&event(&format!("e{i}"), "hi"))
                .unwrap();
        }
        let all = ws.read_channel(None).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].id, "e0");

        let tail = ws.read_channel(Some(2)).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].id, "e3");
        assert_eq!(tail[1].id, "e4");
    }

    #[test]
    fn read_channel_missing_file_is_empty() {
        let (_d, ws) = ws();
        assert!(ws.read_channel(None).unwrap().is_empty());
    }

    #[test]
    fn team_round_trips_through_disk() {
        let (_d, ws) = ws();
        ws.ensure_scaffold("/repo", None).unwrap();
        let manifest = TeamManifest {
            project_id: "pid-test".into(),
            phase: TeamPhase::Planning,
            agents: vec![AgentRecord {
                id: "a1".into(),
                role: "app-owner".into(),
                model: Some("m".into()),
                status: AgentStatus::Building,
            }],
            updated_at: now_rfc3339(),
            schema_version: TEAM_SCHEMA_VERSION,
        };
        ws.write_team(&manifest).unwrap();
        let back = ws.read_team().unwrap().unwrap();
        assert_eq!(back.agents.len(), 1);
        assert_eq!(back.agents[0].role, "app-owner");
        assert!(matches!(back.agents[0].status, AgentStatus::Building));
    }

    #[test]
    fn load_state_reflects_scaffold_and_channel() {
        let (_d, ws) = ws();
        let state = ws.load_state(None).unwrap();
        assert!(
            !state.initialized,
            "un-scaffolded workspace is uninitialized"
        );

        ws.ensure_scaffold("/repo", None).unwrap();
        ws.append_channel_event(&event("e1", "standup")).unwrap();
        let state = ws.load_state(None).unwrap();
        assert!(state.initialized);
        assert_eq!(state.project.unwrap().repo_path, "/repo");
        assert_eq!(state.channel.len(), 1);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file() {
        let (_d, ws) = ws();
        ws.ensure_scaffold("/repo", None).unwrap();
        let tmp = ws.root().join("team.json.tmp");
        assert!(!tmp.exists(), "tmp must be renamed away: {}", tmp.display());
    }
}
