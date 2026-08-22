//! One turn against `agent.v1.AgentService/Run`.
//!
//! This is a **bidirectional** stream, not a request/response. A single turn:
//!
//! ```text
//! client → run_request
//! server → kv{get_blob_args}         pulls our history back, by content hash
//! client → kv{get_blob_result}
//! server → exec{request_context_args}  asks what tools exist
//! client → exec{request_context_result}
//! server → interaction_update{text_delta}…
//! server → exec{mcp_args}             the model wants one of our tools
//! server → interaction_update{turn_ended}
//! ```
//!
//! Two consequences shape everything here.
//!
//! **History travels out of band.** Messages are serialized, hashed, and only
//! the hashes go in the request; the server fetches the bodies over the KV
//! channel *while the stream is open*. So the request body cannot be finished
//! before the response is read — both halves must be live at once.
//!
//! **Tools execute on our side.** Cursor normally drives tools server-side over
//! the exec channel, but Aurora owns its own tool loop. So an `mcp_args` is not
//! answered: it is surfaced as a tool call, the turn ends, and the result comes
//! back as history on the next request. Paired with
//! `x-cursor-agent-allowed-tools: mcp_tool_call`, the model sees Aurora's tools
//! and none of Cursor's own.

use futures::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use cursor_proto::agent as pb;
use cursor_proto::Message as _;

use super::frame::{self, Frame, FrameDecoder};
use super::history::TurnInput;
use super::{CURSOR_API_BASE, CURSOR_CLIENT_TYPE, CURSOR_CLIENT_VERSION};

/// Full RPC path for the streaming turn.
const RUN_PATH: &str = "/agent.v1.AgentService/Run";

/// The only native tool the model is allowed to see.
///
/// `mcp_tool_call` is the oneof member carrying an MCP invocation, and Aurora's
/// tools arrive as MCP tools. Naming it alone leaves Cursor's ~40 built-ins
/// (shell, edit, grep, todos, …) invisible — which is the whole point: Aurora
/// runs its own tools, through its own permission gate, with its own
/// checkpoints.
const ALLOWED_NATIVE_TOOLS: &str = "mcp_tool_call";

/// What one turn produces.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEvent {
    Text(String),
    Thinking(String),
    ToolCall {
        id: String,
        name: String,
        args: serde_json::Value,
    },
    /// Cursor reports a single counter for the turn with no prompt/completion
    /// split, so this is output only. Prompt tokens are genuinely unavailable
    /// — inventing a number would corrupt Aurora's context accounting.
    Usage { tokens: Option<i32> },
    Done(DoneReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DoneReason {
    /// The model finished speaking.
    Stop,
    /// The model asked for tools; Aurora runs them and continues next turn.
    ToolCalls,
    Error(String),
}

/// Everything one turn needs.
pub struct RunTurn<'a> {
    pub access_token: &'a str,
    /// Upstream model id, e.g. `cursor-grok-4.6-high`. Sent verbatim.
    pub model: &'a str,
    pub input: TurnInput,
    pub tools: Vec<pb::McpToolDefinition>,
}

/// Content-addressed store for the history the server pulls back.
struct BlobStore(HashMap<Vec<u8>, Vec<u8>>);

impl BlobStore {
    fn new() -> Self {
        Self(HashMap::new())
    }

    /// Store one entry and return its id — the sha256 of the bytes, which is
    /// what makes the channel content-addressed and the ids stable.
    fn put(&mut self, data: Vec<u8>) -> Vec<u8> {
        let id = Sha256::digest(&data).to_vec();
        self.0.insert(id.clone(), data);
        id
    }

    fn get(&self, id: &[u8]) -> Option<&Vec<u8>> {
        self.0.get(id)
    }
}

