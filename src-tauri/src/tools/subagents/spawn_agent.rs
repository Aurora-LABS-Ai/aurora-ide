//! `spawn_agent` — start a sub-agent. It runs in the background, always.
//!
//! Spawning used to offer a synchronous mode that parked the parent's turn
//! until the child was done. That made the parent's transcript sit on one
//! tool card for minutes and taught the model to wait instead of work. Now a
//! spawn returns the moment the child is running; the child's report, and
//! anything it needs to say before that, arrive as messages in the parent's
//! conversation, and `get_task_output` is a short look, not a wait.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::subagents::host::{
    ParentTurn, SpawnOutcome, SpawnRequest, SubagentError, SubagentHost,
};
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

use super::{optional_str, required_str};

pub struct SpawnAgentTool {
    host: Arc<dyn SubagentHost>,
    parent: Arc<ParentTurn>,
}

impl SpawnAgentTool {
    #[must_use]
    pub fn new(host: Arc<dyn SubagentHost>, parent: Arc<ParentTurn>) -> Self {
        Self { host, parent }
    }
}

/// The sentence that teaches the model how to come back to an agent. Short
/// and fixed on purpose: the model learns the shape from seeing it, and a
/// shape that drifts between releases is one it stops trusting.
fn continue_hint(handle: &str) -> String {
    format!("To give this agent more work or answer it, call send_message with to=\"{handle}\".")
}

#[async_trait]
impl ToolExecutor for SpawnAgentTool {
    fn name(&self) -> &str {
        "spawn_agent"
    }

