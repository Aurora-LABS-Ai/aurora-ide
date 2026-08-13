//! `plan_read` — the answer to "where am I". Available in every mode.
//!
//! Deliberately returns the whole truth every time: the steps, their statuses,
//! and a cursor. Nothing here depends on the plan still being in the model's
//! context, which is the failure that makes a write-only task list impossible
//! to follow after a compaction.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::plans::document;
use crate::plans::store;

use super::{body_sections, plan_state, progress_line, workspace_of};

pub struct PlanReadTool;

#[async_trait]
impl ToolExecutor for PlanReadTool {
    fn name(&self) -> &str {
        "plan_read"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "plan_read".into(),
            description: "Read the workspace's plan and find out exactly where the work stands.

Call this at the start of a turn whenever a plan may exist — after a compaction, after the user \
returns to an old conversation, or any time you are unsure which step you were on. It reads the \
plan file from disk, so it is accurate even if the plan is no longer in your context.

Returns the steps with their live statuses, a cursor naming the active and next step, the \
overview, and each step's markdown detail. If no plan exists it says so plainly rather than \
failing — absence of a plan is a normal state, not an error."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "planId": {
                        "type": "string",
                        "description": "Read a specific plan. Omit to read the workspace's active plan, which is almost always what you want."
                    },
                    "includeDetail": {
                        "type": "boolean",
                        "description": "Include each step's markdown body. Defaults to true; set false when you only need statuses and want to save context."
                    }
                }
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let workspace = workspace_of(ctx)?;

        let plan_id = input
            .get("planId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let include_detail = input
            .get("includeDetail")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let found = match plan_id {
            Some(id) => store::load(&workspace, id).map_err(ToolError::Execution)?,
            None => store::active(&workspace).map_err(ToolError::Execution)?,
        };

        let Some((path, doc)) = found else {
            // Not an error: most conversations never author a plan.
            let others = store::list(&workspace).map_err(ToolError::Execution)?;
            return Ok(json!({
                "success": true,
                "hasPlan": false,
                "message": match plan_id {
                    Some(id) => format!("No plan with id `{id}` in this workspace."),
                    None => "This workspace has no active plan. Use plan_write in Plan mode to author one.".to_string(),
                },
                "otherPlans": others,
            })
            .to_string());
        };

        let path_str = path.to_string_lossy().to_string();
        let mut result = plan_state(&doc, &path_str);
        result["success"] = Value::Bool(true);
        result["hasPlan"] = Value::Bool(true);
        result["progress"] = Value::String(progress_line(&doc));
        result["overview"] = Value::String(document::preamble(&doc.body));
        if include_detail {
            result["sections"] = body_sections(&doc);
        }
        Ok(result.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::model::StepStatus;
    use crate::tools::plan::plan_write::PlanWriteTool;
    use crate::tools::shell_editor_todo::NoopIdeEventSink;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn temp_workspace(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aurora-planread-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp workspace");
        dir
    }

    fn ctx(workspace: &PathBuf) -> ToolContext {
        ToolContext {
            allow_outside_workspace: false,
            turn_id: "turn_1".into(),
            tool_call_id: "call_1".into(),
            thread_id: "thr_1".into(),
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
                    "overview": "Ship the API.",
                    "steps": [
                        {"title": "Scaffold routes", "detail": "Create the router."},
                        {"title": "Wire auth", "detail": "Add middleware."}
                    ]
                }),
                &ctx(ws),
            )
            .await
            .expect("seed");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        parsed["planId"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn reports_absence_of_a_plan_as_a_normal_state() {
        let ws = temp_workspace("noplan");
        let out = PlanReadTool
            .execute(json!({}), &ctx(&ws))
            .await
            .expect("must not error");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["hasPlan"], json!(false));
        assert!(parsed["message"]
            .as_str()
            .unwrap()
            .contains("no active plan"));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn returns_steps_cursor_overview_and_details() {
        let ws = temp_workspace("read");
        seed(&ws).await;

        let out = PlanReadTool
            .execute(json!({}), &ctx(&ws))
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["hasPlan"], json!(true));
        assert_eq!(parsed["overview"], "Ship the API.");
        assert_eq!(parsed["cursor"]["nextStepId"], "s1");
        assert_eq!(parsed["steps"].as_array().unwrap().len(), 2);
        let sections = parsed["sections"].as_array().unwrap();
        assert_eq!(sections[0]["stepId"], "s1");
        assert_eq!(sections[0]["content"], "Create the router.");
        assert!(parsed["progress"]
            .as_str()
            .unwrap()
            .contains("0/2 steps done"));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn include_detail_false_omits_the_bodies() {
        let ws = temp_workspace("nodetail");
        seed(&ws).await;

        let out = PlanReadTool
            .execute(json!({"includeDetail": false}), &ctx(&ws))
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert!(parsed.get("sections").is_none(), "detail suppressed");
        assert_eq!(
            parsed["steps"].as_array().unwrap().len(),
            2,
            "statuses remain"
        );

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn reads_status_from_disk_not_from_context() {
        // The whole point: a fresh tool instance with no memory still knows
        // exactly where the work stands.
        let ws = temp_workspace("fromdisk");
        let plan_id = seed(&ws).await;
        store::update(&ws, &plan_id, |doc| {
            doc.frontmatter.step_mut("s1").unwrap().status = StepStatus::Done;
            doc.frontmatter.step_mut("s2").unwrap().status = StepStatus::InProgress;
            Ok(())
        })
        .expect("update");

        let out = PlanReadTool
            .execute(json!({}), &ctx(&ws))
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed["cursor"]["activeStepId"], "s2");
        assert_eq!(parsed["cursor"]["done"], 1);
        assert!(parsed["progress"]
            .as_str()
            .unwrap()
            .contains("in progress: Wire auth (s2)"));

        std::fs::remove_dir_all(&ws).ok();
    }

    #[tokio::test]
    async fn an_unknown_plan_id_reports_cleanly() {
        let ws = temp_workspace("badid");
        seed(&ws).await;
        let out = PlanReadTool
            .execute(json!({"planId": "plan_nope"}), &ctx(&ws))
            .await
            .expect("must not error");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["hasPlan"], json!(false));
        assert!(parsed["message"].as_str().unwrap().contains("plan_nope"));
        std::fs::remove_dir_all(&ws).ok();
    }
}
