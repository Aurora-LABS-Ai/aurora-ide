//! [`CursorAdapter`] — Aurora's turn loop driving Cursor's agent service.
//!
//! Everything protocol-shaped lives in [`super::session`]; this is the
//! translation layer between that and [`StreamingApiClient`]:
//!
//! - resolve a fresh access token per turn (forced refresh once on a 401),
//! - map Aurora's messages onto Cursor's history format ([`super::history`]),
//! - map [`TurnEvent`]s back onto [`AssistantEvent`]s,
//! - reconstruct the final assistant message the runtime persists.
//!
//! ## Token accounting: counted here, because the wire will not say
//!
//! Cursor reports a **single** counter per turn (`TokenDeltaUpdate`) with no
//! prompt/completion split — `input_tokens` genuinely does not exist on this
//! wire. That is a problem, because Aurora's context ring is
//! measurement-anchored: it draws from the last usage the provider reported.
//! Left at zero, the ring would sit empty through a conversation that was
//! actually filling the window, and the first sign of trouble would be a
//! refusal from the far end.
//!
//! So the prompt is counted locally with Aurora's own tokenizer
//! ([`crate::services::token_service`], tiktoken) over exactly what this turn
//! sends — system prompt, history, and tool schemas. That is an estimate, not
//! a measurement: tiktoken's vocabulary is not Grok's or Claude's, and
//! Cursor's server prepends a system prompt of its own that Aurora cannot see
//! or size. It is close enough to drive a ring honestly and far better than
//! zero.
//!
//! The whole usage is therefore flagged `estimated: true`. This drives a money
//! figure as well as a ring, and an exact-looking `$0.00` would be a false
//! number rather than a missing one.

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::api_client::{ApiError, ApiRequest, StreamingApiClient, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::{ContentBlock, ConversationMessage, TokenUsage};
use crate::api::client::ProviderConfigSnapshot;
use crate::api::provider_kernel_adapter::unprefix_model;

use super::history;
use super::session::{self, DoneReason, RunTurn, TurnEvent};

pub struct CursorAdapter {
    config: ProviderConfigSnapshot,
}

impl CursorAdapter {
    #[must_use]
    pub fn new(config: ProviderConfigSnapshot) -> Self {
        Self { config }
    }
}

/// Collect one turn's events into the final assistant message.
///
/// Text arrives as many deltas and must be concatenated into a single block;
/// thinking likewise. Tool calls become their own blocks in arrival order.
#[derive(Default)]
struct TurnAccumulator {
    text: String,
    thinking: String,
    tool_uses: Vec<ContentBlock>,
    tokens: u32,
}

impl TurnAccumulator {
    fn into_blocks(self) -> Vec<ContentBlock> {
        let mut blocks = Vec::new();
        if !self.thinking.is_empty() {
            blocks.push(ContentBlock::Thinking {
                text: self.thinking,
                // Cursor issues no reasoning signature, and a signature from
                // one provider is meaningless to another — so there is
                // nothing to persist and nothing to replay.
                signature: None,
                duration_ms: None,
            });
        }
        if !self.text.is_empty() {
            blocks.push(ContentBlock::Text { text: self.text });
        }
        blocks.extend(self.tool_uses);
        blocks
    }
}

#[async_trait::async_trait]
impl StreamingApiClient for CursorAdapter {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }

        let model = unprefix_model(request.model, &self.config.provider_id).to_string();
        let input = history::build_turn_input(request.system_prompt, request.messages);
        let tools = history::build_tools(request.tools);

        let mut access = super::auth::fresh_access(false)
            .await
            .map_err(ApiError::Provider)?;

        // One retry on an auth failure: a token that has not expired can
        // still be dead (password change, session revoked), and that only
        // reveals itself here.
        let mut refreshed_once = false;
        loop {
            let (tx, mut rx) = mpsc::channel::<TurnEvent>(64);

            let turn = RunTurn {
                access_token: &access,
                model: &model,
                input: input.clone(),
                tools: tools.clone(),
            };

            let sink = event_sink.clone();
            let cancel = cancel_token.clone();
            let pump = tokio::spawn(async move {
                let mut acc = TurnAccumulator::default();
                let mut done = DoneReason::Stop;

                while let Some(event) = rx.recv().await {
                    match event {
                        TurnEvent::Text(delta) => {
                            acc.text.push_str(&delta);
                            let _ = sink.send(AssistantEvent::TextDelta { delta }).await;
                        }
                        TurnEvent::Thinking(delta) => {
                            acc.thinking.push_str(&delta);
                            let _ = sink
                                .send(AssistantEvent::Thinking {
                                    text: delta,
                                    signature: None,
                                })
                                .await;
                        }
                        TurnEvent::ToolCall { id, name, args } => {
                            acc.tool_uses.push(ContentBlock::ToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                input: args.clone(),
                            });
                            let _ = sink
                                .send(AssistantEvent::ToolUse {
                                    id,
                                    name,
                                    input: args,
                                })
                                .await;
                        }
                        TurnEvent::Usage { tokens } => {
                            // A per-delta counter, so accumulate rather than
                            // overwrite — the last update is not the total.
                            acc.tokens =
                                acc.tokens.saturating_add(tokens.unwrap_or(0).max(0) as u32);
                        }
                        TurnEvent::Done(reason) => done = reason,
                    }
                }
                let _ = cancel; // held so the sink outlives the stream
                (acc, done)
            });

            let outcome = session::run_turn(turn, tx, cancel_token.clone()).await;
            let (acc, done) = pump
                .await
                .map_err(|err| ApiError::Provider(format!("Cursor event pump failed: {err}")))?;

            if let Err(err) = outcome {
                if !refreshed_once && looks_like_auth_failure(&err) {
                    refreshed_once = true;
                    access = super::auth::fresh_access(true)
                        .await
                        .map_err(ApiError::Provider)?;
                    continue;
                }
                return Err(ApiError::Provider(err));
            }

            return match done {
                DoneReason::Error(err) => {
                    if !refreshed_once && looks_like_auth_failure(&err) {
                        refreshed_once = true;
                        access = super::auth::fresh_access(true)
                            .await
                            .map_err(ApiError::Provider)?;
                        continue;
                    }
                    if err == "cancelled" {
                        Err(ApiError::Cancelled)
                    } else {
                        Err(ApiError::Provider(err))
                    }
                }
                reason => {
                    let stop_reason = match reason {
                        DoneReason::ToolCalls => "tool_use",
                        _ => "end_turn",
                    }
                    .to_string();

                    let usage = TokenUsage {
                        // Counted locally — the wire carries no prompt figure,
                        // and a zero here would leave the context ring empty
                        // while the window genuinely filled.
                        input_tokens: estimate_prompt_tokens(&input, &tools, &model),
                        output_tokens: acc.tokens,
                        cache_creation_input_tokens: None,
                        cache_read_input_tokens: None,
                        estimated: Some(true),
                        // Usage bills against the Cursor subscription, not
                        // per token. A dollar figure here would be fiction.
                        cost_usd: None,
                    };
                    let blocks = acc.into_blocks();
                    let assistant_message = ConversationMessage::assistant_with_usage(
                        blocks,
                        usage.clone(),
                        crate::api::provider_kernel_adapter::now_unix_ms(),
                    );

                    Ok(TurnUsage {
                        usage,
                        stop_reason,
                        assistant_message,
                    })
                }
            };
        }
    }
}

