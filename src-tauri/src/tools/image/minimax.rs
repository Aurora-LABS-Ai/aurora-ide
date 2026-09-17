//! Native MiniMax image-01, including character-reference generation.
//! Contracts: https://platform.minimax.io/docs/api-reference/image-generation-t2i.md
//! and https://platform.minimax.io/docs/api-reference/image-generation-i2i.md

use super::config::ImageRequestFormat;
use super::wire::{data_url, EditSource, GenerationCall, ImageOutput, ImageResponse, WireError};
use serde_json::{json, Value};

pub fn validate(call: GenerationCall<'_>, source: Option<EditSource<'_>>) -> Result<(), WireError> {
    let invalid = |message: &str| WireError::InvalidRequest(format!("MiniMax: {message}"));
    if call.prompt.trim().is_empty() || call.prompt.chars().count() > 1500 {
        return Err(invalid("image prompts must contain 1-1500 characters"));
    }
    if let Some(size) = call.size {
        if dimensions(size).is_none() {
            return Err(invalid(
                "size must be WIDTHxHEIGHT, each 512-2048 pixels and divisible by 8",
            ));
        }
    }
    if let Some(source) = source {
        if !matches!(source.media_type, "image/png" | "image/jpeg")
            || source.bytes.len() >= 10 * 1024 * 1024
        {
            return Err(invalid(
                "portrait references must be PNG or JPEG and smaller than 10 MiB",
            ));
        }
    }
    Ok(())
}

fn dimensions(size: &str) -> Option<(u32, u32)> {
    let (w, h) = size.trim().split_once('x')?;
    let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
    ((512..=2048).contains(&w) && (512..=2048).contains(&h) && w % 8 == 0 && h % 8 == 0)
        .then_some((w, h))
}

pub fn generation_body(call: GenerationCall<'_>) -> Value {
    let mut body = json!({"model":call.model,"prompt":call.prompt,"n":1,"prompt_optimizer":false,
        "response_format": if call.format == Some(ImageRequestFormat::B64Json) { "base64" } else { "url" }});
    if let Some((width, height)) = call.size.and_then(dimensions) {
        body["width"] = json!(width);
        body["height"] = json!(height);
    }
    body
}

pub fn reference_body(call: GenerationCall<'_>, source: EditSource<'_>) -> Value {
    let mut body = generation_body(call);
    // Saved URLs expire after 24 hours. The local copy remains authoritative.
    body["subject_reference"] =
        json!([{"type":"character", "image_file":data_url(source.media_type, source.bytes)}]);
    body
}

pub fn parse_response(status: u16, body: &str) -> Result<ImageResponse, WireError> {
    let parsed: Value = serde_json::from_str(body).map_err(|_| WireError::NotJson {
        status,
        body: body.chars().take(800).collect(),
    })?;
    if let Some(code) = parsed
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .filter(|c| *c != 0)
    {
        return Err(WireError::Provider {
            status,
            code: Some(code.to_string()),
            message: parsed
                .pointer("/base_resp/status_msg")
                .and_then(Value::as_str)
                .unwrap_or("Request refused")
                .to_string(),
        });
    }
    if !(200..300).contains(&status) || parsed.get("error").is_some() {
        return super::wire::parse_response(status, body);
    }
    let mut images = Vec::new();
    for (field, encoded) in [("image_urls", false), ("image_base64", true)] {
        if let Some(values) = parsed
            .get("data")
            .and_then(|d| d.get(field))
            .and_then(Value::as_array)
        {
            for value in values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if !encoded
                    && !reqwest::Url::parse(value).is_ok_and(|u| {
                        matches!(u.scheme(), "https" | "http")
                            && u.host_str().is_some()
                            && u.username().is_empty()
                            && u.password().is_none()
                    })
                {
                    continue;
                }
                images.push(ImageOutput {
                    url: (!encoded).then(|| value.to_string()),
                    b64_json: encoded.then(|| value.to_string()),
                    revised_prompt: None,
                });
            }
        }
    }
    if images.is_empty() {
        return Err(WireError::NoImage);
    }
    Ok(ImageResponse {
        images,
        usage: parsed.get("metadata").cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call() -> GenerationCall<'static> {
        GenerationCall {
            model: "image-01",
            prompt: "A portrait",
            size: Some("1280x720"),
            format: Some(ImageRequestFormat::B64Json),
        }
    }
    #[test]
    fn native_body_uses_dimensions_base64_and_character_reference() {
        let source = EditSource {
            bytes: b"image",
            media_type: "image/png",
            file_name: "test.png",
            remote_url: Some("https://expired.example/test.png"),
        };
        validate(call(), Some(source)).unwrap();
        let body = reference_body(call(), source);
        assert_eq!(body["width"], 1280);
        assert_eq!(body["height"], 720);
        assert_eq!(body["response_format"], "base64");
        assert!(body.get("size").is_none());
        assert_eq!(body["subject_reference"][0]["type"], "character");
        assert!(body["subject_reference"][0]["image_file"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
    #[test]
    fn validates_before_spending_and_reads_errors_inside_http_200() {
        assert!(validate(
            GenerationCall {
                size: Some("1025x1024"),
                ..call()
            },
            None
        )
        .is_err());
        let long = "x".repeat(1501);
        assert!(validate(
            GenerationCall {
                prompt: &long,
                ..call()
            },
            None
        )
        .is_err());
        let error = parse_response(
            200,
            r#"{"base_resp":{"status_code":1008,"status_msg":"Insufficient balance"}}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("1008"));
        assert!(parse_response(
            200,
            r#"{"base_resp":{"status_code":0},"data":{"image_urls":[]}}"#
        )
        .is_err());
    }
    #[test]
    fn reads_both_native_output_shapes() {
        assert_eq!(parse_response(200,r#"{"base_resp":{"status_code":0},"data":{"image_urls":["https://cdn.example/a.png"]}}"#).unwrap().images.len(),1);
        assert_eq!(
            parse_response(200, r#"{"data":{"image_base64":["aW1hZ2U="]}}"#)
                .unwrap()
                .images[0]
                .b64_json
                .as_deref(),
            Some("aW1hZ2U=")
        );
    }
    #[tokio::test]
    async fn native_http_adapter_sends_character_reference_and_checks_http_200_errors() {
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
                r#"{"data":{"image_base64":["aW1hZ2U="]},"base_resp":{"status_code":0}}"#,
            ),
            Canned::json(
                200,
                r#"{"base_resp":{"status_code":1008,"status_msg":"Insufficient balance"}}"#,
            ),
        ])
        .await;
        let provider: ImageProviderConfig = serde_json::from_value(json!({"id":"mini","name":"MiniMax","baseUrl":server.base_url.trim_end_matches("/v1"),"apiKey":"image-key","apiFormat":"minimax-native"})).unwrap();
        let source = EditSource {
            bytes: b"image",
            media_type: "image/png",
            file_name: "portrait.png",
            remote_url: None,
        };
        ImageClient::new()
            .edit(&provider, call(), source)
            .await
            .unwrap();
        assert!(ImageClient::new()
            .generate(&provider, call())
            .await
            .unwrap_err()
            .to_string()
            .contains("1008"));
        let calls = server.recorded();
        assert_eq!(calls[0].path, "/v1/image_generation");
        assert_eq!(calls[0].header("authorization"), Some("Bearer image-key"));
        assert!(calls[0]
            .header("content-type")
            .unwrap()
            .contains("application/json"));
        assert_eq!(calls[0].json()["subject_reference"][0]["type"], "character");
        assert_eq!(calls[0].json()["response_format"], "base64");
    }
}
