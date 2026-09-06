//! Provider-independent discovery. Only two static schemas are advertised;
//! optional tools stay in a turn-local catalog and their documentation travels
//! in ordinary tool results. Discovery never mutates the cached tools prefix.

mod call;
mod catalog;
#[cfg(test)]
mod tests;
mod validation;

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor, ToolRegistry};
use async_trait::async_trait;
pub use call::call_identity;
use call::CallToolExecutor;
use catalog::ToolCatalog;
use serde_json::{json, Value};
use std::sync::Arc;

pub const TOOL_NAMES: &[&str] = &["tool_search", "call_tool"];

/// Install even for an empty catalog. A server connecting on a later turn must
/// change only search results, never the two advertised definitions.
pub fn install(registry: &ToolRegistry, tools: Vec<Arc<dyn ToolExecutor>>) {
    let catalog = Arc::new(ToolCatalog::new(tools));
    registry.register(Arc::new(ToolSearchExecutor {
        catalog: catalog.clone(),
    }));
    registry.register(Arc::new(CallToolExecutor::new(catalog)));
}

struct ToolSearchExecutor {
    catalog: Arc<ToolCatalog>,
}

#[async_trait]
impl ToolExecutor for ToolSearchExecutor {
    fn name(&self) -> &str {
        "tool_search"
    }
    fn concurrency_safe(&self) -> bool {
        true
    }
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: self.name().into(),
            description: "Find optional tools for browser interaction, connected MCP apps, and team coordination. Search by task keywords or use `select:name_one,name_two` for exact names. Returns matching tools' descriptions and complete argument schemas. Invoke a discovered tool through `call_tool` with its name and arguments; it is not added to your direct tool list. Search again if you need a different tool or its schema is no longer in context. Core file, search, shell, and task tools are directly available.".into(),
            input_schema: json!({"type": "object", "properties": {
                "query": {"type": "string", "description": "Task keywords, +required_name_fragment, or select:exact_name,another_name."},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 20, "description": "Maximum matching schemas to return. Default 5. Use exact names to narrow a large result."},
                "schema_offset": {"type":"integer", "minimum":0, "description":"For a paged large schema only: use the returned next_offset with select:one_exact_tool_name."}
            }, "required": ["query"]}),
        }
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        let query = input.get("query").and_then(Value::as_str).map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 4_000)
            .ok_or_else(|| ToolError::InvalidInput("`query` must be nonempty text of at most 4000 bytes. Use task keywords or select:exact_name.".into()))?;
        let limit = match input.get("max_results") {
            None => 5,
            Some(value) => value
                .as_u64()
                .filter(|n| (1..=20).contains(n))
                .ok_or_else(|| {
                    ToolError::InvalidInput("`max_results` must be an integer from 1 to 20.".into())
                })? as usize,
        };
        let offset = input
            .get("schema_offset")
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| {
                        ToolError::InvalidInput(
                            "schema_offset must be a nonnegative integer.".into(),
                        )
                    })
            })
            .transpose()?;
        Ok(self.catalog.search(query, limit, offset)?.to_string())
    }
}
