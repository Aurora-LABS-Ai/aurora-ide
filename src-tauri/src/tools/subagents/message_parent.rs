//! `message_parent` — the CHILD's one tool for raising a hand mid-run.
//!
//! A sub-agent cannot ask the user anything, and the parent reads only its
//! final report. Before this tool, a child missing a capability could only
//! improvise or give up and say so at the end. Now it says so at once: the
//! message rides the parent's mid-turn queue — the same path a person's
//! message takes while the parent works — and lands in the parent's
//! transcript as the agent's own card, by name. An idle parent is woken with
//! it.
//!
//! Installed for child turns only (`ToolScope::Child`), regardless of the
//! definition's allow-list: every child must be able to say "I cannot do
//! this as asked".

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{MessageDelivery, ParentMessenger, SubagentError};
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::required_str;

pub const MESSAGE_PARENT_TOOL: &str = "message_parent";

pub struct MessageParentTool {
    messenger: Arc<dyn ParentMessenger>,
}

impl MessageParentTool {
    #[must_use]
    pub fn new(messenger: Arc<dyn ParentMessenger>) -> Self {
        Self { messenger }
    }
}

#[async_trait]
impl ToolExecutor for MessageParentTool {
    fn name(&self) -> &str {
        MESSAGE_PARENT_TOOL
    }

    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: MESSAGE_PARENT_TOOL.into(),
            description: format!(
                "Send a message to the parent agent that started you. Use it the moment you are \
                 blocked or the task cannot be done as asked: a tool you need and do not have \
                 (say which), a file or path that does not exist, a contradiction in the brief, \
                 a decision only the parent can make. Be specific and short. Not for progress \
                 updates, and not for your final report (that is submit_report).\n\n\
                 Set waitForReply: true when you cannot continue without the answer: the call \
                 holds for up to {} minutes and returns the parent's answer as its result. \
                 Leave it off when you only need the parent to know and can carry on; its \
                 answer then arrives later as a message.",
                crate::agent_runtime::subagents::WAIT_FOR_REPLY_SECS / 60
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "What the parent needs to know, and what you need from it."
                    },
                    "waitForReply": {
                        "type": "boolean",
                        "description": "Hold for the parent's answer and get it back as this call's result. For questions you cannot continue without."
                    }
                },
                "required": ["message"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let message = required_str(&input, "message")?;
        let wait = input.get("waitForReply").and_then(Value::as_bool) == Some(true);
        let delivery = self
            .messenger
            .message_parent(&message, wait)
            .map_err(|e| match e {
                SubagentError::Invalid(msg) => ToolError::InvalidInput(msg),
                other => ToolError::Execution(other.to_string()),
            })?;
        if wait {
            // The parent's answer comes back as this call's result: answered
            // inside this run, where it was asked. Before this the child had
            // to carry on, finished first, and the answer started a second
            // run with a second report.
            let timeout =
                std::time::Duration::from_secs(crate::agent_runtime::subagents::WAIT_FOR_REPLY_SECS);
            let reply = self.messenger.wait_for_reply(timeout, &ctx.cancel_token).await;
            ctx.bail_if_cancelled()?;
            let body = match reply {
                Some(answer) => json!({
                    "delivered": delivery,
                    "answered": true,
                    "reply": answer,
                    "hint": "The parent answered (`reply`). Continue with it.",
                }),
                None => json!({
                    "delivered": delivery,
                    "answered": false,
                    "hint": format!(
                        "No answer within {} minutes. Carry on with what you can; if the parent \
                         answers later, it arrives as a message in this conversation.",
                        crate::agent_runtime::subagents::WAIT_FOR_REPLY_SECS / 60
                    ),
                }),
            };
            return Ok(serde_json::to_string_pretty(&body).unwrap_or_default());
        }
        let hint = match delivery {
            MessageDelivery::QueuedIntoTurn => {
                "Delivered: the parent is working and reads it at its next step. Its answer \
                 arrives as a message in this conversation. Carry on meanwhile."
            }
            MessageDelivery::WokeParent => {
                "Delivered: the parent was idle and has been woken with it. Its answer arrives \
                 as a message in this conversation. Carry on meanwhile."
            }
        };
        Ok(serde_json::to_string_pretty(&json!({
            "delivered": delivery,
            "hint": hint,
        }))
        .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::test_support::{context, parent_turn};
    use super::*;

    #[derive(Default)]
    struct Recorder {
        sent: Mutex<Vec<String>>,
        delivery: Mutex<Option<MessageDelivery>>,
    }

    impl ParentMessenger for Recorder {
        fn message_parent(&self, text: &str, _waiting: bool) -> Result<MessageDelivery, SubagentError> {
            self.sent.lock().unwrap().push(text.to_string());
            Ok(self
                .delivery
                .lock()
                .unwrap()
                .unwrap_or(MessageDelivery::QueuedIntoTurn))
        }

        fn submit_report(
            &self,
            _report: crate::agent_runtime::subagents::host::SubmittedReport,
        ) -> Result<bool, SubagentError> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn a_message_is_handed_to_the_messenger_and_the_child_is_told_to_carry_on() {
        let recorder = Arc::new(Recorder::default());
        let tool = MessageParentTool::new(recorder.clone());
        let parent = parent_turn();
        let out = tool
            .execute(
                json!({ "message": "I was asked to run pytest but have no shell tool." }),
                &context(&parent),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["delivered"], "queued_into_turn");
        assert!(parsed["hint"].as_str().unwrap().contains("Carry on"));
        assert_eq!(
            recorder.sent.lock().unwrap().as_slice(),
            ["I was asked to run pytest but have no shell tool."]
        );
    }

    #[tokio::test]
    async fn an_empty_message_is_refused_before_it_is_sent() {
        let recorder = Arc::new(Recorder::default());
        let tool = MessageParentTool::new(recorder.clone());
        let parent = parent_turn();
        let err = tool
            .execute(json!({ "message": "   " }), &context(&parent))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
        assert!(recorder.sent.lock().unwrap().is_empty());
    }
}
