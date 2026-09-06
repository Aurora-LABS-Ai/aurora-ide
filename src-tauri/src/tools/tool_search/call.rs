//! Fixed native invocation envelope. Sessions retain the provider-issued call;
//! the runtime executes and presents its underlying operation with the same id.
use super::catalog::ToolCatalog;
use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolInvocation};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallInput {
    name: String,
    arguments: Map<String, Value>,
}

/// Display-only projection for live events and reopened JSONL sessions.
/// Never use this projection to authorize or execute a call.
pub fn call_identity<'a>(name: &'a str, input: &'a Value) -> (&'a str, &'a Value) {
    if name == "call_tool" {
        if let (Some(target), Some(arguments)) = (
            input.get("name").and_then(Value::as_str),
            input.get("arguments").filter(|v| v.is_object()),
        ) {
            if !target.is_empty() && !super::TOOL_NAMES.contains(&target) {
                return (target, arguments);
            }
        }
    }
    (name, input)
}

pub(super) struct CallToolExecutor {
    catalog: Arc<ToolCatalog>,
}
impl CallToolExecutor {
    pub fn new(catalog: Arc<ToolCatalog>) -> Self {
        Self { catalog }
    }
    fn resolve(&self, input: &Value) -> Result<ToolInvocation, ToolError> {
        let args: CallInput = serde_json::from_value(input.clone()).map_err(|error| {
            ToolError::InvalidInput(format!(
                "call_tool expects {{\"name\":\"tool_name\",\"arguments\":{{...}}}}: {error}"
            ))
        })?;
        if args.name.trim().is_empty() || super::TOOL_NAMES.contains(&args.name.as_str()) {
            return Err(ToolError::InvalidInput("call_tool requires an optional tool name returned by tool_search; wrapper recursion is not allowed.".into()));
        }
        let input = Value::Object(args.arguments);
        Ok(ToolInvocation {
            executor: self.catalog.get(&args.name, &input)?,
            input,
        })
    }
}
#[async_trait]
impl ToolExecutor for CallToolExecutor {
    fn name(&self) -> &str {
        "call_tool"
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema { name: self.name().into(),
            description: "Execute an optional tool described by tool_search. Pass its exact name and an arguments object matching the returned parameters. The actual tool's mode restrictions, permissions, timeout, and cancellation still apply. Call core tools directly. If a schema is missing from context, retrieve it with tool_search.".into(),
            input_schema: json!({"type":"object", "properties": {
                "name": {"type":"string", "description":"Exact optional tool name returned by tool_search."},
                "arguments": {"type":"object", "additionalProperties":true, "description":"Arguments matching that tool's parameters; use {} for no arguments."}
            }, "required":["name","arguments"], "additionalProperties":false}),
        }
    }
    fn resolve_call(&self, input: &Value) -> Option<Result<ToolInvocation, ToolError>> {
        Some(self.resolve(input))
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let resolved = self.resolve(&input)?;
        resolved.executor.execute(resolved.input, ctx).await
    }
}
