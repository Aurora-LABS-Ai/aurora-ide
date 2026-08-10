//! Tauri commands backing the Plan Canvas.
//!
//! The frontend never caches plan content: every command re-reads the file, so
//! switching workspace, reopening the app, or a hand-edit outside Aurora all
//! resolve correctly without a sync step.
//!
//! Liveness is deliberately **not** computed here. Whether an `in_progress`
//! step is actually running depends on which thread is streaming right now,
//! which only the frontend knows — it compares each step's `runId` against the
//! live thread. See `useAgentPlanStore`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::plans::document::{self, BodySection};
use crate::plans::model::{PlanCursor, PlanStatus, PlanStep, StepStatus};
use crate::plans::store::{self, PlanSummary};

/// Everything the Canvas needs to render one plan.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub id: String,
    pub title: String,
    pub status: PlanStatus,
    pub created_at: String,
    pub updated_at: String,
    pub thread_id: Option<String>,
    pub path: String,
    pub steps: Vec<PlanStep>,
    pub cursor: PlanCursor,
    /// Text before the first step heading.
    pub overview: String,
    pub sections: Vec<BodySection>,
    /// Raw markdown body, for the Canvas source view.
    pub body: String,
}

fn view(path: PathBuf, doc: document::PlanDocument) -> PlanView {
    let ids: Vec<String> = doc.frontmatter.steps.iter().map(|s| s.id.clone()).collect();
    PlanView {
        cursor: doc.frontmatter.cursor(),
        overview: document::preamble(&doc.body),
        sections: document::sections(&doc.body, &ids),
        id: doc.frontmatter.id,
        title: doc.frontmatter.title,
        status: doc.frontmatter.status,
        created_at: doc.frontmatter.created_at,
        updated_at: doc.frontmatter.updated_at,
        thread_id: doc.frontmatter.thread_id,
        path: path.to_string_lossy().to_string(),
        steps: doc.frontmatter.steps,
        body: doc.body,
    }
}

