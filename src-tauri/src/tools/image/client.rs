//! The HTTP half of the image tool: send what `wire.rs` built, read what came
//! back, and fetch the picture itself.
//!
//! Kept apart from the tool so the tool's tests can point a provider row at a
//! local socket and watch the bytes, and so the settings commands (Test,
//! Discover models) reuse the same calls instead of a second client with a
//! second set of headers.

use std::time::Duration;

use base64::Engine;

use super::config::ImageProviderConfig;
use super::wire::{
    self, DiscoveredModel, EditSource, GenerationCall, ImageOutput, ImageResponse, RequestBody,
    WireError,
};

/// How long one generation may take before Aurora gives up on it. gpt-image
/// models take twenty to sixty seconds at 1024²; a minute of headroom past the
/// slowest measured call, and a provider that has not answered in three has
/// lost the request.
pub const GENERATION_TIMEOUT: Duration = Duration::from_secs(180);
/// Fetching the finished picture from the provider's CDN.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// `GET /models` and the Test button.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a call did not produce a picture.
#[derive(Debug)]
pub enum ImageError {
    /// The provider answered and the answer was not a picture.
    Wire(WireError),
    /// The request never got an answer: DNS, TLS, a dead socket, a timeout.
    Transport { url: String, reason: String },
    /// The picture's URL did not yield bytes.
    Download { url: String, reason: String },
    /// `b64_json` that is not base64.
    Decode(String),
    /// The bytes came, and there were too many of them.
    TooLarge { bytes: usize, limit: usize },
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wire(error) => write!(f, "{error}"),
            Self::Transport { url, reason } => {
                write!(f, "could not reach the image provider at {url}: {reason}")
            }
            Self::Download { url, reason } => {
                write!(f, "the provider made the image but it could not be downloaded from {url}: {reason}")
            }
            Self::Decode(reason) => write!(f, "the provider's b64_json was not decodable: {reason}"),
            Self::TooLarge { bytes, limit } => write!(
                f,
                "the image is {} MiB, above Aurora's {} MiB limit for one picture",
                bytes / 1024 / 1024,
                limit / 1024 / 1024
            ),
        }
    }
}

impl From<WireError> for ImageError {
    fn from(error: WireError) -> Self {
        Self::Wire(error)
    }
}

/// A reqwest client tuned for image calls: no compression negotiation (the
/// payloads are already compressed pixels), and a per-call timeout because an
/// image request that has gone quiet is not thinking.
#[derive(Clone)]
pub struct ImageClient {
    http: reqwest::Client,
}

