//! Plan model — the structured half of a `.aurora.md` plan document.
//!
//! The hard split this module exists to enforce: **prose is a document, step
//! status is structured state**. Everything here is frontmatter. The markdown
//! body never appears in these types, so a status flip can never rewrite prose.
//!
//! Pure logic only — no filesystem, no Tauri. Parsing/serialisation lives in
//! [`super::document`], disk access in [`super::store`].

use serde::{Deserialize, Serialize};

/// Frontmatter schema version. Bumped only on a breaking layout change so an
/// older Aurora refuses a newer file instead of silently misreading it.
pub const PLAN_SCHEMA_VERSION: u32 = 1;

/// Where a single step stands.
///
/// `Skipped` exists because plans get revised mid-flight — a step that reality
/// made unnecessary must be closable without pretending it was `Done` or
/// claiming it `Failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Done,
    Failed,
    Skipped,
}

impl StepStatus {
    /// A step nobody is waiting on any more.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Skipped)
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

/// Lifecycle of the plan as a whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    /// Authored but not yet handed to Agent mode.
    Draft,
    /// Being executed.
    Active,
    Done,
    Failed,
    Abandoned,
}

/// One step. `id` is stable for the life of the plan — revisions reconcile by
/// id so a re-authored plan cannot re-map statuses onto the wrong step (the
/// exact bug that makes positional `todo_write` untrustworthy).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub title: String,
    pub status: StepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Which run claimed this step as `InProgress`. The Canvas spins a section
    /// only when this matches a currently-live run — see
    /// [`PlanStep::is_live_under`]. A stale value is what turns a spinner into
    /// an honest "Interrupted".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Optional declared scope, advisory only under soft enforcement.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// Short note, typically the reason for `Failed` or `Skipped`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl PlanStep {
    #[must_use]
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            status: StepStatus::Pending,
            started_at: None,
            ended_at: None,
            run_id: None,
            paths: Vec::new(),
            note: None,
        }
    }

    /// True only when this step is `InProgress` **and** the run that claimed it
    /// is the one currently executing.
    ///
    /// This is the whole liveness rule. A step left `InProgress` by a stopped
    /// run, a closed window, or a session from three hours ago is *not* live,
    /// and must never be presented as though work were happening.
    #[must_use]
    pub fn is_live_under(&self, live_run_id: Option<&str>) -> bool {
        if self.status != StepStatus::InProgress {
            return false;
        }
        match (self.run_id.as_deref(), live_run_id) {
            (Some(owner), Some(live)) => owner == live,
            // An in-progress step with no owning run predates liveness
            // tracking or was hand-edited; treat it as interrupted rather
            // than inventing a claim that work is happening.
            _ => false,
        }
    }

    /// `InProgress` but abandoned by whatever run claimed it.
    #[must_use]
    pub fn is_interrupted(&self, live_run_id: Option<&str>) -> bool {
        self.status == StepStatus::InProgress && !self.is_live_under(live_run_id)
    }
}

/// The structured half of a plan file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFrontmatter {
    /// Schema version; see [`PLAN_SCHEMA_VERSION`].
    pub aurora_plan: u32,
    pub id: String,
    pub title: String,
    pub status: PlanStatus,
    pub created_at: String,
    pub updated_at: String,
    /// Thread that authored the plan. Advisory — a plan belongs to the
    /// workspace, so a different thread may legitimately execute it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub steps: Vec<PlanStep>,
}

/// "Where am I" — the answer today's `todo_write` can never give.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCursor {
    /// The single `InProgress` step, if any.
    pub active_step_id: Option<String>,
    /// First `Pending` step — what to pick up next.
    pub next_step_id: Option<String>,
    pub done: usize,
    pub failed: usize,
    pub skipped: usize,
    pub pending: usize,
    pub total: usize,
    /// True when no step remains `Pending` or `InProgress`.
    pub complete: bool,
}