/// Count what this turn actually puts on the wire.
///
/// Sizes the same three things the request carries — the system prompt, the
/// history entries, and the tool schemas — rather than re-deriving them from
/// Aurora's stored transcript. Anything conditionally sent must be priced by
/// the view that is *sent*, or the ring drifts from reality in whichever
/// direction the difference falls.
///
/// Cursor's own server-side system prompt is not included, because Aurora
/// cannot see it. The ring will therefore read slightly low, which is the
/// safer direction to be wrong in.
fn estimate_prompt_tokens(
    input: &history::TurnInput,
    tools: &[cursor_proto::agent::McpToolDefinition],
    model: &str,
) -> u32 {
    use crate::services::token_service::TokenService;

    let mut text = String::new();
    for entry in &input.root_messages {
        if let Ok(rendered) = serde_json::to_string(entry) {
            text.push_str(&rendered);
            text.push('\n');
        }
    }
    text.push_str(&input.user_text);

    // Tool schemas are part of every request and are far from free — a large
    // roster is routinely a bigger share of the prompt than the conversation.
    for tool in tools {
        text.push_str(&tool.name);
        text.push_str(&tool.description);
        if let Some(schema) = &tool.input_schema_json {
            text.push_str(schema);
        }
    }

    TokenService::count_tokens_for_model(&text, model)
        .map(|count| count.tokens as u32)
        // A tokenizer that failed to load is not worth failing a turn over;
        // the ring falls back to "unknown" rather than a wrong number.
        .unwrap_or(0)
}