/// Build the opening `run_request`.
fn build_run_request(
    turn: &RunTurn<'_>,
    blobs: &mut BlobStore,
) -> pb::AgentClientMessage {
    let root_prompt_messages_json = turn
        .input
        .root_messages
        .iter()
        .map(|entry| {
            let bytes = serde_json::to_vec(entry).unwrap_or_else(|_| b"{}".to_vec());
            blobs.put(bytes)
        })
        .collect();

    let action = if turn.input.is_resume() {
        pb::conversation_action::Action::ResumeAction(pb::ResumeAction::default())
    } else {
        pb::conversation_action::Action::UserMessageAction(pb::UserMessageAction {
            user_message: Some(pb::UserMessage {
                text: turn.input.user_text.clone(),
                message_id: uuid::Uuid::new_v4().to_string(),
                ..Default::default()
            }),
            ..Default::default()
        })
    };

    let request = pb::AgentRunRequest {
        conversation_state: Some(pb::ConversationStateStructure {
            root_prompt_messages_json,
            ..Default::default()
        }),
        action: Some(pb::ConversationAction {
            action: Some(action),
        }),
        model_details: Some(pb::ModelDetails {
            model_id: turn.model.to_string(),
            display_model_id: turn.model.to_string(),
            display_name: turn.model.to_string(),
            ..Default::default()
        }),
        requested_model: Some(pb::RequestedModel {
            model_id: turn.model.to_string(),
            ..Default::default()
        }),
        mcp_tools: Some(pb::McpTools {
            mcp_tools: turn.tools.clone(),
        }),
        conversation_id: Some(uuid::Uuid::new_v4().to_string()),
        ..Default::default()
    };

    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(request)),
    }
}

/// Reply to the server's context handshake.
///
/// Deliberately minimal: no rules, no repository info, no project layout. The
/// only thing advertised is Aurora's tool set. Everything else in
/// `RequestContext` describes a workspace *Cursor* would drive; Aurora already
/// gives the model its own repo map and context, and sending a second, shallower
/// view would just contradict it.
fn build_request_context_reply(
    id: u32,
    exec_id: String,
    tools: Vec<pb::McpToolDefinition>,
) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::ExecClientMessage(
            pb::ExecClientMessage {
                id,
                exec_id,
                message: Some(pb::exec_client_message::Message::RequestContextResult(
                    pb::RequestContextResult {
                        result: Some(pb::request_context_result::Result::Success(
                            pb::RequestContextSuccess {
                                request_context: Some(pb::RequestContext {
                                    tools,
                                    env: Some(pb::RequestContextEnv {
                                        os_version: std::env::consts::OS.to_string(),
                                        shell: "bash".to_string(),
                                        sandbox_enabled: false,
                                        time_zone: "UTC".to_string(),
                                        ..Default::default()
                                    }),
                                    ..Default::default()
                                }),
                                ..Default::default()
                            },
                        )),
                    },
                )),
                ..Default::default()
            },
        )),
    }
}

/// Decode one `McpArgs.args` value — a `map<string, bytes>` whose values are
/// each a serialized `google.protobuf.Value`.
fn decode_arg(raw: &[u8]) -> serde_json::Value {
    if raw.is_empty() {
        return serde_json::Value::Null;
    }
    match cursor_proto::shim::Value::decode(raw) {
        Ok(value) => shim_to_json(&value),
        // Not a Value envelope — a plain JSON-encoded arg map would arrive as
        // text, so pass it through rather than losing the argument.
        Err(_) => serde_json::Value::String(String::from_utf8_lossy(raw).into_owned()),
    }
}

