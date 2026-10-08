//! `stop_agent` — end a running sub-agent.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{ParentTurn, StopOutcome, SubagentHost};
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::required_str;

pub struct StopAgentTool {
    host: Arc<dyn SubagentHost>,
    parent: Arc<ParentTurn>,
}

impl StopAgentTool {
    #[must_use]
    pub fn new(host: Arc<dyn SubagentHost>, parent: Arc<ParentTurn>) -> Self {
        Self { host, parent }
    }
}

#[async_trait]
impl ToolExecutor for StopAgentTool {
    fn name(&self) -> &str {
        "stop_agent"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "stop_agent".into(),
            description: "Stop a sub-agent you started that is still running, by the `name` you \
                          gave it or its agent id. Use it when the agent is on the wrong track, \
                          its work is no longer needed, or it is taking too long. It stops at \
                          once; you then get its report with status `killed` and whatever it had \
                          said so far. Its transcript is kept, and send_message can give it new \
                          work later."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "The agent's name (as given to spawn_agent) or its agent id."
                    }
                },
                "required": ["to"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let to = required_str(&input, "to")?;
        let parent = ParentTurn {
            thread_id: self.parent.thread_id.clone(),
            turn_id: self.parent.turn_id.clone(),
            request: self.parent.request.clone(),
            store: self.parent.store.clone(),
            cancel: ctx.cancel_token.clone(),
        };
        let outcome = self
            .host
            .stop(&parent, &to)
            .await
            .map_err(super::send_message::map_error)?;
        Ok(match outcome {
            StopOutcome::Stopped { agent_id } => serde_json::to_string_pretty(&json!({
                "status": "stopped",
                "agentId": agent_id,
                "hint": "Stopped. Its report, with whatever it had done, arrives as a message."
            })),
            StopOutcome::NotRunning { agent_id, status } => serde_json::to_string_pretty(&json!({
                "status": "not_running",
                "agentId": agent_id,
                "state": status,
                "hint": "It had already ended; nothing was stopped."
            })),
        }
        .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{context, parent_turn, ScriptedHost};
    use super::*;

    #[tokio::test]
    async fn stopping_names_the_agent_and_says_a_report_follows() {
        let host = Arc::new(ScriptedHost::default());
        *host.next_stop.lock().unwrap() = Some(Ok(StopOutcome::Stopped {
            agent_id: "agent_1".into(),
        }));
        let parent = parent_turn();
        let tool = StopAgentTool::new(host.clone(), parent.clone());
        let out = tool
            .execute(json!({"to": "scout"}), &context(&parent))
            .await
            .expect("stop");
        let body: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(body["status"], "stopped");
        assert_eq!(body["agentId"], "agent_1");
        assert_eq!(host.stops.lock().unwrap().as_slice(), ["scout"]);
    }

    #[tokio::test]
    async fn an_empty_name_is_refused() {
        let parent = parent_turn();
        let tool = StopAgentTool::new(Arc::new(ScriptedHost::default()), parent.clone());
        let err = tool
            .execute(json!({"to": " "}), &context(&parent))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
