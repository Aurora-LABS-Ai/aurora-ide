//! `TeamDispatcher` — the background run engine.
//!
//! The Lead (the chat agent in Team mode) never blocks on the team: one
//! `team_dispatch` call seeds the brain, spawns **one real agent actor per
//! member** ([`super::member_actor::run_member`]), and returns immediately.
//! Members run concurrently on their own tasks, talk to each other through
//! [`super::mailbox::TeamComms`], and each ends by filing a report. The run
//! completes when every member is terminal — the completion carries the
//! actual per-member reports, not an inference scraped from the channel.
//!
//! ## Status (the "pull" re-engage model)
//!
//! The dispatcher keeps a live [`TeamRunStatus`] per project — now including
//! per-member states (working / waiting on the Lead / done) and, on
//! completion, the member reports. The frontend injects it into the Lead's
//! context so the Lead always knows where the team stands. A `run.json`
//! snapshot mirrors it into the brain dir so an app restart shows "a run was
//! in flight and died" instead of amnesia.
//!
//! ## Cancel
//!
//! Cancel is **graceful**: it fires the run's cancellation token, which every
//! member's engine honors mid-stream, and falls back to a hard abort only if
//! the run doesn't wind down in time.

#![allow(dead_code)]

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use serde::Serialize;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::api::ProviderConfigSnapshot;

use super::bus::TeamBus;
use super::ids::project_id_for;
use super::mailbox::TeamComms;
use super::member_actor::{run_member, MemberRun};
use super::orchestrator::{TeamSession, LEAD_AGENT_ID};
use super::runner::seed_dispatch;
use super::types::{
    ChannelEvent, ChannelEventKind, DispatchMember, MemberReport, MemberRunState, ReportStatus,
    TeamPhase,
};
use super::workspace::{now_rfc3339, ProjectWorkspace};

/// Whole-run wall-clock ceiling. A hung provider (connects, never streams,
/// never closes) must not strand the one-run-per-workspace guard until the
/// app restarts. Generous: a real multi-member build takes a while.
const RUN_WALL_CLOCK_TIMEOUT: Duration = Duration::from_secs(45 * 60);

/// After a graceful cancel, how long the engine waits for member actors to
/// settle before hard-aborting the run task.
const CANCEL_GRACE: Duration = Duration::from_secs(20);

/// Lifecycle of a dispatched (background) team run, as seen by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunLifecycle {
    /// No run has ever been dispatched for this workspace this session.
    Idle,
    /// A run is executing right now (see [`TeamRunStatus::phase`]).
    Running,
    /// The most recent worker run finished (reports carried on the status).
    Done,
    /// The most recent run errored (see [`TeamRunStatus::error`]).
    Failed,
}

/// Live status of the background run for one project. Cheap to clone; the
/// frontend injects it into the Lead's context every message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunStatus {
    pub run_id: Option<String>,
    pub state: RunLifecycle,
    /// While `running`: "starting" | "working".
    pub phase: Option<String>,
    /// The goal the run was dispatched with (so the Lead can recall the ask).
    pub goal: Option<String>,
    /// Set when `state == Failed`: a human-readable failure reason.
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub origin_thread_id: Option<String>,
    pub origin_surface: Option<String>,
    /// True once the completion notifier has DELIVERED this run's terminal
    /// report to the Lead. The registry (not the frontend) owns this flag so a
    /// window reload can never re-deliver the same completion and re-trigger
    /// the work — exactly-once, one source of truth.
    pub acknowledged: bool,
    /// Live per-member states while running; final states after.
    #[serde(default)]
    pub members: Vec<MemberRunState>,
    /// Per-member reports, present once the run is terminal.
    #[serde(default)]
    pub reports: Vec<MemberReport>,
}

impl TeamRunStatus {
    fn idle() -> Self {
        Self {
            run_id: None,
            state: RunLifecycle::Idle,
            phase: None,
            goal: None,
            error: None,
            started_at: None,
            finished_at: None,
            origin_thread_id: None,
            origin_surface: None,
            acknowledged: false,
            members: Vec::new(),
            reports: Vec::new(),
        }
    }