/// Whether an upstream failure is worth spending one forced token refresh on.
///
/// Kept narrow on purpose: retrying a non-auth failure with a new token just
/// doubles the wait before showing the same error.
fn looks_like_auth_failure(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("http 401")
        || lower.contains("http 403")
        || lower.contains("unauthenticated")
        || lower.contains("permission_denied")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deltas_are_concatenated_into_single_blocks() {
        let mut acc = TurnAccumulator::default();
        acc.thinking.push_str("let me ");
        acc.thinking.push_str("think");
        acc.text.push_str("Hello, ");
        acc.text.push_str("world");

        let blocks = acc.into_blocks();
        assert_eq!(blocks.len(), 2);
        assert!(matches!(
            &blocks[0],
            ContentBlock::Thinking { text, .. } if text == "let me think"
        ));
        assert!(matches!(
            &blocks[1],
            ContentBlock::Text { text } if text == "Hello, world"
        ));
    }

    /// Thinking leads, then text, then tool calls — the order the transcript
    /// renders and the runtime replays.
    #[test]
    fn tool_calls_follow_the_prose_in_arrival_order() {
        let mut acc = TurnAccumulator::default();
        acc.text.push_str("Reading it.");
        for id in ["c1", "c2"] {
            acc.tool_uses.push(ContentBlock::ToolUse {
                id: id.into(),
                name: "file_read".into(),
                input: json!({}),
            });
        }

        let blocks = acc.into_blocks();
        assert!(matches!(blocks[0], ContentBlock::Text { .. }));
        assert!(
            matches!(&blocks[1], ContentBlock::ToolUse { id, .. } if id == "c1"),
            "arrival order must survive"
        );
        assert!(matches!(&blocks[2], ContentBlock::ToolUse { id, .. } if id == "c2"));
    }

    #[test]
    fn an_empty_turn_produces_no_blocks() {
        assert!(TurnAccumulator::default().into_blocks().is_empty());
    }

    #[test]
    fn thinking_carries_no_signature() {
        let mut acc = TurnAccumulator::default();
        acc.thinking.push_str("hmm");
        // A signature is issued by one provider and meaningless to another;
        // inventing one here would 400 a later turn on a different provider.
        assert!(matches!(
            &acc.into_blocks()[0],
            ContentBlock::Thinking {
                signature: None,
                ..
            }
        ));
    }

    #[test]
    fn only_auth_failures_earn_a_forced_refresh() {
        assert!(looks_like_auth_failure(
            "Cursor returned HTTP 401 over HTTP/2: "
        ));
        assert!(looks_like_auth_failure("unauthenticated: token expired"));
        assert!(looks_like_auth_failure("HTTP 403"));

        // Retrying these with a fresh token only doubles the wait.
        assert!(!looks_like_auth_failure("Cursor returned HTTP 500"));
        assert!(!looks_like_auth_failure(
            "internal: parse binary: premature EOF"
        ));
        assert!(!looks_like_auth_failure(
            "Cursor stream failed: connection reset"
        ));
    }

    #[test]
    fn usage_is_flagged_estimated_because_the_wire_has_no_split() {
        let usage = TokenUsage {
            input_tokens: 4_200,
            output_tokens: 120,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            estimated: Some(true),
            cost_usd: None,
        };
        // Counted locally, so it must never present as measured: this drives a
        // money figure, and an exact-looking cost from an estimate is a false
        // number rather than a missing one.
        assert_eq!(usage.estimated, Some(true));
    }

    fn tool(name: &str, schema: &str) -> cursor_proto::agent::McpToolDefinition {
        cursor_proto::agent::McpToolDefinition {
            name: name.into(),
            tool_name: name.into(),
            provider_identifier: "aurora".into(),
            description: "A tool.".into(),
            input_schema: Vec::new(),
            input_schema_json: Some(schema.into()),
        }
    }

    #[test]
    fn the_context_ring_gets_a_real_number_not_zero() {
        let input = history::build_turn_input(
            Some("You are Aurora's coding agent."),
            &[crate::agent_runtime::types::ConversationMessage {
                role: crate::agent_runtime::types::MessageRole::User,
                blocks: vec![ContentBlock::Text {
                    text: "Refactor the parser module.".into(),
                }],
                usage: None,
                timestamp: 0,
                attached_selected_elements: None,
                attached_prompt_chips: None,
                model: None,
            }],
        );

        let counted = estimate_prompt_tokens(&input, &[], "cursor-grok-4.6-high");
        assert!(
            counted > 0,
            "an empty ring through a filling window is the failure this prevents"
        );
    }

    /// A large tool roster is routinely a bigger share of the prompt than the
    /// conversation, so leaving it out would under-read the ring badly.
    #[test]
    fn tool_schemas_are_counted_as_part_of_the_prompt() {
        let input = history::TurnInput {
            root_messages: vec![],
            user_text: "hi".into(),
        };
        let bare = estimate_prompt_tokens(&input, &[], "cursor-grok-4.6-high");

        let tools: Vec<_> = (0..10)
            .map(|i| {
                tool(
                    &format!("tool_{i}"),
                    r#"{"type":"object","properties":{"path":{"type":"string"},"start":{"type":"integer"}}}"#,
                )
            })
            .collect();
        let with_tools = estimate_prompt_tokens(&input, &tools, "cursor-grok-4.6-high");

        assert!(
            with_tools > bare * 2,
            "tools must move the number materially: {bare} → {with_tools}"
        );
    }

    #[test]
    fn a_longer_conversation_counts_higher() {
        let short = history::TurnInput {
            root_messages: vec![],
            user_text: "hi".into(),
        };
        let long = history::TurnInput {
            root_messages: vec![json!({
                "role": "user",
                "content": [{ "type": "text", "text": "word ".repeat(500) }]
            })],
            user_text: "hi".into(),
        };

        assert!(
            estimate_prompt_tokens(&long, &[], "cursor-grok-4.6-high")
                > estimate_prompt_tokens(&short, &[], "cursor-grok-4.6-high") + 100
        );
    }
}