fn workspace_path(workspace_root: &str) -> Result<PathBuf, String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() {
        return Err("No workspace is open.".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

/// The plan the workspace is currently working from, if any.
#[tauri::command]
pub fn plan_get_active(workspace_root: String) -> Result<Option<PlanView>, String> {
    let workspace = workspace_path(&workspace_root)?;
    Ok(store::active(&workspace)?.map(|(path, doc)| view(path, doc)))
}

/// One specific plan, including finished ones the Canvas can still show.
#[tauri::command]
pub fn plan_get(workspace_root: String, plan_id: String) -> Result<Option<PlanView>, String> {
    let workspace = workspace_path(&workspace_root)?;
    Ok(store::load(&workspace, &plan_id)?.map(|(path, doc)| view(path, doc)))
}

/// Every plan in the workspace, newest first.
#[tauri::command]
pub fn plan_list(workspace_root: String) -> Result<Vec<PlanSummary>, String> {
    let workspace = workspace_path(&workspace_root)?;
    store::list(&workspace)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepStatusRequest {
    pub workspace_root: String,
    pub plan_id: String,
    pub step_id: String,
    pub status: String,
    pub note: Option<String>,
}

/// Flip a step's status from the UI.
///
/// The user driving this is a first-class case, not a debug affordance: they
/// may need to reopen a step the agent closed too early, or abandon one it
/// never finished.
///
/// A user-set `in_progress` deliberately carries **no run claim** — nothing is
/// executing it — so the Canvas shows it as paused rather than spinning. A
/// spinner here would be a lie.
#[tauri::command]
pub fn plan_set_step_status(request: PlanStepStatusRequest) -> Result<PlanView, String> {
    let workspace = workspace_path(&request.workspace_root)?;
    let status = match request.status.as_str() {
        "pending" => StepStatus::Pending,
        "in_progress" => StepStatus::InProgress,
        "done" => StepStatus::Done,
        "failed" => StepStatus::Failed,
        "skipped" => StepStatus::Skipped,
        other => {
            return Err(format!(
                "status `{other}` is not one of [pending, in_progress, done, failed, skipped]"
            ))
        }
    };

    let note = request.note.clone();
    let doc = store::update(&workspace, &request.plan_id, move |doc| {
        let now = store::now_iso();
        let step = doc
            .frontmatter
            .step_mut(&request.step_id)
            .ok_or_else(|| format!("No step `{}` in this plan", request.step_id))?;
        step.status = status;
        if note.is_some() {
            step.note = note.clone();
        }
        match status {
            StepStatus::InProgress => {
                step.run_id = None;
                step.started_at.get_or_insert(now);
                step.ended_at = None;
            }
            StepStatus::Pending => {
                step.run_id = None;
                step.started_at = None;
                step.ended_at = None;
            }
            StepStatus::Done | StepStatus::Failed | StepStatus::Skipped => {
                step.run_id = None;
                step.ended_at = Some(now);
            }
        }
        doc.frontmatter.clamp_single_in_progress();
        let cursor = doc.frontmatter.cursor();
        doc.frontmatter.status = if cursor.complete {
            if cursor.failed > 0 {
                PlanStatus::Failed
            } else {
                PlanStatus::Done
            }
        } else {
            PlanStatus::Active
        };
        Ok(())
    })?;

    let path =
        store::find_path(&workspace, &doc.frontmatter.id)?.unwrap_or_else(|| PathBuf::from(""));
    Ok(view(path, doc))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanBodyRequest {
    pub workspace_root: String,
    pub plan_id: String,
    pub body: String,
}

/// Save a hand-edited plan body from the Canvas source view.
///
/// Only the prose is replaced — step statuses live in frontmatter and are left
/// exactly as they were, so editing the wording of a step cannot silently
/// reset work that is already done.
#[tauri::command]
pub fn plan_save_body(request: PlanBodyRequest) -> Result<PlanView, String> {
    let workspace = workspace_path(&request.workspace_root)?;
    let body = request.body.clone();
    let doc = store::update(&workspace, &request.plan_id, move |doc| {
        doc.body = body.clone();
        Ok(())
    })?;
    let path =
        store::find_path(&workspace, &doc.frontmatter.id)?.unwrap_or_else(|| PathBuf::from(""));
    Ok(view(path, doc))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStatusRequest {
    pub workspace_root: String,
    pub plan_id: String,
    pub status: String,
}

/// Set the plan's own lifecycle status — used by the Canvas to abandon or
/// reopen a plan.
#[tauri::command]
pub fn plan_set_status(request: PlanStatusRequest) -> Result<PlanView, String> {
    let workspace = workspace_path(&request.workspace_root)?;
    let status = match request.status.as_str() {
        "draft" => PlanStatus::Draft,
        "active" => PlanStatus::Active,
        "done" => PlanStatus::Done,
        "failed" => PlanStatus::Failed,
        "abandoned" => PlanStatus::Abandoned,
        other => {
            return Err(format!(
                "status `{other}` is not one of [draft, active, done, failed, abandoned]"
            ))
        }
    };
    let doc = store::update(&workspace, &request.plan_id, move |doc| {
        doc.frontmatter.status = status;
        Ok(())
    })?;
    let path =
        store::find_path(&workspace, &doc.frontmatter.id)?.unwrap_or_else(|| PathBuf::from(""));
    Ok(view(path, doc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::model::PlanStep;

    fn workspace(name: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("aurora-plancmd-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("ws");
        dir.to_string_lossy().to_string()
    }

    fn seed(ws: &str) -> String {
        let mut fm = store::empty_frontmatter("API Building", Some("thr_1".into()));
        fm.status = PlanStatus::Active;
        fm.steps = vec![
            PlanStep::new("s1", "Scaffold"),
            PlanStep::new("s2", "Wire auth"),
        ];
        let id = fm.id.clone();
        store::create(
            &PathBuf::from(ws),
            fm,
            "Overview text.\n\n## 1. Scaffold {#s1}\n\nA.\n\n## 2. Wire auth {#s2}\n\nB.\n".into(),
        )
        .expect("seed");
        id
    }

    #[test]
    fn get_active_returns_a_fully_rendered_view() {
        let ws = workspace("view");
        seed(&ws);

        let plan = plan_get_active(ws.clone()).expect("query").expect("a plan");

        assert_eq!(plan.title, "API Building");
        assert_eq!(plan.overview, "Overview text.");
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.sections.len(), 2);
        assert_eq!(plan.sections[0].step_id.as_deref(), Some("s1"));
        assert_eq!(plan.cursor.next_step_id.as_deref(), Some("s1"));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn get_active_is_none_without_a_workspace_plan() {
        let ws = workspace("empty");
        assert!(plan_get_active(ws.clone()).expect("query").is_none());
        assert!(plan_list(ws.clone()).expect("list").is_empty());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn an_empty_workspace_path_is_an_error_not_a_panic() {
        assert!(plan_get_active(String::new()).is_err());
        assert!(plan_list("   ".into()).is_err());
    }

    #[test]
    fn a_user_set_in_progress_carries_no_run_claim() {
        // Nothing is executing it, so it must present as paused, never spinning.
        let ws = workspace("userclaim");
        let plan_id = seed(&ws);

        let plan = plan_set_step_status(PlanStepStatusRequest {
            workspace_root: ws.clone(),
            plan_id,
            step_id: "s1".into(),
            status: "in_progress".into(),
            note: None,
        })
        .expect("update");

        let step = plan.steps.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(step.status, StepStatus::InProgress);
        assert_eq!(step.run_id, None, "no run owns a user-set in_progress");
        assert!(!step.is_live_under(Some("thr_1")));
        assert!(step.is_interrupted(Some("thr_1")));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn closing_every_step_marks_the_plan_done() {
        let ws = workspace("close");
        let plan_id = seed(&ws);
        for step in ["s1", "s2"] {
            plan_set_step_status(PlanStepStatusRequest {
                workspace_root: ws.clone(),
                plan_id: plan_id.clone(),
                step_id: step.into(),
                status: "done".into(),
                note: None,
            })
            .expect("close");
        }
        let plan = plan_get(ws.clone(), plan_id)
            .expect("get")
            .expect("present");
        assert_eq!(plan.status, PlanStatus::Done);
        assert!(plan.cursor.complete);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn a_failed_step_marks_the_plan_failed() {
        let ws = workspace("fail");
        let plan_id = seed(&ws);
        plan_set_step_status(PlanStepStatusRequest {
            workspace_root: ws.clone(),
            plan_id: plan_id.clone(),
            step_id: "s1".into(),
            status: "failed".into(),
            note: Some("blocked".into()),
        })
        .expect("fail");
        let plan = plan_set_step_status(PlanStepStatusRequest {
            workspace_root: ws.clone(),
            plan_id,
            step_id: "s2".into(),
            status: "skipped".into(),
            note: None,
        })
        .expect("skip");

        assert_eq!(plan.status, PlanStatus::Failed);
        assert_eq!(
            plan.steps
                .iter()
                .find(|s| s.id == "s1")
                .unwrap()
                .note
                .as_deref(),
            Some("blocked")
        );

        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn saving_the_body_leaves_step_statuses_alone() {
        let ws = workspace("body");
        let plan_id = seed(&ws);
        plan_set_step_status(PlanStepStatusRequest {
            workspace_root: ws.clone(),
            plan_id: plan_id.clone(),
            step_id: "s1".into(),
            status: "done".into(),
            note: None,
        })
        .expect("close s1");

        let plan = plan_save_body(PlanBodyRequest {
            workspace_root: ws.clone(),
            plan_id,
            body: "New overview.\n\n## 1. Scaffold {#s1}\n\nRewritten.\n".into(),
        })
        .expect("save");

        assert_eq!(plan.overview, "New overview.");
        assert_eq!(
            plan.steps.iter().find(|s| s.id == "s1").unwrap().status,
            StepStatus::Done,
            "editing prose must not reset finished work"
        );

        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn an_abandoned_plan_stops_being_the_active_one() {
        let ws = workspace("abandon");
        let plan_id = seed(&ws);
        plan_set_status(PlanStatusRequest {
            workspace_root: ws.clone(),
            plan_id,
            status: "abandoned".into(),
        })
        .expect("abandon");
        assert!(plan_get_active(ws.clone()).expect("query").is_none());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn invalid_statuses_are_rejected_with_the_valid_set() {
        let ws = workspace("badstatus");
        let plan_id = seed(&ws);
        let err = plan_set_step_status(PlanStepStatusRequest {
            workspace_root: ws.clone(),
            plan_id: plan_id.clone(),
            step_id: "s1".into(),
            status: "completed".into(),
            note: None,
        })
        .expect_err("must reject");
        assert!(err.contains("in_progress"), "{err}");

        let err = plan_set_status(PlanStatusRequest {
            workspace_root: ws.clone(),
            plan_id,
            status: "nope".into(),
        })
        .expect_err("must reject");
        assert!(err.contains("abandoned"), "{err}");

        std::fs::remove_dir_all(&ws).ok();
    }
}