    fn running(goal: &str, run: &RunMetadata) -> Self {
        Self {
            run_id: Some(run.run_id.clone()),
            state: RunLifecycle::Running,
            phase: Some("starting".to_string()),
            goal: Some(goal.to_string()),
            error: None,
            started_at: Some(now_rfc3339()),
            finished_at: None,
            origin_thread_id: run.origin_thread_id.clone(),
            origin_surface: run.origin_surface.clone(),
            acknowledged: false,
            members: Vec::new(),
            reports: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct RunMetadata {
    run_id: String,
    origin_thread_id: Option<String>,
    origin_surface: Option<String>,
}

impl RunMetadata {
    fn new(origin_thread_id: Option<String>, origin_surface: Option<String>) -> Self {
        Self {
            run_id: Uuid::new_v4().to_string(),
            origin_thread_id,
            origin_surface,
        }
    }

    fn from_status(status: &TeamRunStatus) -> Option<Self> {
        Some(Self {
            run_id: status.run_id.clone()?,
            origin_thread_id: status.origin_thread_id.clone(),
            origin_surface: status.origin_surface.clone(),
        })
    }
}

/// A live run's control handles: the spawned task, its cancel token, and
/// the run's communication hub.
struct RunHandles {
    task: JoinHandle<()>,
    cancel: CancellationToken,
}

/// In-memory registry of background team runs, keyed by `projectId`.
///
/// Lives in Tauri managed state as `Arc<TeamDispatcher>` (wired in `lib.rs`).
/// One run per workspace at a time — a second `dispatch` while one is
/// `running` is rejected so a stray Lead call can't fork a competing run
/// over the same brain.
pub struct TeamDispatcher {
    runs: Mutex<HashMap<String, TeamRunStatus>>,
    handles: Mutex<HashMap<String, RunHandles>>,
    /// Live communication hubs, kept past run end so `team_reply` to a
    /// just-finished run degrades gracefully (unknown ticket) instead of
    /// erroring on a missing hub.
    comms: Mutex<HashMap<String, Arc<TeamComms>>>,
}

impl Default for TeamDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl TeamDispatcher {
    #[must_use]
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
            comms: Mutex::new(HashMap::new()),
        }
    }

    fn lock_runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, TeamRunStatus>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_handles(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunHandles>> {
        self.handles.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_comms(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<TeamComms>>> {
        self.comms.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The live communication hub for a project's current (or most recent)
    /// run. `None` when nothing was ever dispatched this session.
    #[must_use]
    pub fn comms_for(&self, project_id: &str) -> Option<Arc<TeamComms>> {
        self.lock_comms().get(project_id).cloned()
    }

    /// Current status for a project (`idle` when nothing was ever
    /// dispatched), with the live per-member states merged in.
    #[must_use]
    pub fn status(&self, project_id: &str) -> TeamRunStatus {
        let mut status = self
            .lock_runs()
            .get(project_id)
            .cloned()
            .unwrap_or_else(TeamRunStatus::idle);
        if let Some(comms) = self.comms_for(project_id) {
            status.members = comms.member_states();
        }
        status
    }

    /// Mark a terminal run's completion report as delivered. `run_id`, when
    /// given, must match the registered run (a stale ack for an older run is
    /// ignored). Returns true when the flag flipped. Running/idle runs are
    /// never acked — there is nothing to report yet.
    pub fn ack(&self, project_id: &str, run_id: Option<&str>) -> bool {
        if let Some(s) = self.lock_runs().get_mut(project_id) {
            if !matches!(s.state, RunLifecycle::Done | RunLifecycle::Failed) {
                return false;
            }
            if let (Some(want), Some(have)) = (run_id, s.run_id.as_deref()) {
                if !want.trim().is_empty() && want != have {
                    return false;
                }
            }
            if !s.acknowledged {
                s.acknowledged = true;
                return true;
            }
        }
        false
    }

    fn set_phase(&self, project_id: &str, phase: &str) {
        if let Some(s) = self.lock_runs().get_mut(project_id) {
            s.phase = Some(phase.to_string());
        }
        self.snapshot_to_disk(project_id);
    }

    fn finish(&self, project_id: &str, result: Result<Vec<MemberReport>, String>) {
        if let Some(s) = self.lock_runs().get_mut(project_id) {
            s.phase = None;
            s.finished_at = Some(now_rfc3339());
            match result {
                Ok(reports) => {
                    s.state = RunLifecycle::Done;
                    s.reports = reports;
                }
                Err(e) => {
                    s.state = RunLifecycle::Failed;
                    s.error = Some(e);
                }
            }
        }
        self.lock_handles().remove(project_id);
        self.snapshot_to_disk(project_id);
    }

    /// Mirror the current status into the brain dir (`run.json`) so a
    /// restart can tell "a run died mid-flight" from "no run ever happened".
    /// Best-effort — the in-memory registry stays the live source of truth.
    fn snapshot_to_disk(&self, project_id: &str) {
        let status = self.status(project_id);
        let Some(repo) = repo_path_of(project_id) else {
            return;
        };
        let ws = ProjectWorkspace::resolve(&repo);
        if let Ok(json) = serde_json::to_string_pretty(&status) {
            let _ = std::fs::write(ws.root().join("run.json"), json);
        }
    }

    /// Gracefully cancel the live background run for a project: fire its
    /// cancel token (the member engines honor it mid-stream), then
    /// hard-abort only if the run doesn't settle within [`CANCEL_GRACE`].
    /// Returns true when a running task/status was cancelled.
    pub fn cancel(&self, project_id: &str, reason: &str) -> bool {
        let mut cancelled = false;
        if let Some(handles) = self.lock_handles().remove(project_id) {
            handles.cancel.cancel();
            cancelled = true;
            // Grace period, then hard abort — off this thread.
            tokio::spawn(async move {
                tokio::time::sleep(CANCEL_GRACE).await;
                handles.task.abort();
            });
        }
        if let Some(s) = self.lock_runs().get_mut(project_id) {
            if matches!(s.state, RunLifecycle::Running) {
                s.state = RunLifecycle::Failed;
                s.phase = None;
                s.error = Some(reason.to_string());
                s.finished_at = Some(now_rfc3339());
                cancelled = true;
            }
        }
        if cancelled {
            self.snapshot_to_disk(project_id);
        }
        cancelled
    }

    /// Cancel a live run and post the same terminal lifecycle marker a
    /// normal failure would post, so completion routing is not lost.
    pub fn cancel_and_post(&self, bus: &TeamBus, repo_path: &str, reason: &str) -> bool {
        let project_id = project_id_for(repo_path);
        let run = self.status(&project_id);
        let cancelled = self.cancel(&project_id, reason);
        if cancelled {
            let run =
                RunMetadata::from_status(&run).unwrap_or_else(|| RunMetadata::new(None, None));
            post_lifecycle(
                bus,
                repo_path,
                &run,
                "cancelled",
                Some("failed"),
                &format!("Team run failed: {reason}"),
            );
        }
        cancelled
    }

    /// Dispatch the member actors on a detached background task and return
    /// the `projectId` immediately.
    ///
    /// Rejected (without spawning) when a run is already in progress for the
    /// same workspace. All long work happens inside the spawned task; the
    /// caller's chat turn is never blocked.
    #[allow(clippy::too_many_arguments)]
    pub fn dispatch(
        self: &Arc<Self>,
        bus: Arc<TeamBus>,
        repo_path: String,
        goal: String,
        members: Vec<DispatchMember>,
        lead_provider: ProviderConfigSnapshot,
        team_provider: ProviderConfigSnapshot,
        max_size: usize,
        origin_thread_id: Option<String>,
        origin_surface: Option<String>,
    ) -> Result<String, String> {
        if members.is_empty() {
            return Err(
                "team_dispatch requires members: define your team — one entry per member with \
                 role, task, and scope."
                    .to_string(),
            );
        }
        let project_id = project_id_for(&repo_path);
        let run = RunMetadata::new(origin_thread_id, origin_surface);
        {
            let mut runs = self.lock_runs();
            if matches!(
                runs.get(&project_id).map(|s| s.state),
                Some(RunLifecycle::Running)
            ) {
                return Err(
                    "A team run is already in progress for this workspace. Use team_status to check on it."
                        .to_string(),
                );
            }
            runs.insert(project_id.clone(), TeamRunStatus::running(&goal, &run));
        }

        // Fresh communication hub per run.
        let comms = Arc::new(TeamComms::new());
        self.lock_comms().insert(project_id.clone(), comms.clone());

        // Reset the brain for the new run BEFORE returning, so the Team
        // window goes live instantly instead of showing the previous run's
        // final state.
        match TeamSession::open(&repo_path) {
            Ok(session) => {
                if let Err(e) = session.reset_for_dispatch(&bus, &goal) {
                    self.lock_runs().remove(&project_id);
                    return Err(format!("could not reset the team brain: {e}"));
                }
            }
            Err(e) => {
                self.lock_runs().remove(&project_id);
                return Err(format!("could not open the team brain: {e}"));
            }
        }
        remember_repo_path(&project_id, &repo_path);

        let me = Arc::clone(self);
        let pid = project_id.clone();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            // `catch_unwind` so a panic anywhere can never bypass `finish()`
            // — a stuck-`Running` status would stick-lock the one-run guard
            // for the whole workspace until the app restarts.
            let outcome = AssertUnwindSafe(run_team_lifecycle(
                &me,
                &pid,
                &bus,
                &comms,
                &repo_path,
                &goal,
                &members,
                &lead_provider,
                &team_provider,
                max_size,
                &run,
                &task_cancel,
            ))
            .catch_unwind()
            .await;
            let result = match outcome {
                Ok(r) => r,
                Err(_) => {
                    post_lifecycle(
                        &bus,
                        &repo_path,
                        &run,
                        "failed",
                        Some("failed"),
                        "Team run failed: the team engine hit an unexpected internal error.",
                    );
                    Err("the team engine panicked unexpectedly".to_string())
                }
            };
            me.finish(&pid, result);
        });
        self.lock_handles().insert(
            project_id.clone(),
            RunHandles {
                task: handle,
                cancel,
            },
        );

        Ok(project_id)
    }
}

/// The dispatched run for one team: seed the brain, run every member as a
/// real agent actor concurrently, then close the team with the collected
/// reports. Posts the matching terminal lifecycle event on every exit path
/// so the completion notifier fires regardless of how the run ends.
#[allow(clippy::too_many_arguments)]
async fn run_team_lifecycle(
    dispatcher: &TeamDispatcher,
    pid: &str,
    bus: &Arc<TeamBus>,
    comms: &Arc<TeamComms>,
    repo_path: &str,
    goal: &str,
    members: &[DispatchMember],
    lead_provider: &ProviderConfigSnapshot,
    team_provider: &ProviderConfigSnapshot,
    max_size: usize,
    run: &RunMetadata,
    cancel: &CancellationToken,
) -> Result<Vec<MemberReport>, String> {
    let seeded = match seed_dispatch(
        bus,
        repo_path,
        goal,
        members,
        Some(lead_provider.model.clone()),
        &team_provider.model,
        max_size,
    ) {
        Ok(seeded) => seeded,
        Err(e) => {
            post_lifecycle(
                bus,
                repo_path,
                run,
                "failed",
                Some("failed"),
                &format!("Team run failed while starting: {e}"),
            );
            return Err(format!("team start failed: {e}"));
        }
    };

    dispatcher.set_phase(pid, "working");
    post_lifecycle(
        bus,
        repo_path,
        run,
        "working",
        None,
        "Team members started — each is a live agent working its assignment; they coordinate here and report when finished.",
    );

    let roster: Vec<(String, String)> = seeded
        .iter()
        .map(|s| (s.record.id.clone(), s.record.role.clone()))
        .collect();

    // One real actor per member, each on its own task.
    let actor_handles: Vec<JoinHandle<MemberReport>> = seeded
        .iter()
        .map(|s| {
            tokio::spawn(run_member(MemberRun {
                bus: bus.clone(),
                comms: comms.clone(),
                repo_path: repo_path.to_string(),
                run_id: Some(run.run_id.clone()),
                goal: goal.to_string(),
                record: s.record.clone(),
                task: s.task.clone(),
                owned: s.owned.clone(),
                roster: roster.clone(),
                provider: team_provider.clone(),
                cancel: cancel.clone(),
            }))
        })
        .collect();

    let joined = futures::future::join_all(actor_handles);
    let outcomes = match tokio::time::timeout(RUN_WALL_CLOCK_TIMEOUT, joined).await {
        Ok(outcomes) => outcomes,
        Err(_) => {
            cancel.cancel();
            post_lifecycle(
                bus,
                repo_path,
                run,
                "working",
                Some("failed"),
                "Team run failed: it exceeded the wall-clock ceiling and was stopped.",
            );
            return Err("the run exceeded its wall-clock ceiling".to_string());
        }
    };

    let reports: Vec<MemberReport> = outcomes
        .into_iter()
        .zip(seeded.iter())
        .map(|(joined, s)| {
            joined.unwrap_or_else(|_| MemberReport {
                agent_id: s.record.id.clone(),
                role: s.record.role.clone(),
                status: ReportStatus::Failed,
                summary: "the member's actor task crashed".to_string(),
                changed_files: Vec::new(),
            })
        })
        .collect();

    if cancel.is_cancelled() {
        post_lifecycle(
            bus,
            repo_path,
            run,
            "cancelled",
            Some("failed"),
            "Team run failed: cancelled.",
        );
        return Err("cancelled".to_string());
    }

    // Close the team on the brain: phase Done, whatever mix the reports hold
    // — a blocked member is the Lead's to handle, not a reason to pretend
    // the whole run didn't finish.
    {
        let _guard = comms.lock_brain().await;
        if let Ok(session) = TeamSession::open(repo_path) {
            if let Ok(Some(mut team)) = session.workspace().read_team() {
                team.phase = TeamPhase::Done;
                team.updated_at = now_rfc3339();
                let _ = session.workspace().write_team(&team);
            }
        }
    }

    let done = reports
        .iter()
        .filter(|r| matches!(r.status, ReportStatus::Done))
        .count();
    let summary_line = format!(
        "Team finished — {done}/{} member{} reported done. The Lead has the reports.",
        reports.len(),
        if reports.len() == 1 { "" } else { "s" },
    );
    post_lifecycle(bus, repo_path, run, "done", Some("done"), &summary_line);
    Ok(reports)
}

/// Post one Lead lifecycle line to the team channel (persist + broadcast).
/// Best-effort: a failure here is cosmetic and must not abort the run.
fn post_lifecycle(
    bus: &TeamBus,
    repo_path: &str,
    run: &RunMetadata,
    phase: &str,
    terminal: Option<&str>,
    body: &str,
) {
    let ws = ProjectWorkspace::resolve(repo_path);
    let _ = bus.post(
        &ws,
        ChannelEvent {
            id: Uuid::new_v4().to_string(),
            ts: now_rfc3339(),
            author: LEAD_AGENT_ID.to_string(),
            kind: ChannelEventKind::System,
            body: body.to_string(),
            meta: Some(lifecycle_meta(run, phase, terminal)),
        },
    );
}

fn lifecycle_meta(run: &RunMetadata, phase: &str, terminal: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "phase": phase,
        "terminal": terminal,
        "runId": run.run_id,
        "originThreadId": run.origin_thread_id,
        "originSurface": run.origin_surface,
    })
}

// ── projectId → repoPath memory (for run.json snapshots) ──────────────────
//
// `snapshot_to_disk` runs from sync registry methods that only know the
// projectId; the brain dir is derived from the repo path. Dispatch records
// the mapping; a process restart simply loses snapshots until the next
// dispatch, which is fine — the snapshot is a courtesy record, not state.

static REPO_PATHS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn remember_repo_path(project_id: &str, repo_path: &str) {
    let mut guard = REPO_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(project_id.to_string(), repo_path.to_string());
}

fn repo_path_of(project_id: &str) -> Option<String> {
    REPO_PATHS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(project_id).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_fires_the_token_and_marks_status_failed() {
        let dispatcher = TeamDispatcher::new();
        let project_id = "pid-cancel".to_string();
        let cancel = CancellationToken::new();
        let observed = cancel.clone();
        let handle = tokio::spawn(async {
            futures::future::pending::<()>().await;
        });

        dispatcher.lock_runs().insert(
            project_id.clone(),
            TeamRunStatus::running("build", &RunMetadata::new(None, None)),
        );
        dispatcher.lock_handles().insert(
            project_id.clone(),
            RunHandles {
                task: handle,
                cancel,
            },
        );

        assert!(dispatcher.cancel(&project_id, "cancelled by user"));
        // Graceful: the token fired immediately…
        assert!(observed.is_cancelled());
        // …and the status is terminal.
        let status = dispatcher.status(&project_id);
        assert!(matches!(status.state, RunLifecycle::Failed));
        assert_eq!(status.error.as_deref(), Some("cancelled by user"));
        assert!(dispatcher.lock_handles().get(&project_id).is_none());
    }

    #[test]
    fn ack_is_terminal_only_and_run_scoped() {
        let dispatcher = TeamDispatcher::new();
        let pid = "pid-ack".to_string();
        let run = RunMetadata {
            run_id: "run-9".into(),
            origin_thread_id: None,
            origin_surface: None,
        };
        dispatcher
            .lock_runs()
            .insert(pid.clone(), TeamRunStatus::running("goal", &run));

        // A running run can't be acked — there is nothing to report yet.
        assert!(!dispatcher.ack(&pid, Some("run-9")));

        dispatcher.finish(&pid, Ok(Vec::new()));
        // Wrong run id → ignored; right id → flips once, then no-ops.
        assert!(!dispatcher.ack(&pid, Some("other-run")));
        assert!(dispatcher.ack(&pid, Some("run-9")));
        assert!(dispatcher.status(&pid).acknowledged);
        assert!(!dispatcher.ack(&pid, Some("run-9")));
    }

    #[test]
    fn finish_with_reports_lands_them_on_the_status() {
        let dispatcher = TeamDispatcher::new();
        let pid = "pid-reports".to_string();
        let run = RunMetadata::new(None, None);
        dispatcher
            .lock_runs()
            .insert(pid.clone(), TeamRunStatus::running("goal", &run));
        dispatcher.finish(
            &pid,
            Ok(vec![MemberReport {
                agent_id: "a".into(),
                role: "api-owner".into(),
                status: ReportStatus::Done,
                summary: "built and verified".into(),
                changed_files: vec!["src/api/x.ts".into()],
            }]),
        );
        let status = dispatcher.status(&pid);
        assert!(matches!(status.state, RunLifecycle::Done));
        assert_eq!(status.reports.len(), 1);
        assert_eq!(status.reports[0].changed_files, vec!["src/api/x.ts"]);
    }

    #[test]
    fn empty_members_are_rejected_before_any_state_lands() {
        let dispatcher = Arc::new(TeamDispatcher::new());
        let err = dispatcher
            .dispatch(
                Arc::new(TeamBus::headless()),
                "C:/nowhere/repo".into(),
                "goal".into(),
                Vec::new(),
                test_provider(),
                test_provider(),
                4,
                None,
                None,
            )
            .unwrap_err();
        assert!(err.contains("requires members"));
        assert!(dispatcher.lock_runs().is_empty());
    }

    fn test_provider() -> ProviderConfigSnapshot {
        serde_json::from_value(serde_json::json!({
            "providerId": "custom",
            "baseUrl": "http://localhost:9",
            "model": "test-model"
        }))
        .expect("snapshot")
    }

    #[test]
    fn lifecycle_meta_carries_origin_and_terminal_status() {
        let run = RunMetadata {
            run_id: "run-1".into(),
            origin_thread_id: Some("thread-1".into()),
            origin_surface: Some("agent-window".into()),
        };
        let meta = lifecycle_meta(&run, "done", Some("done"));
        assert_eq!(meta["runId"], "run-1");
        assert_eq!(meta["originThreadId"], "thread-1");
        assert_eq!(meta["originSurface"], "agent-window");
        assert_eq!(meta["terminal"], "done");
    }
}
