//! JSON-RPC 2.0 over stdio, and the handful of MCP methods a tool server needs.
//!
//! ## Why this is written out rather than pulled from `rmcp`
//!
//! Aurora already depends on `rmcp`, and `rmcp` has a server half. It is not
//! used here, for three reasons that all point the same way.
//!
//! The server half is async and macro-driven: it wants a tokio runtime, and it
//! derives its schemas from Rust types through an attribute macro. The `aurora`
//! CLI is a synchronous process that starts, answers, and exits — standing up a
//! runtime to read lines from stdin would be the largest thing in the binary's
//! startup path, for a protocol whose entire framing is "one JSON object per
//! line".
//!
//! The tool schemas are also a published interface. They are what another
//! agent reads to decide whether it can do something, and their wording is the
//! difference between a caller that opens the Agent Window and one that gives
//! up. Deriving them from Rust structs would put that wording at the mercy of
//! field names and a macro's idea of a description.
//!
//! And the client half of `rmcp` is pinned to whatever Aurora needs to *talk*
//! to other servers. Coupling what Aurora exposes to the version it consumes
//! means an upgrade for one is an upgrade for both.
//!
//! What is left is about two hundred lines with no dependency beyond
//! `serde_json`, which is the whole of the protocol Aurora actually implements.
//!
//! ## The framing rule
//!
//! One JSON object per line on stdin, one per line on stdout, and **nothing
//! else on stdout ever**. A stray `println!` anywhere in the process corrupts
//! the stream and the client disconnects with a parse error that names none of
//! this. Diagnostics go to stderr, which clients collect as the server's log.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The protocol revisions this server implements.
///
/// Listed newest first. All three are wire-compatible for a tools-only server;
/// they differ in features Aurora does not expose (elicitation, resource
/// subscriptions, structured output). Naming several lets an older client
/// negotiate the version it knows instead of being handed one it does not.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// What to answer when the client asks for a version this server does not know.
///
/// The spec's rule: reply with the newest version supported here and let the
/// client decide whether it can live with it. Refusing outright would break
/// every client that ships a newer revision than this build has heard of, which
/// is the normal condition for anything with a release cycle.
pub const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

/// How the server names itself to a client. Shown in client UIs.
pub const SERVER_NAME: &str = "aurora-agent";

/// Standard JSON-RPC error codes, plus what each one means here.
pub mod error_code {
    /// The line was not JSON.
    pub const PARSE: i32 = -32700;
    /// Valid JSON, but not a JSON-RPC request.
    pub const INVALID_REQUEST: i32 = -32600;
    /// A method this server does not implement.
    pub const METHOD_NOT_FOUND: i32 = -32601;
    /// The method exists; its arguments do not fit.
    pub const INVALID_PARAMS: i32 = -32602;
}

