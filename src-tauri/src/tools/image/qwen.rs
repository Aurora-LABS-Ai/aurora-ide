//! Native Qwen (DashScope) images, generation and editing on ONE endpoint.
//!
//! Contracts, read 2026-09-15:
//! - <https://docs.qwencloud.com/api-reference/image-generation/qwen-text-to-image.md>
//! - <https://docs.qwencloud.com/api-reference/image-generation/qwen-image-editing.md>
//!
//! Qwen also publishes an OpenAI-compatible generation endpoint
//! (`/compatible-mode/v1/images/generations`), which Aurora can already speak
//! as [`ImageApiFormat::OpenaiImages`]. It is not enough on its own: **editing
//! has no compatible-mode equivalent**. The native endpoint does both, so one
//! provider row with this format can generate AND edit, which is what the tool
//! advertises per model.
//!
//! Three things differ from every format Aurora already speaks, and each one
//! is a 400 rather than a worse picture if it is guessed:
//!
//! 1. The prompt is not a `prompt` field. It is
//!    `input.messages[0].content[].text`, chat-shaped, and an edit puts an
//!    `{"image": …}` part BEFORE the text part in the same content array.
//! 2. `size` is `WIDTH*HEIGHT`. The asterisk is not interchangeable with the
//!    `x` every other format here uses, so the row stores `1024x1024` like all
//!    the others and this module converts on the wire.
//! 3. The picture comes back at `output.choices[].message.content[].image` as
//!    a URL that **expires after 24 hours**, so the bytes are fetched at once
//!    like every other provider's and the local copy stays authoritative.
//!
//! `prompt_extend` defaults to `true` at the provider, which rewrites the
//! prompt with a language model before drawing. Aurora sends `false`: the
//! prompt already came from a language model that was told to write prose, and
//! rewriting it again is what makes a picture drift from what was asked for.

use super::wire::{data_url, EditSource, GenerationCall, ImageOutput, ImageResponse, WireError};
use serde_json::{json, Value};

/// Longest prompt the generation endpoint documents, in characters. The token
/// limit it actually states (~4,500) cannot be checked without a tokenizer, so
/// this is the cheap guard that catches a runaway prompt before it is billed.
const MAX_PROMPT_CHARS: usize = 4_000;

/// Refuse what the provider would refuse, before spending the call.
pub fn validate(call: GenerationCall<'_>, source: Option<EditSource<'_>>) -> Result<(), WireError> {
    let invalid = |message: &str| WireError::InvalidRequest(format!("Qwen: {message}"));
    if call.prompt.trim().is_empty() || call.prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(invalid(&format!(
            "image prompts must contain 1-{MAX_PROMPT_CHARS} characters"
        )));
    }
    if let Some(size) = call.size {
        if dimensions(size).is_none() {
            return Err(invalid(
                "size must be WIDTHxHEIGHT, each 512-2048 pixels, with an aspect ratio between 1:8 and 8:1",
            ));
        }
    }
    if let Some(source) = source {
        if !matches!(source.media_type, "image/png" | "image/jpeg" | "image/webp") {
            return Err(invalid(
                "the picture to edit must be PNG, JPEG or WebP",
            ));
        }
    }
    Ok(())
}

/// `WIDTHxHEIGHT` as the provider's two numbers, or `None` when it is outside
/// what every Qwen image model accepts.
///
/// One envelope rather than a per-model table on purpose: the documented
/// ranges for the 3.0 and 2.0 series are both 512-2048, and every fixed size
/// the `max`/`plus`/`image` models list (1664*928 … 928*1664) falls inside it.
/// A second roster would be one more thing that can disagree with the first.
fn dimensions(size: &str) -> Option<(u32, u32)> {
    let (w, h) = size.trim().split_once('x')?;
    let (w, h) = (w.trim().parse::<u32>().ok()?, h.trim().parse::<u32>().ok()?);
    let in_range = (512..=2048).contains(&w) && (512..=2048).contains(&h);
    let ratio_ok = w * 8 >= h && h * 8 >= w;
    (in_range && ratio_ok).then_some((w, h))
}

