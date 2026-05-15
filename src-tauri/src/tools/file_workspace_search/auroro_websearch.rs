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
                let mut value = serde_json::to_value(&response).map_err(|e| {
                    ToolError::Execution(format!("failed to serialize web search response: {e}"))
                })?;
                // Cap fetched page content so a single long article can't
                // single-handedly blow the model's context window. The
                // runtime applies a second hard cap on the final tool
                // string, but trimming here keeps the JSON envelope shape
                // intact (search results stay structured; only the
                // body-text payload of an `action="fetch"` gets clipped).
                trim_oversized_fetch_content(&mut value);
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

/// Maximum byte length of the `content.content` body text returned by a
/// `fetch` action. 64 KiB is roughly five chapters of normal prose —
/// well above what any model will use productively but small enough
/// that two or three concurrent fetches can't push the conversation
/// past a million tokens.
const FETCH_CONTENT_BODY_MAX: usize = 64 * 1024;

fn trim_oversized_fetch_content(value: &mut Value) {
    // Shape produced by `aurora_websearch::extract_content`:
    //   { success: true, action: "fetch", content: { title, url, content: "<body>" }, ... }
    let Some(content_outer) = value.get_mut("content") else {
        return;
    };
    let Some(content_obj) = content_outer.as_object_mut() else {
        return;
    };
    let Some(body) = content_obj.get_mut("content") else {
        return;
    };
    let Some(body_str) = body.as_str() else {
        return;
    };
    if body_str.len() <= FETCH_CONTENT_BODY_MAX {
        return;
    }
    let original_len = body_str.len();
    let mut cut = FETCH_CONTENT_BODY_MAX;
    while cut > 0 && !body_str.is_char_boundary(cut) {
        cut -= 1;
    }
    let trimmed = format!(
        "{}\n\n[truncated {} bytes — original page was {} bytes]",
        &body_str[..cut],
        original_len.saturating_sub(cut),
        original_len,
    );
    *body = Value::String(trimmed);
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
