//! Aurora's conversation as an Antigravity (Cloud Code) request.
//!
//! The envelope, as the IDE sends it and as the 2026-10-12 probe confirmed:
//!
//! ```json
//! { "project": "<cloud project>", "model": "gemini-3.8-flash-medium",
//!   "userAgent": "antigravity",
//!   "requestId": "agent/<conversation uuid>/<ms>/<trajectory uuid>/<step>",
//!   "request": { "sessionId": "<digits>", "contents": [...],
//!                "systemInstruction": {...}, "tools": [...],
//!                "toolConfig": {...}, "generationConfig": {...} } }
//! ```
//!
//! No `requestType`: the IDE omits it on the agent path, and 9router measured
//! that sending one buckets the request into a detail-free 429.
//!
//! ## Signatures
//!
//! A Gemini tool call carries a `thoughtSignature` that must come back with
//! the call on every later request, or the backend answers 400. Aurora keeps
//! it where it keeps every provider's opaque reasoning token: the `signature`
//! of a [`ContentBlock::Thinking`] placed just before the tool call, tagged
//! `{"provider":"antigravity",…}` like the Responses and redacted-thinking
//! encodings, so no other adapter mistakes it for its own. A tool call with no
//! signature of ours (the conversation began on another provider) gets the
//! placeholder Google documents for exactly that case.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::agent_runtime::api_client::{ApiRequest, ToolChoice};
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole};
use crate::api::provider_kernel_adapter::{
    split_aurora_images, strip_aurora_images_for_text, strip_system_boundary, AuroraImagePiece,
};

use super::schema::clean_parameters;

/// Google's documented stand-in for a tool call whose real signature is not
/// available (history from another model). Probed 2026-10-12 on Gemini 3.1
/// Pro: accepted where an absent signature is a 400.
pub const PLACEHOLDER_SIGNATURE: &str = "skip_thought_signature_validator";

/// The backend refuses anything larger, whatever the model card says.
const MAX_OUTPUT_TOKENS: u32 = 64_000;

/// Claude through Antigravity needs a thinking budget to think at all.
const DEFAULT_CLAUDE_THINKING_BUDGET: u32 = 8_192;

const PROVIDER_TAG: &str = "antigravity";

#[must_use]
pub fn encode_signature(signature: &str) -> String {
    json!({ "provider": PROVIDER_TAG, "signature": signature }).to_string()
}

/// The raw signature, when `stored` was written by [`encode_signature`].
#[must_use]
pub fn decode_signature(stored: &str) -> Option<String> {
    let value: Value = serde_json::from_str(stored).ok()?;
    if value.get("provider")?.as_str()? != PROVIDER_TAG {
        return None;
    }
    Some(value.get("signature")?.as_str()?.to_string())
}

/// Claude models are served by Anthropic behind the same envelope; they
/// accept unsigned tool calls and need an explicit thinking budget.
#[must_use]
pub fn is_claude_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("claude")
}

/// Everything about one call that is not in [`ApiRequest`].
pub struct WireContext<'a> {
    /// The model id with any provider prefix removed.
    pub model: &'a str,
    pub project_id: &'a str,
    pub supports_vision: bool,
    pub supports_thinking: bool,
    pub default_temperature: Option<f32>,
}

