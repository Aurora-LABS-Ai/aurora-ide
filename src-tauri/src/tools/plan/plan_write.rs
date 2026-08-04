//! `plan_write` — author or revise the plan document. **Plan mode only.**
//!
//! This is the one write permitted in Plan mode. Everything else about the mode
//! stays read-only, so the user can discuss a plan with the agent and know
//! exactly what will happen before switching to Agent mode.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::plans::model::{reconcile_steps, PlanStatus};
use crate::plans::store;
use crate::tools::shell_editor_todo::{IdeEventSink, PlanChangeReason, PlanChangedPayload};

use super::{parse_step_drafts, plan_state, progress_line, render_body, workspace_of};

pub struct PlanWriteTool {
    sink: Arc<dyn IdeEventSink>,
}

impl PlanWriteTool {
    #[must_use]
    pub fn new(sink: Arc<dyn IdeEventSink>) -> Self {
        Self { sink }
    }
}

#[async_trait]
impl ToolExecutor for PlanWriteTool {
    fn name(&self) -> &str {
        "plan_write"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "plan_write".into(),
            description: "Author or revise the plan for this workspace. Available in Plan mode only.

The plan is a real file at `.aurora/plans/<nnn>-<slug>.aurora.md` and it renders live in the Canvas \
panel. Its steps are the PHASES of the work — the shape the user reads and approves before letting \
you execute. Once they switch to Agent mode you close each phase with `plan_step_update`, and track \
the concrete work inside a phase with the todo tools.

Size the steps accordingly: a phase is a milestone a person would name ('Extractor refactor', \
'PySide6 GUI'), not an individual edit. Five to nine phases is a large plan.

Behaviour:
- Call it again with the returned `planId` to revise. Steps are reconciled by id: a step you keep \
KEEPS its status and timestamps, a step you drop is removed, and a step with no id is created as \
`pending`. This is what lets you revise a plan mid-execution without losing what is already done.
- Omit `planId` and Aurora revises this conversation's existing draft/active plan if it has one, \
otherwise it creates a new plan. You do not need to track the file path.
- Aurora writes the markdown, the numbering, and the section anchors. Supply structure, not markdown.
- Write steps a person can verify from the outside: each `title` is a deliverable, and `detail` \
carries the rationale, the files involved, and what 'done' means.

Returns planId, path, every step with its id and status, and a cursor telling you which step is \
active and which is next."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the whole plan (max 120 characters), e.g. 'API Building'."
                    },
                    "overview": {
                        "type": "string",
                        "description": "Optional markdown intro rendered above the steps. Use it for context, constraints, and risks — not for restating the steps."
                    },
                    "steps": {
                        "type": "array",
                        "description": "The ordered steps. Each becomes one numbered, individually-tracked section in the Canvas.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Existing step id (e.g. 's2') to revise that step in place, preserving its status. Omit for a new step."
                                },
                                "title": {
                                    "type": "string",
                                    "description": "What this step delivers, as an imperative phrase (e.g. 'Wire auth middleware')."
                                },
                                "detail": {
                                    "type": "string",
                                    "description": "Markdown body for the step: rationale, files, and acceptance criteria."
                                },
                                "paths": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Optional file globs this step is expected to touch. Advisory only."
                                }
                            },
                            "required": ["title"]
                        }
                    },
                    "planId": {
                        "type": "string",
                        "description": "Target a specific plan by id. If it exists this revises it; if not, the plan is created with this id. Omit it and Aurora reuses this conversation's existing plan or creates one."
                    }
                },
                "required": ["title", "steps"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let workspace = workspace_of(ctx)?;

        let title = input
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`title` must be a string".into()))?;
        store::validate_title(title).map_err(ToolError::InvalidInput)?;

        let (drafts, details) = parse_step_drafts(&input)?;
        let overview = input.get("overview").and_then(Value::as_str);

        // Which plan are we writing? An explicit id wins; otherwise reuse this
        // conversation's own unfinished plan so an iterative Plan-mode
        // discussion revises one document instead of littering the workspace.
        let explicit_id = input
            .get("planId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let existing = match explicit_id {
            // An id that names nothing yet is a CREATE with a chosen id, not an
            // error. Models reach for a readable slug on the first call, and
            // rejecting it only costs a wasted round-trip before they retry
            // with the same content.
            Some(id) => store::load(&workspace, id).map_err(ToolError::Execution)?,
            None => store::active(&workspace)
                .map_err(ToolError::Execution)?
                .filter(|(_, doc)| doc.frontmatter.thread_id.as_deref() == Some(&ctx.thread_id)),
        };

        let mut frontmatter = match &existing {
            Some((_, doc)) => doc.frontmatter.clone(),
            None => {
                let mut fresh = store::empty_frontmatter(title, Some(ctx.thread_id.clone()));
                if let Some(id) = explicit_id {
                    store::validate_plan_id(id).map_err(ToolError::InvalidInput)?;
                    fresh.id = id.to_string();
                }
                fresh
            }
        };
        frontmatter.title = title.trim().to_string();
        frontmatter.steps = reconcile_steps(&frontmatter.steps, &drafts);
        let demoted = frontmatter.clamp_single_in_progress();

        // A revision that resurrects work must not leave the plan marked
        // finished — the Canvas would stop treating it as the active plan.
        if frontmatter.status != PlanStatus::Active && !frontmatter.cursor().complete {
            if matches!(
                frontmatter.status,
                PlanStatus::Done | PlanStatus::Failed | PlanStatus::Abandoned
            ) {
                frontmatter.status = PlanStatus::Active;
            }
        }
        frontmatter.updated_at = store::now_iso();

        let body = render_body(overview, &frontmatter.steps, &details);
        let (path, doc) = store::create(&workspace, frontmatter, body)
            .map_err(ToolError::Execution)?;
        let path_str = path.to_string_lossy().to_string();

        let _ = self.sink.emit_plan_changed(&PlanChangedPayload {
            workspace_root: workspace.to_string_lossy().to_string(),
            plan_id: doc.frontmatter.id.clone(),
            thread_id: ctx.thread_id.clone(),
            reason: PlanChangeReason::Authored,
        });

        let mut result = plan_state(&doc, &path_str);
        result["success"] = Value::Bool(true);
        result["revised"] = Value::Bool(existing.is_some());
        result["progress"] = Value::String(progress_line(&doc));
        result["message"] = Value::String(format!(
            "{} plan '{}' with {} step(s) at {path_str}. The Canvas is showing it. \
             Switch to Agent mode to execute, marking each step with plan_step_update.",
            if existing.is_some() { "Revised" } else { "Wrote" },
            doc.frontmatter.title,
            doc.frontmatter.steps.len()
        ));
        if !demoted.is_empty() {
            result["warning"] = Value::String(format!(
                "Only one step may be in_progress at a time; {} was kept and {} reset to pending.",
                doc.frontmatter
                    .cursor()
                    .active_step_id
                    .unwrap_or_else(|| "none".into()),
                demoted.join(", ")
            ));
        }
        Ok(result.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::model::StepStatus;
    use crate::tools::shell_editor_todo::{NoopIdeEventSink, RecordedEvent, RecordingIdeEventSink};
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;

    fn temp_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("aurora-planwrite-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp workspace");
        dir
    }

    fn ctx(workspace: &PathBuf, session: &str) -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "turn_1".into(),
            tool_call_id: "call_1".into(),
            thread_id: session.into(),
            workspace_root: Some(workspace.clone()),
            cancel_token: CancellationToken::new(),
        }
    }

    fn args() -> Value {
        json!({
            "title": "API Building",
            "overview": "Ship the API.",
            "steps": [
                {"title": "Scaffold routes", "detail": "Create the router.", "paths": ["src/api/**"]},
                {"title": "Wire auth", "detail": "Add middleware."}
            ]
        })
    }

    #[tokio::test]
    async fn writes_a_plan_file_and_returns_step_ids() {
        let ws = temp_workspace("write");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));

        let out = tool.execute(args(), &ctx(&ws, "thr_1")).await.expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["revised"], json!(false));
        let steps = parsed["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["id"], "s1");
        assert_eq!(steps[0]["status"], "pending");
        assert_eq!(parsed["cursor"]["nextStepId"], "s1");
        assert_eq!(parsed["cursor"]["total"], 2);

        let path = parsed["path"].as_str().unwrap();
        let raw = std::fs::read_to_string(path).expect("file exists");
        assert!(raw.contains("## 1. Scaffold routes {#s1}"));
        assert!(raw.starts_with("---\n"), "frontmatter present");

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn requires_a_workspace() {
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let mut c = ctx(&temp_workspace("nows"), "thr_1");
        c.workspace_root = None;
        let err = tool.execute(args(), &c).await.expect_err("must fail");
        assert!(format!("{err:?}").contains("No workspace"));
    }

    #[tokio::test]
    async fn a_second_call_revises_the_same_plan_instead_of_creating_another() {
        let ws = temp_workspace("revise");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");

        tool.execute(args(), &c).await.expect("first");
        let out = tool
            .execute(
                json!({
                    "title": "API Building v2",
                    "steps": [{"title": "Scaffold routes"}, {"title": "Wire auth"}, {"title": "Tests"}]
                }),
                &c,
            )
            .await
            .expect("second");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["revised"], json!(true));
        assert_eq!(parsed["title"], "API Building v2");
        assert_eq!(parsed["steps"].as_array().unwrap().len(), 3);

        let files: Vec<_> = std::fs::read_dir(store::plans_dir(&ws))
            .expect("dir")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".aurora.md"))
            .collect();
        assert_eq!(files.len(), 1, "revision must not create a second plan file");

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn a_revision_preserves_the_status_of_surviving_steps() {
        let ws = temp_workspace("preserve");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");

        let first: Value =
            serde_json::from_str(&tool.execute(args(), &c).await.expect("first")).unwrap();
        let plan_id = first["planId"].as_str().unwrap().to_string();

        // Simulate execution finishing step 1.
        store::update(&ws, &plan_id, |doc| {
            doc.frontmatter.step_mut("s1").unwrap().status = StepStatus::Done;
            Ok(())
        })
        .expect("mark done");

        let out = tool
            .execute(
                json!({
                    "planId": plan_id,
                    "title": "API Building",
                    "steps": [
                        {"id": "s1", "title": "Scaffold routes"},
                        {"id": "s2", "title": "Wire auth"},
                        {"title": "New: rate limiting"}
                    ]
                }),
                &c,
            )
            .await
            .expect("revise");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let steps = parsed["steps"].as_array().unwrap();

        assert_eq!(steps[0]["status"], "done", "finished work survives revision");
        assert_eq!(steps[2]["status"], "pending");
        assert_eq!(steps[2]["id"], "s3", "new step gets a fresh non-colliding id");
        assert_eq!(parsed["cursor"]["done"], 1);

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn another_conversations_plan_is_not_hijacked() {
        let ws = temp_workspace("otherthread");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));

        tool.execute(args(), &ctx(&ws, "thr_1")).await.expect("first");
        let out = tool
            .execute(args(), &ctx(&ws, "thr_2"))
            .await
            .expect("second thread");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(
            parsed["revised"],
            json!(false),
            "a different conversation writes its own plan"
        );
        let files = std::fs::read_dir(store::plans_dir(&ws)).expect("dir").count();
        assert_eq!(files, 2);

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn an_unknown_plan_id_creates_that_plan_rather_than_erroring() {
        // A model's first call naturally carries a readable slug. Rejecting it
        // only bought a wasted round-trip before it retried with the same body.
        let ws = temp_workspace("newid");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let mut input = args();
        input["planId"] = json!("task-templates-feature");

        let out = tool.execute(input, &ctx(&ws, "thr_1")).await.expect("creates");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["planId"], "task-templates-feature");
        assert_eq!(parsed["revised"], json!(false));
        assert!(store::load(&ws, "task-templates-feature").expect("load").is_some());

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn a_malformed_plan_id_is_still_rejected() {
        let ws = temp_workspace("badid");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let mut input = args();
        input["planId"] = json!("../escape/../../etc");

        let err = tool
            .execute(input, &ctx(&ws, "thr_1"))
            .await
            .expect_err("must reject");
        assert!(matches!(err, ToolError::InvalidInput(_)));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn emits_a_plan_changed_event_so_the_canvas_updates() {
        let ws = temp_workspace("event");
        let sink = RecordingIdeEventSink::new();
        let tool = PlanWriteTool::new(sink.clone());

        tool.execute(args(), &ctx(&ws, "thr_1")).await.expect("ok");

        let events = sink.events();
        let plan_changed = events
            .iter()
            .find_map(|event| match event {
                RecordedEvent::PlanChanged(payload) => Some(payload),
                _ => None,
            })
            .expect("a plan_changed event");
        assert_eq!(plan_changed.thread_id, "thr_1");
        assert!(plan_changed.plan_id.starts_with("plan_"));
        assert_eq!(plan_changed.workspace_root, ws.to_string_lossy());

        // The plan does NOT push itself into the working checklist. The two are
        // different granularities of different things — phases the user
        // approved (Canvas) versus the steps of the phase being executed
        // (checklist) — and projecting one into the other is what made both
        // surfaces untrustworthy.
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, RecordedEvent::TodoWrite { .. })),
            "authoring a plan must not overwrite the agent's task checklist"
        );

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn rejects_a_plan_with_no_steps() {
        let ws = temp_workspace("nosteps");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let err = tool
            .execute(json!({"title": "Empty", "steps": []}), &ctx(&ws, "thr_1"))
            .await
            .expect_err("must fail");
        assert!(matches!(err, ToolError::InvalidInput(_)));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn revising_a_finished_plan_reopens_it() {
        let ws = temp_workspace("reopen");
        let tool = PlanWriteTool::new(Arc::new(NoopIdeEventSink));
        let c = ctx(&ws, "thr_1");
        let first: Value =
            serde_json::from_str(&tool.execute(args(), &c).await.expect("first")).unwrap();
        let plan_id = first["planId"].as_str().unwrap().to_string();

        store::update(&ws, &plan_id, |doc| {
            doc.frontmatter.status = PlanStatus::Done;
            Ok(())
        })
        .expect("close it");

        let out = tool
            .execute(
                json!({
                    "planId": plan_id,
                    "title": "API Building",
                    "steps": [{"title": "More work"}]
                }),
                &c,
            )
            .await
            .expect("revise");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["status"], "active",
            "reopening must not leave the plan marked done"
        );

        std::fs::remove_dir_all(&ws).ok();
    }
}
