//! Plan tool bucket — `plan_write`, `plan_read`, `plan_step_update`.
//!
//! Authoring and progress-marking are split **by execution mode on purpose**:
//!
//! - `plan_write` is the one permitted write in **Plan mode**. The user and the
//!   agent discuss, the plan gets written, and the user knows exactly what will
//!   happen before switching to Agent mode.
//! - `plan_step_update` runs during **execution** (Agent / Team). Authoring a
//!   plan and reporting progress against it are different acts.
//! - `plan_read` is available everywhere — it is the answer to "where am I".
//!
//! Mode filtering itself lives in `src/services/agent-execution-mode.ts`; this
//! bucket only registers the executors.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolRegistry};
use crate::plans::document::{self, PlanDocument};
use crate::plans::model::{PlanStep, StepDraft, StepStatus};

use super::shell_editor_todo::IdeEventSink;

pub mod plan_read;
pub mod plan_step_update;
pub mod plan_write;

/// Names this bucket registers, in roster order.
pub const TOOL_NAMES: &[&str] = &["plan_write", "plan_read", "plan_step_update"];

/// Resolve the workspace a plan belongs to.
///
/// Plans are workspace-scoped, not thread-scoped, so a thread with no workspace
/// bound cannot have one. Failing loudly here beats writing the plan into some
/// arbitrary current directory.
pub(crate) fn workspace_of(ctx: &ToolContext) -> Result<PathBuf, ToolError> {
    ctx.workspace_root.clone().ok_or_else(|| {
        ToolError::InvalidInput(
            "No workspace is open, so there is nowhere to store a plan. \
             Open a folder in Aurora first."
                .into(),
        )
    })
}

/// Render the markdown body for an authored plan.
///
/// Aurora writes the anchors, never the model: an anchor that drifts from its
/// step id silently unbinds the section from its status, and asking the model
/// to hand-maintain `{#s3}` across a revision is a guaranteed source of that
/// drift.
pub(crate) fn render_body(overview: Option<&str>, steps: &[PlanStep], details: &[Option<String>]) -> String {
    let mut out = String::new();
    if let Some(overview) = overview.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str(overview);
        out.push_str("\n\n");
    }
    for (index, step) in steps.iter().enumerate() {
        out.push_str(&format!(
            "## {}. {} {{#{}}}\n\n",
            index + 1,
            step.title.trim(),
            step.id
        ));
        let detail = details
            .get(index)
            .and_then(Option::as_deref)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(detail) = detail {
            out.push_str(detail);
            out.push_str("\n\n");
        }
    }
    out
}

/// The state echo returned by **every** plan tool.
///
/// The agent never has to reconstruct the plan from its own context — which is
/// exactly the failure mode that makes the old `todo_write` impossible to
/// follow after a compaction. Every call hands back the full truth.
pub(crate) fn plan_state(doc: &PlanDocument, path: &str) -> Value {
    let fm = &doc.frontmatter;
    let cursor = fm.cursor();
    json!({
        "planId": fm.id,
        "title": fm.title,
        "status": fm.status,
        "path": path,
        "updatedAt": fm.updated_at,
        "steps": fm.steps.iter().map(|s| json!({
            "id": s.id,
            "title": s.title,
            "status": s.status.as_str(),
            "note": s.note,
            "paths": s.paths,
        })).collect::<Vec<_>>(),
        "cursor": {
            "activeStepId": cursor.active_step_id,
            "nextStepId": cursor.next_step_id,
            "done": cursor.done,
            "failed": cursor.failed,
            "skipped": cursor.skipped,
            "pending": cursor.pending,
            "total": cursor.total,
            "complete": cursor.complete,
        },
    })
}

/// Human-facing one-liner so the model sees progress without parsing JSON.
pub(crate) fn progress_line(doc: &PlanDocument) -> String {
    let cursor = doc.frontmatter.cursor();
    let active = cursor
        .active_step_id
        .as_ref()
        .and_then(|id| doc.frontmatter.step(id))
        .map(|s| format!("; in progress: {} ({})", s.title, s.id));
    // Only mention what is next when nothing is running — naming both at once
    // reads as two concurrent claims.
    let next = if active.is_some() {
        None
    } else {
        cursor
            .next_step_id
            .as_ref()
            .and_then(|id| doc.frontmatter.step(id))
            .map(|s| format!("; next up: {} ({})", s.title, s.id))
    };
    format!(
        "{}/{} steps done{}{}",
        cursor.done,
        cursor.total,
        active.unwrap_or_default(),
        next.unwrap_or_default()
    )
}