#[must_use]
pub fn build_request_body(request: &ApiRequest<'_>, ctx: &WireContext<'_>) -> Value {
    let (system, contents) = build_contents(request, ctx);

    let mut inner = Map::new();
    let session_seed = request.session_key.unwrap_or("aurora");
    inner.insert(
        "sessionId".into(),
        Value::String(numeric_session_id(session_seed)),
    );
    if let Some(system) = system {
        inner.insert(
            "systemInstruction".into(),
            json!({ "role": "user", "parts": [{ "text": system }] }),
        );
    }
    let step = contents.len().max(1) * 2 - 1;
    inner.insert("contents".into(), Value::Array(contents));

    let declarations: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            let mut decl = json!({
                "name": sanitize_function_name(&tool.name),
                "description": tool.description,
            });
            if let Some(parameters) = clean_parameters(&tool.input_schema) {
                decl["parameters"] = parameters;
            }
            decl
        })
        .collect();
    if !declarations.is_empty() {
        inner.insert(
            "tools".into(),
            json!([{ "functionDeclarations": declarations }]),
        );
        let mode = match request.tool_choice {
            ToolChoice::Auto => "VALIDATED",
            ToolChoice::None => "NONE",
        };
        inner.insert(
            "toolConfig".into(),
            json!({ "functionCallingConfig": { "mode": mode } }),
        );
    }
    inner.insert("generationConfig".into(), generation_config(request, ctx));

    json!({
        "project": ctx.project_id,
        "model": ctx.model,
        "userAgent": "antigravity",
        "requestId": request_id(session_seed, ctx.model, step),
        "request": Value::Object(inner),
    })
}

fn generation_config(request: &ApiRequest<'_>, ctx: &WireContext<'_>) -> Value {
    let max_output = request.max_output_tokens.clamp(1, MAX_OUTPUT_TOKENS);
    let mut config = Map::new();
    config.insert("maxOutputTokens".into(), Value::from(max_output));
    if let Some(t) = request.temperature.or(ctx.default_temperature) {
        // Two decimals: float noise like 0.7000000000000001 has been refused
        // by strict backends before (see `insert_temperature`).
        let rounded = (f64::from(t) * 100.0).round() / 100.0;
        config.insert("temperature".into(), json!(rounded));
    }
    if request.reasoning.enabled && ctx.supports_thinking {
        let mut thinking = json!({ "includeThoughts": true });
        let budget = request
            .reasoning
            .budget_tokens
            .or_else(|| is_claude_model(ctx.model).then_some(DEFAULT_CLAUDE_THINKING_BUDGET));
        if let Some(budget) = budget {
            // The budget is part of the output allowance and must leave room
            // for an answer.
            let ceiling = max_output.saturating_sub(1024).max(1024);
            thinking["thinkingBudget"] = Value::from(budget.min(ceiling));
        }
        config.insert("thinkingConfig".into(), thinking);
    }
    Value::Object(config)
}

