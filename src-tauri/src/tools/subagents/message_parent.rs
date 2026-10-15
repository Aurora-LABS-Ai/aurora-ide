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
use crate::agent_runtime::subagents::host::{MessageDelivery, ParentMessenger, ParentResponse, SubagentError};
use crate::agent_runtime::subagents::messaging::ChildMessageKind;
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
        false // A held question has one answer consumer.
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: MESSAGE_PARENT_TOOL.into(),
            description: format!(
                "Your one tool for communicating with the parent during work. Choose kind: \
                 question for an answer or decision, message for useful information, reply \
                 to answer the parent. Every kind reaches and wakes an idle parent. Use it the moment you are \
                 blocked or the task cannot be done as asked: a tool you need and do not have \
                 (say which), a file or path that does not exist, a contradiction in the brief, \
                 a decision only the parent can make. Be specific and short. Avoid routine progress \
                 chatter. Work results belong in submit_report. Do not repeat a submitted report \
                 to acknowledge thanks.\n\n\
                 A question waits for the answer by default: the call holds for up to {} \
                 minutes and returns the parent's answer as its result. If you can carry on \
                 without it, set waitForReply: false; the answer then arrives later as a \
                 message. Only questions wait; a message or reply never does.",
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
                        "description": "For questions: wait for the parent's answer, default true. Set false if you can continue. Only explicit parent replies satisfy the wait."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["message", "question", "reply"],
                        "description": "question: ask for an answer or decision. message: pass information. reply: answer the parent. All reach and can wake the parent."
                    }
                },
                "required": ["message", "kind"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let message = required_str(&input, "message")?;
        let explicit_wait = input.get("waitForReply").map(|value| value.as_bool()
            .ok_or_else(|| ToolError::InvalidInput("`waitForReply` must be a boolean".into()))).transpose()?;
        let kind = match input.get("kind") {
            None if explicit_wait == Some(true) => ChildMessageKind::Question,
            None => ChildMessageKind::Message,
            Some(value) => serde_json::from_value::<ChildMessageKind>(value.clone())
                .map_err(|_| ToolError::InvalidInput("`kind` must be message, question or reply".into()))?,
        };
        let wait = explicit_wait.unwrap_or(kind == ChildMessageKind::Question);
        if wait && kind != ChildMessageKind::Question {
            return Err(ToolError::InvalidInput("only kind question can wait for a reply".into()));
        }
        let delivery = self
            .messenger
            .message_parent_kind(&message, kind, wait)
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
            let reply = self.messenger.wait_for_response(timeout, &ctx.cancel_token).await;
            ctx.bail_if_cancelled()?;
            let body = match reply {
                Some(ParentResponse::Answer(answer)) => json!({
                    "delivered": delivery,
                    "answered": true,
                    "reply": answer,
                    "hint": "The parent answered (`reply`). Continue this conversation with its answer.",
                }),
                Some(ParentResponse::TaskChanged) => json!({
                    "delivered": delivery,
                    "answered": false,
                    "taskChanged": true,
                    "hint": "The parent sent new task instructions. The question wait has ended; read those instructions at the next tool boundary and follow the changed assignment. Do not keep waiting for the old answer."
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
                "Delivered: the parent is working and reads it at its next step. If an answer \
                 is needed, it arrives as a reply. Carry on meanwhile."
            }
            MessageDelivery::WokeParent => {
                "Delivered: the parent was idle and has been woken with it. If an answer is \
                 needed, it arrives as a reply. Carry on meanwhile."
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
        waits: Mutex<Vec<bool>>,
        delivery: Mutex<Option<MessageDelivery>>,
    }

    impl ParentMessenger for Recorder {
        fn message_parent(&self, text: &str, waiting: bool) -> Result<MessageDelivery, SubagentError> {
            self.sent.lock().unwrap().push(text.to_string());
            self.waits.lock().unwrap().push(waiting);
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
    async fn invalid_kinds_and_non_question_waits_are_rejected_before_delivery() {
        let recorder = Arc::new(Recorder::default());
        let tool = MessageParentTool::new(recorder.clone());
        let parent = parent_turn();
        for input in [
            json!({"message":"hello", "kind":"task"}),
            json!({"message":"hello", "kind":"reply", "waitForReply":true}),
            json!({"message":"hello", "kind":"message", "waitForReply":true}),
            json!({"message":"hello", "kind":"question", "waitForReply":"yes"}),
        ] {
            assert!(tool.execute(input, &context(&parent)).await.is_err());
        }
        assert!(recorder.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn every_kind_can_wake_an_idle_parent_and_only_questions_wait_by_default() {
        let recorder = Arc::new(Recorder::default());
        *recorder.delivery.lock().unwrap() = Some(MessageDelivery::WokeParent);
        let tool = MessageParentTool::new(recorder.clone());
        let parent = parent_turn();
        for kind in ["message", "question", "reply"] {
            let result = tool.execute(json!({"message":"hello", "kind":kind}), &context(&parent)).await.unwrap();
            let parsed: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(parsed["delivered"], "woke_parent");
        }
        assert_eq!(*recorder.waits.lock().unwrap(), [false, true, false]);
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
