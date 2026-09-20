//! Pictures made on the user's ChatGPT subscription, not on an image API key.
//!
//! There is **no image endpoint** on the ChatGPT backend. Generation is the
//! Responses API with the hosted `image_generation` tool, posted to the same
//! `https://chatgpt.com/backend-api/codex/responses` the chat adapter already
//! uses ([`crate::api::codex::adapter`]), and the finished picture arrives as
//! base64 inside the SSE stream. Nothing is downloaded afterwards.
//!
//! ## Two ways to name a model
//!
//! The backend accepts the image tool under two arrangements, and which one a
//! request uses is decided by the model key alone:
//!
//! - **`gpt-image-*`** — the image model is a TOOL model. The request's own
//!   `model` is the carrier [`CARRIER_MODEL`], the picture model goes in
//!   `tools[0].model`, and `tool_choice` forces the tool so the carrier cannot
//!   answer in prose instead. This is the arrangement that can `edit`.
//! - **`<chat model>-image`** (`gpt-5.5-image`, `gpt-5.6-sol-image`, …) — a
//!   local spelling, not a model the backend knows. The suffix is stripped and
//!   that chat model is asked with the tool merely available (`tool_choice:
//!   "auto"`). It decides for itself whether to draw.
//!
//! The split, the carrier model and the header set are all measured from a
//! relay that ships this path live (`9router`,
//! `open-sse/handlers/imageProviders/codex.js`), whose own tests assert the
//! exact request. None of it is documented by OpenAI and all of it can change
//! without notice.
//!
//! ## Identity on the wire
//!
//! Unlike the chat adapter, which identifies Aurora honestly as `originator:
//! aurora`, this path presents as the Codex CLI (`codex_cli_rs`, with its
//! `version` header). Image generation is a newer and narrower surface than
//! chat, and the only client configuration observed to be served by it is the
//! CLI's. Aurora is already a Codex client by every other measure — the CLI's
//! OAuth client id, the CLI's `auth.json` — so this is the same claim stated
//! in the one place the backend is known to check it.

use base64::Engine;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde_json::{json, Value};

use crate::api::codex::auth::{self, CodexAccess};
use crate::api::codex::CODEX_RESPONSES_URL;

use super::client::ImageError;
use super::wire::{
    data_url, DiscoveredModel, Discovery, EditSource, GenerationCall, ImageOutput, ImageResponse,
    WireError,
};

/// The Codex CLI release this path claims to be. Bump it when the CLI moves
/// far enough that the backend starts refusing this one.
const CODEX_CLI_VERSION: &str = "0.154.0";
const ORIGINATOR: &str = "codex_cli_rs";

/// The chat model that carries a `gpt-image-*` request. Not a choice Aurora
/// makes — the tool models are not addressable as a request's own `model`.
const CARRIER_MODEL: &str = "gpt-5.5";

/// Model keys that are TOOL models. Anything else is a chat model, with or
/// without the local `-image` spelling.
const TOOL_IMAGE_MODELS: &[&str] = &[
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-2.5",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
];

/// The local suffix that means "ask this chat model to draw".
const MODEL_SUFFIX: &str = "-image";

/// How closely the backend should look at a picture being edited.
const REF_DETAIL: &str = "high";

/// Longest SSE body Aurora will read before giving up. One 1536² PNG is
/// roughly 3 MiB of base64 and the stream also carries partial previews, so
/// this is generous rather than tight; it exists to stop a stream that never
/// ends from filling memory.
const MAX_STREAM_BYTES: usize = 128 * 1024 * 1024;

/// Which model goes where, for one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Routing<'a> {
    /// The request's own `model`.
    pub responses_model: &'a str,
    /// The image model, when it is a tool model rather than a chat model.
    pub tool_model: Option<&'a str>,
}

/// Read a model key the way the backend needs it read.
#[must_use]
pub fn route(model: &str) -> Routing<'_> {
    let model = model.trim();
    if TOOL_IMAGE_MODELS.iter().any(|known| known.eq_ignore_ascii_case(model)) {
        return Routing {
            responses_model: CARRIER_MODEL,
            tool_model: Some(model),
        };
    }
    Routing {
        responses_model: model.strip_suffix(MODEL_SUFFIX).unwrap_or(model),
        tool_model: None,
    }
}

