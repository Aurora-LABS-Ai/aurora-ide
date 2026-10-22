//! The sub-agent tools the PARENT calls.
//!
//! Not a bucket in [`super::register_builtin_tools`] and not counted in
//! [`super::BUILTIN_TOOL_COUNT`]: these executors are built per turn, like
//! `tool_search`, because each one holds the parent turn it belongs to — its
//! thread, its turn id, its cancel token, the request it is running. A tool
//! registered once at startup could not know any of that.
//!
//! They are installed only when the user's master switch is on and the turn
//! is a project Agent turn (`commands::agent_v2::tool_policy`). A child
//! never gets them: the child roster is an allow-list that cannot name them,
//! and [`crate::agent_runtime::subagents::catalog::NEVER_FOR_CHILDREN`]
//! refuses them even if one did.

use std::sync::Arc;

use crate::agent_runtime::subagents::host::{ParentTurn, SubagentHost};
use crate::agent_runtime::tool_executor::ToolRegistry;

pub mod get_task_output;
pub mod list_models;
pub mod message_parent;
pub mod send_message;
pub mod spawn_agent;
pub mod stop_agent;
pub mod submit_report;

/// Names of the parent-side tools, in roster order.
pub const PARENT_TOOL_NAMES: &[&str] = &[
    "spawn_agent",
    "send_message",
    "get_task_output",
    "stop_agent",
    "list_models",
];

/// Names of the child-side tools, in roster order. Every child has them,
/// whatever its definition allows.
pub const CHILD_TOOL_NAMES: &[&str] = &[
    message_parent::MESSAGE_PARENT_TOOL,
    submit_report::SUBMIT_REPORT_TOOL,
];

/// Install the CHILD-side tools: `message_parent`, the way a sub-agent
/// reaches its parent before it is done, and `submit_report`, the way it
/// finishes.
pub fn install_child(
    registry: &ToolRegistry,
    messenger: Arc<dyn crate::agent_runtime::subagents::host::ParentMessenger>,
    report_required: bool,
) {
    registry.register(Arc::new(message_parent::MessageParentTool::new(
        messenger.clone(),
    )));
    if report_required {
        registry.register(Arc::new(submit_report::SubmitReportTool::new(messenger)));
    }
}

/// Install the parent-side tools into a per-turn registry.
pub fn install(registry: &ToolRegistry, host: Arc<dyn SubagentHost>, parent: Arc<ParentTurn>) {
    registry.register(Arc::new(spawn_agent::SpawnAgentTool::new(
        host.clone(),
        parent.clone(),
    )));
    registry.register(Arc::new(send_message::SendMessageTool::new(
        host.clone(),
        parent.clone(),
    )));
    registry.register(Arc::new(get_task_output::GetTaskOutputTool::new(
        host.clone(),
        parent.clone(),
    )));
    registry.register(Arc::new(stop_agent::StopAgentTool::new(
        host.clone(),
        parent.clone(),
    )));
    registry.register(Arc::new(list_models::ListModelsTool::new(host, parent)));
}

/// Read a required, non-empty string field.
fn required_str(input: &serde_json::Value, field: &str) -> Result<String, crate::agent_runtime::tool_executor::ToolError> {
    input
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            crate::agent_runtime::tool_executor::ToolError::InvalidInput(format!(
                "`{field}` must be a non-empty string"
            ))
        })
}