/// The system prompt and the `contents` list.
fn build_contents(request: &ApiRequest<'_>, ctx: &WireContext<'_>) -> (Option<String>, Vec<Value>) {
    let mut system: Vec<String> = Vec::new();
    if let Some(prompt) = request.system_prompt.filter(|p| !p.is_empty()) {
        system.push(strip_system_boundary(prompt).into_owned());
    }

    // A tool result names its function; Aurora's result block only knows the
    // call id, so look the name up from the calls.
    let mut call_names: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for message in request.messages {
        for block in &message.blocks {
            if let ContentBlock::ToolUse { id, name, .. } = block {
                call_names.insert(id.as_str(), name.as_str());
            }
        }
    }

    let claude = is_claude_model(ctx.model);
    let mut contents: Vec<(&'static str, Vec<Value>)> = Vec::new();
    for message in request.messages {
        match message.role {
            MessageRole::System => {
                for block in &message.blocks {
                    if let ContentBlock::Text { text } = block {
                        if !text.is_empty() {
                            system.push(text.clone());
                        }
                    }
                }
            }
            MessageRole::Assistant => {
                push_content(&mut contents, "model", model_parts(message, claude));
            }
            MessageRole::User | MessageRole::Tool => {
                push_content(
                    &mut contents,
                    "user",
                    user_parts(message, &call_names, ctx.supports_vision),
                );
            }
        }
    }

    // The conversation must open and close on the user's side.
    if contents.first().is_some_and(|(role, _)| *role == "model") {
        contents.insert(0, ("user", vec![json!({ "text": "Continue." })]));
    }
    if contents.last().is_some_and(|(role, _)| *role == "model") {
        contents.push(("user", vec![json!({ "text": "Continue." })]));
    }

    let system = (!system.is_empty()).then(|| system.join("\n\n"));
    let contents = contents
        .into_iter()
        .map(|(role, parts)| json!({ "role": role, "parts": parts }))
        .collect();
    (system, contents)
}

/// Same-role neighbours merge: Gemini expects turns to alternate, and Aurora
/// stores a tool result and a queued user note as separate messages.
fn push_content(
    contents: &mut Vec<(&'static str, Vec<Value>)>,
    role: &'static str,
    parts: Vec<Value>,
) {
    if parts.is_empty() {
        return;
    }
    match contents.last_mut() {
        Some((last, existing)) if *last == role => existing.extend(parts),
        _ => contents.push((role, parts)),
    }
}

fn model_parts(message: &ConversationMessage, claude: bool) -> Vec<Value> {
    let mut parts = Vec::new();
    let mut pending_signature: Option<String> = None;
    let mut first_call = true;
    for block in &message.blocks {
        match block {
            // Thought text is not replayed: the backend does not need it and
            // it would be billed again. Only our signature travels.
            ContentBlock::Thinking { signature, .. } => {
                if let Some(sig) = signature.as_deref().and_then(decode_signature) {
                    pending_signature = Some(sig);
                }
            }
            ContentBlock::Text { text } => {
                if !text.is_empty() {
                    parts.push(json!({ "text": strip_aurora_images_for_text(text) }));
                }
            }
            ContentBlock::ToolUse { id, name, input } => {
                let args = if input.is_object() {
                    input.clone()
                } else {
                    json!({})
                };
                let mut part = json!({
                    "functionCall": { "id": id, "name": sanitize_function_name(name), "args": args }
                });
                // In a parallel batch only the first call is signed.
                let signature = pending_signature
                    .take()
                    .or_else(|| (first_call && !claude).then(|| PLACEHOLDER_SIGNATURE.to_string()));
                if let Some(sig) = signature {
                    part["thoughtSignature"] = Value::String(sig);
                }
                first_call = false;
                parts.push(part);
            }
            ContentBlock::ProcessEvent { detail, .. }
            | ContentBlock::AgentReport { detail, .. }
            | ContentBlock::AgentActivity { detail, .. } => {
                parts.push(json!({ "text": detail }));
            }
            ContentBlock::Image { .. } => {
                if let Some(line) = block.image_as_text() {
                    parts.push(json!({ "text": line }));
                }
            }
            ContentBlock::ToolResult { .. }
            | ContentBlock::Compaction { .. }
            | ContentBlock::Notice { .. } => {}
        }
    }
    parts
}

fn user_parts(
    message: &ConversationMessage,
    call_names: &std::collections::HashMap<&str, &str>,
    supports_vision: bool,
) -> Vec<Value> {
    let mut parts = Vec::new();
    // Pictures a tool returned ride after the function responses, in the
    // same user turn: a `functionResponse` carries JSON only.
    let mut trailing_images = Vec::new();
    for block in &message.blocks {
        match block {
            ContentBlock::Text { text } => parts.extend(text_parts(text, supports_vision)),
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let mut text = String::new();
                for piece in split_aurora_images(content) {
                    match piece {
                        AuroraImagePiece::Text(t) => {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&t);
                        }
                        AuroraImagePiece::Image { media_type, base64 } if supports_vision => {
                            trailing_images.push(inline_data(&media_type, &base64));
                        }
                        AuroraImagePiece::Image { media_type, .. } => {
                            text.push_str(&format!(
                                "\n[Image omitted: {media_type} — the selected model does not accept images]"
                            ));
                        }
                    }
                }
                let key = if *is_error == Some(true) {
                    "error"
                } else {
                    "result"
                };
                let name = call_names
                    .get(tool_use_id.as_str())
                    .copied()
                    .unwrap_or("tool");
                parts.push(json!({
                    "functionResponse": {
                        "id": tool_use_id,
                        "name": sanitize_function_name(name),
                        "response": { key: text },
                    }
                }));
            }
            ContentBlock::ProcessEvent { detail, .. }
            | ContentBlock::AgentReport { detail, .. }
            | ContentBlock::AgentActivity { detail, .. } => {
                parts.push(json!({ "text": detail }));
            }
            ContentBlock::Image { .. } => {
                if let Some(line) = block.image_as_text() {
                    parts.push(json!({ "text": line }));
                }
            }
            ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::Compaction { .. }
            | ContentBlock::Notice { .. } => {}
        }
    }
    parts.extend(trailing_images);
    parts
}