impl Default for ImageClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageClient {
    #[must_use]
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { http }
    }

    /// `POST /images/generations`.
    pub async fn generate(
        &self,
        provider: &ImageProviderConfig,
        call: GenerationCall<'_>,
    ) -> Result<ImageResponse, ImageError> {
        let url = provider.generation_url();
        let body = RequestBody::Json(wire::generation_body(provider.api_format, call));
        self.post_image_request(provider, &url, body).await
    }

    /// `POST /images/edits`, in whichever shape this provider's format takes.
    /// The caller has already checked that `provider` can edit; a provider row
    /// whose edit path was emptied has no URL and is refused here as a
    /// programming error rather than a provider one.
    pub async fn edit(
        &self,
        provider: &ImageProviderConfig,
        call: GenerationCall<'_>,
        source: EditSource<'_>,
    ) -> Result<ImageResponse, ImageError> {
        let url = provider.edit_url().ok_or_else(|| ImageError::Transport {
            url: provider.base_url.clone(),
            reason: "this provider has no edit endpoint".to_string(),
        })?;
        let body = wire::edit_body(provider.api_format, call, source);
        self.post_image_request(provider, &url, body).await
    }

    async fn post_image_request(
        &self,
        provider: &ImageProviderConfig,
        url: &str,
        body: RequestBody,
    ) -> Result<ImageResponse, ImageError> {
        let request = self
            .http
            .post(url)
            .bearer_auth(provider.api_key())
            .timeout(GENERATION_TIMEOUT);
        let request = match body {
            RequestBody::Json(value) => request.json(&value),
            RequestBody::Multipart {
                content_type,
                bytes,
            } => request
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(bytes),
        };
        let response = request.send().await.map_err(|error| ImageError::Transport {
            url: url.to_string(),
            reason: transport_reason(&error),
        })?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| ImageError::Transport {
            url: url.to_string(),
            reason: format!("the response body could not be read: {error}"),
        })?;
        Ok(wire::parse_response(status, &text)?)
    }

    /// The picture's bytes, whichever way the provider handed them over.
    ///
    /// `limit` is the most Aurora will accept — enforced on the download as it
    /// streams, so a hostile or broken URL cannot fill memory before the check.
    pub async fn materialize(
        &self,
        output: &ImageOutput,
        limit: usize,
    ) -> Result<Vec<u8>, ImageError> {
        if let Some(b64) = output.b64_json.as_deref() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|error| ImageError::Decode(error.to_string()))?;
            if bytes.len() > limit {
                return Err(ImageError::TooLarge {
                    bytes: bytes.len(),
                    limit,
                });
            }
            return Ok(bytes);
        }
        let url = output.url.as_deref().ok_or(ImageError::Wire(WireError::NoImage))?;
        self.download(url, limit).await
    }

    /// GET a picture, capped at `limit` bytes.
    pub async fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, ImageError> {
        let response = self
            .http
            .get(url)
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|error| ImageError::Download {
                url: url.to_string(),
                reason: transport_reason(&error),
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(ImageError::Download {
                url: url.to_string(),
                reason: format!("HTTP {}", status.as_u16()),
            });
        }
        if let Some(length) = response.content_length() {
            if length as usize > limit {
                return Err(ImageError::TooLarge {
                    bytes: length as usize,
                    limit,
                });
            }
        }
        let mut bytes = Vec::new();
        let mut body = response;
        while let Some(chunk) = body.chunk().await.map_err(|error| ImageError::Download {
            url: url.to_string(),
            reason: format!("the download stopped early: {error}"),
        })? {
            if bytes.len() + chunk.len() > limit {
                return Err(ImageError::TooLarge {
                    bytes: bytes.len() + chunk.len(),
                    limit,
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(ImageError::Download {
                url: url.to_string(),
                reason: "the response was empty".to_string(),
            });
        }
        Ok(bytes)
    }

    /// `GET /models`, reduced to the image models. The Discover button.
    pub async fn discover_models(
        &self,
        provider: &ImageProviderConfig,
    ) -> Result<Vec<DiscoveredModel>, ImageError> {
        let url = provider.models_url();
        let response = self
            .http
            .get(&url)
            .bearer_auth(provider.api_key())
            .timeout(DISCOVERY_TIMEOUT)
            .send()
            .await
            .map_err(|error| ImageError::Transport {
                url: url.clone(),
                reason: transport_reason(&error),
            })?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| ImageError::Transport {
            url: url.clone(),
            reason: format!("the response body could not be read: {error}"),
        })?;
        Ok(wire::parse_models(provider.api_format, status, &text)?)
    }

    /// The Test button: prove the address and key work without spending a
    /// generation. `GET /models` with the key is the cheapest authenticated
    /// call both formats have; a provider that lists models has accepted the
    /// key and is reachable. Returns how many image models it listed.
    pub async fn test(&self, provider: &ImageProviderConfig) -> Result<usize, ImageError> {
        self.discover_models(provider).await.map(|models| models.len())
    }
}

fn transport_reason(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timed out".to_string()
    } else if error.is_connect() {
        format!("connection failed ({})", root_cause(error))
    } else {
        root_cause(error)
    }
}

fn root_cause(error: &reqwest::Error) -> String {
    let mut source: &dyn std::error::Error = error;
    while let Some(next) = source.source() {
        source = next;
    }
    source.to_string()
}