/// Every image model this path can address.
///
/// Answered from code, not from the network: the ChatGPT backend's model list
/// is the chat roster and says nothing about drawing. The `-image` entries are
/// Aurora's own spelling for "ask this chat model to draw", so there is nowhere
/// else they could come from.
#[must_use]
pub fn catalog() -> Vec<DiscoveredModel> {
    const CHAT_MODELS: &[&str] = &[
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.3",
    ];
    TOOL_IMAGE_MODELS
        .iter()
        .map(|id| (*id).to_string())
        .chain(CHAT_MODELS.iter().map(|id| format!("{id}{MODEL_SUFFIX}")))
        .map(|id| DiscoveredModel {
            id,
            discovery: Discovery::Tagged,
        })
        .collect()
}

/// Whether the user is signed in, and to which account. The Test button.
pub async fn check_sign_in() -> Result<Option<String>, ImageError> {
    auth::fresh_access(false)
        .await
        .map(|access| access.account_id)
        .map_err(|message| ImageError::Wire(WireError::InvalidRequest(message)))
}

/// Only a tool model can be told to edit. A chat model with the tool merely
/// available decides for itself, which is not an edit anyone asked for.
#[must_use]
pub fn can_edit(model: &str) -> bool {
    route(model).tool_model.is_some()
}

/// Refuse what the backend would refuse, before spending the call.
pub fn validate(call: GenerationCall<'_>, source: Option<EditSource<'_>>) -> Result<(), WireError> {
    let invalid = |message: &str| WireError::InvalidRequest(format!("Codex: {message}"));
    if call.prompt.trim().is_empty() {
        return Err(invalid("an image prompt cannot be empty"));
    }
    if let Some(size) = call.size.map(str::trim).filter(|size| !size.is_empty()) {
        if !size.eq_ignore_ascii_case("auto") && dimensions(size).is_none() {
            return Err(invalid("size must be WIDTHxHEIGHT, or 'auto'"));
        }
    }
    if source.is_some() && !can_edit(call.model) {
        return Err(invalid(&format!(
            "{} cannot edit a picture. Only the gpt-image-* models can; a `-image` chat model only \
makes new ones.",
            call.model
        )));
    }
    Ok(())
}