    fn concurrency_safe(&self) -> bool {
        true
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "spawn_agent".into(),
            description: format!(
                "Start a sub-agent: a separate agent with its own conversation and tools that does \
                 ONE task in this workspace. It sees nothing of this conversation, so the prompt \
                 must carry everything: the goal, the exact files or areas, the constraints, and \
                 what a finished result looks like.\n\n\
                 The call returns at once with the agent's id and the agent runs in the \
                 background. You will be told, as a message in this conversation, when it \
                 finishes (its report) and whenever it needs something from you before that. Do \
                 not wait for it, poll it or check on it. Do work that does not depend on it, or \
                 tell the user what you started and end your turn; its report starts you again.\n\n\
                 Use a sub-agent for work that is parallel, long, or noisy. Do it yourself when it \
                 is a few direct edits.\n\n\
                 Types:\n{}\n\n\
                 The user sees every agent you start in their Agents list under `name` (or \
                 `description`) and can open its transcript. Sub-agents cannot ask the user \
                 anything and cannot start agents of their own.",
                self.host.describe_definitions()
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "3–6 words naming the task, e.g. \"Find the login flow\". Shown to the user as the agent's title."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The complete task. The agent reads nothing else: include paths, constraints, and what done means."
                    },
                    "agentType": {
                        "type": "string",
                        "description": "Which definition to start from. Default general-purpose."
                    },
                    "model": {
                        "type": "string",
                        "description": "providerId:modelKey to run the agent on, from list_models. Default: the user's sub-agent model setting, else this conversation's model."
                    },
                    "tools": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional exact native task tools for this child. Omit for the type's defaults; [] gives only message_parent and submit_report. Tools must fit the selected type's allowed tools and the current user's access. The grant is saved and kept on resume. MCP and skill tools cannot be granted yet."
                    },
                    "name": {
                        "type": "string",
                        "description": "A short handle (letters, digits, - or _) to address this agent later with send_message and get_task_output, instead of its id."
                    }
                },
                "required": ["description", "prompt"]
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let description = required_str(&input, "description")?;
        let prompt = required_str(&input, "prompt")?;
        let agent_type = optional_str(&input, "agentType");
        let model = optional_str(&input, "model");
        let name = optional_str(&input, "name");
        let tools = match input.get("tools") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(items.iter().map(|item| {
                item.as_str().map(str::trim).filter(|name| !name.is_empty())
                    .map(str::to_string).ok_or_else(|| ToolError::InvalidInput("`tools` entries must be non-empty strings".into()))
            }).collect::<Result<Vec<_>, _>>()?),
            _ => return Err(ToolError::InvalidInput("`tools` must be an array of tool names".into())),
        };
        if let Some(name) = name.as_deref() {
            if !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(ToolError::InvalidInput(format!(
                    "`name` {name:?} must be letters, digits, `-` or `_`"
                )));
            }
        }

        let request = SpawnRequest {
            description,
            prompt,
            agent_type,
            model,
            // Always. See the module note.
            background: true,
            name: name.clone(),
            tools,
        };

        // The parent turn the tool was built for, with THIS call's cancel
        // token: the parent's token may have been replaced by a retry, and
        // the context's is the live one.
        let parent = ParentTurn {
            thread_id: self.parent.thread_id.clone(),
            turn_id: self.parent.turn_id.clone(),
            request: self.parent.request.clone(),
            store: self.parent.store.clone(),
            cancel: ctx.cancel_token.clone(),
        };

        let outcome = self.host.spawn(&parent, request).await.map_err(|e| match e {
            SubagentError::Invalid(msg) | SubagentError::UnknownModel(msg) => {
                ToolError::InvalidInput(msg)
            }
            SubagentError::Start(msg) => ToolError::Execution(msg),
            SubagentError::NotFound(_) | SubagentError::Unavailable => {
                ToolError::Execution(e.to_string())
            }
        })?;

        if ctx.cancel_token.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let agent_id = match outcome {
            SpawnOutcome::Launched { agent_id, .. } | SpawnOutcome::Finished { agent_id, .. } => {
                agent_id
            }
        };
        let handle = name.clone().unwrap_or_else(|| agent_id.clone());
        let mut body = json!({
            "status": "started",
            "agentId": agent_id,
            "hint": format!(
                "Running in the background. Its report arrives as a message in this \
                 conversation when it finishes, and so does anything it needs from you before \
                 then. Do not wait for it, poll it or check on it. If you have work that does not \
                 depend on it, do that; otherwise tell the user in a sentence what you started \
                 and end your turn. The report starts you again. {}",
                continue_hint(&handle)
            ),
        });
        if let Some(name) = name {
            body["name"] = Value::String(name);
        }
        Ok(serde_json::to_string_pretty(&body).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{context, parent_turn, ScriptedHost};
    use super::*;

    fn launching(agent_id: &str) -> Arc<ScriptedHost> {
        let host = Arc::new(ScriptedHost::default());
        *host.next.lock().unwrap() = Some(Ok(SpawnOutcome::Launched {
            agent_id: agent_id.into(),
            output_file: format!("C:/x/agents/{agent_id}/conversation.jsonl"),
        }));
        host
    }

    #[tokio::test]
    async fn every_spawn_is_background_and_returns_the_id_name_and_how_to_continue() {
        let host = launching("agent_test");
        let parent = parent_turn();
        let tool = SpawnAgentTool::new(host.clone(), parent.clone());
        let out = tool
            .execute(
                json!({
                    "description": "Find the login flow",
                    "prompt": "Where is login handled? Give file and line.",
                    "agentType": "explore",
                    "name": "scout"
                }),
                &context(&parent),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["status"], "started");
        assert_eq!(parsed["agentId"], "agent_test");
        assert_eq!(parsed["name"], "scout");
        let hint = parsed["hint"].as_str().unwrap();
        assert!(hint.contains("send_message with to=\"scout\""), "{hint}");
        assert!(hint.contains("end your turn"), "{hint}");
        assert!(!hint.contains("get_task_output"), "the hint must not invite a check: {hint}");
        assert!(parsed.get("outputFile").is_none(), "the path is noise to the model");

        let spawns = host.spawns.lock().unwrap();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].agent_type.as_deref(), Some("explore"));
        assert_eq!(spawns[0].name.as_deref(), Some("scout"));
        assert!(spawns[0].background, "there is no synchronous spawn any more");
    }

    #[tokio::test]
    async fn a_legacy_run_in_background_flag_changes_nothing() {
        let host = launching("agent_bg");
        let parent = parent_turn();
        let tool = SpawnAgentTool::new(host.clone(), parent.clone());
        let out = tool
            .execute(
                json!({ "description": "t", "prompt": "p", "runInBackground": false }),
                &context(&parent),
            )
            .await
            .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["status"], "started");
        assert!(parsed["hint"].as_str().unwrap().contains("to=\"agent_bg\""));
        assert!(host.spawns.lock().unwrap()[0].background);
    }

    #[tokio::test]
    async fn explicit_tool_grants_are_forwarded_and_bad_shapes_are_rejected() {
        let host = launching("agent_granted");
        let parent = parent_turn();
        let tool = SpawnAgentTool::new(host.clone(), parent.clone());
        tool.execute(json!({"description": "Task", "prompt": "Work", "tools": ["file_read", "grep"]}),
            &context(&parent)).await.unwrap();
        assert_eq!(host.spawns.lock().unwrap()[0].tools, Some(vec!["file_read".into(), "grep".into()]));
        for value in [json!("file_read"), json!(["file_read", 7]), json!([""])] {
            assert!(matches!(tool.execute(json!({"description": "Task", "prompt": "Work", "tools": value}),
                &context(&parent)).await, Err(ToolError::InvalidInput(_))));
        }
        assert_eq!(host.spawns.lock().unwrap().len(), 1);
        assert_eq!(tool.schema().input_schema["properties"]["tools"]["type"], "array");
    }

    #[tokio::test]
    async fn missing_prompt_and_bad_names_are_invalid_input() {
        let host = launching("x");
        let parent = parent_turn();
        let tool = SpawnAgentTool::new(host.clone(), parent.clone());
        let err = tool
            .execute(json!({ "description": "Only a title" }), &context(&parent))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(ref m) if m.contains("prompt")));
        let err = tool
            .execute(
                json!({ "description": "t", "prompt": "p", "name": "has space" }),
                &context(&parent),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(ref m) if m.contains("name")));
        assert!(host.spawns.lock().unwrap().is_empty(), "nothing was spawned");
    }

    #[tokio::test]
    async fn an_unknown_type_from_the_host_is_invalid_input_with_the_list() {
        let host = Arc::new(ScriptedHost::default());
        *host.next.lock().unwrap() = Some(Err(SubagentError::Invalid(
            "unknown agentType \"janitor\". Available: explore, general-purpose".into(),
        )));
        let parent = parent_turn();
        let tool = SpawnAgentTool::new(host, parent.clone());
        let err = tool
            .execute(
                json!({ "description": "t", "prompt": "p", "agentType": "janitor" }),
                &context(&parent),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(ref m) if m.contains("Available")));
    }
}
