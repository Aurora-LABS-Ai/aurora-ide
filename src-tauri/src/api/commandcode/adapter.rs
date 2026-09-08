//! [`CommandCodeAdapter`] — streaming against `POST /alpha/generate`.
//!
//! Nothing here delegates to the OpenAI or Anthropic builders, because the
//! wire is neither. See the module docs on [`super`] for why.

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{
    ApiError, ApiRequest, StreamingApiClient, ToolSchema, TurnUsage,
};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, MessageRole, TokenUsage};
use crate::api::client::ProviderConfigSnapshot;
use crate::api::provider_kernel_adapter::{
    map_reqwest_error, map_status_error, split_aurora_images, unprefix_model, AuroraImagePiece,
};

use super::auth;
use super::{COMMANDCODE_ENVIRONMENT, COMMANDCODE_GENERATE_URL, COMMANDCODE_STUDIO_KEYS_URL};

/// User-Agent for Command Code calls. Honest self-identification, the same
/// choice the Codex adapter makes.
const COMMANDCODE_USER_AGENT: &str = concat!("aurora-ide/", env!("CARGO_PKG_VERSION"));

pub struct CommandCodeAdapter {
    config: ProviderConfigSnapshot,
    http: reqwest::Client,
}

impl CommandCodeAdapter {
    #[must_use]
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { config, http }
    }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

fn build_headers(api_key: &str) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(COMMANDCODE_USER_AGENT));

    let bearer = format!("Bearer {api_key}");
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&bearer)
            .map_err(|e| ApiError::InvalidRequest(format!("invalid Command Code key: {e}")))?,
    );

    // Mandatory. Without it every request is 403 `upgrade_required`, whatever
    // the key. The value is floor-checked only, so `auth::cli_version` reads
    // the installed CLI's version and lets the floor track itself.
    let version = auth::cli_version();
    headers.insert(
        "x-command-code-version",
        HeaderValue::from_str(&version).map_err(|e| {
            ApiError::InvalidRequest(format!("invalid Command Code version header: {e}"))
        })?,
    );
    headers.insert(
        "x-cli-environment",
        HeaderValue::from_static(COMMANDCODE_ENVIRONMENT),
    );
    Ok(headers)
}

/// The `config` block the endpoint validates but does not forward.
///
/// All four git fields plus `workingDir`, `date`, `environment`,
/// `structure` and `recentCommits` are required: dropping any of them is a
/// 400 that names each one. They are sent empty on purpose. The endpoint
/// echoes the body it forwards upstream on its `start-step` event, and that
/// echo carries only the model, `max_tokens`, and the messages — nothing
/// from `config` reaches the model. It is context for Command Code's own
/// harness, which Aurora is not using: Aurora already injects its own repo
/// map, IDE context and checklist through its system prompt, so filling
/// this in would pay tokens twice for the half that did arrive and lie
/// about the half that did not.
fn build_config_block() -> Value {
    json!({
        "workingDir": "/",
        "date": chrono::Utc::now().format("%Y-%m-%d").to_string(),
        "environment": format!("{}-{}, Aurora", std::env::consts::OS, std::env::consts::ARCH),
        "structure": [],
        "isGitRepo": false,
        "currentBranch": "",
        "mainBranch": "",
        "gitStatus": "",
        "recentCommits": [],
    })
}

fn build_body(request: &ApiRequest<'_>, config: &ProviderConfigSnapshot) -> Value {
    let model = unprefix_model(request.model, &config.provider_id);
    let messages = build_messages(request.messages, config.supports_vision);

    let mut params = Map::new();
    params.insert("model".into(), json!(model));
    params.insert("messages".into(), json!(messages));
    params.insert("tools".into(), json!(build_tools(request.tools)));
    if let Some(system) = request.system_prompt.filter(|s| !s.is_empty()) {
        params.insert("system".into(), json!(system));
    }
    params.insert("max_tokens".into(), json!(request.max_output_tokens));
    // The endpoint answers only in streaming form. A non-streaming request
    // is not a supported mode to fall back to.
    params.insert("stream".into(), json!(true));

    json!({
        "config": build_config_block(),
        // Command Code's own personalization inputs. Aurora carries its own
        // memory and instructions in the system prompt, so these stay empty
        // rather than duplicating them into a second channel.
        "memory": "",
        "taste": "",
        "skills": Value::Null,
        "permissionMode": "standard",
        "params": Value::Object(params),
    })
}

