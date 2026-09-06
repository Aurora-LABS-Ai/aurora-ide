//! Resolve native forwarding calls without rewriting the provider transcript.
use super::*;
use crate::agent_runtime::tool_executor::ToolExecutor;

pub(super) struct PreparedToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
    pub tool: Result<Arc<dyn ToolExecutor>, ToolError>,
}

impl PreparedToolCall {
    pub fn batch_len(calls: &[Self]) -> usize {
        // Failed resolution has no side effects. Otherwise the actual tool
        // decides whether it can overlap; permission gates remain sequential.
        calls
            .iter()
            .take_while(|call| {
                call.tool
                    .as_ref()
                    .map_or(true, |tool| tool.concurrency_safe())
            })
            .count()
            .max(1)
    }
}

impl ConversationRuntime {
    pub(super) fn prepare_tool_call(&self, call: &PendingToolCall) -> PreparedToolCall {
        let resolved = match crate::api::provider_kernel_adapter::malformed_tool_input(&call.input)
        {
            Some(raw) => Err(super::tool_exec::malformed_input_error(&call.name, raw)),
            None => self.tools.resolve_call(&call.name, &call.input),
        };
        match resolved {
            Ok(invocation) => PreparedToolCall {
                id: call.id.clone(),
                name: invocation.executor.name().to_owned(),
                input: invocation.input,
                tool: Ok(invocation.executor),
            },
            Err(error) => {
                let (name, input) =
                    crate::tools::tool_search::call_identity(&call.name, &call.input);
                PreparedToolCall {
                    id: call.id.clone(),
                    name: name.to_owned(),
                    input: input.clone(),
                    tool: Err(error),
                }
            }
        }
    }
}