fn dimensions(size: &str) -> Option<(u32, u32)> {
    let (w, h) = size.trim().split_once(['x', 'X'])?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// The Responses body for one picture.
///
/// `store: false` and `stream: true` are not options: the backend has no
/// storage for a Codex response and answers this endpoint only as a stream.
#[must_use]
pub fn generation_body(call: GenerationCall<'_>, source: Option<EditSource<'_>>) -> Value {
    let routing = route(call.model);
    // Inlined as bytes even when Aurora knows a URL for the same picture: the
    // backend does not fetch a reference itself, and a URL it ignores is a
    // picture of nothing rather than an error.
    let refs: Vec<String> = source
        .map(|source| vec![data_url(source.media_type, source.bytes)])
        .unwrap_or_default();

    let mut tool = json!({ "type": "image_generation", "output_format": "png" });
    if let Some(tool_model) = routing.tool_model {
        tool["model"] = Value::String(tool_model.to_string());
        tool["action"] = Value::String(if refs.is_empty() { "generate" } else { "edit" }.into());
    }
    if let Some(size) = call.size.map(str::trim).filter(|size| !size.is_empty()) {
        tool["size"] = Value::String(size.to_string());
    }

    json!({
        "model": routing.responses_model,
        "instructions": "",
        "input": [{
            "type": "message",
            "role": "user",
            "content": content_blocks(call.prompt, &refs),
        }],
        "tools": [tool],
        "tool_choice": match routing.tool_model {
            Some(_) => json!({ "type": "image_generation" }),
            None => json!("auto"),
        },
        "parallel_tool_calls": false,
        "prompt_cache_key": uuid::Uuid::new_v4().to_string(),
        "stream": true,
        "store": false,
        "reasoning": match routing.tool_model {
            Some(_) => json!({ "effort": "medium", "summary": "auto" }),
            None => Value::Null,
        },
    })
}

/// References first, each wrapped in a named tag, then the prompt. The tags
/// are what let a prompt say "the woman in image1" and be understood.
fn content_blocks(prompt: &str, refs: &[String]) -> Vec<Value> {
    let mut content = Vec::with_capacity(refs.len() * 3 + 1);
    for (index, url) in refs.iter().enumerate() {
        content.push(json!({ "type": "input_text", "text": format!("<image name=image{}>", index + 1) }));
        content.push(json!({ "type": "input_image", "image_url": url, "detail": REF_DETAIL }));
        content.push(json!({ "type": "input_text", "text": "</image>" }));
    }
    content.push(json!({ "type": "input_text", "text": prompt }));
    content
}

fn headers(access: &CodexAccess, session_id: &str) -> Result<HeaderMap, WireError> {
    let bad = |what: &str| WireError::InvalidRequest(format!("Codex: {what}"));
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/event-stream, application/json"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&format!("{ORIGINATOR}/{CODEX_CLI_VERSION}"))
            .map_err(|_| bad("the user agent could not be built"))?,
    );
    headers.insert("originator", HeaderValue::from_static(ORIGINATOR));
    headers.insert("version", HeaderValue::from_static(CODEX_CLI_VERSION));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", access.access_token))
            .map_err(|_| bad("the access token is not a usable header value"))?,
    );
    // Sent even when unknown: the backend treats a missing header and an empty
    // one the same way, and an empty one keeps the header set identical across
    // accounts that do and do not carry an id.
    headers.insert(
        "chatgpt-account-id",
        HeaderValue::from_str(access.account_id.as_deref().unwrap_or(""))
            .map_err(|_| bad("the ChatGPT account id is not a usable header value"))?,
    );
    headers.insert(
        "session_id",
        HeaderValue::from_str(session_id).map_err(|_| bad("the session id could not be built"))?,
    );
    headers.insert(
        "x-client-request-id",
        HeaderValue::from_str(&uuid::Uuid::new_v4().to_string())
            .map_err(|_| bad("the request id could not be built"))?,
    );
    Ok(headers)
}

/// How many spent accounts one picture will step past before giving up. A
/// bound rather than "all of them" so a store where every account reports a
/// limit cannot turn one call into one request per account, forever.
const MAX_ACCOUNT_ROTATIONS: usize = 4;

/// Make one picture on the signed-in ChatGPT account.
///
/// `source` present means an edit.
///
/// Two things can make the same request worth sending again, and they are not
/// the same thing:
///
/// - **401** — a token that has not expired can still have been revoked (a
///   password change, a signed-out session), and there is no way to learn that
///   except by being refused. Refresh once and retry.
/// - **429** — this account's window is spent. Aurora holds several ChatGPT
///   accounts ([`crate::api::codex::accounts`]) and the chat turn already
///   steps to the next one; a picture does the same, for the same reason. The
///   account is marked spent so the switcher shows it and the next call does
///   not open on it.
pub async fn run(
    http: &reqwest::Client,
    call: GenerationCall<'_>,
    source: Option<EditSource<'_>>,
) -> Result<ImageResponse, ImageError> {
    validate(call, source)?;
    let body = generation_body(call, source);
    let session_id = uuid::Uuid::new_v4().to_string();

    let signed_out = |message: String| ImageError::Wire(WireError::InvalidRequest(message));
    // Whichever account is serving right now — exhausted ones are already
    // filtered out by the store, so this is never one Aurora knows is spent.
    let mut access = auth::fresh_access(false).await.map_err(signed_out)?;

    let mut refreshed_once = false;
    let mut rotations = 0usize;
    let response = loop {
        let headers = headers(&access, &session_id)?;
        let response = http
            .post(CODEX_RESPONSES_URL)
            .headers(headers)
            .json(&body)
            .timeout(super::client::GENERATION_TIMEOUT)
            .send()
            .await
            .map_err(|error| ImageError::Transport {
                url: CODEX_RESPONSES_URL.to_string(),
                reason: error.to_string(),
            })?;
        let status = response.status().as_u16();
        if status == 401 && !refreshed_once {
            refreshed_once = true;
            access = auth::fresh_access(true).await.map_err(signed_out)?;
            continue;
        }
        if status == 429 && rotations < MAX_ACCOUNT_ROTATIONS {
            let body = response.text().await.unwrap_or_default();
            if let Some(next) = rotate_account(&access, &body) {
                rotations += 1;
                // The new account brings its own token, so a 401 on it is a
                // fact about that account and deserves its own refresh.
                refreshed_once = false;
                crate::logging::log_warn(
                    "codex.image",
                    &format!(
                        "ChatGPT account reported its limit reached while making a picture — continuing on {next}"
                    ),
                );
                access = auth::fresh_access(false).await.map_err(signed_out)?;
                continue;
            }
            return Err(ImageError::Wire(status_error(429, &body)));
        }
        break response;
    };

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(ImageError::Wire(status_error(status, &body)));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut read = 0usize;
    let mut parser = StreamState::default();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| ImageError::Transport {
            url: CODEX_RESPONSES_URL.to_string(),
            reason: format!("the stream stopped early: {error}"),
        })?;
        read += chunk.len();
        if read > MAX_STREAM_BYTES {
            return Err(ImageError::Transport {
                url: CODEX_RESPONSES_URL.to_string(),
                reason: "the stream did not end".into(),
            });
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        drain_events(&mut buffer, &mut parser);
        if parser.image.is_some() {
            break;
        }
    }

    parser.finish()
}

