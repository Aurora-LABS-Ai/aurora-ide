//! `send_message` — a follow-up to a sub-agent, running or finished.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{ParentTurn, SendOutcome, SubagentError, SubagentHost};
use crate::agent_runtime::subagents::messaging::ParentMessageKind;
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
            description: "Communicate with a sub-agent by name or id, during its work or afterward. \
                          Choose kind explicitly: message for information, discussion, thanks or \
                          acknowledgement; reply for an answer to its question; task for new or \
                          changed work. A running child reads messages at its next safe boundary; \
                          a held question takes a reply immediately. Message and reply do not \
                          assign new work. A finished child answers them in a conversation-only \
                          turn, without file/shell tools or another work report. Its response \
                          reaches you and can wake you. Only task resumes work with its saved \
                          tools and requires a fresh report. Works with saved agents too."
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
                        "description": "The information, answer, or work instructions to send."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["message", "reply", "task"],
                        "description": "message: conversation or information, including thanks. reply: answer its question. task: assign or change work and require a new report. Never use task for acknowledgement."
                    }
                },
                "required": ["to", "message", "kind"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let to = required_str(&input, "to")?;
        let message = required_str(&input, "message")?;
        let kind = match input.get("kind") {
            None => ParentMessageKind::Message,
            Some(value) => serde_json::from_value::<ParentMessageKind>(value.clone())
                .map_err(|_| ToolError::InvalidInput("`kind` must be message, reply or task".into()))?,
        };
        let parent = ParentTurn {
            thread_id: self.parent.thread_id.clone(),
            turn_id: self.parent.turn_id.clone(),
            request: self.parent.request.clone(),
            store: self.parent.store.clone(),
            cancel: ctx.cancel_token.clone(),
        };
        let outcome = self
            .host
            .send_message_kind(&parent, &to, &message, kind)
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
                         reflect task instructions. Ordinary messages do not require another work report."
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
            SendOutcome::Messaging { agent_id } => serde_json::to_string_pretty(&json!({
                "status": "messaging",
                "agentId": agent_id,
                "hint": "The finished agent is answering your message in the background. Its previous work report stays intact. This is conversation only, with no task tools or report reminder. Its response arrives as a message; do other work or end your turn."
            })).unwrap_or_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{context, parent_turn, ScriptedHost};
    use super::*;

    #[tokio::test]
    async fn invalid_message_kinds_are_rejected_before_delivery() {
        let host = Arc::new(ScriptedHost::default());
        let parent = parent_turn();
        let tool = SendMessageTool::new(host.clone(), parent.clone());
        for kind in [json!("thanks"), json!(null), json!(3), json!(false)] {
            assert!(tool.execute(json!({"to":"worker", "message":"hello", "kind":kind}), &context(&parent)).await.is_err());
        }
        assert!(host.sends.lock().unwrap().is_empty());
        assert_eq!(tool.schema().input_schema["properties"]["kind"]["enum"], json!(["message", "reply", "task"]));
    }

    #[tokio::test]
    async fn purpose_is_explicit_and_legacy_omission_is_a_message() {
        let host = Arc::new(ScriptedHost::default());
        let parent = parent_turn();
        let tool = SendMessageTool::new(host.clone(), parent.clone());
        for kind in [None, Some("message"), Some("reply"), Some("task")] {
            *host.next_send.lock().unwrap() = Some(Ok(SendOutcome::Messaging { agent_id: "agent_1".into() }));
            let mut input = json!({"to":"worker", "message":"Thanks"});
            if let Some(kind) = kind { input["kind"] = json!(kind); }
            tool.execute(input, &context(&parent)).await.unwrap();
        }
        assert_eq!(*host.message_kinds.lock().unwrap(), [ParentMessageKind::Message, ParentMessageKind::Message, ParentMessageKind::Reply, ParentMessageKind::Task]);
    }

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
