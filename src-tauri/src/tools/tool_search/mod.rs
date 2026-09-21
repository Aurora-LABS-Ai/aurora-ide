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
            description: "Find optional tools for browser interaction, connected MCP apps, and team coordination. Search by task keywords or use `select:name_one,name_two` for exact names. Returns matching tools' descriptions and complete argument schemas; it does not execute tools or load a guidelines tool's content. Results can be partial: use select:exact_name for a needed name absent from the result. Invoke a discovered tool through `call_tool` with its name and arguments; it is not added to your direct tool list. For browser work, discover and execute browser_guidelines through call_tool before interacting with the panel. Search again if you need a different tool or its schema is no longer in context. Core file, search, shell, and task tools are directly available.".into(),
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
                .ok_or_else(|| ToolError::InvalidInput(bad_number("max_results", value, "1 to 20")))?
                as usize,
        };
        let offset = input
            .get("schema_offset")
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| {
                        ToolError::InvalidInput(bad_number("schema_offset", value, "0 or greater"))
                    })
            })
            .transpose()?;
        Ok(self.catalog.search(query, limit, offset)?.to_string())
    }
}

/// A refusal that names the value that arrived, not just the rule.
///
/// `max_results` of 0, 21 and 2.5 all produced the identical sentence — true
/// about the tool, silent about the call — so a model reading it had to re-read
/// the schema instead of its own arguments. Found by the harness rig,
/// 2026-09-06. A wrong type is said as a wrong type: `2.5` is not out of range,
/// it is not an integer, and those are different corrections.
fn bad_number(field: &str, got: &Value, range: &str) -> String {
    let described = match got {
        Value::Number(n) if n.is_f64() => format!("{n}, which is not a whole number"),
        Value::Number(n) => format!("{n}"),
        Value::String(s) => format!("the string \"{s}\""),
        Value::Null => "null".into(),
        Value::Bool(b) => format!("{b}"),
        Value::Array(_) => "an array".into(),
        Value::Object(_) => "an object".into(),
    };
    format!("`{field}` must be an integer {range}; you sent {described}.")
}