/// The provider's own spelling of a size: `1024*1024`.
fn wire_size(size: &str) -> Option<String> {
    dimensions(size).map(|(w, h)| format!("{w}*{h}"))
}

fn body(model: &str, content: Vec<Value>, size: Option<&str>) -> Value {
    let mut parameters = json!({
        "n": 1,
        "prompt_extend": false,
        "watermark": false,
    });
    if let Some(size) = size.and_then(wire_size) {
        parameters["size"] = json!(size);
    }
    json!({
        "model": model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": parameters,
    })
}

pub fn generation_body(call: GenerationCall<'_>) -> Value {
    body(call.model, vec![json!({"text": call.prompt})], call.size)
}

/// An edit is the same call with the source picture as the first content part.
///
/// The bytes are sent inline rather than the saved remote URL: a provider URL
/// this conversation stored is expired after 24 hours, and the local copy is
/// the one Aurora knows is still there.
pub fn edit_body(call: GenerationCall<'_>, source: EditSource<'_>) -> Value {
    body(
        call.model,
        vec![
            json!({"image": data_url(source.media_type, source.bytes)}),
            json!({"text": call.prompt}),
        ],
        call.size,
    )
}

pub fn parse_response(status: u16, body: &str) -> Result<ImageResponse, WireError> {
    let parsed: Value = serde_json::from_str(body).map_err(|_| WireError::NotJson {
        status,
        body: body.chars().take(800).collect(),
    })?;

    // DashScope names a refusal with a top-level `code`, and does not always
    // pair it with a failing status. The code is the answer whenever there is
    // no output to read, whatever the status line said.
    if parsed.get("output").is_none() {
        if let Some(code) = parsed
            .get("code")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|code| !code.is_empty())
        {
            return Err(WireError::Provider {
                status,
                code: Some(code.to_string()),
                message: parsed
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Request refused")
                    .to_string(),
            });
        }
        // No output and no code of its own: let the shared reader speak, so an
        // OpenAI-shaped error body or a bare failing status reads the same way
        // here as it does for every other provider.
        return super::wire::parse_response(status, body);
    }

    let images: Vec<ImageOutput> = parsed
        .pointer("/output/choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.pointer("/message/content")?.as_array())
        .flatten()
        .filter_map(|part| part.get("image").and_then(Value::as_str))
        .map(str::trim)
        .filter(|url| is_fetchable(url))
        .map(|url| ImageOutput {
            url: Some(url.to_string()),
            b64_json: None,
            revised_prompt: None,
        })
        .collect();

    if images.is_empty() {
        return Err(WireError::NoImage);
    }
    Ok(ImageResponse {
        images,
        usage: parsed.get("usage").cloned(),
    })
}

