//! What goes on the wire to an image provider, and what comes back.
//!
//! Pure: nothing here performs I/O, so every shape is unit-tested against the
//! bytes it produces and the bodies it accepts. `client.rs` does the sending.
//!
//! ## The two formats, and why the difference is a type
//!
//! OpenAI's image API generates with a JSON body and EDITS with
//! `multipart/form-data`, the source picture as a file part. a6api copies the
//! generation call and then departs on edits: it rejects multipart outright and
//! wants JSON with `image` as a URL. That was measured (HTTP 400 on OpenAI's
//! own `-F image=@file.png` shape), and it is not something a second provider
//! will copy — the next one will deviate differently. So the format is a
//! property of the provider row and every branch here matches on it.
//!
//! ## Errors under HTTP 200
//!
//! a6api returned `{"error":{"code":"model_not_found"}}` with a 200 status. The
//! status code is therefore not a success signal on this wire, and
//! [`parse_response`] reads the body for an `error` object BEFORE it looks at
//! the status — on every format, because a parser that trusts 200 from one
//! provider and not another is a parser with a provider-shaped hole in it.
//!
//! ## `response_format` is sent only when the row asks for it
//!
//! OpenAI's `gpt-image-*` models reject the field (they only ever return
//! `b64_json`); `dall-e-*` accept it and default to `url`. Sending it blindly
//! is a 400 on one family for a default on the other, so the default —
//! a provider row with no `requestFormat` — omits it and [`parse_response`] accepts
//! whichever of `url` / `b64_json` arrives.
//!
//! A provider row can now ask for one, and it has to be able to. Measured on
//! apikl (`api.apikl.ai`, `gpt-image-2-pro`, 2026-09-04): `/images/generations`
//! answered with `b64_json` and `/images/edits` with a `url`, on the same key
//! and the same model — so "what this provider returns" is not a property of
//! the provider at all. Sending `response_format: "url"` made the generation
//! return a URL too, which is the only way to get one answer from both
//! endpoints. Set it per provider; leave it unset where the field is refused.

use base64::Engine;
use serde_json::{json, Value};

use super::config::{ImageApiFormat, ImageRequestFormat};

/// One call to make a picture.
#[derive(Debug, Clone, Copy)]
pub struct GenerationCall<'a> {
    pub model: &'a str,
    pub prompt: &'a str,
    /// `WIDTHxHEIGHT`, when the caller chose one. Omitted otherwise so the
    /// provider applies the model's own default rather than one Aurora guessed.
    pub size: Option<&'a str>,
    /// What to ask the provider to return. `None` omits `response_format`;
    /// see the module header for why that is the default.
    pub format: Option<ImageRequestFormat>,
}

/// The picture an edit starts from.
#[derive(Debug, Clone, Copy)]
pub struct EditSource<'a> {
    pub bytes: &'a [u8],
    pub media_type: &'a str,
    pub file_name: &'a str,
    /// Where the provider can fetch this picture itself, when Aurora knows —
    /// the URL a generation came back with. a6api wants a URL, and a picture
    /// that has one is sent by reference instead of by value.
    pub remote_url: Option<&'a str>,
}

/// A request body, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestBody {
    Json(Value),
    Multipart {
        /// The `Content-Type` header value, boundary included.
        content_type: String,
        bytes: Vec<u8>,
    },
}

/// The JSON body of a generation. Identical on both formats today.
#[must_use]
pub fn generation_body(_format: ImageApiFormat, call: GenerationCall<'_>) -> Value {
    let mut body = json!({
        "model": call.model,
        "prompt": call.prompt,
        "n": 1,
    });
    if let Some(size) = call.size.map(str::trim).filter(|size| !size.is_empty()) {
        body["size"] = Value::String(size.to_string());
    }
    if let Some(format) = call.format {
        body["response_format"] = Value::String(format.as_str().to_string());
    }
    body
}