impl PlanFrontmatter {
    #[must_use]
    pub fn step(&self, step_id: &str) -> Option<&PlanStep> {
        self.steps.iter().find(|s| s.id == step_id)
    }

    #[must_use]
    pub fn step_mut(&mut self, step_id: &str) -> Option<&mut PlanStep> {
        self.steps.iter_mut().find(|s| s.id == step_id)
    }

    /// Derive the cursor. Cheap enough to recompute on every read rather than
    /// storing it — a stored cursor is one more thing that can disagree with
    /// the steps it summarises.
    #[must_use]
    pub fn cursor(&self) -> PlanCursor {
        let mut done = 0;
        let mut failed = 0;
        let mut skipped = 0;
        let mut pending = 0;
        for step in &self.steps {
            match step.status {
                StepStatus::Done => done += 1,
                StepStatus::Failed => failed += 1,
                StepStatus::Skipped => skipped += 1,
                StepStatus::Pending => pending += 1,
                StepStatus::InProgress => {}
            }
        }
        let active_step_id = self
            .steps
            .iter()
            .find(|s| s.status == StepStatus::InProgress)
            .map(|s| s.id.clone());
        let next_step_id = self
            .steps
            .iter()
            .find(|s| s.status == StepStatus::Pending)
            .map(|s| s.id.clone());
        PlanCursor {
            complete: !self.steps.is_empty() && active_step_id.is_none() && pending == 0,
            active_step_id,
            next_step_id,
            done,
            failed,
            skipped,
            pending,
            total: self.steps.len(),
        }
    }

    /// Keep at most one `InProgress` step: the first wins, the rest fall back
    /// to `Pending`. Returns the ids that were demoted.
    ///
    /// Soft-clamp rather than hard error, matching the existing `todo_write`
    /// contract — a hard failure here used to blow up the whole turn with a red
    /// banner even though the agent recovered on the next iteration.
    pub fn clamp_single_in_progress(&mut self) -> Vec<String> {
        let mut demoted = Vec::new();
        let mut seen = false;
        for step in &mut self.steps {
            if step.status != StepStatus::InProgress {
                continue;
            }
            if seen {
                step.status = StepStatus::Pending;
                step.run_id = None;
                step.started_at = None;
                demoted.push(step.id.clone());
            } else {
                seen = true;
            }
        }
        demoted
    }

    /// Mint a step id that cannot collide with an existing one.
    ///
    /// Ids look like `s1`, `s2`, … but a revision must never reuse a retired
    /// id, so this walks past the current maximum rather than counting steps.
    #[must_use]
    pub fn next_step_id(&self) -> String {
        let max = self
            .steps
            .iter()
            .filter_map(|s| s.id.strip_prefix('s'))
            .filter_map(|n| n.parse::<u32>().ok())
            .max()
            .unwrap_or(0);
        format!("s{}", max + 1)
    }
}

/// A step as supplied by `plan_write` — no status, because authoring never
/// dictates progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepDraft {
    /// Reuse an existing id to revise that step in place; `None` mints a new one.
    pub id: Option<String>,
    pub title: String,
    pub paths: Vec<String>,
}