/// An address Aurora can actually fetch, with no credentials smuggled in it.
fn is_fetchable(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|parsed| {
        matches!(parsed.scheme(), "https" | "http")
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::image::config::ImageRequestFormat;

    fn call() -> GenerationCall<'static> {
        GenerationCall {
            model: "qwen-image-3.0-pro",
            prompt: "A vertical portrait in warm afternoon light",
            size: Some("1024x1536"),
            format: Some(ImageRequestFormat::B64Json),
        }
    }

    fn source() -> EditSource<'static> {
        EditSource {
            bytes: b"image",
            media_type: "image/png",
            file_name: "001-generated.png",
            remote_url: Some("https://expired.example/a.png"),
        }
    }

    #[test]
    fn a_generation_is_chat_shaped_with_an_asterisk_size() {
        let body = generation_body(call());
        assert_eq!(body["model"], "qwen-image-3.0-pro");
        assert_eq!(
            body["input"]["messages"][0]["content"][0]["text"],
            "A vertical portrait in warm afternoon light"
        );
        assert_eq!(body["parameters"]["size"], "1024*1536");
        assert_eq!(body["parameters"]["n"], 1);
        // The prompt is already prose from a language model; do not let the
        // provider rewrite it again.
        assert_eq!(body["parameters"]["prompt_extend"], false);
        // `response_format` belongs to the OpenAI shape and is a 400 here.
        assert!(body["parameters"].get("response_format").is_none());
        assert!(body.get("prompt").is_none());
    }

    #[test]
    fn an_edit_puts_the_picture_before_the_instruction() {
        let body = edit_body(call(), source());
        let content = body["input"]["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert!(content[0]["image"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(content[1]["text"], call().prompt);
    }

    #[test]
    fn a_size_without_an_asterisk_equivalent_is_refused_before_spending() {
        // Below the floor, above the ceiling, and past the 8:1 ratio.
        for size in ["256x256", "4096x4096", "2048x128"] {
            assert!(
                validate(
                    GenerationCall {
                        size: Some(size),
                        ..call()
                    },
                    None
                )
                .is_err(),
                "{size} should be refused"
            );
        }
        assert!(validate(call(), Some(source())).is_ok());
        let long = "x".repeat(MAX_PROMPT_CHARS + 1);
        assert!(validate(
            GenerationCall {
                prompt: &long,
                ..call()
            },
            None
        )
        .is_err());
    }

    #[test]
    fn the_picture_is_read_out_of_the_choice_content() {
        let parsed = parse_response(
            200,
            r#"{"output":{"choices":[{"finish_reason":"stop","message":{"role":"assistant",
               "content":[{"image":"https://dashscope-result.example/a.png?Expires=1"}]}}]},
               "usage":{"output_width":1024,"output_height":1536},"request_id":"r-1"}"#,
        )
        .unwrap();
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(
            parsed.images[0].url.as_deref(),
            Some("https://dashscope-result.example/a.png?Expires=1")
        );
        assert_eq!(parsed.usage.unwrap()["output_width"], 1024);
    }

    #[test]
    fn a_named_refusal_wins_over_the_status_line() {
        let error = parse_response(
            200,
            r#"{"code":"InvalidParameter","message":"size is not supported","request_id":"r-2"}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("InvalidParameter"));
        assert!(error.to_string().contains("size is not supported"));
        // Output present but empty of pictures is its own answer, not a crash.
        assert!(parse_response(200, r#"{"output":{"choices":[]}}"#).is_err());
    }

    #[tokio::test]
    async fn the_http_adapter_posts_the_native_body_and_reads_the_url_back() {
        use crate::tools::image::{
            client::{
                fake_server::{serve, Canned},
                ImageClient,
            },
            config::ImageProviderConfig,
        };
        let server = serve(vec![
            Canned::json(
                200,
                r#"{"output":{"choices":[{"message":{"role":"assistant","content":[{"image":"https://dashscope-result.example/a.png"}]}}]}}"#,
            ),
            Canned::json(
                400,
                r#"{"code":"InvalidApiKey","message":"Invalid API-key provided."}"#,
            ),
        ])
        .await;
        let provider: ImageProviderConfig = serde_json::from_value(json!({
            "id": "qwen",
            "name": "Qwen",
            "baseUrl": server.base_url.trim_end_matches("/v1"),
            "apiKey": "sk-qwen",
            "apiFormat": "qwen-dashscope",
        }))
        .unwrap();

        ImageClient::new()
            .edit(&provider, call(), source())
            .await
            .unwrap();
        assert!(ImageClient::new()
            .generate(&provider, call())
            .await
            .unwrap_err()
            .to_string()
            .contains("InvalidApiKey"));

        let calls = server.recorded();
        assert_eq!(
            calls[0].path,
            "/api/v1/services/aigc/multimodal-generation/generation"
        );
        assert_eq!(calls[0].header("authorization"), Some("Bearer sk-qwen"));
        assert_eq!(calls[0].json()["parameters"]["size"], "1024*1536");
        assert!(calls[0].json()["input"]["messages"][0]["content"][0]["image"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
}