/// One incoming message.
///
/// A request and a notification differ only by the presence of `id`, so they
/// share a type and [`Self::is_notification`] tells them apart. Getting this
/// wrong is the classic MCP server bug: answering `notifications/initialized`
/// sends a response with a null id, which a strict client rejects.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl Request {
    /// Whether this message expects no reply.
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    /// A string argument from `params.arguments`, trimmed, absent when empty.
    ///
    /// Empty-as-absent because a calling model that does not want to pass an
    /// argument frequently passes `""` rather than omitting the key, and
    /// treating that as a real value produces a search for the empty string
    /// instead of the default.
    pub fn arg_str(&self, key: &str) -> Option<String> {
        self.params
            .get("arguments")
            .and_then(|args| args.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    /// A boolean argument, or `default` when it is absent or the wrong type.
    pub fn arg_bool(&self, key: &str, default: bool) -> bool {
        self.params
            .get("arguments")
            .and_then(|args| args.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(default)
    }

    /// A whole-number argument clamped into a range.
    ///
    /// Clamped rather than rejected. A caller asking to wait an hour has made a
    /// reasonable request of an unreasonable protocol — its own client will
    /// time out long first — and the useful answer is the longest wait this can
    /// honestly offer, not an argument error.
    pub fn arg_u64(&self, key: &str, default: u64, min: u64, max: u64) -> u64 {
        self.params
            .get("arguments")
            .and_then(|args| args.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(default)
            .clamp(min, max)
    }
}

/// One outgoing message.
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl Response {
    /// A successful reply.
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    /// A protocol-level failure.
    ///
    /// For malformed calls only. A tool that ran and could not do what was
    /// asked is a *successful* JSON-RPC call carrying an error result — see
    /// [`tool_error`] — because the calling model has to be able to read what
    /// went wrong and try something else. A JSON-RPC error is for the client
    /// library, and the model never sees it.
    pub fn failed(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(json!({ "code": code, "message": message.into() })),
        }
    }
}

/// The `initialize` result: what this server is and what it can do.
///
/// `tools` is the only capability declared. Aurora exposes no prompts and no
/// resources over MCP, and declaring a capability it does not implement invites
/// clients to call `resources/list` and receive an error on every connection.
pub fn initialize_result(requested_version: Option<&str>) -> Value {
    let version = match requested_version {
        Some(asked) if SUPPORTED_PROTOCOL_VERSIONS.contains(&asked) => asked,
        _ => DEFAULT_PROTOCOL_VERSION,
    };

    json!({
        "protocolVersion": version,
        "capabilities": {
            // `listChanged: false` is the honest answer: the roster is fixed at
            // build time. Every tool exists whether or not Aurora is running —
            // what changes is whether a call can be carried out, which each
            // tool reports for itself.
            "tools": { "listChanged": false }
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": INSTRUCTIONS,
    })
}

/// What a client shows, or feeds to its model, about this server as a whole.
///
/// Deliberately short and about the *shape* of the thing rather than the tools,
/// which describe themselves. The one fact worth stating up front is the one a
/// caller cannot discover without failing first: work runs in a window on
/// someone's screen, and that window has to be open.
pub const INSTRUCTIONS: &str = "\
Aurora is a coding agent that runs in a window on this machine. These tools send \
it work and read back what it did.

Work you send lands in Aurora's Agent Window as a real message and runs there, \
with its own tools, its own file access, and a person watching who can steer or \
stop it. It is not a sandbox and it is not instant: a task takes as long as the \
work takes.

Everything except aurora_agent_status needs the Agent Window open and the user's \
permission switch on. Call aurora_agent_status first; if it reports anything \
other than ready, tell the user what it said instead of retrying.";

/// A tool result the calling model reads as an answer.
pub fn tool_text(text: impl Into<String>) -> Value {
    json!({
        "content": [{ "type": "text", "text": text.into() }],
        "isError": false,
    })
}

/// A tool result the calling model reads as a failure it can act on.
pub fn tool_error(text: impl Into<String>) -> Value {
    json!({
        "content": [{ "type": "text", "text": text.into() }],
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(arguments: Value) -> Request {
        serde_json::from_value(json!({
            "id": 1,
            "method": "tools/call",
            "params": { "name": "aurora_agent_dispatch", "arguments": arguments }
        }))
        .expect("parses")
    }

    #[test]
    fn a_notification_has_no_id() {
        // The classic MCP server bug: replying to `notifications/initialized`
        // sends a response with a null id, and a strict client drops the
        // connection over it.
        let notification: Request =
            serde_json::from_value(json!({ "method": "notifications/initialized" }))
                .expect("parses");
        assert!(notification.is_notification());

        let request: Request =
            serde_json::from_value(json!({ "id": 1, "method": "tools/list" })).expect("parses");
        assert!(!request.is_notification());
    }

    #[test]
    fn a_request_with_no_params_is_still_a_request() {
        // `tools/list` is usually sent with no params at all.
        let request: Request =
            serde_json::from_value(json!({ "id": 7, "method": "tools/list" })).expect("parses");
        assert_eq!(request.method, "tools/list");
        assert!(request.arg_str("anything").is_none());
    }

    #[test]
    fn an_empty_string_argument_reads_as_absent() {
        // Calling models pass "" for "I am not setting this" constantly.
        // Treating it as a value turns a default into a search for nothing.
        let request = call(json!({ "prompt": "do it", "model": "   " }));
        assert_eq!(request.arg_str("prompt").as_deref(), Some("do it"));
        assert!(request.arg_str("model").is_none());
    }

    #[test]
    fn a_numeric_argument_is_clamped_not_rejected() {
        let request = call(json!({ "timeoutSeconds": 100_000 }));
        assert_eq!(request.arg_u64("timeoutSeconds", 30, 5, 600), 600);

        let request = call(json!({ "timeoutSeconds": 0 }));
        assert_eq!(request.arg_u64("timeoutSeconds", 30, 5, 600), 5);

        // A string where a number belongs falls back rather than failing: the
        // caller meant a duration, and refusing the whole call over its type
        // helps nobody.
        let request = call(json!({ "timeoutSeconds": "30" }));
        assert_eq!(request.arg_u64("timeoutSeconds", 45, 5, 600), 45);
    }

    #[test]
    fn a_known_protocol_version_is_echoed_back() {
        let result = initialize_result(Some("2024-11-05"));
        assert_eq!(result["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn an_unknown_protocol_version_falls_back_to_the_newest() {
        // A client from the future must get a usable answer, not a refusal.
        let result = initialize_result(Some("2099-01-01"));
        assert_eq!(result["protocolVersion"], DEFAULT_PROTOCOL_VERSION);
        let result = initialize_result(None);
        assert_eq!(result["protocolVersion"], DEFAULT_PROTOCOL_VERSION);
    }

    #[test]
    fn only_the_tools_capability_is_declared() {
        // Declaring prompts or resources invites a client to call for them and
        // get an error on every single connection.
        let result = initialize_result(None);
        let capabilities = &result["capabilities"];
        assert!(capabilities.get("tools").is_some());
        assert!(capabilities.get("resources").is_none());
        assert!(capabilities.get("prompts").is_none());
    }

    #[test]
    fn a_response_omits_the_half_it_does_not_have() {
        // JSON-RPC forbids result and error together, and a null `error` key is
        // read as an error by some clients.
        let ok = serde_json::to_value(Response::ok(json!(1), json!({}))).expect("serialise");
        assert!(ok.get("result").is_some());
        assert!(ok.get("error").is_none());

        let failed = serde_json::to_value(Response::failed(
            json!(1),
            error_code::METHOD_NOT_FOUND,
            "nope",
        ))
        .expect("serialise");
        assert!(failed.get("error").is_some());
        assert!(failed.get("result").is_none());
    }

    #[test]
    fn a_tool_failure_is_a_successful_call() {
        // The distinction the whole protocol turns on: a JSON-RPC error is for
        // the client library and the model never sees it. A tool that could not
        // do its job has to reach the model, so it travels as a result.
        let error = tool_error("the Agent Window is closed");
        assert_eq!(error["isError"], true);
        assert_eq!(error["content"][0]["type"], "text");
        assert!(error["content"][0]["text"]
            .as_str()
            .expect("text")
            .contains("Agent Window"));
    }

    #[test]
    fn the_instructions_say_the_window_must_be_open() {
        // This is the one fact a caller cannot discover without failing first.
        assert!(INSTRUCTIONS.contains("Agent Window"));
        assert!(INSTRUCTIONS.contains("aurora_agent_status"));
    }
}
