//! `aurora_search` — semantic codebase search (deferred).
//!
//! The contract names this tool so a future-Sub can land the
//! semantic indexer without renaming the tool registry. The
//! current Aurora codebase, however, intentionally does NOT ship
//! a semantic search backend (see the comment at the top of
//! `src/tools/definitions/search-tools.ts`: *"Codebase exploration
//! is now driven exclusively by `grep` plus the file/workspace
//! tools — Aurora no longer ships a semantic indexer."*).
//!
//! Rather than fail-loud (which would make the tool registry
//! reject `aurora_search` and surface as `tool not found` to the
//! agent), this implementation returns a structured `success:
//! false` JSON payload — the same shape the TS executors use for
//! "feature unavailable in this environment" cases. That keeps
//! the tool discoverable in `tools/list`, lets the agent see a
//! coherent error, and drops in seamlessly when the semantic
//! indexer is restored: a future-Sub can replace `execute`
//! without touching the registry, the schema, or any other
//! caller.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};

pub struct AuroraSearchTool;

#[async_trait]
impl ToolExecutor for AuroraSearchTool {
    fn name(&self) -> &str {
        "aurora_search"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "aurora_search".into(),
            description: "Semantic code search across the workspace. NOTE: this Aurora build does \
                          not ship a semantic indexer; the tool returns success=false with an \
                          'unavailable' error. Use `grep` for keyword search."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language query." },
                    "limit": { "type": "number", "default": 10 },
                    "mode": { "type": "string", "enum": ["hybrid", "lexical", "semantic"], "default": "hybrid" },
                    "languages": { "type": "array", "items": { "type": "string" } },
                    "chunk_types": { "type": "array", "items": { "type": "string" } },
                    "directories": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["query"],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let query = input
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`query` must be a string".into()))?;

        Ok(serde_json::to_string(&json!({
            "success": false,
            "error": "Semantic search is not available in this Aurora build. Use the `grep` tool for keyword search across the codebase.",
            "query": query,
            "fallback": "grep",
        }))
        .unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::tool_executor::ToolContext;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    fn ctx_for() -> ToolContext {
        ToolContext {
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            session_id: "s".into(),
            workspace_root: None,
            cancel_token: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn returns_unavailable_payload() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(AuroraSearchTool);
        let out = tool
            .execute(serde_json::json!({ "query": "needle" }), &ctx_for())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert_eq!(parsed["fallback"], "grep");
        assert!(parsed["error"].as_str().unwrap().contains("not available"));
    }

    #[tokio::test]
    async fn requires_query() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(AuroraSearchTool);
        let err = tool
            .execute(serde_json::json!({}), &ctx_for())
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }
}