/// The body of an edit, in the shape this format actually accepts.
#[must_use]
pub fn edit_body(
    format: ImageApiFormat,
    call: GenerationCall<'_>,
    source: EditSource<'_>,
) -> RequestBody {
    match format {
        ImageApiFormat::A6api => {
            let mut body = generation_body(format, call);
            // Measured: a URL. A picture Aurora holds only as bytes goes as a
            // data URL, which is the one URL form that carries the bytes with
            // it. Whether a6api accepts that form has NOT been probed — a
            // rejection surfaces as the provider's own error, not as a guess.
            let image = match source.remote_url {
                Some(url) => url.to_string(),
                None => data_url(source.media_type, source.bytes),
            };
            body["image"] = Value::String(image);
            RequestBody::Json(body)
        }
        ImageApiFormat::OpenaiImages => {
            let mut form = Multipart::new();
            form.text("model", call.model);
            form.text("prompt", call.prompt);
            form.text("n", "1");
            if let Some(size) = call.size.map(str::trim).filter(|size| !size.is_empty()) {
                form.text("size", size);
            }
            // Same rule as the generation body — a multipart edit carries it as
            // a form field. Measured on apikl: its edit answers with a `url`
            // whether or not this is sent, but a provider whose two endpoints
            // disagree is exactly why the row can ask.
            if let Some(format) = call.format {
                form.text("response_format", format.as_str());
            }
            form.file("image", source.file_name, source.media_type, source.bytes);
            let (content_type, bytes) = form.finish();
            RequestBody::Multipart {
                content_type,
                bytes,
            }
        }
    }
}

/// `data:<media>;base64,<bytes>`.
#[must_use]
pub fn data_url(media_type: &str, bytes: &[u8]) -> String {
    format!(
        "data:{media_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// A `multipart/form-data` body, assembled by hand.
///
/// reqwest's `multipart` feature is not enabled in this crate, and turning it
/// on rebuilds the dependency for thirty lines of framing that are worth being
/// able to read: the boundary, a part header per field, CRLF discipline, and
/// the closing `--`. Every byte of it is asserted in a test.
struct Multipart {
    boundary: String,
    bytes: Vec<u8>,
}

impl Multipart {
    fn new() -> Self {
        // Unique enough that no field value contains it; the bytes of an image
        // are the only unpredictable content and they are binary, not this.
        let boundary = format!("aurora-{}", uuid::Uuid::new_v4().simple());
        Self {
            boundary,
            bytes: Vec::new(),
        }
    }

    #[cfg(test)]
    fn with_boundary(boundary: &str) -> Self {
        Self {
            boundary: boundary.to_string(),
            bytes: Vec::new(),
        }
    }

    fn text(&mut self, name: &str, value: &str) {
        self.open(name, None, None);
        self.bytes.extend_from_slice(value.as_bytes());
        self.bytes.extend_from_slice(b"\r\n");
    }

    fn file(&mut self, name: &str, file_name: &str, media_type: &str, bytes: &[u8]) {
        self.open(name, Some(file_name), Some(media_type));
        self.bytes.extend_from_slice(bytes);
        self.bytes.extend_from_slice(b"\r\n");
    }

    fn open(&mut self, name: &str, file_name: Option<&str>, media_type: Option<&str>) {
        self.bytes
            .extend_from_slice(format!("--{}\r\n", self.boundary).as_bytes());
        let mut disposition = format!("Content-Disposition: form-data; name=\"{name}\"");
        if let Some(file_name) = file_name {
            disposition.push_str(&format!(
                "; filename=\"{}\"",
                file_name.replace('"', "%22")
            ));
        }
        disposition.push_str("\r\n");
        self.bytes.extend_from_slice(disposition.as_bytes());
        if let Some(media_type) = media_type {
            self.bytes
                .extend_from_slice(format!("Content-Type: {media_type}\r\n").as_bytes());
        }
        self.bytes.extend_from_slice(b"\r\n");
    }

    fn finish(mut self) -> (String, Vec<u8>) {
        self.bytes
            .extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        (
            format!("multipart/form-data; boundary={}", self.boundary),
            self.bytes,
        )
    }
}

/// One picture in a response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageOutput {
    pub url: Option<String>,
    pub b64_json: Option<String>,
    /// Some models rewrite the prompt and say so.
    pub revised_prompt: Option<String>,
}

/// A parsed, successful response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageResponse {
    pub images: Vec<ImageOutput>,
    /// The provider's `usage` object verbatim, when it sent one. Its shape is
    /// per provider (a6api bills input tokens and image-output tokens), so it
    /// is passed through rather than modelled.
    pub usage: Option<Value>,
}

/// Why a response was not a picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// The provider said so, in its own words — whatever the status was.
    Provider {
        status: u16,
        code: Option<String>,
        message: String,
    },
    /// A non-2xx status with a body that carried no `error` object.
    Http { status: u16, body: String },
    /// A 2xx with a body that is not JSON.
    NotJson { status: u16, body: String },
    /// A well-formed success that contains no image.
    NoImage,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Provider {
                status,
                code,
                message,
            } => match code {
                Some(code) => write!(
                    f,
                    "the image provider refused the request ({code}, HTTP {status}): {message}"
                ),
                None => write!(
                    f,
                    "the image provider refused the request (HTTP {status}): {message}"
                ),
            },
            Self::Http { status, body } => {
                write!(f, "the image provider answered HTTP {status}: {}", clip(body))
            }
            Self::NotJson { status, body } => write!(
                f,
                "the image provider answered HTTP {status} with something that is not JSON: {}",
                clip(body)
            ),
            Self::NoImage => write!(
                f,
                "the image provider answered without an image — no `data` entry carried a url or \
b64_json"
            ),
        }
    }
}

