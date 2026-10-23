//! `terminal` — the agent's terminals in the Terminal panel, in one tool.
//!
//! One tool for list, read, start, type and stop, with the action worked out
//! from the arguments. Not an `op` field: Aurora's old `todo` tool had one, and
//! every call the model sent without it cost a whole request. Here no field
//! names the action, so there is none to forget, and a call that mixes shapes
//! is refused with a sentence naming what arrived.
//!
//! A started terminal is a real tab in the right panel: the person watches it
//! live and can type into it. The call never waits for the program to finish;
//! it returns what printed in a short window and the agent reads later.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_runtime::api_client::ToolSchema;
use crate::agent_runtime::tool_executor::{ToolContext, ToolError, ToolExecutor};
use crate::pty_sessions::{self, keys, screen, Session};

pub struct TerminalTool;

/// How long a start or a keystroke waits for output by default, and at most.
const DEFAULT_WAIT_MS: u64 = 1_500;
const MAX_WAIT_MS: u64 = 15_000;
/// Output quiet for this long counts as "the program is waiting".
const QUIET_MS: u64 = 400;
const DEFAULT_HEAD: usize = 40;
const DEFAULT_TAIL: usize = 60;

#[async_trait]
impl ToolExecutor for TerminalTool {
    fn name(&self) -> &str {
        "terminal"
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "terminal".into(),
            description: "Terminals in Aurora's Terminal panel (right side), which the user sees \
                live. Use one when a command needs a real terminal or the user should watch it: a \
                dev server, an interactive program (menus, prompts, a REPL), anything that asks \
                for input. For a command whose output you just need, use shell_execute; for a \
                quiet background job, shell_spawn.\n\n\
                The action comes from the arguments:\n\
                - {} → list every open terminal (the user's and yours): id, title, running, exit code.\n\
                - {command, name?, shell?, cwd?} → start a terminal running `command` in a new tab. \
                Returns its id at once, with whatever it printed in the first moment (wait_ms, \
                default 1500). It never waits for the program to finish.\n\
                - {id} → read it: the screen as plain text, colours and redraws applied. A line \
                marked `▶` is highlighted (the selected item of an arrow-key menu).\n\
                - {id, input} → type text into it; end with \\n to press Enter. {id, keys: [...]} \
                presses named keys (up, down, enter, tab, esc, ctrl+c, …). Returns what came back.\n\
                - {id, stop: true} → stop it and everything it started.\n\n\
                You can type into and stop only terminals you started; the user's own tabs are \
                read-only. `@terminal:<id>` in a message is the user pointing at a terminal: \
                read it with {id}. Do not type passwords or answer prompts meant for the user: stop and \
                ask them. When a terminal you started exits during your turn you are told."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Start: the command to run in a new terminal." },
                    "name": { "type": "string", "description": "Start: the tab's title, e.g. \"dev server\"." },
                    "shell": { "type": "string", "description": "Start: pwsh, powershell, bash, cmd, … Defaults to the user's default shell." },
                    "cwd": { "type": "string", "description": "Start: working directory, relative to the workspace. Defaults to the workspace root." },
                    "id": { "type": "string", "description": "The terminal to read, type into or stop." },
                    "input": { "type": "string", "description": "Text to type. End with \\n to press Enter." },
                    "keys": { "type": "array", "items": { "type": "string" }, "description": "Named keys to press in order." },
                    "stop": { "type": "boolean", "description": "true stops the terminal and everything it started." },
                    "scope": { "type": "string", "enum": ["all", "last_input"], "description": "Read: everything (default), or only what followed the last Enter." },
                    "wait_ms": { "type": "number", "description": "Start/type: how long to wait for output before returning (default 1500, max 15000, 0 = return at once)." },
                    "head_lines": { "type": "number", "description": "Read: lines kept from the start (default 40)." },
                    "tail_lines": { "type": "number", "description": "Read: lines kept from the end (default 60)." }
                },
                "required": [],
                "additionalProperties": false,
            }),
        }
    }

    /// Starting and typing run commands, as `shell_execute` does.
    fn requires_permission(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        ctx.bail_if_cancelled()?;
        match action(&input)? {
            Action::List => Ok(list()),
            Action::Read(id) => read(&input, id),
            Action::Start(command) => start(&input, &command, ctx).await,
            Action::Type(id) => type_into(&input, id, ctx).await,
            Action::Stop(id) => stop(id, ctx).await,
        }
    }
}

enum Action {
    List,
    Read(u32),
    Start(String),
    Type(u32),
    Stop(u32),
}

fn text(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
}