/// A one-shot HTTP/1.1 server on a loopback port, for the tests here and in
/// the tool. Answers each connection from `responses` in order and records
/// what it was sent.
#[cfg(test)]
pub(super) mod fake_server {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Debug, Clone)]
    pub struct Recorded {
        pub method: String,
        pub path: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Recorded {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }

        pub fn json(&self) -> serde_json::Value {
            serde_json::from_slice(&self.body).expect("request body is JSON")
        }
    }

    #[derive(Debug, Clone)]
    pub struct Canned {
        pub status: u16,
        pub content_type: &'static str,
        pub body: Vec<u8>,
    }

    impl Canned {
        pub fn json(status: u16, body: &str) -> Self {
            Self {
                status,
                content_type: "application/json",
                body: body.as_bytes().to_vec(),
            }
        }

        pub fn png(bytes: Vec<u8>) -> Self {
            Self {
                status: 200,
                content_type: "image/png",
                body: bytes,
            }
        }
    }

    pub struct FakeServer {
        pub base_url: String,
        pub requests: Arc<Mutex<Vec<Recorded>>>,
    }

    impl FakeServer {
        pub fn recorded(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }
    }

    /// Serve `responses` one per connection, then stop accepting.
    pub async fn serve(responses: Vec<Canned>) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let requests: Arc<Mutex<Vec<Recorded>>> = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        tokio::spawn(async move {
            for canned in responses {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let header_end = loop {
                    let n = match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break None,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = find(&buf, b"\r\n\r\n") {
                        break Some(pos + 4);
                    }
                };
                let Some(header_end) = header_end else {
                    return;
                };
                let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
                let mut lines = head.split("\r\n");
                let request_line = lines.next().unwrap_or_default();
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let headers: Vec<(String, String)> = lines
                    .filter_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        Some((k.trim().to_string(), v.trim().to_string()))
                    })
                    .collect();
                let length: usize = headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                while buf.len() < header_end + length {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let body = buf[header_end..(header_end + length).min(buf.len())].to_vec();
                log.lock().unwrap().push(Recorded {
                    method,
                    path,
                    headers,
                    body,
                });
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    canned.status,
                    canned.content_type,
                    canned.body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.write_all(&canned.body).await;
                let _ = socket.shutdown().await;
            }
        });
        FakeServer {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            requests,
        }
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }
}

#[cfg(test)]
mod tests {
    use super::fake_server::{serve, Canned};
    use super::*;
    use crate::tools::image::config::{ImageApiFormat, ImageModelConfig};

    fn provider(base_url: &str, format: ImageApiFormat) -> ImageProviderConfig {
        ImageProviderConfig {
            id: "p".into(),
            name: "test".into(),
            base_url: base_url.into(),
            api_key: Some("sk-secret".into()),
            api_format: format,
            generation_path: None,
            edit_path: None,
            request_format: None,
            enabled: true,
            models: vec![ImageModelConfig {
                id: "p:m".into(),
                provider_id: "p".into(),
                model_key: "gpt-image-1.5".into(),
                label: None,
                can_edit: true,
                sizes: vec![],
                default_size: None,
                price_per_image: None,
            }],
        }
    }

