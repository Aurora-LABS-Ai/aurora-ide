//! The server loop: read a line, answer it, repeat until stdin closes.
//!
//! ## Nothing but JSON-RPC on stdout
//!
//! This process shares a binary with a GUI application that logs, prints paths,
//! and reports errors. Any one of those reaching stdout puts a non-JSON line in
//! the middle of the protocol stream, and the client's reaction is to drop the
//! connection with a parse error naming none of it — the single most confusing
//! way an MCP server can fail.
//!
//! Two things prevent it. `AURORA_QUIET_PATHS` silences the one startup line
//! Aurora prints for its own logs, and everything this module has to say goes
//! to stderr, which clients collect and show as the server's log.
//!
//! ## Why it stays alive through bad input
//!
//! A malformed line is answered with a parse error and the loop continues. The
//! alternative — exit on the first thing not understood — turns one confused
//! message into a dead server, and the client that reconnects has no idea why
//! the last one went away. Only stdin closing ends this, because that is the
//! client actually leaving.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use super::clients;
use super::protocol::{
    error_code, initialize_result, tool_error, Request, Response, SERVER_NAME,
};
use super::tools;

/// Run the server until the client disconnects. Returns a process exit code.
///
/// Always zero. A client closing the pipe is how every MCP session ends, and a
/// non-zero exit there would show up in client logs as a crash on every clean
/// shutdown.
pub fn run() -> i32 {
    // Belt and braces: the CLI entry point sets this, but this function is the
    // one place where a stray line on stdout is fatal rather than untidy.
    std::env::set_var("AURORA_QUIET_PATHS", "1");

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    eprintln!("[{SERVER_NAME}] ready on stdio");

    // Held for the life of the connection and dropped when the loop ends, which
    // is what removes this session from the count. Set on `initialize`, because
    // that is the only message carrying `clientInfo` — before it there is a
    // process but not yet an agent with a name.
    let mut session: Option<clients::SessionHandle> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            // stdin died mid-read. Nothing left to answer to.
            Err(error) => {
                eprintln!("[{SERVER_NAME}] stdin closed: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        // Register on the way past, before the reply is composed. Reading the
        // line twice is cheap next to the round trip, and keeping this out of
        // `handle_line` leaves that function pure — it is tested on the
        // strength of taking a string and returning a response, and a
        // registration side effect inside it would write files during tests.
        if session.is_none() {
            if let Some(handle) = register_from(&line) {
                session = Some(handle);
            }
        }

        let Some(response) = handle_line(&line) else {
            continue;
        };
        if let Err(error) = write_message(&mut stdout, &response) {
            // The client is gone. Say so on stderr and stop, rather than
            // looping on a broken pipe.
            eprintln!("[{SERVER_NAME}] could not reply: {error}");
            break;
        }
    }

    // Explicit rather than left to scope end, because what this drop does —
    // remove the session file — is the visible half of the feature, and a
    // reader should not have to know `SessionHandle` has a `Drop` to see that
    // disconnecting updates the count.
    drop(session);
    0
}

/// Announce the connection if this line is the `initialize` that opens it.
///
/// `clientInfo` is the only place an agent says what it is, and the MCP spec
/// makes it optional — so a client that sends none is still registered, just
/// without a name. Counting only the agents polite enough to introduce
/// themselves would under-report exactly the connections worth worrying about.
fn register_from(line: &str) -> Option<clients::SessionHandle> {
    let request: Request = serde_json::from_str(line).ok()?;
    if request.method != "initialize" {
        return None;
    }
    let info = request.params.get("clientInfo");
    let text = |key: &str| {
        info.and_then(|i| i.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let handle = clients::register(text("name"), text("version"));
    if handle.is_none() {
        // Worth a line on stderr, which clients surface as the server log: the
        // connection works, the count will just be missing this row.
        eprintln!("[{SERVER_NAME}] could not record this connection for the settings page");
    }
    handle
}

/// Answer one line, or `None` when the message wants no reply.
fn handle_line(line: &str) -> Option<Response> {
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            // A parse failure has no id to answer against, so the reply carries
            // a null one, which JSON-RPC defines for exactly this case.
            eprintln!("[{SERVER_NAME}] unparseable message: {error}");
            return Some(Response::failed(
                Value::Null,
                error_code::PARSE,
                format!("could not parse the message: {error}"),
            ));
        }
    };

    // Notifications get no response at all. `notifications/initialized` is the
    // one every client sends, and replying to it is rejected by strict clients.
    if request.is_notification() {
        return None;
    }
    let id = request.id.clone().unwrap_or(Value::Null);

    Some(match request.method.as_str() {
        "initialize" => Response::ok(
            id,
            initialize_result(
                request
                    .params
                    .get("protocolVersion")
                    .and_then(Value::as_str),
            ),
        ),

        "tools/list" => Response::ok(id, json!({ "tools": tools::roster() })),

        "tools/call" => {
            let name = request
                .params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if name.is_empty() {
                // The client built this message, not the model, so it is a
                // protocol error rather than something to explain in prose.
                return Some(Response::failed(
                    id,
                    error_code::INVALID_PARAMS,
                    "tools/call needs a tool name",
                ));
            }
            // A tool that panics must not take the server down with it: the
            // client would see the pipe close with no explanation, and the user
            // would see an MCP server that "randomly disconnects".
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                tools::call(name, &request)
            }))
            .unwrap_or_else(|_| {
                eprintln!("[{SERVER_NAME}] {name} panicked");
                tool_error(format!(
                    "The {name} tool failed unexpectedly. This is a bug in Aurora; \
                     the details are in Aurora's log."
                ))
            });
            Response::ok(id, result)
        }

        // Clients send this as a keep-alive. An empty result is the whole
        // protocol.
        "ping" => Response::ok(id, json!({})),

        other => Response::failed(
            id,
            error_code::METHOD_NOT_FOUND,
            format!("{SERVER_NAME} does not implement {other}"),
        ),
    })
}

