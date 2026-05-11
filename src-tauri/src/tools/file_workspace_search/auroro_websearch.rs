//! `auroro_websearch` — DuckDuckGo-backed web search + page
//! fetch. Wraps `crate::commands::aurora_websearch` and forwards
//! the response verbatim. The agent picks `action="search"` to
//! query the web or `action="fetch"` to extract clean text from
//! a URL.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::commands::{aurora_websearch, AuroraWebSearchRequest};

pub struct AuroroWebSearchTool;

#[async_trait]
impl ToolExecutor for AuroroWebSearchTool {
    fn name(&self) -> &str {
        "auroro_websearch"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "auroro_websearch".into(),
            description: "Native web search + page fetch (Aurora WebSearch SDK, DuckDuckGo). Use \
                          action='search' with a `query` to search the web; use action='fetch' \
                          with a `url` to extract clean text from a page."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["search", "fetch"] },
                    "query": { "type": "string", "description": "Required for action='search'." },
                    "url": { "type": "string", "description": "Required for action='fetch'." },
                    "numResults": { "type": "number", "default": 10 },
                    "region": { "type": "string" },
                    "safeSearch": { "type": "string", "enum": ["OFF", "MODERATE", "STRICT"] }
                },
                "required": [],
                "additionalProperties": false,
            }),
        }
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;

        let action = input.get("action").and_then(Value::as_str).map(str::to_string);
        let query = input.get("query").and_then(Value::as_str).map(str::to_string);
        let url = input.get("url").and_then(Value::as_str).map(str::to_string);
        let num_results = input
            .get("numResults")
            .or_else(|| input.get("num_results"))
            .and_then(Value::as_u64)
            .map(|n| n as u32);
        let region = input.get("region").and_then(Value::as_str).map(str::to_string);
        let safe_search = input
            .get("safeSearch")
            .or_else(|| input.get("safe_search"))
            .and_then(Value::as_str)
            .map(str::to_string);

        // Mirror the TS executor's "we need at least one of query or url"
        // contract before crossing into the underlying command.
        let resolved_action = action
            .clone()
            .unwrap_or_else(|| if url.is_some() { "fetch".into() } else { "search".into() });
        if resolved_action == "search" && query.is_none() {
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "error": "auroro_websearch: query is required for action='search'.",
            }))
            .unwrap());
        }
        if resolved_action == "fetch" && url.is_none() {
            return Ok(serde_json::to_string(&json!({
                "success": false,
                "error": "auroro_websearch: url is required for action='fetch'.",
            }))
            .unwrap());
        }

        let request = AuroraWebSearchRequest {
            action,
            query,
            url,
            num_results,
            region,
            safe_search,
        };

        match aurora_websearch(request).await {
            Ok(response) => {
                let value = serde_json::to_value(&response).map_err(|e| {
                    ToolError::Execution(format!("failed to serialize web search response: {e}"))
                })?;
                Ok(serde_json::to_string(&value).unwrap())
            }
            Err(err) => Ok(serde_json::to_string(&json!({
                "success": false,
                "error": err,
            }))
            .unwrap()),
        }
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
    async fn rejects_search_without_query() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(AuroroWebSearchTool);
        let out = tool
            .execute(serde_json::json!({ "action": "search" }), &ctx_for())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("query is required"));
    }

    #[tokio::test]
    async fn rejects_fetch_without_url() {
        let tool: Arc<dyn ToolExecutor> = Arc::new(AuroroWebSearchTool);
        let out = tool
            .execute(serde_json::json!({ "action": "fetch" }), &ctx_for())
            .await
            .expect("ok");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["success"], false);
        assert!(parsed["error"].as_str().unwrap().contains("url is required"));
    }
}
