//! `send_message` — a follow-up to a sub-agent, running or finished.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{ParentTurn, SendOutcome, SubagentError, SubagentHost};
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::required_str;

pub struct SendMessageTool {
    host: Arc<dyn SubagentHost>,
    parent: Arc<ParentTurn>,
}

impl SendMessageTool {
    #[must_use]
    pub fn new(host: Arc<dyn SubagentHost>, parent: Arc<ParentTurn>) -> Self {
        Self { host, parent }
    }
}

pub(crate) fn map_error(err: SubagentError) -> ToolError {
    match err {
        SubagentError::Invalid(msg) | SubagentError::UnknownModel(msg) => {
            ToolError::InvalidInput(msg)
        }
        SubagentError::NotFound(_) => ToolError::InvalidInput(err.to_string()),
        SubagentError::Start(msg) => ToolError::Execution(msg),
        SubagentError::Unavailable => ToolError::Execution(err.to_string()),
    }
}

#[async_trait]
impl ToolExecutor for SendMessageTool {
    fn name(&self) -> &str {
        "send_message"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "send_message".into(),
            description: "Send a message to a sub-agent you started, by the `name` you gave it or \
                          its agent id. If it is still running, the message is queued and reaches \
                          it at its next safe point (between tool calls). If it has finished, it is \
                          resumed in the background with your message as its next task — it keeps \
                          everything it knew: its original task, what it did, and its own last \
                          report. Its report arrives in this conversation when it finishes, as \
                          before. Works for agents from earlier sessions too; they are picked up \
                          from disk."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "The agent's name (as given to spawn_agent) or its agent id."
                    },
                    "message": {
                        "type": "string",
                        "description": "What to tell it. For a finished agent this is its next task."
                    }
                },
                "required": ["to", "message"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let to = required_str(&input, "to")?;
        let message = required_str(&input, "message")?;
        let parent = ParentTurn {
            thread_id: self.parent.thread_id.clone(),
            turn_id: self.parent.turn_id.clone(),
            request: self.parent.request.clone(),
            store: self.parent.store.clone(),
            cancel: ctx.cancel_token.clone(),
        };
        let outcome = self
            .host
            .send_message(&parent, &to, &message)
            .await
            .map_err(map_error)?;
        Ok(match outcome {
            SendOutcome::Queued { agent_id, taken_now: true } => serde_json::to_string_pretty(&json!({
                "status": "answered",
                "agentId": agent_id,
                "hint": "The agent was waiting for this answer and has it now. It carries on \
                         from where it asked."
            }))
            .unwrap_or_default(),
            SendOutcome::Queued { agent_id, taken_now: false } => serde_json::to_string_pretty(&json!({
                "status": "queued",
                "agentId": agent_id,
                "hint": "Queued for delivery at the agent's next safe point. Its report will \
                         include what it did with this."
            }))
            .unwrap_or_default(),
            SendOutcome::Resumed {
                agent_id,
                output_file,
                note,
            } => {
                let mut body = json!({
                    "status": "resumed",
                    "agentId": agent_id,
                    "outputFile": output_file,
                    "hint": "The agent is running again in the background with your message as \
                             its task, remembering its earlier work. Its new report arrives as a \
                             message when it finishes. Do not check on it or wait for it: do \
                             other work, or end your turn and the report starts you again.",
                });
                if let Some(note) = note {
                    body["note"] = Value::String(note);
                }
                serde_json::to_string_pretty(&body).unwrap_or_default()
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{context, parent_turn, ScriptedHost};
    use super::*;

    #[tokio::test]
    async fn queued_and_resumed_are_both_reported_with_the_id() {
        let host = Arc::new(ScriptedHost::default());
        *host.next_send.lock().unwrap() = Some(Ok(SendOutcome::Queued {
            agent_id: "agent_1".into(),
            taken_now: false,
        }));
        let parent = parent_turn();
        let tool = SendMessageTool::new(host.clone(), parent.clone());
        let out = tool
            .execute(
                json!({ "to": "scout", "message": "also check the tests" }),
                &context(&parent),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["status"], "queued");
        assert_eq!(parsed["agentId"], "agent_1");
        assert_eq!(
            host.sends.lock().unwrap()[0],
            ("scout".to_string(), "also check the tests".to_string())
        );

        *host.next_send.lock().unwrap() = Some(Ok(SendOutcome::Resumed {
            agent_id: "agent_1".into(),
            output_file: "p".into(),
            note: Some("definition gone".into()),
        }));
        let out = tool
            .execute(json!({ "to": "agent_1", "message": "now billing" }), &context(&parent))
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["status"], "resumed");
        assert_eq!(parsed["note"], "definition gone");
        // Live run 4: the old hint said get_task_output "reads or waits on it
        // sooner", the one invitation to poll left after the others were cut.
        let hint = parsed["hint"].as_str().unwrap();
        assert!(!hint.contains("get_task_output"), "{hint}");
        assert!(hint.contains("end your turn"), "{hint}");
    }

    #[tokio::test]
    async fn an_unknown_agent_is_a_clear_failure() {
        let host = Arc::new(ScriptedHost::default());
        let parent = parent_turn();
        let tool = SendMessageTool::new(host, parent.clone());
        let err = tool
            .execute(json!({ "to": "nobody", "message": "hi" }), &context(&parent))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(ref m) if m.contains("nobody")), "{err}");
        let err = tool
            .execute(json!({ "to": "x" }), &context(&parent))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(ref m) if m.contains("message")));
    }
}