/// A protobuf `Value` number → JSON, keeping whole numbers whole.
///
/// **This is not a nicety, it is the difference between a tool working and
/// silently ignoring half its arguments.**
///
/// Protobuf's `Value` has no integer kind — the spec gives it
/// `NumberValue(double)` and nothing else — so a model asking for
/// `start_line: 960` arrives here as `960.0`. Passed through as an f64 it
/// becomes the JSON number `960.0`, and every one of Aurora's tools reads its
/// numeric arguments with `Value::as_u64()`, which returns `None` for a
/// float-typed number. The argument is not rejected; it is **dropped**, and
/// the tool runs with its default.
///
/// What that looked like in practice: the model asked to read lines 960–1260
/// of a file, got lines 1–1000 back, said so in its reasoning — *"keeps
/// returning from line 1 despite specifying a start line"* — and asked again.
/// Four identical reads before the user stopped it. Nothing errored anywhere;
/// every tool result said `success: true`.
///
/// A whole-valued double **was** an integer before protobuf flattened it, so
/// restoring it here is a correction, not a guess. Genuinely fractional values
/// stay floats, and anything outside `i64`/`u64` range stays a float rather
/// than being mangled into one.
fn number_to_json(n: f64) -> serde_json::Value {
    if n.fract() == 0.0 && n.is_finite() {
        if n >= 0.0 && n <= u64::MAX as f64 {
            return serde_json::Value::Number((n as u64).into());
        }
        if n >= i64::MIN as f64 && n <= i64::MAX as f64 {
            return serde_json::Value::Number((n as i64).into());
        }
    }
    serde_json::Number::from_f64(n)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

fn shim_to_json(value: &cursor_proto::shim::Value) -> serde_json::Value {
    use cursor_proto::shim::value::Kind;
    match &value.kind {
        Some(Kind::StringValue(s)) => serde_json::Value::String(s.clone()),
        Some(Kind::NumberValue(n)) => number_to_json(*n),
        Some(Kind::BoolValue(b)) => serde_json::Value::Bool(*b),
        Some(Kind::StructValue(s)) => serde_json::Value::Object(
            s.fields
                .iter()
                .map(|(k, v)| (k.clone(), shim_to_json(v)))
                .collect(),
        ),
        Some(Kind::ListValue(l)) => {
            serde_json::Value::Array(l.values.iter().map(shim_to_json).collect())
        }
        Some(Kind::NullValue(_)) | None => serde_json::Value::Null,
    }
}

/// Assemble a tool call's arguments from the server's map.
fn decode_args(args: &std::collections::BTreeMap<String, Vec<u8>>) -> serde_json::Value {
    serde_json::Value::Object(
        args.iter()
            .map(|(key, raw)| (key.clone(), decode_arg(raw)))
            .collect(),
    )
}

/// Run one turn, emitting events as they arrive.
///
/// Always terminates with exactly one [`TurnEvent::Done`], including on
/// cancellation — a caller awaiting the sink must never be left hanging.
pub async fn run_turn(
    turn: RunTurn<'_>,
    events: mpsc::Sender<TurnEvent>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let mut blobs = BlobStore::new();
    let opening = build_run_request(&turn, &mut blobs);

    // The request body stays open for the whole turn: the server pulls history
    // back over it after the response headers have already arrived.
    let (mut body_tx, body_rx) =
        futures::channel::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(16);

    body_tx
        .send(Ok(frame::encode(&opening.encode_to_vec())))
        .await
        .map_err(|err| format!("could not start the Cursor request: {err}"))?;

    // HTTP/2 is not optional here. `Run` is a bidirectional stream, and
    // HTTP/1.1 has no way to keep the request body open while the response
    // streams back — a downgrade shows up as a bare `464` (incompatible
    // protocol version) with no body to explain it. ALPN does the negotiating;
    // `http2_prior_knowledge` is the wrong lever over TLS, because ALPN still
    // runs and a mismatch surfaces as "frame with invalid size".
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        // rustls, specifically. The default TLS backend is the platform's —
        // SChannel on Windows — which does not advertise `h2` over ALPN, so
        // the connection silently lands on HTTP/1.1 and Cursor answers a bare
        // `464`. rustls negotiates h2 properly on every platform.
        .use_rustls_tls()
        .build()
        .map_err(|err| format!("build HTTP client: {err}"))?;

    let mut headers = super::unary::base_headers(turn.access_token)?;
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/connect+proto"),
    );
    headers.insert(
        reqwest::header::TE,
        reqwest::header::HeaderValue::from_static("trailers"),
    );
    headers.insert(
        "x-cursor-agent-allowed-tools",
        reqwest::header::HeaderValue::from_static(ALLOWED_NATIVE_TOOLS),
    );

    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            let _ = events.send(TurnEvent::Done(DoneReason::Error("cancelled".into()))).await;
            return Ok(());
        }
        result = http
            .post(format!("{CURSOR_API_BASE}{RUN_PATH}"))
            .headers(headers)
            .body(reqwest::Body::wrap_stream(body_rx))
            .send() => result.map_err(|err| format!("Cursor request failed: {}", error_chain(&err)))?,
    };

    let status = response.status();
    if !status.is_success() {
        // Report the negotiated protocol alongside the status. `Run` only
        // works over HTTP/2, and the statuses a downgrade produces (a bare
        // 464, say) name nothing that would point at the real cause.
        let version = format!("{:?}", response.version());
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(300).collect::<String>();
        let message = format!(
            "Cursor returned HTTP {} over {version}: {detail}",
            status.as_u16()
        );
        let _ = events.send(TurnEvent::Done(DoneReason::Error(message.clone()))).await;
        return Err(message);
    }

    let mut decoder = FrameDecoder::new();
    let mut stream = response.bytes_stream();
    let mut done: Option<DoneReason> = None;

    'outer: loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                done = Some(DoneReason::Error("cancelled".into()));
                break 'outer;
            }
            next = stream.next() => next,
        };
        let Some(chunk) = chunk else { break };
        let chunk = match chunk {
            Ok(bytes) => bytes,
            Err(err) => {
                done = Some(DoneReason::Error(format!("Cursor stream failed: {err}")));
                break;
            }
        };

        let frames = match decoder.push(&chunk) {
            Ok(frames) => frames,
            Err(err) => {
                done = Some(DoneReason::Error(err.to_string()));
                break;
            }
        };

        for parsed in frames {
            match parsed {
                Frame::EndOfStream(trailer) => {
                    done = Some(match frame::read_trailer(&trailer) {
                        Ok(()) => DoneReason::Stop,
                        Err(err) => DoneReason::Error(err),
                    });
                    break 'outer;
                }
                Frame::Message(payload) => {
                    // An unreadable frame is skipped rather than killing the
                    // turn: the schema has messages Aurora never asked about,
                    // and a new one appearing must not end a working stream.
                    let Ok(message) = pb::AgentServerMessage::decode(payload.as_slice()) else {
                        continue;
                    };
                    match handle(message, &mut blobs, &turn, &events, &mut body_tx).await {
                        Ok(Some(reason)) => {
                            done = Some(reason);
                            break 'outer;
                        }
                        Ok(None) => {}
                        Err(err) => {
                            done = Some(DoneReason::Error(err));
                            break 'outer;
                        }
                    }
                }
            }
        }
    }

    let _ = events
        .send(TurnEvent::Done(done.unwrap_or(DoneReason::Stop)))
        .await;
    Ok(())
}

