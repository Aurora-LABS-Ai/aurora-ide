//! What another agent can ask Aurora to do, and what it gets back.
//!
//! ## The roster never changes; what a call can do does
//!
//! Every tool is listed whether or not Aurora is running. A client that only
//! saw tools while the app happened to be open would show an empty server on a
//! cold machine, and the agent reading it would conclude Aurora cannot do
//! anything — which is exactly backwards, since the fix is to open a window.
//!
//! So the roster is fixed at build time and the *gate* lives in the call.
//! [`aurora_agent_status`](STATUS) always answers, because it is how a caller
//! finds out what is wrong. Everything else checks
//! [`Readiness`](super::super::bridge::Readiness) first and refuses with the
//! one action that would fix it.
//!
//! ## Descriptions are the interface
//!
//! Another model reads these strings and nothing else. They are written for
//! that reader: what the tool does, what it costs, when *not* to call it. A
//! description that undersells the cost of `aurora_agent_dispatch` produces an
//! agent that fires five tasks into someone's editor to see what sticks.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::super::bridge::{BridgeState, Readiness};
use super::super::cancel;
use super::super::catalog::Catalog;
use super::super::follow::Tail;
use super::super::inbox::Inbox;
use super::super::render::summarize;
use super::super::run::collect_task_summaries;
use super::super::task::{
    new_task_id, ResultKind, TaskEvent, TaskMode, TaskOrigin, TaskRequest, TASK_FORMAT_VERSION,
};
use super::super::threads::Threads;
use super::protocol::{tool_error, tool_text, Request};

/// Tool names, as one place rather than scattered string literals.
pub const STATUS: &str = "aurora_agent_status";
pub const DISPATCH: &str = "aurora_agent_dispatch";
pub const WATCH: &str = "aurora_agent_watch";
pub const CANCEL: &str = "aurora_agent_cancel";
pub const TASKS: &str = "aurora_agent_tasks";
pub const THREADS: &str = "aurora_agent_threads";
pub const MODELS: &str = "aurora_agent_models";

/// Every tool name, for the "no such tool" answer and for the test that keeps
/// this list and [`roster`] from drifting apart.
pub const ALL: &[&str] = &[STATUS, DISPATCH, WATCH, CANCEL, TASKS, THREADS, MODELS];

/// Longest tool result this server will return, in characters.
///
/// A run that touched forty files would otherwise return a transcript larger
/// than most of the context the caller has to think in. Cut at the *front* of
/// the tail rather than the end: the last thing that happened is what a caller
/// is asking about, and the opening of a long run is the part it already saw on
/// the previous call.
const MAX_RESULT_CHARS: usize = 20_000;

/// Longest single tool output quoted inside a run summary.
///
/// The full text is in the transcript (capped at 16 KiB there) and in Aurora's
/// own session record. This is the reading copy: enough to tell a file read
/// from a failed build, not enough for one `grep` to fill the answer.
const MAX_TOOL_OUTPUT_CHARS: usize = 240;