fn clip(body: &str) -> String {
    const MAX: usize = 300;
    let trimmed = body.trim();
    if trimmed.chars().count() <= MAX {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(MAX).collect();
    out.push('…');
    out
}

/// Read a generation or edit response.
///
/// The body is parsed FIRST. a6api sends errors under HTTP 200, so an `error`
/// object wins over any status; a non-JSON body is only acceptable as an
/// explanation of a failing status, never as a success.
pub fn parse_response(status: u16, body: &str) -> Result<ImageResponse, WireError> {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    if let Some(error) = parsed.as_ref().and_then(|v| v.get("error")) {
        return Err(provider_error(status, error));
    }
    let Some(parsed) = parsed else {
        return Err(if (200..300).contains(&status) {
            WireError::NotJson {
                status,
                body: body.to_string(),
            }
        } else {
            WireError::Http {
                status,
                body: body.to_string(),
            }
        });
    };
    if !(200..300).contains(&status) {
        return Err(WireError::Http {
            status,
            body: body.to_string(),
        });
    }
    let images: Vec<ImageOutput> = parsed
        .get("data")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|entry| ImageOutput {
                    url: string_field(entry, "url"),
                    b64_json: string_field(entry, "b64_json"),
                    revised_prompt: string_field(entry, "revised_prompt"),
                })
                .filter(|image| image.url.is_some() || image.b64_json.is_some())
                .collect()
        })
        .unwrap_or_default();
    if images.is_empty() {
        return Err(WireError::NoImage);
    }
    Ok(ImageResponse {
        images,
        usage: parsed.get("usage").cloned(),
    })
}

fn provider_error(status: u16, error: &Value) -> WireError {
    // `{"error": "string"}` and `{"error": {"message", "code", "type"}}` are
    // both seen in the wild.
    if let Some(text) = error.as_str() {
        return WireError::Provider {
            status,
            code: None,
            message: text.to_string(),
        };
    }
    let code = string_field(error, "code").or_else(|| string_field(error, "type"));
    let message = string_field(error, "message")
        .or_else(|| code.clone())
        .unwrap_or_else(|| error.to_string());
    WireError::Provider {
        status,
        code,
        message,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// How a model made it onto a discovery list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Discovery {
    /// The provider tagged it as an image model. Trustworthy.
    Tagged,
    /// The provider tags nothing; the id LOOKS like an image model. A guess,
    /// and reported as one.
    NameHeuristic,
}

/// One model a provider's `/models` lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: String,
    pub discovery: Discovery,
}

/// The image models in a `GET /models` body.
///
/// a6api tags each model with `supported_endpoint_types`, and image models
/// carry `"image-generation"` — so its list is authoritative. OpenAI's own
/// `/models` tags nothing, so the fallback is the id: anything with `image`,
/// `dall-e`, `imagen` or `flux` in it, and the result says it was a guess.
///
/// The per-model lookup (`/models/{id}`) is never consulted. It reported
/// `gpt-image-2` missing while the list was showing it.
pub fn parse_models(format: ImageApiFormat, status: u16, body: &str) -> Result<Vec<DiscoveredModel>, WireError> {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    if let Some(error) = parsed.as_ref().and_then(|v| v.get("error")) {
        return Err(provider_error(status, error));
    }
    let Some(parsed) = parsed else {
        return Err(if (200..300).contains(&status) {
            WireError::NotJson {
                status,
                body: body.to_string(),
            }
        } else {
            WireError::Http {
                status,
                body: body.to_string(),
            }
        });
    };
    if !(200..300).contains(&status) {
        return Err(WireError::Http {
            status,
            body: body.to_string(),
        });
    }
    let entries = parsed
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in entries {
        let Some(id) = string_field(&entry, "id") else {
            continue;
        };
        let tagged = entry
            .get("supported_endpoint_types")
            .and_then(Value::as_array)
            .is_some_and(|types| {
                types
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|t| t.eq_ignore_ascii_case("image-generation"))
            });
        let include = match format {
            ImageApiFormat::A6api => tagged.then_some(Discovery::Tagged),
            ImageApiFormat::OpenaiImages => {
                if tagged {
                    Some(Discovery::Tagged)
                } else if looks_like_an_image_model(&id) {
                    Some(Discovery::NameHeuristic)
                } else {
                    None
                }
            }
        };
        if let Some(discovery) = include {
            out.push(DiscoveredModel { id, discovery });
        }
    }
    Ok(out)
}

