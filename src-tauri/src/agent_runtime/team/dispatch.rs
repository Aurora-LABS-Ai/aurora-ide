//! `TeamDispatcher` — the **background run engine** (ground truth §9, §17
//! "the team is its own engine").
//!
//! The Lead (the chat agent in Team mode) must never block on the team. When
//! the user says "spin up a team for X", the Lead calls `team_dispatch` once;
//! that hands the work to this dispatcher, which starts the assigned workers on
//! a detached [`tokio::spawn`] task and returns control to the Lead
//! **immediately**. The Lead is then free to keep talking to the user while the
//! team works in the background, streaming into the Team window via the
//! [`TeamBus`].
//!
//! ## Why this lives entirely in Rust
//!
//! The worker run is Rust-native: [`run_build`] calls the model through
//! [`crate::api::build_api_client`] and writes files directly to disk
//! (scope-guarded). Nothing bridges back to the frontend, so a spawned task can
//! run to completion even after the Lead's chat turn has ended.
//!
//! ## Status (the "pull" re-engage model, §17)
//!
//! Instead of pushing a turn back into the chat when the team finishes, the
//! dispatcher keeps a small in-memory [`TeamRunStatus`] per project. The
//! frontend reads it (via `team_run_status`) and injects it into the Lead's
//! context on **every** user message in Team mode — so the moment the user
//! pings the Lead, the Lead already knows whether the team is still running,
//! finished, or failed, and can report back. The on-disk brain phase remains
//! the durable source of truth; this registry just adds the live
//! running/failed signal the brain alone can't express.

#![allow(dead_code)]

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use serde::Serialize;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::api::ProviderConfigSnapshot;

use super::bus::TeamBus;
use super::ids::project_id_for;
use super::integration_runner::GateCommands;
use super::orchestrator::LEAD_AGENT_ID;
use super::run_build;
use super::runner::run_assigned_planning;
use super::types::{ChannelEvent, ChannelEventKind, DispatchMember};
use super::workspace::{now_rfc3339, ProjectWorkspace};

/// Lifecycle of a dispatched (background) team run, as seen by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunLifecycle {
    /// No run has ever been dispatched for this workspace this session.
    Idle,
    /// A run is executing right now (see [`TeamRunStatus::phase`]).
    Running,
    /// The most recent worker run finished.
    Done,
    /// The most recent run errored (see [`TeamRunStatus::error`]).
    Failed,
}

/// Live status of the background run for one project. Cheap to clone; the
/// frontend injects it into the Lead's context every message (§17 pull model).
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

