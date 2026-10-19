//! rmcp's protocol types → the shapes the frontend and agent already use.
//!
//! Everything goes through `serde_json::Value`: the wire JSON is the stable
//! contract, while rmcp's Rust enums grow a variant every spec revision.

use serde::Serialize;
use serde_json::Value;

use super::types::{McpResourceInfo, McpServerInfo, McpToolCallResult, McpToolContent, McpToolInfo};

/// Lines kept per text item so one runaway tool can't flood the context.
const MAX_TEXT_LINES: usize = 500;

fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

pub fn tools<T: Serialize>(tools: &[T]) -> Vec<McpToolInfo> {
    tools
        .iter()
        .map(to_value)
        .map(|tool| McpToolInfo {
            name: str_field(&tool, "name").unwrap_or_else(|| "unknown".into()),
            description: str_field(&tool, "description"),
            // Passed through whole — `$defs`, `anyOf`, everything. Trimming
            // it to properties/required left dangling `$ref`s.
            input_schema: tool.get("inputSchema").cloned(),
        })
        .collect()
}

pub fn resources<T: Serialize>(resources: &[T]) -> Vec<McpResourceInfo> {
    resources
        .iter()
        .map(to_value)
        .map(|r| McpResourceInfo {
            uri: str_field(&r, "uri").unwrap_or_default(),
            name: str_field(&r, "name").unwrap_or_else(|| "unknown".into()),
            description: str_field(&r, "description"),
            mime_type: str_field(&r, "mimeType"),
        })
        .collect()
}

pub fn server_info<T: Serialize>(peer_info: &T) -> Option<McpServerInfo> {
    let info = to_value(peer_info);
    let server = info.get("serverInfo")?;
    Some(McpServerInfo {
        name: str_field(server, "name").unwrap_or_else(|| "Unknown".into()),
        version: str_field(server, "version"),
    })
}

/// Server instructions from `initialize`, if any — the text a server writes
/// for the model about how to use its tools.
pub fn instructions<T: Serialize>(peer_info: &T) -> Option<String> {
    str_field(&to_value(peer_info), "instructions").filter(|s| !s.trim().is_empty())
}

pub fn call_result<T: Serialize>(result: &T) -> McpToolCallResult {
    from_call_value(&to_value(result))
}

fn from_call_value(result: &Value) -> McpToolCallResult {
    let is_error = result.get("isError").and_then(Value::as_bool);
    let mut content: Vec<McpToolContent> = result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(content_item).collect())
        .unwrap_or_default();

    // A tool that answers only with structured output still answered.
    if content.is_empty() {
        if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
            content.push(McpToolContent {
                content_type: "text".into(),
                text: Some(structured.to_string()),
                data: None,
                mime_type: Some("application/json".into()),
            });
        }
    }

    let failed = is_error.unwrap_or(false);
    // The server's own words are the error. Without this the model only ever
    // saw "MCP tool call failed" and retried blind.
    let error = failed.then(|| {
        let text = content
            .iter()
            .filter_map(|c| c.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            "The tool reported an error without a message.".to_string()
        } else {
            text
        }
    });

    McpToolCallResult {
        success: !failed,
        content: Some(content),
        error,
        is_error,
    }
}

fn content_item(item: &Value) -> McpToolContent {
    let kind = str_field(item, "type").unwrap_or_else(|| "text".into());
    let mut text = str_field(item, "text");
    let mut mime_type = str_field(item, "mimeType");
    // Embedded resources carry their text one level down.
    if kind == "resource" {
        if let Some(resource) = item.get("resource") {
            text = text.or_else(|| str_field(resource, "text"));
            mime_type = mime_type.or_else(|| str_field(resource, "mimeType"));
        }
    }
    if kind == "resource_link" {
        let uri = str_field(item, "uri").unwrap_or_default();
        let name = str_field(item, "name").unwrap_or_default();
        text = Some(format!("Resource: {name} {uri}").trim().to_string());
    }
    McpToolContent {
        content_type: kind,
        text: text.map(cap_lines),
        data: str_field(item, "data"),
        mime_type,
    }
}

fn cap_lines(text: String) -> String {
    let mut lines = text.lines();
    let kept: Vec<&str> = lines.by_ref().take(MAX_TEXT_LINES).collect();
    if lines.next().is_none() {
        return text;
    }
    format!(
        "{}\n\n... [Output truncated to {MAX_TEXT_LINES} lines to save context]",
        kept.join("\n")
    )
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_error_text_reaches_the_caller() {
        let r = from_call_value(&json!({
            "isError": true,
            "content": [{ "type": "text", "text": "server 'prod' not in config" }]
        }));
        assert!(!r.success);
        assert_eq!(r.error.as_deref(), Some("server 'prod' not in config"));
    }

    #[test]
    fn structured_only_result_is_not_empty() {
        let r = from_call_value(&json!({ "content": [], "structuredContent": { "ok": 1 } }));
        assert!(r.success);
        assert_eq!(r.content.unwrap()[0].text.as_deref(), Some(r#"{"ok":1}"#));
    }

    #[test]
    fn schema_is_kept_whole() {
        let t = tools(&[json!({
            "name": "q",
            "inputSchema": { "type": "object", "$defs": { "A": {} }, "properties": { "a": { "$ref": "#/$defs/A" } } }
        })]);
        assert!(t[0].input_schema.as_ref().unwrap().get("$defs").is_some());
    }

    #[test]
    fn long_text_is_capped() {
        let text = (0..600).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let capped = cap_lines(text);
        assert!(capped.contains("truncated to 500 lines"));
        assert!(!capped.contains("\n599\n"));
    }
}