/// Work out the action from which arguments arrived.
fn action(input: &Value) -> Result<Action, ToolError> {
    let id = match input.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) if raw.trim().is_empty() => None,
        Some(value) => Some(parse_id(value)?),
    };
    let command = text(input, "command");
    let typing = input.get("input").is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        || input
            .get("keys")
            .and_then(Value::as_array)
            .is_some_and(|keys| !keys.is_empty());
    let stop = input.get("stop").and_then(Value::as_bool).unwrap_or(false);

    match (id, command, typing, stop) {
        (None, None, false, false) => Ok(Action::List),
        (None, Some(command), false, false) => Ok(Action::Start(command)),
        (Some(id), None, false, false) => Ok(Action::Read(id)),
        (Some(id), None, true, false) => Ok(Action::Type(id)),
        (Some(id), None, false, true) => Ok(Action::Stop(id)),
        (Some(_), Some(_), _, _) => Err(ToolError::InvalidInput(
            "`command` starts a NEW terminal, so it takes no `id`. To type into terminal `id`, \
             send `input` instead of `command`."
                .into(),
        )),
        (None, _, true, _) | (None, _, _, true) => Err(ToolError::InvalidInput(
            "`input`, `keys` and `stop` act on an existing terminal: add its `id` (call terminal \
             with no arguments to list them)."
                .into(),
        )),
        (Some(_), None, true, true) => Err(ToolError::InvalidInput(
            "Send `stop` on its own, not together with `input` or `keys`.".into(),
        )),
    }
}

fn parse_id(value: &Value) -> Result<u32, ToolError> {
    let parsed = match value {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().trim_start_matches('t').parse::<u64>().ok(),
        _ => None,
    };
    parsed
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| {
            ToolError::InvalidInput(format!(
                "`id` {value} is not a terminal id. Call terminal with no arguments to list them."
            ))
        })
}