/// Reconcile an authored step list onto the existing one.
///
/// Surviving steps keep their status, timestamps, and run claim; only the
/// title and declared paths are refreshed. Steps absent from the draft are
/// dropped. This is what lets the agent revise a plan mid-execution without
/// losing the record of what it already finished.
#[must_use]
pub fn reconcile_steps(existing: &[PlanStep], drafts: &[StepDraft]) -> Vec<PlanStep> {
    let mut minted = PlanFrontmatter {
        aurora_plan: PLAN_SCHEMA_VERSION,
        id: String::new(),
        title: String::new(),
        status: PlanStatus::Draft,
        created_at: String::new(),
        updated_at: String::new(),
        thread_id: None,
        steps: existing.to_vec(),
    };

    let mut out: Vec<PlanStep> = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let prior = draft
            .id
            .as_deref()
            .and_then(|id| existing.iter().find(|s| s.id == id));
        match prior {
            Some(prior) => out.push(PlanStep {
                title: draft.title.clone(),
                paths: draft.paths.clone(),
                ..prior.clone()
            }),
            None => {
                let id = match draft.id.as_deref() {
                    // An explicit id that matches nothing existing is honoured
                    // as-is; the agent may be re-creating a plan from its own
                    // earlier output.
                    Some(explicit) if !explicit.is_empty() => explicit.to_string(),
                    _ => {
                        let id = minted.next_step_id();
                        minted.steps.push(PlanStep::new(id.clone(), &draft.title));
                        id
                    }
                };
                let mut step = PlanStep::new(id, &draft.title);
                step.paths = draft.paths.clone();
                out.push(step);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, status: StepStatus) -> PlanStep {
        PlanStep {
            status,
            ..PlanStep::new(id, format!("Step {id}"))
        }
    }

    fn frontmatter(steps: Vec<PlanStep>) -> PlanFrontmatter {
        PlanFrontmatter {
            aurora_plan: PLAN_SCHEMA_VERSION,
            id: "plan_test".into(),
            title: "Test".into(),
            status: PlanStatus::Active,
            created_at: "2026-07-28T00:00:00Z".into(),
            updated_at: "2026-07-28T00:00:00Z".into(),
            thread_id: None,
            steps,
        }
    }

    #[test]
    fn a_step_is_live_only_under_its_own_run() {
        let mut s = step("s1", StepStatus::InProgress);
        s.run_id = Some("run_a".into());

        assert!(s.is_live_under(Some("run_a")), "own run is live");
        assert!(!s.is_live_under(Some("run_b")), "another run is not");
        assert!(!s.is_live_under(None), "no live run at all");
        assert!(s.is_interrupted(Some("run_b")));
        assert!(!s.is_interrupted(Some("run_a")));
    }

    #[test]
    fn in_progress_without_a_run_claim_is_interrupted_not_live() {
        // Hand-edited files and pre-liveness plans land here. Presenting this
        // as a spinner would animate over a runtime that does not exist.
        let s = step("s1", StepStatus::InProgress);
        assert!(!s.is_live_under(Some("run_a")));
        assert!(s.is_interrupted(Some("run_a")));
    }

    #[test]
    fn terminal_steps_are_never_live() {
        for status in [StepStatus::Done, StepStatus::Failed, StepStatus::Skipped] {
            let mut s = step("s1", status);
            s.run_id = Some("run_a".into());
            assert!(!s.is_live_under(Some("run_a")), "{status:?} must not spin");
            assert!(!s.is_interrupted(Some("run_a")));
            assert!(status.is_terminal());
        }
    }

    #[test]
    fn cursor_reports_active_next_and_counts() {
        let fm = frontmatter(vec![
            step("s1", StepStatus::Done),
            step("s2", StepStatus::InProgress),
            step("s3", StepStatus::Pending),
            step("s4", StepStatus::Failed),
            step("s5", StepStatus::Skipped),
        ]);
        let c = fm.cursor();
        assert_eq!(c.active_step_id.as_deref(), Some("s2"));
        assert_eq!(c.next_step_id.as_deref(), Some("s3"));
        assert_eq!((c.done, c.failed, c.skipped, c.pending), (1, 1, 1, 1));
        assert_eq!(c.total, 5);
        assert!(!c.complete, "a pending step remains");
    }

    #[test]
    fn cursor_is_complete_only_when_nothing_is_open() {
        let fm = frontmatter(vec![
            step("s1", StepStatus::Done),
            step("s2", StepStatus::Skipped),
        ]);
        assert!(fm.cursor().complete);

        // An empty plan is not "complete" — it is unplanned.
        assert!(!frontmatter(vec![]).cursor().complete);
    }

    #[test]
    fn clamp_keeps_the_first_in_progress_and_resets_the_rest() {
        let mut a = step("s1", StepStatus::InProgress);
        a.run_id = Some("run_a".into());
        let mut b = step("s2", StepStatus::InProgress);
        b.run_id = Some("run_a".into());
        b.started_at = Some("t".into());
        let mut fm = frontmatter(vec![a, b, step("s3", StepStatus::InProgress)]);

        let demoted = fm.clamp_single_in_progress();

        assert_eq!(demoted, vec!["s2".to_string(), "s3".to_string()]);
        assert_eq!(fm.steps[0].status, StepStatus::InProgress);
        assert_eq!(fm.steps[1].status, StepStatus::Pending);
        assert_eq!(
            fm.steps[1].run_id, None,
            "a demoted step must not keep a run claim"
        );
        assert_eq!(fm.steps[1].started_at, None);
        assert_eq!(fm.cursor().active_step_id.as_deref(), Some("s1"));
    }

    #[test]
    fn next_step_id_walks_past_the_maximum_not_the_count() {
        // Retired ids must never be reused: s2 was deleted, so a two-step plan
        // must still mint s4 rather than colliding with the surviving s3.
        let fm = frontmatter(vec![step("s1", StepStatus::Done), step("s3", StepStatus::Done)]);
        assert_eq!(fm.next_step_id(), "s4");
        assert_eq!(frontmatter(vec![]).next_step_id(), "s1");
    }

    #[test]
    fn reconcile_preserves_status_of_surviving_steps() {
        let mut done = step("s1", StepStatus::Done);
        done.ended_at = Some("t1".into());
        let mut running = step("s2", StepStatus::InProgress);
        running.run_id = Some("run_a".into());
        let existing = vec![done, running];

        let drafts = vec![
            StepDraft {
                id: Some("s1".into()),
                title: "Scaffold routes (renamed)".into(),
                paths: vec!["src/api/**".into()],
            },
            StepDraft {
                id: Some("s2".into()),
                title: "Wire auth".into(),
                paths: vec![],
            },
            StepDraft {
                id: None,
                title: "New integration tests".into(),
                paths: vec![],
            },
        ];

        let out = reconcile_steps(&existing, &drafts);

        assert_eq!(out.len(), 3);
        assert_eq!(out[0].status, StepStatus::Done, "finished work survives");
        assert_eq!(out[0].title, "Scaffold routes (renamed)");
        assert_eq!(out[0].ended_at.as_deref(), Some("t1"));
        assert_eq!(out[0].paths, vec!["src/api/**".to_string()]);
        assert_eq!(out[1].status, StepStatus::InProgress);
        assert_eq!(out[1].run_id.as_deref(), Some("run_a"), "run claim survives");
        assert_eq!(out[2].status, StepStatus::Pending, "new steps start pending");
        assert_eq!(out[2].id, "s3", "minted id must not collide");
    }

    #[test]
    fn reconcile_drops_steps_absent_from_the_draft() {
        let existing = vec![step("s1", StepStatus::Done), step("s2", StepStatus::Pending)];
        let drafts = vec![StepDraft {
            id: Some("s1".into()),
            title: "Only survivor".into(),
            paths: vec![],
        }];

        let out = reconcile_steps(&existing, &drafts);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "s1");
    }

    #[test]
    fn reconcile_mints_non_colliding_ids_for_a_fully_new_plan() {
        let out = reconcile_steps(
            &[],
            &[
                StepDraft { id: None, title: "A".into(), paths: vec![] },
                StepDraft { id: None, title: "B".into(), paths: vec![] },
                StepDraft { id: None, title: "C".into(), paths: vec![] },
            ],
        );
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["s1", "s2", "s3"]);
        assert!(out.iter().all(|s| s.status == StepStatus::Pending));
    }
}