/// Dispatch one server message. `Ok(Some(reason))` ends the turn.
async fn handle(
    message: pb::AgentServerMessage,
    blobs: &mut BlobStore,
    turn: &RunTurn<'_>,
    events: &mpsc::Sender<TurnEvent>,
    body_tx: &mut futures::channel::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
) -> Result<Option<DoneReason>, String> {
    use pb::agent_server_message::Message as Server;

    let Some(inner) = message.message else {
        return Ok(None);
    };

    match inner {
        Server::KvServerMessage(kv) => {
            let reply = match kv.message {
                Some(pb::kv_server_message::Message::GetBlobArgs(args)) => {
                    // A blob we do not have comes back empty rather than as an
                    // error: the server asks for ids it has seen before, and
                    // refusing the whole turn over one miss is worse than
                    // letting it proceed without that entry.
                    let data = blobs.get(&args.blob_id).cloned();
                    pb::kv_client_message::Message::GetBlobResult(pb::GetBlobResult {
                        blob_data: data,
                    })
                }
                Some(pb::kv_server_message::Message::SetBlobArgs(args)) => {
                    blobs.0.insert(args.blob_id, args.blob_data);
                    pb::kv_client_message::Message::SetBlobResult(pb::SetBlobResult::default())
                }
                None => return Ok(None),
            };
            send(
                body_tx,
                pb::AgentClientMessage {
                    message: Some(pb::agent_client_message::Message::KvClientMessage(
                        pb::KvClientMessage {
                            id: kv.id,
                            message: Some(reply),
                        },
                    )),
                },
            )
            .await?;
        }

        Server::ExecServerMessage(exec) => match exec.message {
            Some(pb::exec_server_message::Message::RequestContextArgs(_)) => {
                send(
                    body_tx,
                    build_request_context_reply(exec.id, exec.exec_id, turn.tools.clone()),
                )
                .await?;
            }
            Some(pb::exec_server_message::Message::McpArgs(args)) => {
                let id = if args.tool_call_id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    args.tool_call_id.clone()
                };
                // Cursor names client tools `mcp_aurora_<tool>` for the model,
                // and that is the name that comes back. Aurora's executor
                // knows `file_read` — and `mcp_aurora_file_read` would be read
                // as one of Aurora's OWN MCP tools (`mcp_{serverId}_{tool}`)
                // from a server that does not exist.
                let raw = if args.tool_name.is_empty() {
                    args.name.clone()
                } else {
                    args.tool_name.clone()
                };
                let name = super::history::short_tool_name(&raw).to_string();
                let _ = events
                    .send(TurnEvent::ToolCall {
                        id,
                        name,
                        args: decode_args(&args.args),
                    })
                    .await;
                // Hand control back — Aurora executes tools, not Cursor.
                return Ok(Some(DoneReason::ToolCalls));
            }
            // Every other exec request is a native tool Aurora hid via the
            // allowed-tools header. Reaching one means the header did not take
            // effect, which is worth failing loudly over rather than hanging
            // on a reply the server will wait forever for.
            Some(_) => {
                return Err(
                    "Cursor asked Aurora to run one of its own built-in tools, which should be \
                     disabled. The allowed-tools header may no longer be honoured."
                        .to_string(),
                );
            }
            None => {}
        },

        Server::InteractionUpdate(update) => {
            use pb::interaction_update::Message as Update;
            match update.message {
                Some(Update::TextDelta(delta)) if !delta.text.is_empty() => {
                    let _ = events.send(TurnEvent::Text(delta.text)).await;
                }
                Some(Update::ThinkingDelta(delta)) if !delta.text.is_empty() => {
                    let _ = events.send(TurnEvent::Thinking(delta.text)).await;
                }
                Some(Update::TokenDelta(delta)) => {
                    let _ = events
                        .send(TurnEvent::Usage {
                            tokens: Some(delta.tokens),
                        })
                        .await;
                }
                Some(Update::TurnEnded(_)) => return Ok(Some(DoneReason::Stop)),
                _ => {}
            }
        }

        _ => {}
    }

    Ok(None)
}