/// Parse the `steps` argument shared by `plan_write`.
pub(crate) fn parse_step_drafts(input: &Value) -> Result<(Vec<StepDraft>, Vec<Option<String>>), ToolError> {
    let steps = input
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::InvalidInput("`steps` must be an array".into()))?;
    if steps.is_empty() {
        return Err(ToolError::InvalidInput(
            "A plan needs at least one step.".into(),
        ));
    }
    if steps.len() > 64 {
        return Err(ToolError::InvalidInput(
            "A plan is capped at 64 steps; group finer work inside a step's detail.".into(),
        ));
    }

    let mut drafts = Vec::with_capacity(steps.len());
    let mut details = Vec::with_capacity(steps.len());
    for (index, raw) in steps.iter().enumerate() {
        let obj = raw
            .as_object()
            .ok_or_else(|| ToolError::InvalidInput(format!("steps[{index}] must be an object")))?;
        let title = obj
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidInput(format!("steps[{index}].title must be a non-empty string"))
            })?;
        let paths = obj
            .get("paths")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        drafts.push(StepDraft {
            id: obj
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            title: title.to_string(),
            paths,
        });
        details.push(
            obj.get("detail")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
    }
    Ok((drafts, details))
}

/// Parse a status word from `plan_step_update`.
pub(crate) fn parse_status(raw: &str) -> Result<StepStatus, ToolError> {
    match raw {
        "in_progress" => Ok(StepStatus::InProgress),
        "done" => Ok(StepStatus::Done),
        "failed" => Ok(StepStatus::Failed),
        "skipped" => Ok(StepStatus::Skipped),
        "pending" => Ok(StepStatus::Pending),
        other => Err(ToolError::InvalidInput(format!(
            "status `{other}` is not one of [pending, in_progress, done, failed, skipped]"
        ))),
    }
}

/// Sections of the body, for `plan_read`.
pub(crate) fn body_sections(doc: &PlanDocument) -> Value {
    let ids: Vec<String> = doc.frontmatter.steps.iter().map(|s| s.id.clone()).collect();
    json!(document::sections(&doc.body, &ids))
}