/// How often a waiting call re-reads the transcript.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Every tool, in the order a caller meets them.
pub fn roster() -> Vec<Value> {
    vec![
        json!({
            "name": STATUS,
            "description": "\
Is Aurora available, and what is it doing right now. Call this first, and call \
it again after any other tool reports that Aurora is unavailable.

This is the only tool that works when Aurora is closed — it is how you find out \
that it is. It reports which of three things is missing (Aurora not running, the \
Agent Window not open, or the user's permission switch off) and what fixes it. \
When Aurora is available it also reports the project it has open, the \
conversation on screen, the model that conversation runs on, and whether a turn \
is running right now.

Costs nothing and changes nothing.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": DISPATCH,
            "description": "\
Send Aurora a task. It arrives in the Agent Window as a real message and runs \
there — with file access, a shell, and a person watching who can steer or stop \
it.

This is a real agent doing real work on someone's machine, not a query. It edits \
files, runs commands, and takes as long as the work takes. Send one task and \
follow it; do not fan out several to see which lands. If you only want to look \
without changing anything, pass mode \"plan\", which holds it to read-only tools.

Returns a task id immediately. Pass wait true to stay on the call until it \
finishes, but only for work you expect to be short — a long task will hit your \
own client's timeout, and the honest way to follow one is aurora_agent_watch.

By default this starts a new conversation. Pass conversation \"latest\" to \
continue the project's most recent one, or a thread id to continue a specific \
one; Aurora then remembers everything already said, which is usually what you \
want for a follow-up.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "What you want done, written as you would say it to a capable colleague who cannot see your screen. Aurora sees this and nothing else about why you asked."
                    },
                    "path": {
                        "type": "string",
                        "description": "Absolute path of the project to work in. Defaults to the project the Agent Window already has open, which is almost always the right one."
                    },
                    "conversation": {
                        "type": "string",
                        "description": "\"new\" (default) starts a fresh conversation. \"latest\" continues this project's most recent one. A thread id, or any unique prefix of one from aurora_agent_threads, continues that one."
                    },
                    "model": {
                        "type": "string",
                        "description": "Model to run on, e.g. \"glm-5.2\", or \"fireworks:glm-5.2\" when several providers serve that name. Omit to use whatever the Agent Window has selected. Names come from aurora_agent_models."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["agent", "plan"],
                        "description": "\"agent\" (default) has the full toolset and edits files. \"plan\" is read-only: it can look and report, and cannot change anything."
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "Stay on the call until the task finishes. Default false. Use only for work you expect to take under a minute."
                    },
                    "timeoutSeconds": {
                        "type": "integer",
                        "description": "How long to wait when wait is true, 5 to 600. Default 60. Hitting it does not stop the task — you get what happened so far and a cursor to carry on with."
                    }
                },
                "required": ["prompt"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": WATCH,
            "description": "\
Read what a dispatched task has done, from where you left off.

Pass the cursor from the previous call to get only what is new; leave it out to \
read from the beginning. Every call returns a fresh cursor, whether or not \
anything new arrived, so a follow-up never repeats what you have already seen.

By default it waits for something to happen rather than returning an empty \
answer, which makes a polling loop cheap. Aurora's reasoning is left out — you \
get the assistant's replies, the tools it ran and how they turned out, and how \
the run ended.

Watching never affects the task: leaving does not stop it, and neither does \
timing out.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "Task id from aurora_agent_dispatch, or any unique prefix of one."
                    },
                    "cursor": {
                        "type": "integer",
                        "description": "How much of the run you have already read. Use the cursor returned by your last call. Omit to read from the start."
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "Wait for new activity instead of returning immediately. Default true. Returns as soon as anything arrives."
                    },
                    "timeoutSeconds": {
                        "type": "integer",
                        "description": "How long to wait, 5 to 600. Default 30."
                    }
                },
                "required": ["task"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": CANCEL,
            "description": "\
Stop a dispatched task.

A task that has not started yet is dropped and never runs. One that is running \
is stopped the same way the Stop button in the Agent Window does it — the turn \
ends after the tool it is currently in returns, so a shell command already \
underway finishes first.

Work already done is not undone. Files Aurora has written stay written; stopping \
it is not a way to roll anything back.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "Task id, or any unique prefix of one."
                    }
                },
                "required": ["task"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": TASKS,
            "description": "\
Tasks that have been sent to Aurora, newest first, with how each one ended.

Covers everything dispatched on this machine, including work sent from a \
terminal rather than by you. Use it to find the id of something you lost track \
of, or to check whether anything is still running before sending more.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "How many to list, 1 to 100. Default 20."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": THREADS,
            "description": "\
Aurora's conversations, most recently used first.

Each one is a chat with its own memory of what has been discussed. Continue one \
by passing its id to aurora_agent_dispatch as the conversation, which is how you \
ask a follow-up that builds on earlier work rather than starting over.

Scoped to the project the Agent Window has open unless you say otherwise.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path of the project whose conversations you want. Defaults to the one the Agent Window has open."
                    },
                    "all": {
                        "type": "boolean",
                        "description": "List conversations from every project instead of one. Default false."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "How many to list, 1 to 100. Default 20."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": MODELS,
            "description": "\
The models Aurora can run, grouped by the provider that serves them.

Worth reading before naming a model, because the same name is often served by \
several providers at different context sizes and prices. When that happens the \
qualified \"provider:model\" form is what aurora_agent_dispatch needs — an \
ambiguous name is refused rather than guessed at.

Omitting the model entirely is fine and common: the task then runs on whatever \
the Agent Window has selected.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Only models whose name contains this. Omit for all of them."
                    }
                },
                "additionalProperties": false
            }
        }),
    ]
}

/// Run one tool call.
///
/// The gate is applied here, once, rather than inside each tool: every tool but
/// [`STATUS`] needs the same three conditions, and a check repeated seven times
/// is a check that will eventually be forgotten in the eighth.
pub fn call(name: &str, request: &Request) -> Value {
    if name == STATUS {
        return status();
    }

    // The name is checked before the gate, and the order matters. A caller that
    // misspelled a tool must be told *that*, not that Aurora is closed —
    // otherwise it opens Aurora, tries the same wrong name, and gets a
    // different wrong answer.
    //
    // The calling model chose this name, so it is the calling model that has to
    // learn it was wrong. A JSON-RPC error would be swallowed by its client and
    // surface as a transport failure it cannot act on.
    if !ALL.contains(&name) {
        return tool_error(format!(
            "There is no tool called {name}. Aurora offers: {}.",
            ALL.join(", ")
        ));
    }

    let readiness = Readiness::check();
    let Some(state) = readiness.state() else {
        return tool_error(readiness.refusal());
    };

    match name {
        DISPATCH => dispatch(request, state),
        WATCH => watch(request),
        CANCEL => cancel_task(request),
        TASKS => tasks(request),
        THREADS => threads(request, state),
        MODELS => models(request),
        // Unreachable: `ALL` gates entry and `STATUS` returned above. Kept as a
        // result rather than a panic because a roster entry added without a
        // handler should be a bad answer to one call, not a dead server.
        other => tool_error(format!("{other} is listed but not implemented.")),
    }
}