fn text_parts(text: &str, supports_vision: bool) -> Vec<Value> {
    if text.is_empty() {
        return Vec::new();
    }
    if !supports_vision {
        return vec![json!({ "text": strip_aurora_images_for_text(text) })];
    }
    split_aurora_images(text)
        .into_iter()
        .filter_map(|piece| match piece {
            AuroraImagePiece::Text(t) if t.trim().is_empty() => None,
            AuroraImagePiece::Text(t) => Some(json!({ "text": t })),
            AuroraImagePiece::Image { media_type, base64 } => {
                Some(inline_data(&media_type, &base64))
            }
        })
        .collect()
}

fn inline_data(media_type: &str, base64: &str) -> Value {
    json!({ "inlineData": { "mimeType": media_type, "data": base64 } })
}

/// Gemini function names: `[A-Za-z_][A-Za-z0-9_.:-]{0,63}`. Aurora's own
/// names already fit; an MCP server's might not.
#[must_use]
pub fn sanitize_function_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if !out.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        out.insert(0, '_');
    }
    out.chars().take(64).collect()
}

fn digest(seed: &str) -> [u8; 32] {
    Sha256::digest(seed.as_bytes()).into()
}

/// A stable UUID-shaped id from a seed, so one conversation keeps one id.
fn uuid_from_seed(seed: &str) -> String {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest(seed)[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// The IDE's `sessionId` is a decimal number; a conversation keeps one so the
/// backend can keep its cache warm across the turn.
fn numeric_session_id(seed: &str) -> String {
    let d = digest(&format!("antigravity:session:{seed}"));
    let mut n = [0u8; 8];
    n.copy_from_slice(&d[..8]);
    (u64::from_be_bytes(n) >> 1).to_string()
}

/// `agent/<conversation>/<ms>/<trajectory>/<step>`, the IDE's request id.
fn request_id(seed: &str, model: &str, step: usize) -> String {
    let conversation = uuid_from_seed(&format!("antigravity:conversation:{seed}"));
    let trajectory = uuid_from_seed(&format!("antigravity:trajectory:{seed}:{model}"));
    let now = chrono::Utc::now().timestamp_millis();
    format!("agent/{conversation}/{now}/{trajectory}/{step}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::api_client::{ReasoningRequest, ToolSchema};

    fn msg(role: MessageRole, blocks: Vec<ContentBlock>) -> ConversationMessage {
        ConversationMessage {
            role,
            blocks,
            ..ConversationMessage::user_text("", 0)
        }
    }

    fn text(t: &str) -> ContentBlock {
        ContentBlock::Text { text: t.into() }
    }

    fn ctx(model: &str) -> WireContext<'_> {
        WireContext {
            model,
            project_id: "proj-1",
            supports_vision: true,
            supports_thinking: true,
            default_temperature: None,
        }
    }

    fn request<'a>(messages: &'a [ConversationMessage], tools: &'a [ToolSchema]) -> ApiRequest<'a> {
        ApiRequest {
            model: "antigravity:gemini-3.8-flash-medium",
            system_prompt: Some("You are Aurora."),
            messages,
            tools,
            tool_choice: ToolChoice::Auto,
            temperature: None,
            max_output_tokens: 200_000,
            reasoning: ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: Some("thread-1"),
        }
    }

    fn tool_loop(signature: Option<String>) -> Vec<ConversationMessage> {
        let mut assistant = Vec::new();
        if let Some(sig) = signature {
            assistant.push(ContentBlock::Thinking {
                text: String::new(),
                signature: Some(sig),
                duration_ms: None,
            });
        }
        assistant.push(ContentBlock::ToolUse {
            id: "call_1".into(),
            name: "file_read".into(),
            input: json!({ "path": "README.md" }),
        });
        assistant.push(ContentBlock::ToolUse {
            id: "call_2".into(),
            name: "glob".into(),
            input: json!({ "pattern": "*.rs" }),
        });
        vec![
            msg(MessageRole::User, vec![text("read it")]),
            msg(MessageRole::Assistant, assistant),
            msg(
                MessageRole::Tool,
                vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "call_1".into(),
                        content: "Aurora".into(),
                        is_error: None,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "call_2".into(),
                        content: "denied".into(),
                        is_error: Some(true),
                    },
                ],
            ),
        ]
    }

    #[test]
    fn envelope_has_the_ides_shape_and_no_request_type() {
        let messages = vec![msg(MessageRole::User, vec![text("hi")])];
        let body = build_request_body(&request(&messages, &[]), &ctx("gemini-3.8-flash-medium"));
        assert_eq!(body["project"], "proj-1");
        assert_eq!(body["model"], "gemini-3.8-flash-medium");
        assert_eq!(body["userAgent"], "antigravity");
        assert!(body.get("requestType").is_none());
        let id = body["requestId"].as_str().unwrap();
        assert!(
            id.starts_with("agent/") && id.split('/').count() == 5,
            "{id}"
        );
        let session = body["request"]["sessionId"].as_str().unwrap();
        assert!(session.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(
            body["request"]["systemInstruction"]["parts"][0]["text"],
            "You are Aurora."
        );
        assert_eq!(
            body["request"]["contents"],
            json!([{ "role": "user", "parts": [{ "text": "hi" }] }])
        );
        assert_eq!(
            body["request"]["generationConfig"]["maxOutputTokens"],
            64_000
        );
    }

    #[test]
    fn one_conversation_keeps_one_session_and_conversation_id() {
        let messages = vec![msg(MessageRole::User, vec![text("hi")])];
        let a = build_request_body(&request(&messages, &[]), &ctx("m"));
        let b = build_request_body(&request(&messages, &[]), &ctx("m"));
        assert_eq!(a["request"]["sessionId"], b["request"]["sessionId"]);
        let conv = |v: &Value| {
            v["requestId"]
                .as_str()
                .unwrap()
                .split('/')
                .nth(1)
                .unwrap()
                .to_string()
        };
        assert_eq!(conv(&a), conv(&b));
    }

    #[test]
    fn our_signature_goes_back_on_the_first_call_only() {
        let messages = tool_loop(Some(encode_signature("SIG-1")));
        let body = build_request_body(&request(&messages, &[]), &ctx("gemini-3.8-flash-medium"));
        let model = &body["request"]["contents"][1];
        assert_eq!(model["role"], "model");
        assert_eq!(model["parts"][0]["thoughtSignature"], "SIG-1");
        assert_eq!(model["parts"][0]["functionCall"]["name"], "file_read");
        assert!(model["parts"][1].get("thoughtSignature").is_none());
        assert_eq!(
            model["parts"].as_array().unwrap().len(),
            2,
            "thought text is not replayed"
        );
    }

    #[test]
    fn a_call_without_our_signature_gets_googles_placeholder_on_gemini_only() {
        // An Anthropic signature is not ours and must not be sent.
        let messages = tool_loop(Some("EqQBCkgIBRABGAI=".into()));
        let gemini = build_request_body(&request(&messages, &[]), &ctx("gemini-3.1-pro-low"));
        assert_eq!(
            gemini["request"]["contents"][1]["parts"][0]["thoughtSignature"],
            PLACEHOLDER_SIGNATURE
        );
        let claude = build_request_body(&request(&messages, &[]), &ctx("claude-sonnet-4-6"));
        assert!(claude["request"]["contents"][1]["parts"][0]
            .get("thoughtSignature")
            .is_none());
    }

    #[test]
    fn tool_results_answer_by_name_and_mark_errors() {
        let messages = tool_loop(None);
        let body = build_request_body(&request(&messages, &[]), &ctx("gemini-3.8-flash-medium"));
        let results = &body["request"]["contents"][2];
        assert_eq!(results["role"], "user");
        assert_eq!(
            results["parts"][0],
            json!({ "functionResponse": { "id": "call_1", "name": "file_read", "response": { "result": "Aurora" } } })
        );
        assert_eq!(results["parts"][1]["functionResponse"]["name"], "glob");
        assert_eq!(
            results["parts"][1]["functionResponse"]["response"],
            json!({ "error": "denied" })
        );
    }

    #[test]
    fn a_tool_result_and_a_queued_note_share_one_user_turn() {
        let mut messages = tool_loop(None);
        messages.push(msg(MessageRole::User, vec![text("also check docs")]));
        let body = build_request_body(&request(&messages, &[]), &ctx("gemini-3.8-flash-medium"));
        let contents = body["request"]["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[2]["parts"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn a_conversation_ending_on_the_model_gets_a_user_turn() {
        let messages = vec![
            msg(MessageRole::User, vec![text("hi")]),
            msg(MessageRole::Assistant, vec![text("partial")]),
        ];
        let body = build_request_body(&request(&messages, &[]), &ctx("m"));
        let contents = body["request"]["contents"].as_array().unwrap();
        assert_eq!(contents.last().unwrap()["role"], "user");
    }

    #[test]
    fn tools_are_one_declaration_group_with_validated_calling() {
        let tools = vec![
            ToolSchema {
                name: "file_read".into(),
                description: "Read".into(),
                input_schema: json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }),
            },
            ToolSchema {
                name: "TaskList".into(),
                description: "List".into(),
                input_schema: json!({ "type": "object", "properties": {} }),
            },
            ToolSchema {
                name: "mcp_my server_do it".into(),
                description: "x".into(),
                input_schema: json!({}),
            },
        ];
        let messages = vec![msg(MessageRole::User, vec![text("hi")])];
        let body = build_request_body(&request(&messages, &tools), &ctx("m"));
        let decls = body["request"]["tools"][0]["functionDeclarations"]
            .as_array()
            .unwrap();
        assert_eq!(decls.len(), 3);
        assert!(decls[0].get("parameters").is_some());
        assert!(
            decls[1].get("parameters").is_none(),
            "no-argument tool sends no schema"
        );
        assert_eq!(decls[2]["name"], "mcp_my_server_do_it");
        assert_eq!(
            body["request"]["toolConfig"]["functionCallingConfig"]["mode"],
            "VALIDATED"
        );
    }

    #[test]
    fn thinking_is_asked_for_only_when_enabled_and_claude_gets_a_budget() {
        let messages = vec![msg(MessageRole::User, vec![text("hi")])];
        let mut req = request(&messages, &[]);
        let off = build_request_body(&req, &ctx("claude-sonnet-4-6"));
        assert!(off["request"]["generationConfig"]
            .get("thinkingConfig")
            .is_none());

        req.reasoning = ReasoningRequest {
            enabled: true,
            ..ReasoningRequest::disabled()
        };
        let claude = build_request_body(&req, &ctx("claude-sonnet-4-6"));
        assert_eq!(
            claude["request"]["generationConfig"]["thinkingConfig"],
            json!({ "includeThoughts": true, "thinkingBudget": DEFAULT_CLAUDE_THINKING_BUDGET })
        );
        let gemini = build_request_body(&req, &ctx("gemini-3.1-pro-high"));
        assert_eq!(
            gemini["request"]["generationConfig"]["thinkingConfig"],
            json!({ "includeThoughts": true })
        );
    }

    #[test]
    fn signatures_roundtrip_and_reject_other_providers() {
        assert_eq!(
            decode_signature(&encode_signature("abc")).as_deref(),
            Some("abc")
        );
        assert!(decode_signature(r#"{"provider":"openai-responses","id":"x"}"#).is_none());
        assert!(decode_signature("EqQBCkgIBRABGAI=").is_none());
    }
}