/// Flatten an error and everything that caused it into one line.
///
/// `reqwest`'s `Display` is deliberately terse — "error sending request for
/// url (…)" — and the actual reason (TLS, ALPN, a refused connection) only
/// lives in the source chain. Losing it turns a five-minute diagnosis into an
/// afternoon.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.join(" ← ")
}

async fn send(
    body_tx: &mut futures::channel::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
    message: pb::AgentClientMessage,
) -> Result<(), String> {
    body_tx
        .send(Ok(frame::encode(&message.encode_to_vec())))
        .await
        .map_err(|err| format!("Cursor connection closed while replying: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::cursor::history::build_turn_input;

    fn turn_for(model: &str, input: TurnInput) -> RunTurn<'static> {
        // Leak is fine in a test; the struct borrows for its lifetime.
        RunTurn {
            access_token: Box::leak(String::from("tok").into_boxed_str()),
            model: Box::leak(model.to_string().into_boxed_str()),
            input,
            tools: Vec::new(),
        }
    }

    #[test]
    fn blob_ids_are_the_sha256_of_their_contents() {
        let mut blobs = BlobStore::new();
        let id = blobs.put(b"hello".to_vec());

        assert_eq!(id, Sha256::digest(b"hello").to_vec());
        assert_eq!(blobs.get(&id).unwrap(), b"hello");
        // Content-addressed: the same bytes always hash to the same id.
        assert_eq!(blobs.put(b"hello".to_vec()), id);
    }

    #[test]
    fn a_new_user_message_uses_the_user_action() {
        let input = TurnInput {
            root_messages: vec![],
            user_text: "hello".into(),
        };
        let message = build_run_request(&turn_for("m", input), &mut BlobStore::new());

        let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message else {
            panic!("expected a run request");
        };
        assert!(matches!(
            request.action.unwrap().action,
            Some(pb::conversation_action::Action::UserMessageAction(_))
        ));
    }

    /// Mid-tool-loop turns must resume; an empty user message makes the model
    /// answer the void.
    #[test]
    fn a_resume_turn_uses_the_resume_action() {
        let input = TurnInput {
            root_messages: vec![],
            user_text: String::new(),
        };
        let message = build_run_request(&turn_for("m", input), &mut BlobStore::new());

        let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message else {
            panic!("expected a run request");
        };
        assert!(matches!(
            request.action.unwrap().action,
            Some(pb::conversation_action::Action::ResumeAction(_))
        ));
    }

    #[test]
    fn history_travels_as_hashes_not_bodies() {
        let input = build_turn_input(Some("be careful"), &[]);
        let entries = input.root_messages.len();
        let mut blobs = BlobStore::new();

        let message = build_run_request(&turn_for("m", input), &mut blobs);
        let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message else {
            panic!("expected a run request");
        };
        let state = request.conversation_state.unwrap();

        assert_eq!(state.root_prompt_messages_json.len(), entries);
        for id in &state.root_prompt_messages_json {
            assert_eq!(id.len(), 32, "a sha256 id, not an inlined body");
            assert!(blobs.get(id).is_some(), "the server must be able to pull it");
        }
    }

    #[test]
    fn the_model_id_is_sent_verbatim() {
        let input = TurnInput {
            root_messages: vec![],
            user_text: "hi".into(),
        };
        let message = build_run_request(&turn_for("cursor-grok-4.6-high", input), &mut BlobStore::new());
        let Some(pb::agent_client_message::Message::RunRequest(request)) = message.message else {
            panic!("expected a run request");
        };
        assert_eq!(request.model_details.unwrap().model_id, "cursor-grok-4.6-high");
        assert_eq!(
            request.requested_model.unwrap().model_id,
            "cursor-grok-4.6-high"
        );
    }

    #[test]
    fn the_context_reply_advertises_only_aurora_tools() {
        let tools = vec![pb::McpToolDefinition {
            name: "file_read".into(),
            tool_name: "file_read".into(),
            provider_identifier: "aurora".into(),
            ..Default::default()
        }];
        let message = build_request_context_reply(7, "exec-1".into(), tools);

        let Some(pb::agent_client_message::Message::ExecClientMessage(exec)) = message.message
        else {
            panic!("expected an exec reply");
        };
        assert_eq!(exec.id, 7);
        assert_eq!(exec.exec_id, "exec-1");

        let Some(pb::exec_client_message::Message::RequestContextResult(result)) = exec.message
        else {
            panic!("expected a request-context result");
        };
        let Some(pb::request_context_result::Result::Success(success)) = result.result else {
            panic!("expected success");
        };
        let context = success.request_context.unwrap();
        assert_eq!(context.tools.len(), 1);
        assert_eq!(context.tools[0].name, "file_read");
        assert!(
            context.rules.is_empty() && context.repository_info.is_empty(),
            "Aurora supplies its own context; a second shallower view would contradict it"
        );
    }

    #[test]
    fn tool_arguments_decode_from_protobuf_values() {
        use cursor_proto::shim::{value::Kind, Value as ShimValue};

        let mut args = std::collections::BTreeMap::new();
        args.insert(
            "path".to_string(),
            ShimValue {
                kind: Some(Kind::StringValue("src/main.rs".into())),
            }
            .encode_to_vec(),
        );
        args.insert(
            "line".to_string(),
            ShimValue {
                kind: Some(Kind::NumberValue(42.0)),
            }
            .encode_to_vec(),
        );

        let decoded = decode_args(&args);
        assert_eq!(decoded["path"], "src/main.rs");
        // `as_u64`, NOT `== 42.0`. Every tool reads its numeric arguments with
        // `as_u64`, and that returns `None` for a float-typed number — while
        // `== 42.0` passes either way, which is why this assertion missed the
        // bug for as long as it did.
        assert_eq!(
            decoded["line"].as_u64(),
            Some(42),
            "a whole number must survive as an integer or every tool drops it"
        );
    }

    /// The bug this whole function exists for.
    ///
    /// Protobuf `Value` has no integer kind, so `start_line: 960` arrives as
    /// `960.0`. Left a float, `Value::as_u64()` returns `None`, the tool takes
    /// its default, and the model gets lines 1–1000 no matter what it asked
    /// for — then asks again, and again.
    #[test]
    fn whole_numbers_survive_as_integers_so_tools_can_read_them() {
        for whole in [0.0, 1.0, 42.0, 960.0, 1260.0, -7.0] {
            let json = number_to_json(whole);
            assert!(
                json.is_i64() || json.is_u64(),
                "{whole} came back as {json}, which every tool reads as absent"
            );
            assert_eq!(json.as_f64(), Some(whole));
        }
    }

    #[test]
    fn a_real_fraction_stays_a_fraction() {
        // Not every numeric argument is an index. Rounding a temperature or a
        // ratio to make indices work would trade one silent corruption for
        // another.
        let json = number_to_json(0.7);
        assert!(json.is_f64());
        assert_eq!(json.as_f64(), Some(0.7));
    }

    #[test]
    fn a_number_too_large_for_an_integer_is_left_alone() {
        let json = number_to_json(1e300);
        assert_eq!(json.as_f64(), Some(1e300));
    }

    #[test]
    fn a_number_that_cannot_be_json_becomes_null_rather_than_panicking() {
        // JSON has no NaN or infinity. Dropping the one argument beats killing
        // the turn.
        assert!(number_to_json(f64::NAN).is_null());
        assert!(number_to_json(f64::INFINITY).is_null());
    }

    /// The exact call from the session that surfaced this, end to end.
    #[test]
    fn a_file_read_window_arrives_as_the_range_that_was_asked_for() {
        use cursor_proto::shim::{value::Kind, Value as ShimValue};

        let mut args = std::collections::BTreeMap::new();
        for (key, n) in [("start_line", 960.0), ("end_line", 1260.0)] {
            args.insert(
                key.to_string(),
                ShimValue {
                    kind: Some(Kind::NumberValue(n)),
                }
                .encode_to_vec(),
            );
        }

        let decoded = decode_args(&args);
        assert_eq!(decoded["start_line"].as_u64(), Some(960));
        assert_eq!(decoded["end_line"].as_u64(), Some(1260));
    }

    /// Model used by the live tests. Deliberately the non-`fast` variant:
    /// `-fast` is a real mode Aurora will offer, but a slower model gives the
    /// streaming path more chances to split a frame across chunks.
    #[cfg(test)]
    const LIVE_MODEL: &str = "cursor-grok-4.6-high";

    async fn drain(
        turn: RunTurn<'_>,
    ) -> (Vec<TurnEvent>, DoneReason) {
        let (tx, mut rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let runner = tokio::spawn(async move {
            let mut collected = Vec::new();
            while let Some(event) = rx.recv().await {
                collected.push(event);
            }
            collected
        });

        run_turn(turn, tx, cancel).await.expect("turn");
        let events = runner.await.expect("collector");

        let done = events
            .iter()
            .rev()
            .find_map(|e| match e {
                TurnEvent::Done(reason) => Some(reason.clone()),
                _ => None,
            })
            .expect("a turn must always end with exactly one Done");
        (events, done)
    }

    /// A real streaming turn, no tools.
    ///
    /// ```text
    /// cargo test --lib api::cursor::session -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "calls Cursor's live API with the developer's session"]
    async fn streams_a_real_turn() {
        let token = crate::api::cursor::auth::fresh_access(false)
            .await
            .expect("a signed-in Cursor session is required");

        let messages = [crate::agent_runtime::types::ConversationMessage {
            role: crate::agent_runtime::types::MessageRole::User,
            blocks: vec![crate::agent_runtime::types::ContentBlock::Text {
                text: "Reply with exactly the word: AURORA-OK".into(),
            }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        }];
        let input = build_turn_input(
            Some("You are running inside Aurora. Follow instructions exactly."),
            &messages,
        );

        let (events, done) = drain(RunTurn {
            access_token: &token,
            model: LIVE_MODEL,
            input,
            tools: Vec::new(),
        })
        .await;

        let text: String = events
            .iter()
            .filter_map(|e| match e {
                TurnEvent::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        let thinking: usize = events
            .iter()
            .filter(|e| matches!(e, TurnEvent::Thinking(_)))
            .count();

        println!("done:     {done:?}");
        println!("text:     {text}");
        println!("thinking: {thinking} deltas");
        println!("events:   {}", events.len());

        assert_eq!(done, DoneReason::Stop, "the turn must end cleanly");
        assert!(!text.trim().is_empty(), "the model must have said something");
    }

    /// The one that decides everything: does the model call **Aurora's** tools,
    /// with Cursor's own built-ins hidden?
    #[tokio::test]
    #[ignore = "calls Cursor's live API with the developer's session"]
    async fn a_real_turn_calls_auroras_tools() {
        use crate::agent_runtime::api_client::ToolSchema;

        let token = crate::api::cursor::auth::fresh_access(false)
            .await
            .expect("a signed-in Cursor session is required");

        let messages = [crate::agent_runtime::types::ConversationMessage {
            role: crate::agent_runtime::types::MessageRole::User,
            blocks: vec![crate::agent_runtime::types::ContentBlock::Text {
                text: "Read the file src/main.rs and tell me what it contains.".into(),
            }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        }];
        let input = build_turn_input(
            Some(
                "You are Aurora's coding agent. To read a file you MUST call the file_read \
                 tool. Never guess file contents.",
            ),
            &messages,
        );

        let tools = crate::api::cursor::history::build_tools(&[ToolSchema {
            name: "file_read".into(),
            description: "Read a file from the workspace.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        }]);

        let (events, done) = drain(RunTurn {
            access_token: &token,
            model: LIVE_MODEL,
            input,
            tools,
        })
        .await;

        println!("done: {done:?}");
        for event in &events {
            match event {
                TurnEvent::ToolCall { id, name, args } => {
                    println!("TOOL  {name} id={id} args={args}")
                }
                TurnEvent::Text(t) => println!("TEXT  {t}"),
                TurnEvent::Usage { tokens } => println!("USAGE {tokens:?}"),
                _ => {}
            }
        }

        let calls: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                TurnEvent::ToolCall { name, args, .. } => Some((name.clone(), args.clone())),
                _ => None,
            })
            .collect();

        assert_eq!(
            done,
            DoneReason::ToolCalls,
            "the turn must hand control back for Aurora to run the tool"
        );
        assert_eq!(calls.len(), 1, "expected exactly one tool call");
        assert_eq!(
            calls[0].0, "file_read",
            "the model must call Aurora's tool, not one of Cursor's"
        );
        assert!(
            calls[0].1.get("path").is_some(),
            "arguments must decode, got: {}",
            calls[0].1
        );
    }

    /// Proves Cursor's own built-in tools are invisible to the model.
    ///
    /// Sends **no** tools at all and asks for something only a file-reading
    /// tool could do. If the allowed-tools header works, the model has nothing
    /// to call and must say so. If Cursor's natives were still reachable it
    /// would call one — which arrives as a non-MCP exec request and trips the
    /// loud error in [`handle`].
    #[tokio::test]
    #[ignore = "calls Cursor's live API with the developer's session"]
    async fn cursors_own_tools_are_hidden_from_the_model() {
        let token = crate::api::cursor::auth::fresh_access(false)
            .await
            .expect("a signed-in Cursor session is required");

        let messages = [crate::agent_runtime::types::ConversationMessage {
            role: crate::agent_runtime::types::MessageRole::User,
            blocks: vec![crate::agent_runtime::types::ContentBlock::Text {
                text: "Read the file src/main.rs and print its exact contents. \
                       If you have no tool available to read files, reply with \
                       exactly: NO-TOOLS-AVAILABLE"
                    .into(),
            }],
            usage: None,
            timestamp: 0,
            attached_selected_elements: None,
            attached_prompt_chips: None,
            model: None,
        }];

        let (events, done) = drain(RunTurn {
            access_token: &token,
            model: LIVE_MODEL,
            input: build_turn_input(None, &messages),
            // Deliberately empty.
            tools: Vec::new(),
        })
        .await;

        let text: String = events
            .iter()
            .filter_map(|e| match e {
                TurnEvent::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        let tool_calls = events
            .iter()
            .filter(|e| matches!(e, TurnEvent::ToolCall { .. }))
            .count();

        println!("done: {done:?}");
        println!("text: {text}");
        println!("tool calls: {tool_calls}");

        assert_eq!(
            tool_calls, 0,
            "with no tools declared, nothing should be callable"
        );
        assert!(
            !matches!(done, DoneReason::Error(_)),
            "a native tool request would have failed the turn here: {done:?}"
        );
    }

    #[test]
    fn an_unparseable_argument_keeps_its_text_rather_than_vanishing() {
        assert_eq!(decode_arg(b""), serde_json::Value::Null);
        // Losing an argument silently would make a tool call fail for reasons
        // nothing in the transcript explains.
        let decoded = decode_arg(&[0xFF, 0xFF, 0xFF]);
        assert!(!decoded.is_null());
    }
}