/// Mark the account that just hit its limit and name the one taking over.
///
/// `None` means there is nobody to hand to — a single account, or every other
/// one already spent — and the caller should report the limit instead of
/// retrying into the same wall.
fn rotate_account(access: &CodexAccess, body: &str) -> Option<String> {
    let spent = access.account_id.as_deref()?;
    let reset_in = crate::api::codex::adapter::reset_after_seconds(body);
    let next = crate::api::codex::accounts::note_exhausted(spent, reset_in)?;
    Some(next.email.unwrap_or(next.account_id))
}

/// What one stream has told us so far.
#[derive(Debug, Default)]
struct StreamState {
    image: Option<String>,
    usage: Option<Value>,
    /// The backend's own words, when it failed inside a 200.
    failure: Option<String>,
}

impl StreamState {
    fn finish(self) -> Result<ImageResponse, ImageError> {
        if let Some(image) = self.image {
            // Decoded here rather than at the call site so a truncated stream
            // is reported as this provider's failure and not as "the bytes
            // were not an image".
            base64::engine::general_purpose::STANDARD
                .decode(image.trim())
                .map_err(|error| ImageError::Decode(error.to_string()))?;
            return Ok(ImageResponse {
                images: vec![ImageOutput {
                    url: None,
                    b64_json: Some(image),
                    revised_prompt: None,
                }],
                usage: self.usage,
            });
        }
        Err(ImageError::Wire(WireError::Provider {
            status: 200,
            code: None,
            // The backend states no reason here, so neither does Aurora. The
            // guess that used to be in this string — "your plan is too low" —
            // came from a third party's interface copy, not from anything
            // measured, and a guess printed as a fact sends the user to fix
            // the wrong thing.
            message: self.failure.unwrap_or_else(|| {
                "ChatGPT answered without making a picture and gave no reason for it. If it keeps \
happening, check the account under Settings → Providers → Codex."
                    .into()
            }),
        }))
    }
}

/// Take every complete SSE frame out of `buffer` and read it.
///
/// A frame is `event:` and `data:` lines up to a blank line. Several `data:`
/// lines in one frame are concatenated, which is how a payload longer than the
/// backend's line budget arrives.
fn drain_events(buffer: &mut String, state: &mut StreamState) {
    while let Some(end) = find_frame_end(buffer) {
        let frame = buffer[..end.0].to_string();
        buffer.drain(..end.1);
        let mut name = String::new();
        let mut data = String::new();
        for line in frame.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data.push_str(rest.trim());
            }
        }
        if name.is_empty() || data.is_empty() {
            continue;
        }
        read_event(&name, &data, state);
    }
}