/// Read an optional string field; `""` counts as absent.
fn optional_str(input: &serde_json::Value, field: &str) -> Option<String> {
    input
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A scripted host so the tools can be tested without the turn driver.

    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::agent_runtime::subagents::host::{
        ModelChoice, SendOutcome, SpawnOutcome, SpawnRequest, StopOutcome, SubagentError,
        SubagentUsage,
    };
    use crate::agent_runtime::subagents::record::TaskSnapshot;

    #[derive(Default)]
    pub struct ScriptedHost {
        pub spawns: Mutex<Vec<SpawnRequest>>,
        pub next: Mutex<Option<Result<SpawnOutcome, SubagentError>>>,
        pub models: Mutex<Vec<ModelChoice>>,
        pub sends: Mutex<Vec<(String, String)>>,
        pub message_kinds: Mutex<Vec<crate::agent_runtime::subagents::messaging::ParentMessageKind>>,
        pub next_send: Mutex<Option<Result<SendOutcome, SubagentError>>>,
        pub next_output: Mutex<Option<Result<TaskSnapshot, SubagentError>>>,
        pub outputs: Mutex<Vec<(String, Option<std::time::Duration>)>>,
        pub stops: Mutex<Vec<String>>,
        pub next_stop: Mutex<Option<Result<StopOutcome, SubagentError>>>,
    }

    impl ScriptedHost {
        pub fn finishing_with(result: &str) -> Arc<Self> {
            let host = Self::default();
            *host.next.lock().unwrap() = Some(Ok(SpawnOutcome::Finished {
                agent_id: "agent_test".into(),
                state: "completed".into(),
                result: result.into(),
                error: None,
                usage: SubagentUsage {
                    input_tokens: 100,
                    output_tokens: 20,
                    tool_calls: 3,
                    iterations: 2,
                    duration_ms: 1_500,
                },
                output_file: "C:/x/agents/agent_test/conversation.jsonl".into(),
            }));
            Arc::new(host)
        }
    }

    #[async_trait]
    impl SubagentHost for ScriptedHost {
        async fn spawn(
            &self,
            _parent: &ParentTurn,
            request: SpawnRequest,
        ) -> Result<SpawnOutcome, SubagentError> {
            self.spawns.lock().unwrap().push(request);
            self.next
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Err(SubagentError::Unavailable))
        }

        async fn send_message(
            &self,
            _parent: &ParentTurn,
            to: &str,
            message: &str,
        ) -> Result<SendOutcome, SubagentError> {
            self.sends
                .lock()
                .unwrap()
                .push((to.to_string(), message.to_string()));
            self.next_send
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Err(SubagentError::NotFound(to.to_string())))
        }

        async fn send_message_kind(
            &self,
            parent: &ParentTurn,
            to: &str,
            message: &str,
            kind: crate::agent_runtime::subagents::messaging::ParentMessageKind,
        ) -> Result<SendOutcome, SubagentError> {
            self.message_kinds.lock().unwrap().push(kind);
            self.send_message(parent, to, message).await
        }

        async fn output(
            &self,
            _parent: &ParentTurn,
            task_id: &str,
            wait: Option<std::time::Duration>,
        ) -> Result<TaskSnapshot, SubagentError> {
            self.outputs
                .lock()
                .unwrap()
                .push((task_id.to_string(), wait));
            self.next_output
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Err(SubagentError::NotFound(task_id.to_string())))
        }

        async fn stop(&self, _parent: &ParentTurn, to: &str) -> Result<StopOutcome, SubagentError> {
            self.stops.lock().unwrap().push(to.to_string());
            self.next_stop
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Err(SubagentError::NotFound(to.to_string())))
        }

        fn list(&self, _parent_thread_id: &str) -> Vec<TaskSnapshot> {
            Vec::new()
        }

        fn models(&self, _parent: &ParentTurn) -> Result<Vec<ModelChoice>, SubagentError> {
            Ok(self.models.lock().unwrap().clone())
        }

        fn describe_definitions(&self) -> String {
            "- `general-purpose`: Does things".to_string()
        }
    }

    pub fn parent_turn() -> Arc<ParentTurn> {
        use crate::agent_runtime::ipc::{AgentChatRequest, AgentExecutionMode};
        let request = AgentChatRequest {
            cli_task_id: None,
            turn_id: "parent-turn".into(),
            thread_id: "parent-thread".into(),
            user_message: "hi".into(),
            user_message_origin: Default::default(),
            user_message_summary: None,
            user_message_agent: None,
            provider_id: "mock".into(),
            model: "mock-model".into(),
            model_selection: None,
            workspace_path: None,
            execution_mode: AgentExecutionMode::Agent,
            provider_config: crate::api::ProviderConfigSnapshot {
                provider_id: "mock".into(),
                provider_type: None,
                base_url: "https://example.invalid".into(),
                api_key: "k".into(),
                api_keys: None,
                model: "mock-model".into(),
                custom_headers: None,
                custom_params: None,
                default_temperature: None,
                default_max_tokens: None,
                supports_thinking: false,
                reasoning: None,
                supports_vision: false,
                tool_images_in_result: false,
            },
            system_prompt: None,
            ide_context: None,
            tools: Vec::new(),
            temperature: None,
            max_output_tokens: None,
            thinking_enabled: None,
            thinking_budget_tokens: None,
            context_window: None,
            compaction_threshold_pct: None,
            compaction_summary_budget: None,
            compaction_provider_config: None,
            workspace_access: None,
            allow_outside_workspace: None,
            transcript_chapters: None,
            browser_tools: None,
            defer_tools: None,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            image_providers: Vec::new(),
            subagents_enabled: Some(true),
            subagent_model: None,
        };
        Arc::new(ParentTurn {
            thread_id: "parent-thread".into(),
            turn_id: "parent-turn".into(),
            request: Arc::new(request),
            store: Arc::new(crate::agent_runtime::session_store::SessionStore::new_project(
                std::env::temp_dir().join("aurora-subagent-tool-tests"),
            )),
            cancel: tokio_util::sync::CancellationToken::new(),
        })
    }

    pub fn context(parent: &ParentTurn) -> crate::agent_runtime::tool_executor::ToolContext {
        crate::agent_runtime::tool_executor::ToolContext {
            turn_id: parent.turn_id.clone(),
            tool_call_id: "call-1".into(),
            thread_id: parent.thread_id.clone(),
            workspace_root: None,
            workspace_access: Default::default(),
            spill_dir: None,
            cancel_token: parent.cancel.clone(),
        }
    }
}