/// In-memory registry of background team runs, keyed by `projectId`.
///
/// Lives in Tauri managed state as `Arc<TeamDispatcher>` (wired in `lib.rs`).
/// One run per workspace at a time — a second `dispatch` while one is `running`
/// is rejected so a stray Lead call can't fork a competing run over the same
/// brain.
pub struct TeamDispatcher {
    runs: Mutex<HashMap<String, TeamRunStatus>>,
    handles: Mutex<HashMap<String, JoinHandle<()>>>,
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
        }
    }

    /// Lock the run registry, recovering from a poisoned mutex instead of
    /// panicking. A panic in one dispatched task must never cascade into every
    /// later `status`/`dispatch` call for the whole app session.
    fn lock_runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, TeamRunStatus>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Lock the join-handle registry, recovering from poison (see [`Self::lock_runs`]).
    fn lock_handles(&self) -> std::sync::MutexGuard<'_, HashMap<String, JoinHandle<()>>> {
        self.handles.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Current status for a project (`idle` when nothing was ever dispatched).
    #[must_use]
    pub fn status(&self, project_id: &str) -> TeamRunStatus {
        self.lock_runs()
            .get(project_id)
            .cloned()
            .unwrap_or_else(TeamRunStatus::idle)
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

    fn is_running(&self, project_id: &str) -> bool {
        matches!(
            self.lock_runs().get(project_id).map(|s| s.state),
            Some(RunLifecycle::Running)
        )
    }

    fn set_phase(&self, project_id: &str, phase: &str) {
        if let Some(s) = self.lock_runs().get_mut(project_id) {
            s.phase = Some(phase.to_string());
        }
    }

    fn finish(&self, project_id: &str, result: Result<(), String>) {
        if let Some(s) = self.lock_runs().get_mut(project_id) {
            s.phase = None;
            s.finished_at = Some(now_rfc3339());
            match result {
                Ok(()) => s.state = RunLifecycle::Done,
                Err(e) => {
                    s.state = RunLifecycle::Failed;
                    s.error = Some(e);
                }
            }
        }
        self.lock_handles().remove(project_id);
    }

    /// Abort the live background task for a project, if one is running.
    /// Returns true when a task/status was cancelled.
    pub fn cancel(&self, project_id: &str, reason: &str) -> bool {
        let mut cancelled = false;
        if let Some(handle) = self.lock_handles().remove(project_id) {
            handle.abort();
            cancelled = true;
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
        cancelled
    }

    /// Abort a live run and post the same terminal lifecycle marker that a
    /// normal failure would post, so completion routing is not lost on cancel.
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

    /// Dispatch the assigned worker run on a detached background task and
    /// return its `projectId` immediately.
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
        members: Option<Vec<DispatchMember>>,
        lead_provider: ProviderConfigSnapshot,
        team_provider: ProviderConfigSnapshot,
        max_size: usize,
        _desired_ics: Option<usize>,
        _gate: GateCommands,
        origin_thread_id: Option<String>,
        origin_surface: Option<String>,
    ) -> Result<String, String> {
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

        // Reset the brain for the new run BEFORE returning: Lead-only roster,
        // cleared scope/board/gate, plus a dispatched
        // lifecycle line (meta.dispatched = true, which scopes the Team view to
        // this run). Without this the window shows the PREVIOUS run's final
        // state (stale roster, old "done" statuses) until the workers start —
        // which reads as frozen/broken to the user.
        match super::orchestrator::TeamSession::open(&repo_path) {
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

        let me = Arc::clone(self);
        let pid = project_id.clone();
        let handle = tokio::spawn(async move {
            // Run the worker task under `catch_unwind` so a panic anywhere can
            // never bypass `finish()` — a
            // stuck-`Running` status would otherwise stick-lock the one-run
            // guard for the whole workspace until the app is restarted.
            let outcome = AssertUnwindSafe(run_team_lifecycle(
                &me,
                &pid,
                &bus,
                &repo_path,
                &goal,
                members.as_deref(),
                &lead_provider,
                &team_provider,
                max_size,
                &run,
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
        self.lock_handles().insert(project_id.clone(), handle);

        Ok(project_id)
    }
}

/// The assigned-worker run for one dispatched team.
///
/// Extracted from the spawned task so the caller can wrap it in
/// `catch_unwind` and call [`TeamDispatcher::finish`] exactly once on every
/// exit path (Ok, Err, or panic). Returns `Ok(())` on success and `Err(msg)`
/// on any phase failure; it posts the matching terminal lifecycle event
/// itself so the completion notifier fires regardless of how the run ends.
#[allow(clippy::too_many_arguments)]
async fn run_team_lifecycle(
    dispatcher: &TeamDispatcher,
    pid: &str,
    bus: &Arc<TeamBus>,
    repo_path: &str,
    goal: &str,
    members: Option<&[DispatchMember]>,
    lead_provider: &ProviderConfigSnapshot,
    team_provider: &ProviderConfigSnapshot,
    max_size: usize,
    run: &RunMetadata,
) -> Result<(), String> {
    let Some(members) = members.filter(|m| !m.is_empty()) else {
        post_lifecycle(
            bus,
            repo_path,
            run,
            "failed",
            Some("failed"),
            "Team run failed: team_dispatch requires assigned members.",
        );
        return Err("team_dispatch requires assigned members".to_string());
    };

    if let Err(e) = run_assigned_planning(
        bus,
        repo_path,
        goal,
        members,
        Some(lead_provider.model.clone()),
        team_provider,
        max_size,
    )
    .await
    {
        post_lifecycle(
            bus,
            repo_path,
            run,
            "failed",
            Some("failed"),
            &format!("Team run failed while starting workers: {e}"),
        );
        return Err(format!("team start failed: {e}"));
    }

    dispatcher.set_phase(pid, "working");
    post_lifecycle(
        bus,
        repo_path,
        run,
        "working",
        None,
        "Team workers started — they are reading, writing, and coordinating in their scopes.",
    );
    if let Err(e) = run_build(bus, repo_path, goal, team_provider).await {
        post_lifecycle(
            bus,
            repo_path,
            run,
            "working",
            Some("failed"),
            &format!("Team run failed while workers were active: {e}"),
        );
        return Err(format!("worker run failed: {e}"));
    }

    post_lifecycle(
        bus,
        repo_path,
        run,
        "done",
        Some("done"),
        "Team workers finished and reported back. The Lead can inspect their reports and continue with the user.",
    );
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_aborts_running_task_and_marks_status_failed() {
        let dispatcher = TeamDispatcher::new();
        let project_id = "pid-cancel".to_string();
        let handle = tokio::spawn(async {
            futures::future::pending::<()>().await;
        });

        dispatcher.runs.lock().unwrap().insert(
            project_id.clone(),
            TeamRunStatus::running("build", &RunMetadata::new(None, None)),
        );
        dispatcher
            .handles
            .lock()
            .unwrap()
            .insert(project_id.clone(), handle);

        assert!(dispatcher.cancel(&project_id, "cancelled by user"));

        let status = dispatcher.status(&project_id);
        assert!(matches!(status.state, RunLifecycle::Failed));
        assert_eq!(status.phase, None);
        assert_eq!(status.error.as_deref(), Some("cancelled by user"));
        assert!(dispatcher
            .handles
            .lock()
            .unwrap()
            .get(&project_id)
            .is_none());
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
            .runs
            .lock()
            .unwrap()
            .insert(pid.clone(), TeamRunStatus::running("goal", &run));

        // A running run can't be acked — there is nothing to report yet.
        assert!(!dispatcher.ack(&pid, Some("run-9")));

        dispatcher.finish(&pid, Ok(()));
        // Wrong run id → ignored; right id → flips once, then no-ops.
        assert!(!dispatcher.ack(&pid, Some("other-run")));
        assert!(dispatcher.ack(&pid, Some("run-9")));
        assert!(dispatcher.status(&pid).acknowledged);
        assert!(!dispatcher.ack(&pid, Some("run-9")));
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
