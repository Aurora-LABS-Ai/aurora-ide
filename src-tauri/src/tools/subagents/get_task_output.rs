//! `get_task_output` — a short look at what a sub-agent is doing.
//!
//! This is a glance, not a wait, and never the way a report arrives. A
//! child's report reaches the parent as a message in the conversation and
//! nowhere else: when this tool carried it too, a report bigger than the
//! 8 KiB tool-result cap was dropped whole, and having been "read" it was
//! never sent again. It may hold for a few seconds in case the agent is about
//! to finish, never longer: the cap keeps the parent's turn, and the card the
//! user is looking at, from parking on one call.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{ParentTurn, SubagentHost};
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::required_str;

/// Longest one call may hold for the agent to finish.
pub const MAX_WAIT_MS: u64 = 10_000;

pub struct GetTaskOutputTool {
    host: Arc<dyn SubagentHost>,
    parent: Arc<ParentTurn>,
}

impl GetTaskOutputTool {
    #[must_use]
    pub fn new(host: Arc<dyn SubagentHost>, parent: Arc<ParentTurn>) -> Self {
        Self { host, parent }
    }
}

fn clock(ms: u64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

#[async_trait]
impl ToolExecutor for GetTaskOutputTool {
    fn name(&self) -> &str {
        "get_task_output"
    }

    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "get_task_output".into(),
            description: format!(
                "Look at what a running sub-agent is doing: its timeline since your previous \
                 check, in order — the tools it ran and what on, what it thought, what it said, \
                 messages that reached it. Never tool results, and never its report: a finished \
                 agent's report arrives as a message in this conversation on its own, and so \
                 does anything it needs from you before then. Do not use this to wait for an \
                 agent or to poll it. If you have nothing to do until it reports, end your turn; \
                 the report starts you again. Holds up to `waitMs` (default and maximum \
                 {MAX_WAIT_MS} ms) in case it is about to finish."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "taskId": {
                        "type": "string",
                        "description": "The agent id from spawn_agent, or the name you gave it."
                    },
                    "waitMs": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_WAIT_MS,
                        "description": format!("Hold at most this long for it to finish before answering. Default and maximum {MAX_WAIT_MS}; 0 answers at once.")
                    }
                },
                "required": ["taskId"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let task_id = required_str(&input, "taskId")?;
        // A check watches for up to ten seconds, so what comes back is the
        // agent's work over that window plus anything since the last look.
        // `block: false` is the old spelling of "answer at once".
        let legacy_now = input.get("block").and_then(Value::as_bool) == Some(false);
        let wait_ms = input
            .get("waitMs")
            .and_then(Value::as_u64)
            .unwrap_or(if legacy_now { 0 } else { MAX_WAIT_MS })
            .min(MAX_WAIT_MS);
        let wait = (wait_ms > 0).then(|| Duration::from_millis(wait_ms));
        let parent = ParentTurn {
            thread_id: self.parent.thread_id.clone(),
            turn_id: self.parent.turn_id.clone(),
            request: self.parent.request.clone(),
            store: self.parent.store.clone(),
            cancel: ctx.cancel_token.clone(),
        };
        let snapshot = tokio::select! {
            out = self.host.output(&parent, &task_id, wait) => out.map_err(super::send_message::map_error)?,
            () = ctx.cancel_token.cancelled() => return Err(ToolError::Cancelled),
        };

        // What the model needs and nothing it does not: no epoch millis, no
        // parent id it already knows, no flags about how it was started.
        let handle = snapshot.name.clone().unwrap_or_else(|| snapshot.agent_id.clone());
        let elapsed_ms = if snapshot.status.is_terminal() {
            snapshot.usage.duration_ms
        } else {
            let now = chrono::Utc::now().timestamp_millis();
            u64::try_from(now.saturating_sub(snapshot.started_at_ms)).unwrap_or(0)
        };
        let mut body = json!({
            "agentId": snapshot.agent_id,
            "status": snapshot.status,
            "description": snapshot.description,
            "elapsed": clock(elapsed_ms),
            "toolCalls": snapshot.usage.tool_calls,
        });
        if let Some(name) = &snapshot.name {
            body["name"] = Value::String(name.clone());
        }
        if snapshot.status.is_terminal() {
            if let Some(error) = &snapshot.error {
                body["error"] = Value::String(error.clone());
            }
            body["hint"] = Value::String(format!(
                "Finished. Its report is a message from \"{handle}\" in this conversation, not \
                 this result; if you do not have it yet, it is arriving now. To give this agent \
                 more work or ask it about its report, call send_message with to=\"{handle}\"."
            ));
        } else {
            // What it has done since the last check, in order. Enough to
            // decide whether to wait, redirect it with send_message, or stop
            // it with stop_agent. Read from its live log, which never waits.
            let activity = tokio::select! {
                a = self.host.activity(&parent, &task_id) => a,
                () = ctx.cancel_token.cancelled() => return Err(ToolError::Cancelled),
            };
            if let Some(activity) = activity {
                body["steps"] = json!(activity.steps);
                body["toolCalls"] = json!(activity.tool_calls);
                body["timeline"] = json!(activity.timeline);
                if activity.omitted > 0 {
                    body["omitted"] = json!(format!(
                        "{} earlier steps since your last check are not shown",
                        activity.omitted
                    ));
                }
                if let Some(now) = activity.in_progress {
                    body["now"] = Value::String(now);
                }
            }
            body["hint"] = Value::String(
                "Still running. Do not check again: its report arrives as a message in this \
                 conversation when it finishes. Work on something that does not depend on it, \
                 or, if there is nothing, tell the user what is running and end your turn; the \
                 report starts you again. To redirect it, call send_message; to end it, \
                 stop_agent."
                    .to_string(),
            );
        }
        Ok(serde_json::to_string_pretty(&body).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{context, parent_turn, ScriptedHost};
    use super::*;
    use crate::agent_runtime::subagents::host::SubagentUsage;
    use crate::agent_runtime::subagents::record::{TaskSnapshot, TaskStatus};

    fn snapshot(status: TaskStatus) -> TaskSnapshot {
        TaskSnapshot {
            agent_id: "agent_1".into(),
            parent_thread_id: "parent-thread".into(),
            agent_type: "explore".into(),
            name: Some("scout".into()),
            description: "Find things".into(),
            status,
            background: true,
            started_at_ms: chrono::Utc::now().timestamp_millis() - 5_000,
            ended_at_ms: status.is_terminal().then_some(2),
            result: status.is_terminal().then(|| "found it".to_string()),
            error: None,
            usage: SubagentUsage {
                duration_ms: 91_000,
                tool_calls: 4,
                ..SubagentUsage::default()
            },
            notified: false,
            runs: 1,
            model: None,
            context_tokens: None,
        }
    }

    #[tokio::test]
    async fn the_wait_is_capped_and_a_finished_agent_points_at_its_report_message() {
        let host = Arc::new(ScriptedHost::default());
        *host.next_output.lock().unwrap() = Some(Ok(snapshot(TaskStatus::Completed)));
        let parent = parent_turn();
        let tool = GetTaskOutputTool::new(host.clone(), parent.clone());
        let out = tool
            .execute(
                json!({ "taskId": "scout", "waitMs": 999_999_999u64 }),
                &context(&parent),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["status"], "completed");
        assert_eq!(parsed["name"], "scout");
        assert_eq!(parsed["elapsed"], "1m 31s");
        let hint = parsed["hint"].as_str().unwrap();
        assert!(hint.contains("send_message with to=\"scout\""), "{hint}");
        assert!(hint.contains("message from \"scout\""), "{hint}");
        // The report travels as a message only. Carried here as well, a
        // big one met the tool-result cap and was dropped whole.
        for noise in ["result", "parentThreadId", "startedAtMs", "endedAtMs", "background", "notified"] {
            assert!(parsed.get(noise).is_none(), "{noise} leaked to the model");
        }
        let (id, wait) = host.outputs.lock().unwrap()[0].clone();
        assert_eq!(id, "scout");
        assert_eq!(wait, Some(Duration::from_millis(MAX_WAIT_MS)), "clamped to the ceiling");
    }

    #[tokio::test]
    async fn a_plain_look_watches_for_ten_seconds_and_says_not_to_check_again() {
        let host = Arc::new(ScriptedHost::default());
        *host.next_output.lock().unwrap() = Some(Ok(snapshot(TaskStatus::Running)));
        let parent = parent_turn();
        let tool = GetTaskOutputTool::new(host.clone(), parent.clone());
        let out = tool
            .execute(json!({ "taskId": "agent_1" }), &context(&parent))
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["status"], "running");
        assert!(parsed.get("result").is_none());
        let hint = parsed["hint"].as_str().unwrap();
        assert!(hint.contains("Do not check again"), "{hint}");
        assert!(hint.contains("end your turn"), "{hint}");
        assert_eq!(
            host.outputs.lock().unwrap()[0].1,
            Some(Duration::from_millis(MAX_WAIT_MS)),
            "a check watches up to the cap by default"
        );
    }

    #[tokio::test]
    async fn wait_zero_answers_at_once() {
        let host = Arc::new(ScriptedHost::default());
        *host.next_output.lock().unwrap() = Some(Ok(snapshot(TaskStatus::Running)));
        let parent = parent_turn();
        let tool = GetTaskOutputTool::new(host.clone(), parent.clone());
        tool.execute(json!({ "taskId": "agent_1", "waitMs": 0 }), &context(&parent))
            .await
            .unwrap();
        assert_eq!(host.outputs.lock().unwrap()[0].1, None);
    }

    #[tokio::test]
    async fn the_old_block_flag_means_the_capped_wait() {
        let host = Arc::new(ScriptedHost::default());
        *host.next_output.lock().unwrap() = Some(Ok(snapshot(TaskStatus::Running)));
        let parent = parent_turn();
        let tool = GetTaskOutputTool::new(host.clone(), parent.clone());
        tool.execute(
            json!({ "taskId": "agent_1", "block": true, "timeoutMs": 300_000 }),
            &context(&parent),
        )
        .await
        .unwrap();
        assert_eq!(
            host.outputs.lock().unwrap()[0].1,
            Some(Duration::from_millis(MAX_WAIT_MS))
        );
    }
}