// ── status ──────────────────────────────────────────────────────────────────

/// `aurora_agent_status` — the one call that always answers.
fn status() -> Value {
    let readiness = Readiness::check();
    let Some(state) = readiness.state() else {
        // Not an error result. The caller asked a question and got a true
        // answer; flagging it as a failure would have a careful agent report
        // that the status check broke, when what it found is that Aurora is
        // simply closed.
        return tool_text(format!(
            "Aurora is not available.\n\nstate: {}\n\n{}",
            readiness.label(),
            readiness.refusal()
        ));
    };

    let mut lines = vec![
        "Aurora is ready to accept work.".to_string(),
        String::new(),
        "state: ready".to_string(),
    ];
    match &state.workspace {
        Some(workspace) => lines.push(format!("project: {workspace}")),
        None => lines.push(
            "project: none open — pass an explicit path when you dispatch".to_string(),
        ),
    }
    if let Some(title) = &state.thread_title {
        let id = state.thread_id.as_deref().unwrap_or("");
        lines.push(format!("conversation on screen: {title} ({id})"));
    }
    if let Some(model) = &state.model {
        lines.push(format!("model: {model}"));
    }
    lines.push(format!(
        "busy: {}",
        if state.busy {
            "yes — a turn is running. A task sent now is queued behind it."
        } else {
            "no"
        }
    ));

    // What is already in flight, so a caller can see it is about to pile work
    // onto a machine that is not finished with the last lot.
    if let Ok(summaries) = collect_task_summaries() {
        let live = summaries
            .iter()
            .filter(|task| task.status == "running" || task.status == "queued")
            .count();
        if live > 0 {
            lines.push(format!(
                "tasks not finished: {live} (see {TASKS} for what they are)"
            ));
        }
    }

    tool_text(lines.join("\n"))
}

// ── dispatch ────────────────────────────────────────────────────────────────

/// `aurora_agent_dispatch` — write a task request and, optionally, wait on it.
fn dispatch(request: &Request, state: &BridgeState) -> Value {
    let Some(prompt) = request.arg_str("prompt") else {
        return tool_error(
            "dispatch needs a prompt: what you want Aurora to do, in words it can act on.",
        );
    };

    let workspace = match resolve_workspace(request.arg_str("path"), state) {
        Ok(workspace) => workspace,
        Err(message) => return tool_error(message),
    };

    let model = match resolve_model(request.arg_str("model")) {
        Ok(model) => model,
        Err(message) => return tool_error(message),
    };

    let thread_id = match resolve_conversation(request.arg_str("conversation"), &workspace) {
        Ok(thread) => thread,
        Err(message) => return tool_error(message),
    };

    let mode = match request.arg_str("mode").as_deref() {
        None | Some("agent") => TaskMode::Agent,
        Some("plan") => TaskMode::Plan,
        Some(other) => {
            return tool_error(format!(
                "mode must be \"agent\" or \"plan\", not {other:?}. \
                 \"plan\" is the read-only one."
            ))
        }
    };

    let inbox = Inbox::open();
    let task = TaskRequest {
        version: TASK_FORMAT_VERSION,
        id: new_task_id(),
        created_at: chrono::Utc::now().to_rfc3339(),
        prompt,
        workspace_path: workspace.to_string_lossy().into_owned(),
        thread_id,
        provider_id: model.as_ref().map(|entry| entry.0.clone()),
        model: model.as_ref().map(|entry| entry.1.clone()),
        mode,
        // No `--out` equivalent. The caller is reading this through
        // `aurora_agent_watch`, and a second copy at a path it would have to
        // invent is a file nobody deletes.
        out_path: None,
        origin: TaskOrigin::capture(),
    };

    if let Err(error) = inbox.write_request(&task) {
        return tool_error(format!("Aurora could not be given the task: {error}"));
    }

    let mut lines = vec![
        format!("Sent to Aurora. task: {}", task.id),
        format!("project: {}", task.workspace_path),
    ];
    if let Some(pin) = task.model_pin() {
        lines.push(format!("model: {pin}"));
    }
    if let Some(thread) = &task.thread_id {
        lines.push(format!("continuing conversation: {thread}"));
    }
    if mode == TaskMode::Plan {
        lines.push("mode: plan — read-only, it will not change any file".to_string());
    }

    if !request.arg_bool("wait", false) {
        lines.push(String::new());
        lines.push(format!(
            "It is running in the Agent Window now. Read it with {WATCH} \
             (task: {}), or stop it with {CANCEL}.",
            task.id
        ));
        return tool_text(lines.join("\n"));
    }

    let timeout = Duration::from_secs(request.arg_u64("timeoutSeconds", 60, 5, 600));
    let transcript = inbox.transcript_path(&task.id);
    let run = read_run(&transcript, 0, true, timeout);

    lines.push(String::new());
    lines.push(run.render(&task.id));
    tool_text(lines.join("\n"))
}

