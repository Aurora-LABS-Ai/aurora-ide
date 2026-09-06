//! `plan_step_update` — mark one step's progress during execution.
//!
//! Available in Agent and Team mode, not Plan mode: authoring a plan and
//! reporting progress against it are different acts.
//!
//! Marking a step `in_progress` stamps the conversation as its **run claim**.
//! That claim is what lets the Canvas tell "being worked on right now" apart
//! from "abandoned by a run that stopped three hours ago" — see
//! [`crate::plans::model::PlanStep::is_live_under`].

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::plans::model::{PlanStatus, StepStatus};
use crate::plans::store;
use crate::tools::shell_editor_todo::{IdeEventSink, PlanChangeReason, PlanChangedPayload};

use super::{parse_status, plan_state, progress_line, workspace_of};

pub struct PlanStepUpdateTool {
    sink: Arc<dyn IdeEventSink>,
}

impl PlanStepUpdateTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for PlanStepUpdateTool {
    fn name(&self) -> &str {
        "plan_step_update"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "plan_step_update".into(),
            description: "Mark one plan step's status while executing the plan.

Mark a step `in_progress` BEFORE you start working it, and `done` / `failed` as soon as you \
finish. The Canvas animates the step you marked in_progress, so the user can see what you are \
working on right now — leaving it stale is visibly wrong to them.

A plan step is a PHASE. The usual rhythm for one is: mark it in_progress here, call `TaskCreate` \
once per concrete step that phase needs, work them with `TaskUpdate`, then mark the phase `done` \
here and move to the next one.

Only one step may be in_progress at a time; marking a new one does not automatically close the \
previous one, so close it first. Use `failed` with a note when a step cannot be completed, and \
`skipped` when it turned out to be unnecessary — never mark something `done` that is not.

Returns every step with its status and a cursor naming the active and next step, so you always \
know where you are without re-reading the plan."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "stepId": {
                        "type": "string",
                        "description": "Step id from plan_write or plan_read, e.g. 's2'."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "done", "failed", "skipped"],
                        "description": "New status. Mark in_progress before starting the work, done/failed when it ends."
                    },
                    "note": {
                        "type": "string",
                        "description": "Short reason, shown on the step in the Canvas. Expected for failed and skipped."
                    },
                    "planId": {
                        "type": "string",
                        "description": "Target a specific plan. Omit to use the workspace's active plan."
                    }
                },
                "required": ["stepId", "status"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let workspace = workspace_of(ctx)?;

        let step_id = input
            .get("stepId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ToolError::InvalidInput("`stepId` must be a non-empty string".into()))?
            .to_string();
        let status = parse_status(
            input
                .get("status")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::InvalidInput("`status` must be a string".into()))?,
        )?;
        let note = input
            .get("note")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        // Resolve which plan, then mutate it under the storage lock so two
        // concurrent flips cannot read the same base and lose one write.
        let plan_id = match input
            .get("planId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(id) => id.to_string(),
            None => {
                let active = store::active(&workspace).map_err(ToolError::Execution)?;
                let Some((_, doc)) = active else {
                    return Err(ToolError::InvalidInput(
                        "This workspace has no active plan to update. Author one with plan_write \
                         in Plan mode, or use plan_read to see what exists."
                            .into(),
                    ));
                };
                doc.frontmatter.id
            }
        };

        let session_id = ctx.thread_id.clone();
        let mut demoted: Vec<String> = Vec::new();
        let mut previous: Option<StepStatus> = None;

        let doc = store::update(&workspace, &plan_id, |doc| {
            let now = store::now_iso();
            let step = doc.frontmatter.step_mut(&step_id).ok_or_else(|| {
                format!("No step `{step_id}` in this plan. Call plan_read for the step ids.")
            })?;
            previous = Some(step.status);
            step.status = status;
            if note.is_some() {
                step.note = note.clone();
            }
            match status {
                StepStatus::InProgress => {
                    step.run_id = Some(session_id.clone());
                    step.started_at.get_or_insert(now);
                    step.ended_at = None;
                }
                StepStatus::Pending => {
                    step.run_id = None;
                    step.started_at = None;
                    step.ended_at = None;
                }
                StepStatus::Done | StepStatus::Failed | StepStatus::Skipped => {
                    // The claim is released so a finished step can never be
                    // mistaken for live work.
                    step.run_id = None;
                    step.ended_at = Some(now);
                }
            }
            demoted = doc.frontmatter.clamp_single_in_progress();

            // A plan being executed is Active, and one whose steps are all
            // closed is finished — otherwise it would stay "active" forever and
            // keep claiming the Canvas.
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
        })
        .map_err(ToolError::Execution)?;

        let path = store::find_path(&workspace, &plan_id)
            .map_err(ToolError::Execution)?
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let _ = self.sink.emit_plan_changed(&PlanChangedPayload {
            workspace_root: workspace.to_string_lossy().to_string(),
            plan_id: plan_id.clone(),
            thread_id: ctx.thread_id.clone(),
            reason: PlanChangeReason::Progress,
        });

        let cursor = doc.frontmatter.cursor();
        let mut result = plan_state(&doc, &path);
        result["success"] = Value::Bool(true);
        result["stepId"] = Value::String(step_id.clone());
        result["previousStatus"] = Value::String(
            previous
                .map(StepStatus::as_str)
                .unwrap_or("unknown")
                .to_string(),
        );
        result["progress"] = Value::String(progress_line(&doc));
        result["message"] = Value::String(format!(
            "Marked {step_id} as {}. {}",
            status.as_str(),
            if cursor.complete {
                format!(
                    "Every step is closed — the plan is {}.",
                    if cursor.failed > 0 {
                        "failed"
                    } else {
                        "complete"
                    }
                )
            } else {
                match (&cursor.active_step_id, &cursor.next_step_id) {
                    (Some(active), _) => format!("Currently working: {active}."),
                    (None, Some(next)) => {
                        format!("Nothing is in progress; next up is {next}.")
                    }
                    (None, None) => "Nothing left to start.".to_string(),
                }
            }
        ));
        if !demoted.is_empty() {
            result["warning"] = Value::String(format!(
                "Only one step may be in_progress at a time, so {} was reset to pending. \
                 Close a step with done/failed before starting the next one.",
                demoted.join(", ")
            ));
        }
        Ok(result.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::plan::plan_write::PlanWriteTool;
    use crate::tools::shell_editor_todo::{NoopIdeEventSink, RecordedEvent, RecordingIdeEventSink};
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;

    fn temp_workspace(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aurora-planstep-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp workspace");
        dir
    }

    fn ctx(workspace: &PathBuf, session: &str) -> ToolContext {
        ToolContext {
            workspace_access: Default::default(),
            turn_id: "turn_1".into(),
            tool_call_id: "call_1".into(),
            thread_id: session.into(),
            workspace_root: Some(workspace.clone()),
            cancel_token: CancellationToken::new(),
            spill_dir: None,
        }
    }

    async fn seed(ws: &PathBuf) -> String {
        let writer = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let out = writer
            .execute(
                json!({
                    "title": "API Building",
                    "steps": [
                        {"title": "Scaffold routes"},
                        {"title": "Wire auth"},
                        {"title": "Tests"}
                    ]
                }),
                &ctx(ws, "thr_1"),
            )
            .await
            .expect("seed");
        serde_json::from_str::<Value>(&out).unwrap()["planId"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn marking_in_progress_stamps_the_run_claim() {
        let ws = temp_workspace("claim");
        let plan_id = seed(&ws).await;
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));

        let out = tool
            .execute(
                json!({"stepId": "s1", "status": "in_progress"}),
                &ctx(&ws, "thr_1"),
            )
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["cursor"]["activeStepId"], "s1");
        assert_eq!(parsed["previousStatus"], "pending");

        let (_, doc) = store::load(&ws, &plan_id).expect("load").expect("present");
        let step = doc.frontmatter.step("s1").unwrap();
        assert_eq!(step.run_id.as_deref(), Some("thr_1"), "claim recorded");
        assert!(step.started_at.is_some());
        assert!(
            step.is_live_under(Some("thr_1")),
            "live under its own conversation"
        );
        assert!(
            step.is_interrupted(Some("thr_2")),
            "not live under a different one"
        );

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn closing_a_step_releases_the_claim_so_it_cannot_look_live() {
        let ws = temp_workspace("release");
        let plan_id = seed(&ws).await;
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");

        tool.execute(json!({"stepId": "s1", "status": "in_progress"}), &c)
            .await
            .expect("start");
        tool.execute(json!({"stepId": "s1", "status": "done"}), &c)
            .await
            .expect("finish");

        let (_, doc) = store::load(&ws, &plan_id).expect("load").expect("present");
        let step = doc.frontmatter.step("s1").unwrap();
        assert_eq!(step.status, StepStatus::Done);
        assert_eq!(step.run_id, None, "claim released");
        assert!(step.ended_at.is_some());
        assert!(!step.is_live_under(Some("thr_1")));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn a_second_in_progress_step_is_clamped_with_a_warning() {
        let ws = temp_workspace("clamp");
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");
        seed(&ws).await;

        tool.execute(json!({"stepId": "s1", "status": "in_progress"}), &c)
            .await
            .expect("first");
        let out = tool
            .execute(json!({"stepId": "s2", "status": "in_progress"}), &c)
            .await
            .expect("second");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(
            parsed["cursor"]["activeStepId"], "s1",
            "the first claim survives; the clamp keeps document order"
        );
        assert!(parsed["warning"].as_str().unwrap().contains("s2"));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn a_failed_step_records_its_note_and_fails_the_plan_at_the_end() {
        let ws = temp_workspace("failed");
        let plan_id = seed(&ws).await;
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");

        tool.execute(json!({"stepId": "s1", "status": "done"}), &c)
            .await
            .expect("s1");
        tool.execute(
            json!({"stepId": "s2", "status": "failed", "note": "auth lib is incompatible"}),
            &c,
        )
        .await
        .expect("s2");
        let out = tool
            .execute(
                json!({"stepId": "s3", "status": "skipped", "note": "blocked by s2"}),
                &c,
            )
            .await
            .expect("s3");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["cursor"]["complete"], json!(true));
        assert_eq!(parsed["status"], "failed", "a failed step fails the plan");
        assert!(parsed["message"].as_str().unwrap().contains("failed"));

        let (_, doc) = store::load(&ws, &plan_id).expect("load").expect("present");
        assert_eq!(
            doc.frontmatter.step("s2").unwrap().note.as_deref(),
            Some("auth lib is incompatible")
        );

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn a_fully_done_plan_closes_as_done() {
        let ws = temp_workspace("done");
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");
        seed(&ws).await;

        for id in ["s1", "s2", "s3"] {
            tool.execute(json!({"stepId": id, "status": "done"}), &c)
                .await
                .expect(id);
        }
        // A closed plan stops being the workspace's active plan.
        assert!(store::active(&ws).expect("query").is_none());

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn an_unknown_step_is_rejected_with_guidance() {
        let ws = temp_workspace("badstep");
        seed(&ws).await;
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(
                json!({"stepId": "s99", "status": "done"}),
                &ctx(&ws, "thr_1"),
            )
            .await
            .expect_err("must fail");
        let msg = format!("{err:?}");
        assert!(msg.contains("s99") && msg.contains("plan_read"), "{msg}");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn updating_with_no_plan_explains_how_to_get_one() {
        let ws = temp_workspace("noplan");
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(
                json!({"stepId": "s1", "status": "done"}),
                &ctx(&ws, "thr_1"),
            )
            .await
            .expect_err("must fail");
        assert!(format!("{err:?}").contains("plan_write"));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn rejects_a_status_outside_the_documented_set() {
        let ws = temp_workspace("badstatus");
        seed(&ws).await;
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(
                json!({"stepId": "s1", "status": "completed"}),
                &ctx(&ws, "thr_1"),
            )
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn emits_a_plan_changed_event_for_the_canvas() {
        let ws = temp_workspace("event");
        seed(&ws).await;
        let sink = RecordingIdeEventSink::new();
        let tool = PlanStepUpdateTool::new(sink.clone());

        tool.execute(
            json!({"stepId": "s1", "status": "in_progress"}),
            &ctx(&ws, "thr_1"),
        )
        .await
        .expect("ok");

        match sink.events().last().expect("an event") {
            RecordedEvent::PlanChanged(p) => assert_eq!(p.thread_id, "thr_1"),
            other => panic!("unexpected: {other:?}"),
        }

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn the_prose_body_survives_every_status_flip() {
        let ws = temp_workspace("prose");
        let plan_id = seed(&ws).await;
        let (_, before) = store::load(&ws, &plan_id).expect("load").expect("present");
        let tool = PlanStepUpdateTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");

        for (id, status) in [("s1", "in_progress"), ("s1", "done"), ("s2", "in_progress")] {
            tool.execute(json!({"stepId": id, "status": status}), &c)
                .await
                .expect("update");
        }

        let (_, after) = store::load(&ws, &plan_id).expect("load").expect("present");
        assert_eq!(
            after.body, before.body,
            "status flips must never touch prose"
        );

        std::fs::remove_dir_all(&ws).ok();
    }
}