fn looks_like_an_image_model(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    ["image", "dall-e", "imagen", "flux"]
        .iter()
        .any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call<'a>(size: Option<&'a str>) -> GenerationCall<'a> {
        GenerationCall {
            model: "gpt-image-1.5",
            prompt: "an aurora over mountains",
            size,
            format: None,
        }
    }

    #[test]
    fn a_generation_is_json_with_n_one_and_no_response_format() {
        let body = generation_body(ImageApiFormat::A6api, call(Some("1024x1024")));
        assert_eq!(
            body,
            json!({"model": "gpt-image-1.5", "prompt": "an aurora over mountains", "n": 1, "size": "1024x1024"})
        );
        assert!(body.get("response_format").is_none());
        let bare = generation_body(ImageApiFormat::OpenaiImages, call(None));
        assert!(bare.get("size").is_none(), "no size means the model's default");
    }

    /// Deviation 1, measured: a6api's edit is JSON with `image` as a URL.
    #[test]
    fn an_a6api_edit_is_json_with_the_image_as_a_url() {
        let source = EditSource {
            bytes: b"png-bytes",
            media_type: "image/png",
            file_name: "001-generated-aurora.png",
            remote_url: Some("https://img.pinest.xyz/amg/images/2026/09/04/x.png"),
        };
        match edit_body(ImageApiFormat::A6api, call(None), source) {
            RequestBody::Json(body) => {
                assert_eq!(body["image"], "https://img.pinest.xyz/amg/images/2026/09/04/x.png");
                assert_eq!(body["model"], "gpt-image-1.5");
                assert_eq!(body["n"], 1);
            }
            other => panic!("a6api edits must be JSON, got {other:?}"),
        }
    }

    /// A picture Aurora holds only as bytes travels as a data URL.
    #[test]
    fn an_a6api_edit_without_a_remote_url_sends_a_data_url() {
        let source = EditSource {
            bytes: &[0x89, b'P', b'N', b'G'],
            media_type: "image/png",
            file_name: "x.png",
            remote_url: None,
        };
        let RequestBody::Json(body) = edit_body(ImageApiFormat::A6api, call(None), source) else {
            panic!("json");
        };
        assert_eq!(body["image"], "data:image/png;base64,iVBORw==");
    }

    /// OpenAI's own shape, byte for byte.
    #[test]
    fn an_openai_edit_is_multipart_with_the_image_as_a_file_part() {
        let mut form = Multipart::with_boundary("B");
        form.text("model", "gpt-image-1");
        form.text("prompt", "add the word AURORA");
        form.text("n", "1");
        form.file("image", "001-generated.png", "image/png", b"PNG");
        let (content_type, bytes) = form.finish();
        assert_eq!(content_type, "multipart/form-data; boundary=B");
        let expected = concat!(
            "--B\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-image-1\r\n",
            "--B\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nadd the word AURORA\r\n",
            "--B\r\nContent-Disposition: form-data; name=\"n\"\r\n\r\n1\r\n",
            "--B\r\nContent-Disposition: form-data; name=\"image\"; filename=\"001-generated.png\"\r\n",
            "Content-Type: image/png\r\n\r\nPNG\r\n",
            "--B--\r\n",
        );
        assert_eq!(String::from_utf8(bytes).unwrap(), expected);

        let source = EditSource {
            bytes: b"PNG",
            media_type: "image/png",
            file_name: "x.png",
            remote_url: Some("https://ignored.example/x.png"),
        };
        match edit_body(ImageApiFormat::OpenaiImages, call(Some("1024x1024")), source) {
            RequestBody::Multipart { content_type, bytes } => {
                assert!(content_type.starts_with("multipart/form-data; boundary=aurora-"));
                let text = String::from_utf8_lossy(&bytes);
                assert!(text.contains("name=\"size\"\r\n\r\n1024x1024\r\n"));
                assert!(text.contains("filename=\"x.png\""));
                assert!(!text.contains("ignored.example"), "OpenAI takes the bytes, not a URL");
            }
            other => panic!("openai edits must be multipart, got {other:?}"),
        }
    }

    #[test]
    fn a_success_yields_every_image_and_the_usage() {
        let body = r#"{"created": 1, "data": [{"url": "https://x/1.png", "revised_prompt": "aurora"},
            {"b64_json": "AAAA"}], "usage": {"input_tokens": 37, "output_tokens": 1056}}"#;
        let parsed = parse_response(200, body).unwrap();
        assert_eq!(parsed.images.len(), 2);
        assert_eq!(parsed.images[0].url.as_deref(), Some("https://x/1.png"));
        assert_eq!(parsed.images[0].revised_prompt.as_deref(), Some("aurora"));
        assert_eq!(parsed.images[1].b64_json.as_deref(), Some("AAAA"));
        assert_eq!(parsed.usage.unwrap()["output_tokens"], 1056);
    }

    /// Deviation 2, measured: an error under HTTP 200 is an error.
    #[test]
    fn an_error_object_wins_over_a_200_status() {
        let body = r#"{"error":{"code":"model_not_found","message":"The model `x` does not exist"}}"#;
        let err = parse_response(200, body).unwrap_err();
        assert_eq!(
            err,
            WireError::Provider {
                status: 200,
                code: Some("model_not_found".into()),
                message: "The model `x` does not exist".into(),
            }
        );
        assert!(err.to_string().contains("model_not_found"));
    }

    #[test]
    fn an_error_string_and_a_code_only_error_both_have_a_message() {
        let err = parse_response(429, r#"{"error":"rate limited"}"#).unwrap_err();
        assert!(matches!(err, WireError::Provider { message, .. } if message == "rate limited"));
        let err = parse_response(200, r#"{"error":{"code":"quota"}}"#).unwrap_err();
        assert!(matches!(err, WireError::Provider { message, .. } if message == "quota"));
    }

    #[test]
    fn a_failing_status_without_an_error_object_reports_the_status_and_body() {
        let err = parse_response(502, "<html>Bad gateway</html>").unwrap_err();
        assert_eq!(
            err,
            WireError::Http {
                status: 502,
                body: "<html>Bad gateway</html>".into()
            }
        );
        let err = parse_response(500, r#"{"detail": "boom"}"#).unwrap_err();
        assert!(matches!(err, WireError::Http { status: 500, .. }));
    }

    #[test]
    fn a_200_that_is_not_json_or_has_no_image_is_named_as_such() {
        assert!(matches!(
            parse_response(200, "ok").unwrap_err(),
            WireError::NotJson { status: 200, .. }
        ));
        assert_eq!(
            parse_response(200, r#"{"data": []}"#).unwrap_err(),
            WireError::NoImage
        );
        assert_eq!(
            parse_response(200, r#"{"data": [{"revised_prompt": "x"}]}"#).unwrap_err(),
            WireError::NoImage
        );
    }

    #[test]
    fn long_bodies_are_clipped_in_the_message() {
        let body = "x".repeat(1000);
        let text = WireError::Http { status: 500, body }.to_string();
        assert!(text.chars().count() < 400);
        assert!(text.ends_with('…'));
    }

    /// Deviation 3: discovery reads the list and its tags, never the lookup.
    #[test]
    fn a6api_discovery_keeps_only_tagged_image_models() {
        let body = r#"{"data": [
            {"id": "gpt-image-2", "supported_endpoint_types": ["image-generation", "openai"]},
            {"id": "gpt-5", "supported_endpoint_types": ["openai"]},
            {"id": "nano-banana", "supported_endpoint_types": ["image-generation"]},
            {"id": "flux-something"}
        ]}"#;
        let models = parse_models(ImageApiFormat::A6api, 200, body).unwrap();
        assert_eq!(
            models,
            vec![
                DiscoveredModel { id: "gpt-image-2".into(), discovery: Discovery::Tagged },
                DiscoveredModel { id: "nano-banana".into(), discovery: Discovery::Tagged },
            ],
            "an untagged id is not an image model on a provider that tags them"
        );
    }

    #[test]
    fn openai_discovery_falls_back_to_the_name_and_says_so() {
        let body = r#"{"data": [{"id": "gpt-image-1"}, {"id": "dall-e-3"}, {"id": "gpt-4o"}, {"id": "whisper-1"}]}"#;
        let models = parse_models(ImageApiFormat::OpenaiImages, 200, body).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-image-1", "dall-e-3"]);
        assert!(models.iter().all(|m| m.discovery == Discovery::NameHeuristic));
    }

    #[test]
    fn discovery_errors_read_like_generation_errors() {
        let err = parse_models(ImageApiFormat::A6api, 200, r#"{"error":{"code":"invalid_api_key"}}"#)
            .unwrap_err();
        assert!(matches!(err, WireError::Provider { code: Some(code), .. } if code == "invalid_api_key"));
        assert!(matches!(
            parse_models(ImageApiFormat::A6api, 401, "Unauthorized").unwrap_err(),
            WireError::Http { status: 401, .. }
        ));
    }
}