/// `(content length, total length)` of the first complete frame, if there is
/// one. Both separators are accepted because the framing is the network's, not
/// the backend's, and a proxy may rewrite line endings.
fn find_frame_end(buffer: &str) -> Option<(usize, usize)> {
    let lf = buffer.find("\n\n").map(|at| (at, at + 2));
    let crlf = buffer.find("\r\n\r\n").map(|at| (at, at + 4));
    match (lf, crlf) {
        (Some(lf), Some(crlf)) => Some(if lf.0 <= crlf.0 { lf } else { crlf }),
        (Some(one), None) | (None, Some(one)) => Some(one),
        (None, None) => None,
    }
}

fn read_event(name: &str, data: &str, state: &mut StreamState) {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };
    match name {
        // The finished picture: raw base64, no `data:` prefix.
        "response.output_item.done" => {
            let item = value.get("item");
            let is_image = item
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                == Some("image_generation_call");
            if is_image {
                if let Some(result) = item
                    .and_then(|item| item.get("result"))
                    .and_then(Value::as_str)
                    .filter(|result| !result.is_empty())
                {
                    state.image = Some(result.to_string());
                }
            }
        }
        "response.completed" => {
            if let Some(usage) = value.pointer("/response/usage") {
                state.usage = Some(usage.clone());
            }
        }
        // A refusal that arrived inside a 200. Its message is the only honest
        // thing to show, and it is usually about entitlement.
        "response.failed" | "response.incomplete" | "error" => {
            if state.failure.is_none() {
                state.failure = error_message(&value);
            }
        }
        // `response.image_generation_call.partial_image` carries a preview of
        // the picture being drawn. Aurora shows the finished one, so it is
        // read past rather than kept.
        _ => {}
    }
}