fn wait(input: &Value) -> Duration {
    let ms = input
        .get("wait_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_WAIT_MS)
        .min(MAX_WAIT_MS);
    Duration::from_millis(ms)
}

fn lines(input: &Value, key: &str, default: usize) -> usize {
    input
        .get(key)
        .and_then(Value::as_u64)
        .map_or(default, |n| n as usize)
}

fn summary(session: &Session) -> Value {
    let info = session.info();
    json!({
        "id": session.id.to_string(),
        "title": info.title,
        "shell": info.shell,
        "cwd": info.cwd,
        "startedBy": if info.owner_thread.is_some() { "agent" } else { "user" },
        "command": info.command,
        "running": session.running(),
        "exitCode": session.exit_code(),
    })
}

fn list() -> String {
    let terminals: Vec<Value> = pty_sessions::all().iter().map(|s| summary(s)).collect();
    json!({
        "success": true,
        "terminals": terminals,
        "note": if terminals.is_empty() { Some("No terminal is open.") } else { None },
    })
    .to_string()
}

fn snapshot(session: &Session, scope: screen::Scope, head: usize, tail: usize) -> Value {
    let read = session.read(scope, head, tail);
    let mut result = summary(session);
    result["success"] = json!(true);
    result["output"] = json!(read.text);
    result["totalLines"] = json!(read.total_lines);
    if read.hidden_lines > 0 {
        result["hiddenLines"] = json!(read.hidden_lines);
    }
    if read.full_screen {
        result["fullScreen"] = json!(true);
    }
    result
}

fn find(id: u32) -> Result<std::sync::Arc<Session>, ToolError> {
    pty_sessions::session(id).map_err(|error| {
        ToolError::InvalidInput(format!(
            "{error} Call terminal with no arguments to list the open ones."
        ))
    })
}

fn read(input: &Value, id: u32) -> Result<String, ToolError> {
    let session = find(id)?;
    let scope = match input.get("scope").and_then(Value::as_str) {
        Some("last_input") => session
            .last_input_line()
            .map_or(screen::Scope::All, screen::Scope::From),
        _ => screen::Scope::All,
    };
    let head = lines(input, "head_lines", DEFAULT_HEAD);
    let tail = lines(input, "tail_lines", DEFAULT_TAIL);
    Ok(snapshot(&session, scope, head, tail).to_string())
}

/// Only the conversation that started a terminal may type into or stop it.
fn owned(session: &Session, ctx: &ToolContext) -> Result<(), ToolError> {
    match session.info().owner_thread {
        Some(owner) if owner == ctx.thread_id => Ok(()),
        Some(_) => Err(ToolError::PolicyViolation(format!(
            "Terminal {} was started by another conversation; you can read it but not type into \
             or stop it.",
            session.id
        ))),
        None => Err(ToolError::PolicyViolation(format!(
            "Terminal {} is the user's own tab; you can read it but not type into or stop it. \
             Start your own with `command`.",
            session.id
        ))),
    }
}

async fn start(input: &Value, command: &str, ctx: &ToolContext) -> Result<String, ToolError> {
    let shell = text(input, "shell");
    let kind = crate::shell::resolve_kind(shell.as_deref());
    super::shell_execute::validate_shell_command(command, input, ctx, kind)?;
    let cwd = super::shell_execute::resolve_working_directory(input, ctx)?;
    let title = text(input, "name").unwrap_or_else(|| command.chars().take(40).collect());
    let owner = ctx.thread_id.clone();
    let command = command.to_string();
    let wait = wait(input);
    tokio::task::spawn_blocking(move || {
        let session = pty_sessions::open_for_agent(
            shell.as_deref().unwrap_or(""),
            &command,
            Some(cwd),
            title,
            owner,
        )
        .map_err(ToolError::Execution)?;
        let settled = wait.is_zero() || session.settle(Duration::from_millis(QUIET_MS), wait);
        let mut result = snapshot(&session, screen::Scope::All, DEFAULT_HEAD, DEFAULT_TAIL);
        result["message"] = json!(format!(
            "Started in the Terminal panel as terminal {}. It keeps running; read it with \
             {{\"id\": \"{}\"}} when you need its output.",
            session.id, session.id
        ));
        if !settled {
            result["stillPrinting"] = json!(true);
        }
        Ok(result.to_string())
    })
    .await
    .map_err(|error| ToolError::Execution(format!("terminal start task failed: {error}")))?
}

async fn type_into(input: &Value, id: u32, ctx: &ToolContext) -> Result<String, ToolError> {
    let session = find(id)?;
    owned(&session, ctx)?;
    if !session.running() {
        return Err(ToolError::InvalidInput(format!(
            "Terminal {id} has exited (code {}); there is nothing to type into.",
            session.exit_code().map_or("unknown".into(), |c| c.to_string())
        )));
    }
    let mut bytes: Vec<u8> = Vec::new();
    if let Some(text) = input.get("input").and_then(Value::as_str) {
        // A model writes `\n` for Enter; a terminal's Enter is `\r`.
        bytes.extend(text.replace("\r\n", "\r").replace('\n', "\r").into_bytes());
    }
    if let Some(names) = input.get("keys").and_then(Value::as_array) {
        for name in names {
            let name = name.as_str().unwrap_or_default();
            let key = keys::bytes(name).ok_or_else(|| {
                ToolError::InvalidInput(format!(
                    "Unknown key `{name}`. Keys: {}. For text, use `input`.",
                    keys::NAMES
                ))
            })?;
            bytes.extend(key);
        }
    }
    let wait = wait(input);
    tokio::task::spawn_blocking(move || {
        let before = session.last_input_line();
        session.write(&bytes).map_err(ToolError::Execution)?;
        let settled = wait.is_zero() || session.settle(Duration::from_millis(QUIET_MS), wait);
        // What this input produced: from the line it was typed on.
        let scope = session
            .last_input_line()
            .or(before)
            .map_or(screen::Scope::All, screen::Scope::From);
        let mut result = snapshot(&session, scope, DEFAULT_HEAD, DEFAULT_TAIL);
        if !settled {
            result["stillPrinting"] = json!(true);
        }
        Ok(result.to_string())
    })
    .await
    .map_err(|error| ToolError::Execution(format!("terminal write task failed: {error}")))?
}

async fn stop(id: u32, ctx: &ToolContext) -> Result<String, ToolError> {
    let session = find(id)?;
    owned(&session, ctx)?;
    drop(session);
    tokio::task::spawn_blocking(move || pty_sessions::kill(id))
        .await
        .map_err(|error| ToolError::Execution(format!("terminal stop task failed: {error}")))?
        .map_err(ToolError::Execution)?;
    Ok(json!({
        "success": true,
        "id": id.to_string(),
        "message": format!("Stopped terminal {id} and everything it started."),
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(input: Value) -> Result<&'static str, String> {
        action(&input)
            .map(|a| match a {
                Action::List => "list",
                Action::Read(_) => "read",
                Action::Start(_) => "start",
                Action::Type(_) => "type",
                Action::Stop(_) => "stop",
            })
            .map_err(|e| e.to_string())
    }

    /// The action is the shape of the call; no field to forget.
    #[test]
    fn the_action_comes_from_the_arguments() {
        assert_eq!(kind(json!({})).unwrap(), "list");
        assert_eq!(kind(json!({"command": "pnpm dev"})).unwrap(), "start");
        assert_eq!(kind(json!({"id": "3"})).unwrap(), "read");
        assert_eq!(kind(json!({"id": 3, "input": "1\n"})).unwrap(), "type");
        assert_eq!(kind(json!({"id": "3", "keys": ["down", "enter"]})).unwrap(), "type");
        assert_eq!(kind(json!({"id": "3", "stop": true})).unwrap(), "stop");
        // Blank fields some gateways send for every declared property.
        assert_eq!(kind(json!({"id": "", "command": "", "keys": []})).unwrap(), "list");
    }

    #[test]
    fn a_mixed_call_is_refused_with_the_shape_that_works() {
        assert!(kind(json!({"id": "3", "command": "ls"})).unwrap_err().contains("send `input`"));
        assert!(kind(json!({"input": "y\n"})).unwrap_err().contains("add its `id`"));
        assert!(kind(json!({"id": "3", "stop": true, "input": "x"}))
            .unwrap_err()
            .contains("`stop` on its own"));
        assert!(kind(json!({"id": "abc"})).unwrap_err().contains("not a terminal id"));
    }
}