fn build_tools(tools: &[ToolSchema]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            // A no-argument tool still needs a schema here; an empty object
            // is rejected upstream, and one bad tool fails the whole request.
            let schema = if tool.input_schema.is_null() {
                json!({ "type": "object", "properties": {} })
            } else {
                tool.input_schema.clone()
            };
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "input_schema": schema,
            })
        })
        .collect()
}

/// Map Aurora's conversation into the endpoint's message list.
///
/// Two shape differences drive most of this:
///
/// - Tool results travel in their own `role: "tool"` message and must name
///   the tool, not just its call id. Aurora's [`ContentBlock::ToolResult`]
///   carries only the id, so the tool name is recovered from the
///   `tool-call` that produced it earlier in the conversation. A result
///   whose call cannot be found is sent as plain user text rather than
///   dropped, because a missing result reads to the model as a tool that
///   silently did nothing.
/// - A message can mix tool results with ordinary content. Those are split
///   into separate wire messages, since one message cannot be both roles.
fn build_messages(messages: &[ConversationMessage], supports_vision: bool) -> Vec<Value> {
    let tool_names = collect_tool_names(messages);
    let mut out = Vec::with_capacity(messages.len());

    for message in messages {
        // System messages never reach the provider. The system prompt rides
        // on `params.system`, and the only other System messages Aurora
        // stores are compaction markers and notices, which are transcript
        // bookkeeping.
        if message.role == MessageRole::System {
            continue;
        }

        let mut tool_parts = Vec::new();
        let mut content_parts = Vec::new();

        for block in &message.blocks {
            match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => match tool_names.get(tool_use_id) {
                    Some(name) => tool_parts.push(json!({
                        "type": "tool-result",
                        "toolCallId": tool_use_id,
                        "toolName": name,
                        "output": { "type": "text", "value": content },
                    })),
                    None => content_parts.push(json!({
                        "type": "text",
                        "text": format!("[tool result {tool_use_id}]\n{content}"),
                    })),
                },
                ContentBlock::Text { text } => {
                    if !text.is_empty() {
                        content_parts.extend(text_parts(text, supports_vision));
                    }
                }
                ContentBlock::Thinking { text, .. } => {
                    // Replayed as plain reasoning text. There is no signature
                    // to echo and nothing encrypted to carry, so a reloaded
                    // thread costs exactly the reasoning it shows.
                    if !text.is_empty() {
                        content_parts.push(json!({ "type": "reasoning", "text": text }));
                    }
                }
                ContentBlock::ToolUse { id, name, input } => {
                    content_parts.push(json!({
                        "type": "tool-call",
                        "toolCallId": id,
                        "toolName": name,
                        "input": input,
                    }));
                }
                // A directly made picture is described in one line; the
                // pixels never ride in an assistant turn.
                ContentBlock::Image { .. } => {
                    if let Some(line) = block.image_as_text() {
                        content_parts.push(json!({ "type": "text", "text": line }));
                    }
                }
                // Compaction markers and notices are Aurora's own transcript
                // furniture and are never sent.
                ContentBlock::Compaction { .. } | ContentBlock::Notice { .. } => {}
                // A background process ending is not furniture — the agent
                // started it and has to be told it is over.
                ContentBlock::ProcessEvent { detail, .. } => {
                    content_parts.push(json!({ "type": "text", "text": detail }));
                }
            }
        }

        if !tool_parts.is_empty() {
            out.push(json!({ "role": "tool", "content": tool_parts }));
        }
        if !content_parts.is_empty() {
            let role = match message.role {
                MessageRole::Assistant => "assistant",
                _ => "user",
            };
            out.push(json!({ "role": role, "content": content_parts }));
        }
    }

    out
}

/// Tool call id to tool name, taken from every `tool-call` in history.
fn collect_tool_names(
    messages: &[ConversationMessage],
) -> std::collections::HashMap<String, String> {
    let mut names = std::collections::HashMap::new();
    for message in messages {
        for block in &message.blocks {
            if let ContentBlock::ToolUse { id, name, .. } = block {
                names.insert(id.clone(), name.clone());
            }
        }
    }
    names
}