/// Write one message as a single line, flushed.
///
/// Flushed every time because the client is blocked reading: a buffered reply
/// is a reply that has not happened, and the caller times out on a server that
/// already answered.
fn write_message(out: &mut impl Write, response: &Response) -> std::io::Result<()> {
    let mut line = serde_json::to_string(response)?;
    line.push('\n');
    out.write_all(line.as_bytes())?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(line: &str) -> Option<Value> {
        handle_line(line).map(|response| serde_json::to_value(response).expect("serialise"))
    }

    #[test]
    fn initialize_is_answered_with_a_protocol_version() {
        let response = answer(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
        )
        .expect("a response");
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(response["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn the_initialized_notification_is_not_answered() {
        // Replying sends a response with a null id, which strict clients treat
        // as a protocol violation and disconnect over.
        assert!(answer(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
    }

    #[test]
    fn tools_are_listed_without_aurora_running() {
        // The property the whole design turns on. A client that only saw tools
        // while Aurora happened to be open would show an empty server, and the
        // agent reading it would conclude Aurora cannot do anything.
        let response =
            answer(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).expect("a response");
        let listed = response["result"]["tools"]
            .as_array()
            .expect("an array of tools");
        assert_eq!(listed.len(), 7);
        assert!(listed
            .iter()
            .any(|tool| tool["name"] == super::tools::STATUS));
    }

    #[test]
    fn status_answers_whatever_state_the_machine_is_in() {
        // Runs against the real machine, so it must not assert on readiness —
        // only that a call arrives, is handled, and comes back as a result
        // rather than a protocol error.
        let response = answer(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"aurora_agent_status","arguments":{}}}"#,
        )
        .expect("a response");
        assert!(response.get("error").is_none());
        assert!(response["result"]["content"][0]["text"].is_string());
    }

    #[test]
    fn an_unparseable_line_is_answered_and_the_server_lives() {
        // One confused message must not end the session.
        let response = answer("this is not json").expect("a response");
        assert_eq!(response["error"]["code"], error_code::PARSE);
        assert!(response["id"].is_null());
    }

    #[test]
    fn an_unknown_method_is_a_protocol_error() {
        let response =
            answer(r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#).expect("a response");
        assert_eq!(response["error"]["code"], error_code::METHOD_NOT_FOUND);
    }

    #[test]
    fn a_call_with_no_tool_name_is_a_parameter_error() {
        let response = answer(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{}}"#)
            .expect("a response");
        assert_eq!(response["error"]["code"], error_code::INVALID_PARAMS);
    }

    #[test]
    fn ping_is_answered_empty() {
        let response =
            answer(r#"{"jsonrpc":"2.0","id":6,"method":"ping"}"#).expect("a response");
        assert_eq!(response["result"], serde_json::json!({}));
    }

    #[test]
    fn a_message_is_written_as_exactly_one_line() {
        // The framing rule. A response containing a raw newline splits into two
        // records and desynchronises every message after it.
        let mut out: Vec<u8> = Vec::new();
        write_message(
            &mut out,
            &Response::ok(json!(1), json!({ "text": "first\nsecond" })),
        )
        .expect("write");
        let written = String::from_utf8(out).expect("utf8");
        assert_eq!(written.matches('\n').count(), 1);
        assert!(written.ends_with('\n'));
    }
}