fn error_message(value: &Value) -> Option<String> {
    for path in [
        "/response/error/message",
        "/error/message",
        "/message",
        "/response/incomplete_details/reason",
    ] {
        if let Some(text) = value.pointer(path).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

/// A non-2xx, said in the backend's own words where it gave any.
fn status_error(status: u16, body: &str) -> WireError {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed.as_ref().and_then(error_message);
    let code = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/type").or_else(|| value.pointer("/error/code")))
        .and_then(Value::as_str)
        .map(str::to_string);
    match (status, message) {
        (401 | 403, _) => WireError::Provider {
            status,
            code,
            message: "ChatGPT refused the sign-in. Open Settings → Providers → Codex and sign in \
again."
                .into(),
        },
        (429, message) => WireError::Provider {
            status,
            code,
            message: message.unwrap_or_else(|| {
                "ChatGPT's usage limit for this plan is reached. It resets on a rolling window."
                    .into()
            }),
        },
        (_, Some(message)) => WireError::Provider {
            status,
            code,
            message,
        },
        (_, None) => WireError::Http {
            status,
            body: body.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(model: &'static str, size: Option<&'static str>) -> GenerationCall<'static> {
        GenerationCall {
            model,
            prompt: "a red square",
            size,
            format: None,
        }
    }

    fn source() -> EditSource<'static> {
        EditSource {
            bytes: b"\x89PNG\r\n\x1a\n",
            media_type: "image/png",
            file_name: "001-generated-red.png",
            remote_url: Some("https://example.invalid/red.png"),
        }
    }

    #[test]
    fn a_tool_model_rides_the_carrier_and_forces_the_tool() {
        let body = generation_body(call("gpt-image-2.5", Some("1024x1024")), None);
        assert_eq!(body["model"], "gpt-5.5");
        assert_eq!(body["tools"][0]["model"], "gpt-image-2.5");
        assert_eq!(body["tools"][0]["action"], "generate");
        assert_eq!(body["tools"][0]["size"], "1024x1024");
        assert_eq!(body["tool_choice"]["type"], "image_generation");
        assert_eq!(body["reasoning"]["effort"], "medium");
    }

    #[test]
    fn a_suffixed_chat_model_is_asked_under_its_real_name_with_the_tool_merely_offered() {
        let body = generation_body(call("gpt-5.5-image", None), None);
        assert_eq!(body["model"], "gpt-5.5");
        assert!(body["tools"][0].get("model").is_none(), "no tool model");
        assert!(body["tools"][0].get("action").is_none(), "no action");
        assert_eq!(body["tool_choice"], "auto");
        assert!(body["reasoning"].is_null());
    }

    #[test]
    fn the_stream_is_never_stored_and_always_streamed() {
        let body = generation_body(call("gpt-image-2", None), None);
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["parallel_tool_calls"], false);
        assert_eq!(body["instructions"], "");
    }

    #[test]
    fn an_edit_inlines_the_source_even_when_it_has_a_url() {
        // The backend does not fetch a reference itself, so a remote URL is
        // exactly the case that would silently produce a picture of nothing.
        let body = generation_body(call("gpt-image-2.5", None), Some(source()));
        let content = body["input"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 4, "tag, image, close tag, prompt");
        assert_eq!(content[0]["text"], "<image name=image1>");
        assert!(content[1]["image_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(content[2]["text"], "</image>");
        assert_eq!(content[3]["text"], "a red square");
        assert_eq!(body["tools"][0]["action"], "edit");
    }

    #[test]
    fn only_a_tool_model_may_be_asked_to_edit() {
        assert!(can_edit("gpt-image-1.5"));
        assert!(!can_edit("gpt-5.5-image"));
        let refused = validate(call("gpt-5.5-image", None), Some(source())).unwrap_err();
        assert!(refused.to_string().contains("cannot edit"));
    }

    #[test]
    fn a_size_that_is_not_a_size_is_refused_before_the_call() {
        assert!(validate(call("gpt-image-2", Some("huge")), None).is_err());
        assert!(validate(call("gpt-image-2", Some("auto")), None).is_ok());
        assert!(validate(call("gpt-image-2", Some("1536x1024")), None).is_ok());
    }

    #[test]
    fn the_finished_picture_is_read_out_of_the_done_frame() {
        let mut buffer = String::new();
        let mut state = StreamState::default();
        buffer.push_str(
            "event: response.image_generation_call.partial_image\n\
             data: {\"partial_image_b64\":\"cGFydGlhbA==\",\"partial_image_index\":0}\n\n\
             event: response.output_item.done\n\
             data: {\"item\":{\"type\":\"image_generation_call\",\"result\":\"ZmluYWw=\"}}\n\n",
        );
        drain_events(&mut buffer, &mut state);
        let response = state.finish().unwrap();
        assert_eq!(response.images[0].b64_json.as_deref(), Some("ZmluYWw="));
    }

    #[test]
    fn a_frame_split_across_chunks_is_still_read() {
        let mut buffer = String::new();
        let mut state = StreamState::default();
        buffer.push_str("event: response.output_item.done\ndata: {\"item\":{\"type\":\"im");
        drain_events(&mut buffer, &mut state);
        assert!(state.image.is_none(), "an incomplete frame says nothing");
        buffer.push_str("age_generation_call\",\"result\":\"ZmluYWw=\"}}\n\n");
        drain_events(&mut buffer, &mut state);
        assert_eq!(state.image.as_deref(), Some("ZmluYWw="));
    }

    #[test]
    fn a_stream_that_carried_no_picture_says_what_the_backend_said() {
        let mut buffer = String::new();
        let mut state = StreamState::default();
        buffer.push_str(
            "event: response.failed\n\
             data: {\"response\":{\"error\":{\"message\":\"Image generation is not available on your plan.\"}}}\n\n",
        );
        drain_events(&mut buffer, &mut state);
        let error = state.finish().unwrap_err();
        assert!(error.to_string().contains("not available on your plan"));
    }

    #[test]
    fn a_stream_that_said_nothing_at_all_reports_that_and_not_a_cause() {
        let error = StreamState::default().finish().unwrap_err().to_string();
        assert!(error.contains("gave no reason"));
        // Nothing measured says which plans serve this, so nothing here may
        // tell the user their plan is the problem.
        assert!(!error.contains("Plus") && !error.contains("Pro"), "{error}");
    }

    #[test]
    fn a_refused_sign_in_says_where_to_fix_it() {
        let error = status_error(401, r#"{"error":{"message":"invalid token"}}"#);
        assert!(error.to_string().contains("Settings"));
    }
}