/// Split text on `<aurora_image>` markers so screenshots and pasted images
/// ride as real image parts. The `source` shape is Anthropic's, which is
/// what this endpoint expects too.
fn text_parts(text: &str, supports_vision: bool) -> Vec<Value> {
    if !supports_vision {
        return vec![json!({ "type": "text", "text": text })];
    }
    split_aurora_images(text)
        .into_iter()
        .filter_map(|piece| match piece {
            AuroraImagePiece::Text(text) if text.trim().is_empty() => None,
            AuroraImagePiece::Text(text) => Some(json!({ "type": "text", "text": text })),
            AuroraImagePiece::Image { media_type, base64 } => Some(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": base64,
                },
            })),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/// Aurora's stop reason for one of the endpoint's finish reasons.
fn map_stop_reason(finish: &str) -> &'static str {
    match finish {
        "tool-calls" | "tool_calls" => "tool_use",
        "length" | "max-tokens" | "max_tokens" => "max_tokens",
        "content-filter" | "content_filter" => "content_filter",
        "error" => "error",
        _ => "end_turn",
    }
}

fn usage_from(value: &Value) -> Option<TokenUsage> {
    let input = value.get("inputTokens")?.as_u64()? as u32;
    let output = value
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let details = value.get("inputTokenDetails");
    let cache_read = details
        .and_then(|d| d.get("cacheReadTokens"))
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    let cache_write = details
        .and_then(|d| d.get("cacheWriteTokens"))
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    Some(TokenUsage {
        // `inputTokens` matches the upstream's own `raw.prompt_tokens`, which
        // is the OpenAI convention: cached tokens are counted in the total and
        // broken out separately, not excluded from it.
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cache_write,
        cache_read_input_tokens: cache_read,
        estimated: None,
        cost_usd: None,
    })
}

/// Who actually served the request, from `providerMetadata`.
///
/// The gateway resells other people's capacity and says so on every
/// response. Worth logging: a model whose route does not match its name is
/// how a relabelled catalog gives itself away.
fn served_by(value: &Value) -> Option<String> {
    value
        .get("providerMetadata")?
        .as_object()?
        .keys()
        .next()
        .cloned()
}

/// Accumulates the assistant message while events stream past.
#[derive(Default)]
struct StreamState {
    blocks: Vec<ContentBlock>,
    text: String,
    reasoning: String,
    /// Partial tool arguments keyed by call id, for the live tool card.
    tool_inputs: std::collections::HashMap<String, (String, String)>,
    usage: Option<TokenUsage>,
    stop_reason: Option<String>,
    served_by: Option<String>,
}

impl StreamState {
    /// Close any open text block. Called before a tool call or reasoning
    /// block starts so blocks land in the order the model emitted them.
    fn flush_text(&mut self) {
        if !self.text.is_empty() {
            self.blocks.push(ContentBlock::Text {
                text: std::mem::take(&mut self.text),
            });
        }
    }

    fn flush_reasoning(&mut self) {
        if !self.reasoning.is_empty() {
            self.blocks.push(ContentBlock::Thinking {
                text: std::mem::take(&mut self.reasoning),
                signature: None,
                duration_ms: None,
            });
        }
    }

    fn finish(mut self) -> (Vec<ContentBlock>, TokenUsage, String) {
        self.flush_reasoning();
        self.flush_text();
        let usage = self.usage.unwrap_or(TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            // Nothing was reported, so nothing may be presented as exact.
            estimated: Some(true),
            cost_usd: None,
        });
        let stop = self.stop_reason.unwrap_or_else(|| "end_turn".to_string());
        (self.blocks, usage, stop)
    }
}