pub fn register(reg: &mut ToolRegistry, sink: Arc<dyn IdeEventSink>) {
    reg.register(Arc::new(plan_write::PlanWriteTool::new(sink.clone())));
    reg.register(Arc::new(plan_read::PlanReadTool));
    reg.register(Arc::new(plan_step_update::PlanStepUpdateTool::new(sink)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::model::{PlanFrontmatter, PlanStatus, PLAN_SCHEMA_VERSION};
    use crate::tools::shell_editor_todo::NoopIdeEventSink;

    fn doc(steps: Vec<PlanStep>) -> PlanDocument {
        PlanDocument {
            frontmatter: PlanFrontmatter {
                aurora_plan: PLAN_SCHEMA_VERSION,
                id: "plan_x".into(),
                title: "T".into(),
                status: PlanStatus::Active,
                created_at: "t".into(),
                updated_at: "t".into(),
                thread_id: None,
                steps,
            },
            body: String::new(),
        }
    }

    #[test]
    fn register_mounts_every_plan_tool() {
        let mut reg = ToolRegistry::new();
        register(&mut reg, Arc::new(NoopIdeEventSink));
        assert_eq!(reg.len(), TOOL_NAMES.len());
        for name in TOOL_NAMES {
            let tool = reg.get(name).unwrap_or_else(|| panic!("{name} missing"));
            assert_eq!(tool.schema().name, *name);
            assert!(!tool.schema().description.is_empty());
        }
    }

    #[test]
    fn render_body_numbers_steps_and_writes_anchors() {
        let steps = vec![PlanStep::new("s1", "Scaffold"), PlanStep::new("s4", "Test")];
        let details = vec![Some("Do it.".to_string()), None];
        let body = render_body(Some("An overview."), &steps, &details);

        assert!(body.starts_with("An overview.\n\n"));
        assert!(body.contains("## 1. Scaffold {#s1}\n\nDo it.\n"));
        assert!(
            body.contains("## 2. Test {#s4}"),
            "display number is positional, anchor is the real id: {body}"
        );
    }

    #[test]
    fn rendered_body_round_trips_through_the_section_parser() {
        let steps = vec![PlanStep::new("s1", "One"), PlanStep::new("s2", "Two")];
        let body = render_body(
            Some("Intro"),
            &steps,
            &[Some("First detail".into()), Some("Second detail".into())],
        );
        let ids: Vec<String> = steps.iter().map(|s| s.id.clone()).collect();
        let parsed = document::sections(&body, &ids);

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].step_id.as_deref(), Some("s1"));
        assert_eq!(parsed[0].content, "First detail");
        assert_eq!(parsed[1].step_id.as_deref(), Some("s2"));
        assert_eq!(document::preamble(&body), "Intro");
    }

    #[test]
    fn plan_state_echoes_every_step_and_the_cursor() {
        let mut running = PlanStep::new("s2", "Two");
        running.status = StepStatus::InProgress;
        let mut done = PlanStep::new("s1", "One");
        done.status = StepStatus::Done;
        let state = plan_state(&doc(vec![done, running, PlanStep::new("s3", "Three")]), "p.md");

        assert_eq!(state["steps"].as_array().unwrap().len(), 3);
        assert_eq!(state["cursor"]["activeStepId"], "s2");
        assert_eq!(state["cursor"]["nextStepId"], "s3");
        assert_eq!(state["cursor"]["done"], 1);
        assert_eq!(state["cursor"]["total"], 3);
    }

    #[test]
    fn progress_line_names_the_active_step_then_the_next_one() {
        let mut running = PlanStep::new("s1", "Scaffold routes");
        running.status = StepStatus::InProgress;
        let line = progress_line(&doc(vec![running, PlanStep::new("s2", "Test")]));
        assert!(line.contains("in progress: Scaffold routes (s1)"), "{line}");
        assert!(!line.contains("next up"), "active suppresses next: {line}");

        let idle = progress_line(&doc(vec![PlanStep::new("s1", "Scaffold routes")]));
        assert!(idle.contains("next up: Scaffold routes (s1)"), "{idle}");
    }

    #[test]
    fn parse_step_drafts_reads_ids_titles_paths_and_details() {
        let (drafts, details) = parse_step_drafts(&json!({
            "steps": [
                {"title": "  Scaffold  ", "detail": "why", "paths": ["src/**"]},
                {"id": "s7", "title": "Reuse"}
            ]
        }))
        .expect("parses");

        assert_eq!(drafts[0].id, None);
        assert_eq!(drafts[0].title, "Scaffold", "title is trimmed");
        assert_eq!(drafts[0].paths, vec!["src/**".to_string()]);
        assert_eq!(details[0].as_deref(), Some("why"));
        assert_eq!(drafts[1].id.as_deref(), Some("s7"));
        assert_eq!(details[1], None);
    }

    #[test]
    fn parse_step_drafts_rejects_empty_and_malformed_input() {
        assert!(parse_step_drafts(&json!({})).is_err(), "missing steps");
        assert!(parse_step_drafts(&json!({"steps": []})).is_err(), "empty plan");
        assert!(
            parse_step_drafts(&json!({"steps": [{"title": "  "}]})).is_err(),
            "blank title"
        );
        assert!(
            parse_step_drafts(&json!({"steps": ["nope"]})).is_err(),
            "non-object step"
        );
    }

    #[test]
    fn parse_status_accepts_the_documented_set_only() {
        for (raw, expected) in [
            ("pending", StepStatus::Pending),
            ("in_progress", StepStatus::InProgress),
            ("done", StepStatus::Done),
            ("failed", StepStatus::Failed),
            ("skipped", StepStatus::Skipped),
        ] {
            assert_eq!(parse_status(raw).expect(raw), expected);
        }
        let err = parse_status("completed").expect_err("must reject");
        assert!(
            format!("{err:?}").contains("in_progress"),
            "error lists the valid set"
        );
    }
}