/// Which project a task runs in.
///
/// The window's own project is the default rather than this process's working
/// directory. An MCP server inherits its working directory from whichever
/// client launched it, which may be anywhere on the machine and has no
/// relationship to what the person in front of Aurora is doing — silently
/// dispatching into it is how a task edits the wrong repository.
fn resolve_workspace(explicit: Option<String>, state: &BridgeState) -> Result<PathBuf, String> {
    let candidate = match explicit {
        Some(path) => PathBuf::from(path),
        None => match &state.workspace {
            Some(workspace) => PathBuf::from(workspace),
            None => {
                return Err(
                    "Aurora does not have a project open, so there is nowhere to run this. \
                     Pass an absolute path, or ask the user to open a project in the Agent Window."
                        .to_string(),
                )
            }
        },
    };

    // Resolved to an absolute path before it is written, exactly as the CLI
    // does: the app that claims this request has its own working directory, and
    // a relative path would resolve against the wrong one.
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        std::env::current_dir()
            .map_err(|error| format!("could not resolve {}: {error}", candidate.display()))?
            .join(candidate)
    };

    if !absolute.is_dir() {
        return Err(format!(
            "{} is not a folder on this machine. Pass the absolute path of the project.",
            absolute.display()
        ));
    }
    Ok(absolute)
}

/// Resolve a model name to a `(provider_id, model_key)` pair, or nothing.
///
/// `Ok(None)` means the caller named no model and the window's own selection
/// should be used, which is both the default and the common case.
fn resolve_model(query: Option<String>) -> Result<Option<(String, String)>, String> {
    let Some(query) = query else {
        return Ok(None);
    };

    let catalog = Catalog::load().map_err(|error| {
        format!("Aurora's model list could not be read: {error}. Dispatch without a model to use whatever the Agent Window has selected.")
    })?;

    // A qualified `provider:model` splits here; a bare name is resolved against
    // every provider and refused when more than one serves it. Never guessed —
    // the same name on two providers can be two different models at two prices.
    let (provider, name) = match query.split_once(':') {
        Some((provider, name)) => (Some(provider.trim().to_string()), name.trim().to_string()),
        None => (None, query),
    };

    catalog
        .resolve(&name, provider.as_deref())
        .map(|entry| Some((entry.provider_id, entry.model_key)))
        .map_err(|error| format!("{error}\n\nCall {MODELS} to see what is configured."))
}

/// Resolve the `conversation` argument to a thread id, or nothing for a new chat.
fn resolve_conversation(query: Option<String>, workspace: &Path) -> Result<Option<String>, String> {
    let query = match query {
        None => return Ok(None),
        Some(query) if query.eq_ignore_ascii_case("new") => return Ok(None),
        Some(query) => query,
    };

    let scope = workspace.to_string_lossy().into_owned();
    let threads = Threads::load(Some(&scope))
        .map_err(|error| format!("Aurora's conversations could not be read: {error}"))?;

    if query.eq_ignore_ascii_case("latest") {
        return match threads.latest() {
            Some(summary) => Ok(Some(summary.id.clone())),
            // Asking to continue where there is nothing to continue is a
            // mistake worth naming: silently starting a new chat would look
            // identical and lose the caller's intent.
            None => Err(format!(
                "There are no conversations yet in {scope}, so there is nothing to continue. \
                 Omit conversation (or pass \"new\") to start one."
            )),
        };
    }

    threads
        .resolve(&query)
        .map(|summary| Some(summary.id))
        .map_err(|error| format!("{error}\n\nCall {THREADS} to see what is there."))
}

// ── watch ───────────────────────────────────────────────────────────────────

/// `aurora_agent_watch` — read a run from a cursor.
fn watch(request: &Request) -> Value {
    let Some(query) = request.arg_str("task") else {
        return tool_error(format!(
            "watch needs a task id. {TASKS} lists what has been dispatched."
        ));
    };
    let inbox = Inbox::open();
    let id = match resolve_task_id(&inbox, &query) {
        Ok(id) => id,
        Err(message) => return tool_error(message),
    };

    let cursor = request.arg_u64("cursor", 0, 0, u64::MAX) as usize;
    let wait = request.arg_bool("wait", true);
    let timeout = Duration::from_secs(request.arg_u64("timeoutSeconds", 30, 5, 600));

    let run = read_run(&inbox.transcript_path(&id), cursor, wait, timeout);
    tool_text(run.render(&id))
}

// ── cancel ──────────────────────────────────────────────────────────────────