    fn call() -> GenerationCall<'static> {
        GenerationCall {
            model: "gpt-image-1.5",
            prompt: "an aurora",
            size: Some("1024x1024"),
            format: None,
        }
    }

    #[tokio::test]
    async fn a_generation_posts_json_with_the_bearer_key_and_reads_the_url_back() {
        let server = serve(vec![Canned::json(
            200,
            r#"{"data":[{"url":"https://img.example/a.png"}],"usage":{"output_tokens":1}}"#,
        )])
        .await;
        let client = ImageClient::new();
        let response = client
            .generate(&provider(&server.base_url, ImageApiFormat::A6api), call())
            .await
            .unwrap();
        assert_eq!(response.images[0].url.as_deref(), Some("https://img.example/a.png"));

        let recorded = server.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].method, "POST");
        assert_eq!(recorded[0].path, "/v1/images/generations");
        assert_eq!(recorded[0].header("authorization"), Some("Bearer sk-secret"));
        assert!(recorded[0]
            .header("content-type")
            .unwrap()
            .starts_with("application/json"));
        let body = recorded[0].json();
        assert_eq!(body["model"], "gpt-image-1.5");
        assert_eq!(body["size"], "1024x1024");
        assert!(body.get("response_format").is_none());
    }

    /// Deviation 2 on a live socket: 200 with an error object is an error.
    #[tokio::test]
    async fn an_error_under_200_is_reported_as_the_provider_s_words() {
        let server = serve(vec![Canned::json(
            200,
            r#"{"error":{"code":"model_not_found","message":"no such model"}}"#,
        )])
        .await;
        let err = ImageClient::new()
            .generate(&provider(&server.base_url, ImageApiFormat::A6api), call())
            .await
            .unwrap_err();
        assert!(matches!(err, ImageError::Wire(WireError::Provider { .. })));
        assert!(err.to_string().contains("no such model"), "{err}");
    }

    #[tokio::test]
    async fn an_a6api_edit_is_json_and_an_openai_edit_is_multipart() {
        let server = serve(vec![
            Canned::json(200, r#"{"data":[{"b64_json":"AAAA"}]}"#),
            Canned::json(200, r#"{"data":[{"b64_json":"AAAA"}]}"#),
        ])
        .await;
        let client = ImageClient::new();
        let source = EditSource {
            bytes: b"PNG",
            media_type: "image/png",
            file_name: "001.png",
            remote_url: Some("https://img.example/a.png"),
        };
        client
            .edit(&provider(&server.base_url, ImageApiFormat::A6api), call(), source)
            .await
            .unwrap();
        client
            .edit(&provider(&server.base_url, ImageApiFormat::OpenaiImages), call(), source)
            .await
            .unwrap();
        let recorded = server.recorded();
        assert_eq!(recorded[0].path, "/v1/images/edits");
        assert_eq!(recorded[0].json()["image"], "https://img.example/a.png");
        assert!(recorded[1]
            .header("content-type")
            .unwrap()
            .starts_with("multipart/form-data; boundary=aurora-"));
        assert!(String::from_utf8_lossy(&recorded[1].body).contains("filename=\"001.png\""));
    }

    #[tokio::test]
    async fn a_provider_without_an_edit_endpoint_is_refused_before_any_request() {
        let mut p = provider("http://127.0.0.1:9/v1", ImageApiFormat::A6api);
        p.edit_path = Some(String::new());
        let source = EditSource {
            bytes: b"PNG",
            media_type: "image/png",
            file_name: "001.png",
            remote_url: None,
        };
        let err = ImageClient::new().edit(&p, call(), source).await.unwrap_err();
        assert!(err.to_string().contains("no edit endpoint"), "{err}");
    }

    #[tokio::test]
    async fn materialize_decodes_b64_or_downloads_the_url_with_a_cap() {
        let client = ImageClient::new();
        let inline = ImageOutput {
            url: None,
            b64_json: Some("aGVsbG8=".into()),
            revised_prompt: None,
        };
        assert_eq!(client.materialize(&inline, 1024).await.unwrap(), b"hello");
        assert!(matches!(
            client.materialize(&inline, 2).await.unwrap_err(),
            ImageError::TooLarge { bytes: 5, limit: 2 }
        ));
        let bad = ImageOutput {
            url: None,
            b64_json: Some("not base64!".into()),
            revised_prompt: None,
        };
        assert!(matches!(client.materialize(&bad, 1024).await.unwrap_err(), ImageError::Decode(_)));

        let server = serve(vec![Canned::png(vec![1, 2, 3, 4]), Canned::png(vec![0; 100])]).await;
        let remote = ImageOutput {
            url: Some(format!("{}/img.png", server.base_url)),
            b64_json: None,
            revised_prompt: None,
        };
        assert_eq!(client.materialize(&remote, 1024).await.unwrap(), vec![1, 2, 3, 4]);
        assert!(matches!(
            client.materialize(&remote, 50).await.unwrap_err(),
            ImageError::TooLarge { .. }
        ));
        assert_eq!(server.recorded()[0].method, "GET");
        assert_eq!(server.recorded()[0].path, "/v1/img.png");
    }

    #[tokio::test]
    async fn a_download_that_fails_names_the_url_and_the_status() {
        let server = serve(vec![Canned::json(404, r#"{"error":"gone"}"#)]).await;
        let url = format!("{}/missing.png", server.base_url);
        let err = ImageClient::new().download(&url, 1024).await.unwrap_err();
        let text = err.to_string();
        assert!(text.contains("HTTP 404") && text.contains("missing.png"), "{text}");
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_a_transport_error_with_the_url() {
        let p = provider("http://127.0.0.1:1/v1", ImageApiFormat::A6api);
        let err = ImageClient::new().generate(&p, call()).await.unwrap_err();
        assert!(matches!(err, ImageError::Transport { .. }));
        assert!(err.to_string().contains("127.0.0.1:1"), "{err}");
    }

    #[tokio::test]
    async fn discovery_and_test_read_the_model_list_with_the_key() {
        let server = serve(vec![
            Canned::json(
                200,
                r#"{"data":[{"id":"gpt-image-2","supported_endpoint_types":["image-generation"]},{"id":"gpt-5","supported_endpoint_types":["openai"]}]}"#,
            ),
            Canned::json(401, r#"{"error":{"code":"invalid_api_key","message":"bad key"}}"#),
        ])
        .await;
        let client = ImageClient::new();
        let p = provider(&server.base_url, ImageApiFormat::A6api);
        let models = client.discover_models(&p).await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-image-2");
        let recorded = server.recorded();
        assert_eq!(recorded[0].path, "/v1/models");
        assert_eq!(recorded[0].header("authorization"), Some("Bearer sk-secret"));

        let err = client.test(&p).await.unwrap_err();
        assert!(err.to_string().contains("invalid_api_key"), "{err}");
    }
}
