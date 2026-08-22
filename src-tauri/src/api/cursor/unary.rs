//! Unary Connect-RPC calls against `agent.v1.AgentService`.
//!
//! Connect's unary format is **not** the streaming one:
//!
//! | | unary | streaming |
//! |---|---|---|
//! | `content-type` | `application/proto` | `application/connect+proto` |
//! | body | bare serialized message | 5-byte-enveloped frames |
//! | errors | JSON body with a non-2xx status | trailer envelope |
//!
//! Sending the streaming content type to a unary method returns a bodyless
//! `415` — a status that says nothing about the cause and costs an hour to
//! diagnose. Keeping the two in separate modules is what stops that mistake
//! being one boolean away.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};

use super::{CURSOR_API_BASE, CURSOR_CLIENT_TYPE, CURSOR_CLIENT_VERSION};

/// How long a metadata call may take. Generous relative to the work — these
/// are small responses — but bounded so a hung connection cannot wedge a
/// settings page waiting on a model list.
const UNARY_TIMEOUT_SECS: u64 = 30;

/// Headers every call to Cursor's agent service carries.
///
/// `x-ghost-mode: true` asks Cursor not to retain the request for training,
/// matching what its own CLI sends. Aurora sends it on every call rather than
/// making it a setting: a coding agent ships the user's source code upstream,
/// and the privacy-preserving default is the only defensible one to pick on
/// their behalf.
pub fn base_headers(access_token: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|err| format!("invalid access token header: {err}"))?,
    );
    headers.insert("x-ghost-mode", HeaderValue::from_static("true"));
    headers.insert(
        "x-cursor-client-version",
        HeaderValue::from_static(CURSOR_CLIENT_VERSION),
    );
    headers.insert(
        "x-cursor-client-type",
        HeaderValue::from_static(CURSOR_CLIENT_TYPE),
    );
    headers.insert(
        "connect-protocol-version",
        HeaderValue::from_static("1"),
    );
    let request_id = uuid::Uuid::new_v4().to_string();
    headers.insert(
        HeaderName::from_static("x-request-id"),
        HeaderValue::from_str(&request_id)
            .map_err(|err| format!("invalid request id header: {err}"))?,
    );
    Ok(headers)
}

/// POST a bare protobuf body to a unary method and return the bare response.
///
/// `method` is the full RPC path, e.g. `/agent.v1.AgentService/GetUsableModels`.
pub async fn call(method: &str, body: Vec<u8>, access_token: &str) -> Result<Vec<u8>, String> {
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(UNARY_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("build HTTP client: {err}"))?;

    let mut headers = base_headers(access_token)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/proto"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/proto"));

    let response = http
        .post(format!("{CURSOR_API_BASE}{method}"))
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|err| format!("{method} request failed: {err}"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("{method} response body failed: {err}"))?;

    if !status.is_success() {
        return Err(describe_failure(status.as_u16(), &content_type, &bytes));
    }
    Ok(bytes.to_vec())
}

/// Turn a non-2xx unary response into something a person can act on.
///
/// Connect reports errors as a JSON `{"code":…,"message":…}` body. When that
/// is what arrived, the server's own words beat any status-code table we would
/// write; when it is not, the status is all there is and the body is quoted
/// rather than dropped.
fn describe_failure(status: u16, content_type: &str, body: &[u8]) -> String {
    if content_type.contains("json") {
        if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(body) {
            let code = parsed
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("error");
            let message = parsed
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !message.is_empty() {
                return format!("Cursor refused the request ({code}): {message}");
            }
            return format!("Cursor refused the request ({code}, HTTP {status})");
        }
    }
    let preview = String::from_utf8_lossy(body);
    let preview = preview.trim();
    if preview.is_empty() {
        // The signature of the content-type mistake, so name it: an empty
        // 415 here almost always means a streaming content type reached a
        // unary method.
        if status == 415 {
            return "Cursor rejected the request format (HTTP 415 with no body). A unary method \
                    must be sent as `application/proto`."
                .to_string();
        }
        return format!("Cursor returned HTTP {status} with no body.");
    }
    format!(
        "Cursor returned HTTP {status}: {}",
        preview.chars().take(300).collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_headers_carry_the_client_identity() {
        let headers = base_headers("tok_abc").expect("headers");
        assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer tok_abc");
        assert_eq!(headers.get("x-ghost-mode").unwrap(), "true");
        assert_eq!(headers.get("x-cursor-client-type").unwrap(), "cli");
        assert_eq!(headers.get("connect-protocol-version").unwrap(), "1");
        assert!(headers.get("x-request-id").is_some());
    }

    #[test]
    fn each_call_gets_its_own_request_id() {
        let a = base_headers("t").unwrap();
        let b = base_headers("t").unwrap();
        assert_ne!(
            a.get("x-request-id").unwrap(),
            b.get("x-request-id").unwrap()
        );
    }

    #[test]
    fn a_token_that_cannot_be_a_header_is_rejected_not_panicked_on() {
        assert!(base_headers("bad\nvalue").is_err());
    }

    #[test]
    fn connect_json_errors_surface_the_servers_own_words() {
        let body = br#"{"code":"unauthenticated","message":"token expired"}"#;
        let message = describe_failure(401, "application/json", body);
        assert!(message.contains("unauthenticated"), "got: {message}");
        assert!(message.contains("token expired"), "got: {message}");
    }

    #[test]
    fn an_empty_415_names_the_content_type_mistake() {
        let message = describe_failure(415, "", b"");
        assert!(message.contains("application/proto"), "got: {message}");
    }

    #[test]
    fn a_non_json_body_is_quoted_rather_than_dropped() {
        let message = describe_failure(500, "text/plain", b"upstream exploded");
        assert!(message.contains("upstream exploded"), "got: {message}");
    }
}