/// `aurora_agent_cancel` — ask a task to stop.
fn cancel_task(request: &Request) -> Value {
    let Some(query) = request.arg_str("task") else {
        return tool_error(format!("cancel needs a task id. {TASKS} lists them."));
    };
    let inbox = Inbox::open();
    let id = match resolve_task_id(&inbox, &query) {
        Ok(id) => id,
        Err(message) => return tool_error(message),
    };

    // Already over. Saying so beats writing a marker that expires unnoticed,
    // and it tells the caller the work it wanted stopped is already done.
    if let Some(status) = task_status(&inbox, &id) {
        if matches!(status.as_str(), "done" | "failed" | "stopped") {
            return tool_text(format!(
                "Task {id} had already finished ({status}), so there was nothing to stop. \
                 Read what it did with {WATCH}."
            ));
        }
    }

    match cancel::request(&inbox, &id) {
        Ok(()) => tool_text(format!(
            "Asked Aurora to stop task {id}.\n\n\
             A turn part-way through a tool ends when that tool returns, so this is not \
             instant. Anything already written to disk stays written. Confirm with {WATCH}, \
             which ends the run with \"stopped\"."
        )),
        Err(error) => tool_error(format!("The stop request could not be written: {error}")),
    }
}

// ── lists ───────────────────────────────────────────────────────────────────

/// `aurora_agent_tasks`
fn tasks(request: &Request) -> Value {
    let limit = request.arg_u64("limit", 20, 1, 100) as usize;
    let summaries = match collect_task_summaries() {
        Ok(summaries) => summaries,
        Err(error) => return tool_error(format!("The task list could not be read: {error}")),
    };

    if summaries.is_empty() {
        return tool_text("No tasks have been sent to Aurora on this machine yet.".to_string());
    }

    let total = summaries.len();
    let mut lines = Vec::new();
    for task in summaries.iter().take(limit) {
        lines.push(format!(
            "{}  {:<8}  {}\n    {}  ({})",
            task.id,
            task.status,
            task.prompt,
            project_name(&task.workspace_path),
            task.created_at
        ));
    }
    if total > limit {
        lines.push(format!("\n{} more not shown.", total - limit));
    }
    tool_text(lines.join("\n"))
}

/// `aurora_agent_threads`
fn threads(request: &Request, state: &BridgeState) -> Value {
    let limit = request.arg_u64("limit", 20, 1, 100) as usize;
    let all = request.arg_bool("all", false);

    // `all` wins over an explicit path: asking for every project's
    // conversations and naming one project is a contradiction, and the broader
    // reading is the one that cannot silently hide what the caller asked for.
    let scope = if all {
        None
    } else {
        request.arg_str("path").or_else(|| state.workspace.clone())
    };

    let threads = match Threads::load(scope.as_deref()) {
        Ok(threads) => threads,
        Err(error) => {
            return tool_error(format!("Aurora's conversations could not be read: {error}"))
        }
    };

    if threads.all.is_empty() {
        return tool_text(match &scope {
            Some(path) => format!("No conversations in {path} yet."),
            None => "No conversations yet.".to_string(),
        });
    }

    let total = threads.all.len();
    let mut lines = match &scope {
        Some(path) => vec![format!("Conversations in {path}, most recent first:\n")],
        None => vec!["Conversations across every project, most recent first:\n".to_string()],
    };
    for summary in threads.all.iter().take(limit) {
        let model = summary.model.as_deref().unwrap_or("no model pinned");
        lines.push(format!(
            "{}\n    {}  ({} messages, {}, last used {})",
            summary.id,
            summarize(&summary.title, 70),
            summary.message_count,
            model,
            summary.updated_at
        ));
    }
    if total > limit {
        lines.push(format!("\n{} more not shown.", total - limit));
    }
    tool_text(lines.join("\n"))
}

/// `aurora_agent_models`
fn models(request: &Request) -> Value {
    let catalog = match Catalog::load() {
        Ok(catalog) => catalog,
        Err(error) => return tool_error(format!("Aurora's model list could not be read: {error}")),
    };

    let query = request.arg_str("query");
    let entries = match &query {
        Some(query) => catalog.find(query, None),
        None => catalog.entries.clone(),
    };

    if entries.is_empty() {
        return tool_text(match &query {
            Some(query) => format!("No configured model matches {query:?}."),
            None => "No providers are configured in Aurora yet.".to_string(),
        });
    }

    let mut lines = Vec::new();
    let mut provider = String::new();
    for entry in &entries {
        if entry.provider_label() != provider {
            provider = entry.provider_label().to_string();
            lines.push(format!("\n{provider}"));
        }
        let mut detail = Vec::new();
        if let Some(window) = entry.context_window {
            detail.push(format!("{}k context", window / 1000));
        }
        if let Some(price) = entry.price_output_per_mtok {
            detail.push(format!("${price:.2}/M out"));
        }
        if entry.selected {
            detail.push("currently selected".to_string());
        }
        lines.push(format!(
            "  {}{}",
            entry.display_pin(),
            if detail.is_empty() {
                String::new()
            } else {
                format!("  ({})", detail.join(", "))
            }
        ));
    }

    lines.push(
        "\nPass the qualified \"provider:model\" form to aurora_agent_dispatch when \
         two providers serve the same name."
            .to_string(),
    );
    tool_text(lines.join("\n"))
}

// ── reading a run ───────────────────────────────────────────────────────────