/// Handle one decoded event. Returns `Err` when the stream reported a
/// provider error.
async fn handle_event(
    event: &Value,
    state: &mut StreamState,
    sink: &mpsc::Sender<AssistantEvent>,
) -> Result<(), ApiError> {
    let Some(kind) = event.get("type").and_then(Value::as_str) else {
        return Ok(());
    };
    let text_of = |key: &str| {
        event
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    match kind {
        "text-delta" => {
            let delta = text_of("text");
            if !delta.is_empty() {
                state.flush_reasoning();
                state.text.push_str(&delta);
                let _ = sink.send(AssistantEvent::TextDelta { delta }).await;
            }
        }
        "reasoning-delta" => {
            let delta = text_of("text");
            if !delta.is_empty() {
                state.reasoning.push_str(&delta);
                let _ = sink
                    .send(AssistantEvent::Thinking {
                        text: delta,
                        signature: None,
                    })
                    .await;
            }
        }
        "tool-input-start" => {
            state.flush_reasoning();
            state.flush_text();
            let id = text_of("id");
            let name = text_of("toolName");
            if !id.is_empty() {
                state
                    .tool_inputs
                    .insert(id.clone(), (name.clone(), String::new()));
                // Fired immediately so the tool card appears while the
                // arguments are still arriving.
                let _ = sink
                    .send(AssistantEvent::ToolUseDelta {
                        id,
                        name,
                        arguments: String::new(),
                    })
                    .await;
            }
        }
        "tool-input-delta" => {
            let id = text_of("id");
            let delta = text_of("delta");
            if let Some((name, buffer)) = state.tool_inputs.get_mut(&id) {
                buffer.push_str(&delta);
                let _ = sink
                    .send(AssistantEvent::ToolUseDelta {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: buffer.clone(),
                    })
                    .await;
            }
        }
        "tool-call" => {
            state.flush_reasoning();
            state.flush_text();
            let id = text_of("toolCallId");
            let name = text_of("toolName");
            // Already a parsed object here, unlike every OpenAI-shaped wire
            // where the arguments arrive as a string to reassemble. The
            // accumulated `tool-input-delta` buffer is only ever a preview.
            let input = event.get("input").cloned().unwrap_or_else(|| json!({}));
            if !id.is_empty() {
                state.tool_inputs.remove(&id);
                state.blocks.push(ContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
                let _ = sink.send(AssistantEvent::ToolUse { id, name, input }).await;
            }
        }
        "finish-step" | "finish" => {
            if let Some(usage) = event
                .get("totalUsage")
                .or_else(|| event.get("usage"))
                .and_then(usage_from)
            {
                let _ = sink.send(AssistantEvent::Usage(usage.clone())).await;
                state.usage = Some(usage);
            }
            if let Some(finish) = event.get("finishReason").and_then(Value::as_str) {
                state.stop_reason = Some(map_stop_reason(finish).to_string());
            }
            if state.served_by.is_none() {
                state.served_by = served_by(event);
            }
        }
        "provider-metadata" => {
            if state.served_by.is_none() {
                state.served_by = served_by(event);
            }
        }
        "error" | "tool-error" => {
            let detail = event
                .get("error")
                .map(|value| match value.as_str() {
                    Some(text) => text.to_string(),
                    None => value.to_string(),
                })
                .unwrap_or_else(|| "the provider reported an error mid-stream".to_string());
            return Err(ApiError::Provider(detail));
        }
        _ => {}
    }
    Ok(())
}

/// Turn a 403 into something that says what to do about it.
///
/// The endpoint uses one status for two unrelated situations, and the
/// generic "permission denied" rendering is wrong for both.
fn map_forbidden(body: &str) -> ApiError {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = parsed
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = parsed
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or(body);

    if code == "upgrade_required" {
        return ApiError::Provider(format!(
            "Command Code raised the minimum CLI version it accepts. Run \
             `npm i -g command-code@latest` and Aurora will pick the new version up. ({message})"
        ));
    }
    if message.contains("MODEL_NOT_IN_PLAN") {
        return ApiError::Provider(format!(
            "{message} Pick a model your plan covers, or upgrade at {COMMANDCODE_STUDIO_KEYS_URL}."
        ));
    }
    ApiError::Provider(message.to_string())
}

#[async_trait::async_trait]
impl StreamingApiClient for CommandCodeAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let (api_key, source) =
            auth::resolve_api_key(&self.config.api_key).map_err(ApiError::Provider)?;
        let headers = build_headers(&api_key)?;
        let body = build_body(&request, &self.config);

        let response = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
            result = self
                .http
                .post(COMMANDCODE_GENERATE_URL)
                .headers(headers)
                .json(&body)
                .send() => match result {
                Ok(response) => response,
                Err(err) => return Err(map_reqwest_error(err)),
            }
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            if status.as_u16() == 403 {
                return Err(map_forbidden(&body));
            }
            if status.as_u16() == 401 {
                return Err(ApiError::Provider(match source {
                    auth::KeySource::Cli => format!(
                        "Command Code rejected the key in ~/.commandcode/auth.json. Run \
                         `cmd login` again, or paste a fresh key from \
                         {COMMANDCODE_STUDIO_KEYS_URL}. ({body})"
                    ),
                    _ => format!(
                        "Command Code rejected this provider's API key. Create a new one at \
                         {COMMANDCODE_STUDIO_KEYS_URL}. ({body})"
                    ),
                }));
            }
            return Err(map_status_error(status.as_u16(), body));
        }

        let mut stream = response.bytes_stream();
        let mut state = StreamState::default();
        let mut pending = String::new();

        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => return Err(ApiError::Cancelled),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk.map_err(map_reqwest_error)?;
            pending.push_str(&String::from_utf8_lossy(&chunk));

            // Newline-delimited JSON, one event per line. Not SSE: there is
            // no `data:` prefix, no blank-line frame boundary and no
            // `[DONE]`, so the shared frame buffer cannot read this.
            while let Some(newline) = pending.find('\n') {
                let line: String = pending.drain(..=newline).collect();
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(event) => handle_event(&event, &mut state, &event_sink).await?,
                    // A malformed line is not worth ending a turn over, but
                    // it must not pass silently either.
                    Err(err) => crate::logging::log_warn(
                        "commandcode.stream",
                        &format!("skipped an unreadable event ({err})"),
                    ),
                }
            }
        }

        // The stream can end without a trailing newline.
        let tail = pending.trim();
        if !tail.is_empty() {
            if let Ok(event) = serde_json::from_str::<Value>(tail) {
                handle_event(&event, &mut state, &event_sink).await?;
            }
        }

        if let Some(route) = state.served_by.clone() {
            let model = unprefix_model(request.model, &self.config.provider_id);
            crate::logging::log_info(
                "commandcode.route",
                &format!("{model} was served by {route}"),
            );
        }

        let (blocks, usage, stop_reason) = state.finish();
        let _ = event_sink
            .send(AssistantEvent::MessageStop {
                stop_reason: stop_reason.clone(),
            })
            .await;

        Ok(TurnUsage {
            usage: usage.clone(),
            stop_reason,
            assistant_message: ConversationMessage {
                role: MessageRole::Assistant,
                blocks,
                usage: Some(usage),
                timestamp: chrono::Utc::now().timestamp_millis(),
                attached_selected_elements: None,
                attached_prompt_chips: None,
                aurora_context: None,
                model: Some(format!(
                    "{}:{}",
                    self.config.provider_id,
                    unprefix_model(request.model, &self.config.provider_id)
                )),
            },
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ProviderConfigSnapshot {
        ProviderConfigSnapshot {
            provider_id: "commandcode".into(),
            provider_type: Some(super::super::COMMANDCODE_PROVIDER_TYPE.into()),
            base_url: "https://api.commandcode.ai".into(),
            api_key: "user_test".into(),
            api_keys: None,
            model: "zai-org/GLM-5.2".into(),
            custom_headers: None,
            custom_params: None,
            default_temperature: None,
            default_max_tokens: None,
            supports_thinking: true,
            reasoning: None,
            supports_vision: false,
        }
    }

    fn request<'a>(
        messages: &'a [ConversationMessage],
        tools: &'a [ToolSchema],
    ) -> ApiRequest<'a> {
        ApiRequest {
            model: "commandcode:zai-org/GLM-5.2",
            system_prompt: Some("You are Aurora."),
            messages,
            tools,
            tool_choice: Default::default(),
            temperature: Some(0.7),
            max_output_tokens: 4096,
            reasoning: crate::agent_runtime::api_client::ReasoningRequest::disabled(),
            tool_bridge: None,
            session_key: None,        }
    }

    fn message(role: MessageRole, blocks: Vec<ContentBlock>) -> ConversationMessage {
        ConversationMessage {
            role,
            blocks,
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            aurora_context: None,
            model: None,
        }
    }

    #[test]
    fn body_carries_every_config_field_the_endpoint_demands() {
        // Omitting any of these is a 400 that names it, so the test names
        // them too rather than asserting the object is merely present.
        let body = build_body(&request(&[], &[]), &config());
        for field in [
            "workingDir",
            "date",
            "environment",
            "structure",
            "isGitRepo",
            "currentBranch",
            "mainBranch",
            "gitStatus",
            "recentCommits",
        ] {
            assert!(
                body["config"].get(field).is_some(),
                "config.{field} is required by the endpoint"
            );
        }
        assert_eq!(body["permissionMode"], "standard");
    }

    #[test]
    fn model_prefix_is_stripped_and_params_are_nested() {
        let body = build_body(&request(&[], &[]), &config());
        assert_eq!(body["params"]["model"], "zai-org/GLM-5.2");
        assert_eq!(body["params"]["system"], "You are Aurora.");
        assert_eq!(body["params"]["max_tokens"], 4096);
        assert_eq!(body["params"]["stream"], true);
    }

    #[test]
    fn tool_results_become_a_tool_role_message_naming_the_tool() {
        let messages = vec![
            message(
                MessageRole::Assistant,
                vec![ContentBlock::ToolUse {
                    id: "call_1".into(),
                    name: "get_weather".into(),
                    input: json!({ "city": "Lagos" }),
                }],
            ),
            message(
                MessageRole::Tool,
                vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "28C".into(),
                    is_error: None,
                }],
            ),
        ];
        let wire = build_messages(&messages, false);
        assert_eq!(wire[0]["role"], "assistant");
        assert_eq!(wire[0]["content"][0]["type"], "tool-call");
        assert_eq!(wire[0]["content"][0]["toolCallId"], "call_1");
        assert_eq!(wire[1]["role"], "tool");
        assert_eq!(wire[1]["content"][0]["type"], "tool-result");
        // The name is recovered from the call, not carried on the result.
        assert_eq!(wire[1]["content"][0]["toolName"], "get_weather");
        assert_eq!(wire[1]["content"][0]["output"]["value"], "28C");
    }

    #[test]
    fn an_orphan_tool_result_survives_as_text() {
        // Better than dropping it: a vanished result reads to the model as
        // a tool that ran and returned nothing.
        let messages = vec![message(
            MessageRole::Tool,
            vec![ContentBlock::ToolResult {
                tool_use_id: "call_missing".into(),
                content: "28C".into(),
                is_error: None,
            }],
        )];
        let wire = build_messages(&messages, false);
        assert_eq!(wire.len(), 1);
        assert_eq!(wire[0]["role"], "user");
        assert!(wire[0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("28C"));
    }

    #[test]
    fn system_messages_and_transcript_furniture_never_ship() {
        let messages = vec![message(
            MessageRole::System,
            vec![ContentBlock::Text {
                text: "compaction bookkeeping".into(),
            }],
        )];
        assert!(build_messages(&messages, false).is_empty());
    }

    #[test]
    fn stop_reasons_map_to_auroras_vocabulary() {
        assert_eq!(map_stop_reason("tool-calls"), "tool_use");
        assert_eq!(map_stop_reason("length"), "max_tokens");
        assert_eq!(map_stop_reason("stop"), "end_turn");
    }

    #[test]
    fn usage_reads_the_gateways_own_field_names() {
        let value = json!({
            "inputTokens": 170,
            "outputTokens": 30,
            "inputTokenDetails": { "cacheReadTokens": 12, "cacheWriteTokens": 4 },
        });
        let usage = usage_from(&value).expect("usage parses");
        assert_eq!(usage.input_tokens, 170);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.cache_read_input_tokens, Some(12));
        assert_eq!(usage.cache_creation_input_tokens, Some(4));
        // Reported, so never flagged as an estimate.
        assert_eq!(usage.estimated, None);
    }

    #[test]
    fn missing_usage_is_flagged_as_an_estimate_not_a_zero_bill() {
        let (_, usage, stop) = StreamState::default().finish();
        assert_eq!(usage.estimated, Some(true));
        assert_eq!(stop, "end_turn");
    }

    #[test]
    fn served_by_names_the_real_route() {
        let event = json!({ "providerMetadata": { "alibaba": {} } });
        assert_eq!(served_by(&event).as_deref(), Some("alibaba"));
    }

    #[test]
    fn forbidden_tells_the_user_what_to_do() {
        let stale = r#"{"error":{"code":"upgrade_required","message":"Your CLI is out of date"}}"#;
        let ApiError::Provider(message) = map_forbidden(stale) else {
            panic!("expected a provider error");
        };
        assert!(message.contains("npm i -g command-code@latest"));

        let plan = r#"{"error":{"code":"FORBIDDEN","message":"MODEL_NOT_IN_PLAN: Claude Sonnet 5 available in Pro and above plans"}}"#;
        let ApiError::Provider(message) = map_forbidden(plan) else {
            panic!("expected a provider error");
        };
        assert!(message.contains("Pro and above"));
    }

    #[tokio::test]
    async fn tool_arguments_come_parsed_and_need_no_reassembly() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut state = StreamState::default();
        let event = json!({
            "type": "tool-call",
            "toolCallId": "call_1",
            "toolName": "get_weather",
            "input": { "city": "Lagos" },
        });
        handle_event(&event, &mut state, &tx).await.expect("handled");
        drop(tx);

        let Some(AssistantEvent::ToolUse { id, name, input }) = rx.recv().await else {
            panic!("expected a ToolUse event");
        };
        assert_eq!(id, "call_1");
        assert_eq!(name, "get_weather");
        assert_eq!(input["city"], "Lagos");
        assert_eq!(state.blocks.len(), 1);
    }

    /// End-to-end against the real endpoint, using whatever key this machine
    /// has. Ignored by default: it needs network and an account.
    ///
    /// Worth keeping runnable, because `/alpha/generate` is undocumented and
    /// every fact this adapter encodes was read off the live wire. When
    /// Command Code changes the shape, this is what says so.
    ///
    /// `cargo test -p aurora --lib commandcode -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "hits the live Command Code API; needs an account"]
    async fn live_turn_against_the_real_endpoint() {
        let mut snapshot = config();
        // Free on every plan, so the check costs nothing.
        snapshot.model = "meituan/LongCat-2.0:free".into();
        snapshot.api_key = String::new(); // fall back to ~/.commandcode/auth.json

        let adapter = CommandCodeAdapter::new(snapshot);
        let messages = vec![message(
            MessageRole::User,
            vec![ContentBlock::Text {
                text: "Reply with exactly: OK".into(),
            }],
        )];
        let mut req = request(&messages, &[]);
        req.model = "commandcode:meituan/LongCat-2.0:free";

        let (tx, mut rx) = mpsc::channel(256);
        let collector = tokio::spawn(async move {
            let mut text = String::new();
            while let Some(event) = rx.recv().await {
                if let AssistantEvent::TextDelta { delta } = event {
                    text.push_str(&delta);
                }
            }
            text
        });

        let usage = adapter
            .stream(req, tx, CancellationToken::new())
            .await
            .expect("the live turn should succeed");
        let text = collector.await.expect("collector");

        assert!(
            text.to_lowercase().contains("ok"),
            "expected the model to answer, got {text:?}"
        );
        assert_eq!(usage.stop_reason, "end_turn");
        assert!(
            usage.usage.input_tokens > 0,
            "the endpoint reports usage; a zero means the parse drifted"
        );
        assert_ne!(usage.usage.estimated, Some(true));
    }

    #[tokio::test]
    async fn text_and_reasoning_land_in_separate_blocks_in_order() {
        let (tx, _rx) = mpsc::channel(64);
        let mut state = StreamState::default();
        for event in [
            json!({ "type": "reasoning-delta", "text": "thinking" }),
            json!({ "type": "text-delta", "text": "answer" }),
        ] {
            handle_event(&event, &mut state, &tx).await.expect("handled");
        }
        let (blocks, _, _) = state.finish();
        assert!(matches!(blocks[0], ContentBlock::Thinking { .. }));
        assert!(matches!(blocks[1], ContentBlock::Text { .. }));
    }
}