/// What a read of a transcript found.
struct Run {
    /// Events after the caller's cursor, already filtered.
    events: Vec<TaskEvent>,
    /// Events consumed in total — the cursor for the next call.
    cursor: usize,
    /// Whether the run has ended.
    done: bool,
    /// True when the wait expired with nothing new.
    quiet: bool,
    /// True when nothing has claimed the task yet.
    unstarted: bool,
}

/// Read a transcript from `cursor`, optionally waiting for something to happen.
///
/// Waiting stops at the first new event rather than at the end of the run: a
/// caller that asked to be told when something happens has been told, and
/// holding the call open until the whole task finishes would make every wait
/// last as long as the work.
fn read_run(transcript: &Path, cursor: usize, wait: bool, timeout: Duration) -> Run {
    let deadline = Instant::now() + timeout;
    let mut tail = Tail::new(transcript.to_path_buf());
    let mut all: Vec<TaskEvent> = Vec::new();

    loop {
        if let Ok(fresh) = tail.poll() {
            all.extend(fresh);
        }
        let done = all
            .iter()
            .any(|event| matches!(event, TaskEvent::Result { .. }));

        if !wait || done || all.len() > cursor || Instant::now() >= deadline {
            let unstarted = all.is_empty();
            let events = all.split_off(cursor.min(all.len()));
            return Run {
                cursor: cursor + events.len(),
                quiet: events.is_empty() && !done,
                events,
                done,
                unstarted,
            };
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

impl Run {
    /// The whole answer a watch (or a waiting dispatch) returns.
    fn render(&self, task_id: &str) -> String {
        let mut out = String::new();

        if self.unstarted {
            out.push_str(
                "Aurora has not started this yet. The Agent Window claims a task within a \
                 second or two of it being sent, so this usually means the window was busy \
                 booting.\n\n",
            );
        } else if self.quiet {
            out.push_str("Nothing new happened while waiting. The task is still running.\n\n");
        }

        let body = render_events(&self.events);
        if !body.is_empty() {
            out.push_str(&body);
            out.push_str("\n\n");
        }

        out.push_str(&format!("cursor: {}\n", self.cursor));
        if self.done {
            out.push_str(&format!(
                "The run has ended. Nothing further will be added for task {task_id}."
            ));
        } else {
            out.push_str(&format!(
                "Still running. Call {WATCH} again with task {task_id} and cursor {} for what \
                 comes next.",
                self.cursor
            ));
        }
        out
    }
}

/// Turn transcript events into something a model reads as a narrative.
///
/// Runs of assistant text are joined into one block rather than left as the
/// deltas they arrive as, and reasoning is dropped entirely: it is the largest
/// thing in a transcript and the least useful to somebody asking what was
/// *done*.
fn render_events(events: &[TaskEvent]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut text = String::new();

    // Assistant text arrives as deltas. Flushing on the next non-text event
    // rebuilds the paragraph the person in front of Aurora actually saw.
    fn flush(text: &mut String, lines: &mut Vec<String>) {
        let whole = text.trim();
        if !whole.is_empty() {
            lines.push(format!("Aurora: {whole}"));
        }
        text.clear();
    }

    for event in events {
        match event {
            TaskEvent::Text { text: delta } => text.push_str(delta),

            // Reasoning is deliberately not rendered. See the function docs.
            TaskEvent::Thinking { .. } => {}

            TaskEvent::Dispatch {
                workspace_path,
                model,
                ..
            } => {
                flush(&mut text, &mut lines);
                lines.push(format!(
                    "Started in {}{}",
                    workspace_path,
                    model
                        .as_deref()
                        .map(|model| format!(" on {model}"))
                        .unwrap_or_default()
                ));
            }

            TaskEvent::Tool { name, input, .. } => {
                flush(&mut text, &mut lines);
                lines.push(format!(
                    "  ran {name} {}",
                    summarize(&input.to_string(), 160)
                ));
            }

            TaskEvent::ToolResult {
                name, ok, content, ..
            } => {
                flush(&mut text, &mut lines);
                lines.push(format!(
                    "  {} {name}: {}",
                    if *ok { "->" } else { "FAILED" },
                    summarize(content, MAX_TOOL_OUTPUT_CHARS)
                ));
            }

            TaskEvent::Notice { message } => {
                flush(&mut text, &mut lines);
                lines.push(format!("  note: {message}"));
            }

            // Token counts are Aurora's own accounting. A caller deciding what
            // to do next has no use for them, and they would appear between
            // every pair of lines.
            TaskEvent::Usage { .. } => {}

            TaskEvent::Result {
                subtype,
                result,
                error,
                duration_ms,
                num_turns,
            } => {
                flush(&mut text, &mut lines);
                let outcome = match subtype {
                    ResultKind::Success => "finished".to_string(),
                    ResultKind::Cancelled => "was stopped".to_string(),
                    ResultKind::Error => format!(
                        "failed: {}",
                        error.as_deref().unwrap_or("no reason was reported")
                    ),
                };
                lines.push(format!(
                    "\nThe task {outcome} after {} and {num_turns} model {}.",
                    human_duration(*duration_ms),
                    if *num_turns == 1 { "call" } else { "calls" }
                ));
                if let Some(answer) = result.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
                    lines.push(format!("\nWhat it said at the end:\n{answer}"));
                }
            }
        }
    }
    flush(&mut text, &mut lines);

    cap_from_the_front(&lines.join("\n"))
}

/// Trim a long run from the top, keeping the end.
///
/// The end is what the caller asked about; the beginning is what it read last
/// time. Cutting the other way would return the part it already has and drop
/// the answer.
fn cap_from_the_front(body: &str) -> String {
    if body.chars().count() <= MAX_RESULT_CHARS {
        return body.to_string();
    }
    let kept: String = body
        .chars()
        .skip(body.chars().count() - MAX_RESULT_CHARS)
        .collect();
    // Start at a line boundary so the first line is not half a sentence.
    let kept = match kept.find('\n') {
        Some(newline) => &kept[newline + 1..],
        None => &kept[..],
    };
    format!("[the earlier part of this run is not shown]\n{kept}")
}

/// A duration a person reads without converting it.
fn human_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    format!("{}m {}s", seconds / 60, seconds % 60)
}

/// The last path segment, for naming a project without a column of absolute path.
fn project_name(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Resolve a task id or unique prefix against the task directory.
fn resolve_task_id(inbox: &Inbox, query: &str) -> Result<String, String> {
    let query = query.trim();
    if inbox.transcript_path(query).exists() {
        return Ok(query.to_string());
    }

    let summaries = collect_task_summaries()
        .map_err(|error| format!("The task list could not be read: {error}"))?;
    let matches: Vec<&str> = summaries
        .iter()
        .map(|task| task.id.as_str())
        .filter(|id| id.starts_with(query))
        .collect();

    match matches.len() {
        1 => Ok(matches[0].to_string()),
        0 => Err(format!(
            "No task here has the id {query:?}. Call {TASKS} to see what has been dispatched."
        )),
        _ => Err(format!(
            "{query:?} matches {} tasks: {}. Use the full id.",
            matches.len(),
            matches.join(", ")
        )),
    }
}

/// How a task ended, or `None` when it has not.
fn task_status(inbox: &Inbox, id: &str) -> Option<String> {
    collect_task_summaries()
        .ok()?
        .into_iter()
        .find(|task| task.id == id)
        .map(|task| task.status.to_string())
        .or_else(|| {
            // Not in the listing at all: its request file was swept, but the
            // transcript may still be there.
            inbox
                .transcript_path(id)
                .exists()
                .then(|| "done".to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call_request(name: &str, arguments: Value) -> Request {
        serde_json::from_value(json!({
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }))
        .expect("parses")
    }

    fn state() -> BridgeState {
        BridgeState {
            version: super::super::super::bridge::BRIDGE_FORMAT_VERSION,
            enabled: true,
            window_open: true,
            pid: 1,
            workspace: Some(env!("CARGO_MANIFEST_DIR").to_string()),
            thread_id: None,
            thread_title: None,
            model: None,
            busy: false,
            updated_at: "2026-09-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn every_tool_is_listed_with_a_schema() {
        // A tool without an inputSchema is silently unusable in most clients.
        let roster = roster();
        assert_eq!(roster.len(), 7);
        for tool in &roster {
            assert!(tool["name"].is_string(), "a tool has no name");
            let description = tool["description"].as_str().expect("description");
            assert!(
                description.len() > 80,
                "{} has a description too short to choose by",
                tool["name"]
            );
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn the_roster_matches_the_dispatch_table() {
        // A tool listed but not handled answers "there is no tool called that"
        // to a caller that read its description one message earlier. This runs
        // on a machine where Aurora may or may not be up, so it asserts only
        // that every listed name is *recognised* — not that the call succeeds.
        let listed: Vec<String> = roster()
            .iter()
            .map(|tool| tool["name"].as_str().expect("name").to_string())
            .collect();
        assert_eq!(listed.len(), ALL.len());
        for name in &listed {
            assert!(
                ALL.contains(&name.as_str()),
                "{name} is listed but not in ALL, so a call to it is refused as unknown"
            );
            let result = call(name, &call_request(name, json!({})));
            let text = result["content"][0]["text"].as_str().expect("text");
            assert!(
                !text.contains("is listed but not implemented"),
                "{name} is listed but has no handler"
            );
        }
    }

    #[test]
    fn an_unknown_tool_names_the_real_ones() {
        let result = call("aurora_do_the_thing", &call_request("x", json!({})));
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().expect("text");
        assert!(text.contains(STATUS));
        assert!(text.contains(DISPATCH));
    }

    #[test]
    fn status_is_never_an_error_result() {
        // Even with Aurora closed. "Aurora is shut" is a true answer to the
        // question asked, and flagging it as a failure makes a careful caller
        // report that the status check itself is broken.
        let result = call(STATUS, &call_request(STATUS, json!({})));
        assert_eq!(result["isError"], false);
    }

    #[test]
    fn dispatch_without_a_prompt_says_so() {
        let result = dispatch(&call_request(DISPATCH, json!({})), &state());
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .expect("text")
            .contains("prompt"));
    }

    #[test]
    fn dispatch_rejects_a_mode_it_does_not_have() {
        let request = call_request(DISPATCH, json!({ "prompt": "x", "mode": "build" }));
        let result = dispatch(&request, &state());
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("agent"));
        assert!(text.contains("plan"));
    }

    #[test]
    fn a_workspace_that_is_not_a_folder_is_refused_before_dispatch() {
        // Writing the request first would leave a task in the inbox that a
        // running Aurora picks up and fails in a window nobody is looking at.
        let error = resolve_workspace(Some(r"Z:\nope\not\here".to_string()), &state())
            .expect_err("must refuse");
        assert!(error.contains("not a folder"));
    }

    #[test]
    fn no_path_and_no_open_project_explains_itself() {
        let mut state = state();
        state.workspace = None;
        let error = resolve_workspace(None, &state).expect_err("must refuse");
        assert!(error.contains("open a project"));
    }

    #[test]
    fn the_window_project_is_the_default() {
        let resolved = resolve_workspace(None, &state()).expect("resolves");
        assert_eq!(resolved, PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    }

    #[test]
    fn a_new_conversation_needs_no_lookup() {
        // Both spellings, because a calling model writes either.
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(resolve_conversation(None, &workspace), Ok(None));
        assert_eq!(
            resolve_conversation(Some("new".to_string()), &workspace),
            Ok(None)
        );
        assert_eq!(
            resolve_conversation(Some("NEW".to_string()), &workspace),
            Ok(None)
        );
    }

    #[test]
    fn text_deltas_are_rejoined_into_a_paragraph() {
        // They arrive one token at a time. Rendered as they arrive, a reply
        // becomes forty lines of two words each.
        let events = vec![
            TaskEvent::Text {
                text: "I looked at ".to_string(),
            },
            TaskEvent::Text {
                text: "the config".to_string(),
            },
        ];
        assert_eq!(render_events(&events), "Aurora: I looked at the config");
    }

    #[test]
    fn reasoning_never_reaches_the_caller() {
        // The biggest thing in a transcript and the least useful to somebody
        // asking what was done.
        let events = vec![
            TaskEvent::Thinking {
                text: "the user probably means".to_string(),
            },
            TaskEvent::Text {
                text: "Done.".to_string(),
            },
        ];
        let rendered = render_events(&events);
        assert!(!rendered.contains("probably means"));
        assert_eq!(rendered, "Aurora: Done.");
    }

    #[test]
    fn a_failed_tool_is_marked_as_one() {
        let events = vec![TaskEvent::ToolResult {
            tool_use_id: "t1".to_string(),
            name: "shell_execute".to_string(),
            ok: false,
            content: "cargo: command not found".to_string(),
            truncated_from: None,
        }];
        let rendered = render_events(&events);
        assert!(rendered.contains("FAILED"));
        assert!(rendered.contains("command not found"));
    }

    #[test]
    fn the_final_answer_is_carried_through() {
        // The single most useful line for a caller that waited on a run.
        let events = vec![TaskEvent::Result {
            subtype: ResultKind::Success,
            result: Some("The test was failing on a stale mock.".to_string()),
            error: None,
            duration_ms: 95_000,
            num_turns: 4,
        }];
        let rendered = render_events(&events);
        assert!(rendered.contains("1m 35s"));
        assert!(rendered.contains("4 model calls"));
        assert!(rendered.contains("stale mock"));
    }

    #[test]
    fn a_cancelled_run_reads_as_stopped_not_failed() {
        // A task the user stopped is not a task that broke, and a caller that
        // cannot tell them apart retries work that was deliberately halted.
        let events = vec![TaskEvent::Result {
            subtype: ResultKind::Cancelled,
            result: None,
            error: None,
            duration_ms: 3_000,
            num_turns: 1,
        }];
        let rendered = render_events(&events);
        assert!(rendered.contains("was stopped"));
        assert!(!rendered.contains("failed"));
        assert!(rendered.contains("1 model call"), "singular for one call");
    }

    #[test]
    fn a_long_run_keeps_its_ending() {
        // Cut from the front: the end is what the caller asked about, the
        // beginning is what it read on the previous call.
        let body = format!("{}\nTHE LAST LINE", "x".repeat(MAX_RESULT_CHARS * 2));
        let capped = cap_from_the_front(&body);
        assert!(capped.contains("THE LAST LINE"));
        assert!(capped.contains("earlier part"));
        assert!(capped.chars().count() < body.chars().count());
    }

    #[test]
    fn a_short_run_is_left_alone() {
        assert_eq!(cap_from_the_front("two lines\nhere"), "two lines\nhere");
    }

    #[test]
    fn durations_read_as_time_not_milliseconds() {
        assert_eq!(human_duration(4_200), "4s");
        assert_eq!(human_duration(63_000), "1m 3s");
    }
}
