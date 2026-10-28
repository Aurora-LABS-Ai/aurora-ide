//! The commands any host serves, by name: one registry for the desktop app's
//! IPC and for HTTP (`DOCS/rust-core-extraction.md`, Phase 6.2).
//!
//! A client calls `name` with a JSON object of arguments, keyed exactly as
//! Tauri keys them (a parameter `turn_id` arrives as `turnId`), and gets the
//! command's JSON result. The window keeps calling its `#[tauri::command]`s;
//! each of those is a thin wrapper over the same function [`dispatch`] calls,
//! so a command is written once. A host with no window serves [`dispatch`]
//! over `POST /api/invoke/{cmd}`, the contract the frontend's `WebRuntime`
//! already speaks.
//!
//! Commands move here a few at a time. A name not listed yet answers
//! [`CommandError::Unknown`]; one that only makes sense beside a window
//! (window controls, native dialogs, the browser dock, speech) answers
//! [`CommandError::NotOnThisHost`].

pub mod agent;
pub mod cards;
pub mod checkpoints;
pub mod composer;
pub mod conversation;
pub mod delegate;
pub mod explorer;
pub mod files;
pub mod git;
pub mod insights;
pub mod mcp;
pub mod media;
pub mod plans;
pub mod providers;
pub mod settings;
pub mod shell;
pub mod sign_ins;
pub mod subagents;
pub mod system;
pub mod terminal;
pub mod threads;
pub mod tokens;

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use crate::agent_runtime::host::{AgentRegistry, Engine, HostEmitter};
use crate::agent_runtime::ipc::AgentChatRequest;
use crate::checkpoints::commands::CheckpointState;
use crate::db::{Database, DatabaseAccess};
use crate::host_events::Events;
use crate::tools::permissions::PermissionRouter;

/// What a command runs against: the started engine, the settings database
/// and where events go.
#[derive(Clone)]
pub struct CommandContext {
    pub registry: Arc<AgentRegistry>,
    pub permissions: Arc<PermissionRouter>,
    pub events: Events,
    pub db: Arc<dyn DatabaseAccess>,
    /// This host's checkpoint service (the window keeps its own as managed
    /// state).
    pub checkpoints: Arc<CheckpointState>,
    /// This host's Files panel tree (the window keeps its own as managed
    /// state).
    pub explorer: crate::explorer::ExplorerStateHandle,
    /// In-flight prompt rewrites, cancellable by request id.
    pub refine: Arc<crate::prompt_refine::RefineState>,
}

impl CommandContext {
    pub fn new(engine: &Engine, events: Events, db: Arc<dyn DatabaseAccess>) -> Self {
        let checkpoints = CheckpointState::new();
        checkpoints.init(crate::paths::checkpoints_dir());
        Self {
            registry: engine.registry.clone(),
            permissions: engine.permission_router.clone(),
            events,
            db,
            checkpoints: Arc::new(checkpoints),
            explorer: Default::default(),
            refine: Default::default(),
        }
    }

    fn emitter(&self) -> Arc<HostEmitter> {
        Arc::new(HostEmitter::new(self.events.clone()))
    }

    /// Run `f` against the database, off the async threads (SQLite blocks).
    pub(crate) async fn with_db<T, F>(&self, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&Database) -> Result<T, String> + Send + 'static,
    {
        run_db(self.db.clone(), f).await
    }
}

/// Run `f` against `db`, off the async threads (SQLite blocks). For command
/// bodies that both hosts call: the window passes its `AppHandle`, a server
/// its own database.
pub(crate) async fn run_db<T, F>(db: Arc<dyn DatabaseAccess>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Database) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut f = Some(f);
        let mut out = None;
        let reached = db.with_db(&mut |db| {
            if let Some(f) = f.take() {
                out = Some(f(db));
            }
        });
        match out {
            Some(result) => result,
            None if !reached => Err("Aurora's database is not available".to_string()),
            None => Err("the database call did not run".to_string()),
        }
    })
    .await
    .map_err(|e| format!("the database task stopped: {e}"))?
}

/// Every command this host serves, across the groups.
pub fn all_commands() -> impl Iterator<Item = &'static str> {
    COMMANDS
        .iter()
        .chain(settings::COMMANDS)
        .chain(threads::COMMANDS)
        .chain(files::COMMANDS)
        .chain(shell::COMMANDS)
        .chain(system::COMMANDS)
        .chain(mcp::COMMANDS)
        .chain(git::COMMANDS)
        .chain(plans::COMMANDS)
        .chain(checkpoints::COMMANDS)
        .chain(subagents::COMMANDS)
        .chain(cards::COMMANDS)
        .chain(conversation::COMMANDS)
        .chain(tokens::COMMANDS)
        .chain(providers::COMMANDS)
        .chain(sign_ins::COMMANDS)
        .chain(media::COMMANDS)
        .chain(insights::COMMANDS)
        .chain(explorer::COMMANDS)
        .chain(terminal::COMMANDS)
        .chain(composer::COMMANDS)
        .chain(delegate::COMMANDS)
        .copied()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    /// No command by this name on this host yet.
    Unknown(String),
    /// The command exists, but only beside a window.
    NotOnThisHost(String),
    /// The arguments did not decode.
    BadArguments { command: String, reason: String },
    /// The command ran and failed; its own message.
    Failed(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown(name) => write!(f, "unknown command `{name}`"),
            Self::NotOnThisHost(name) => {
                write!(f, "`{name}` is not available on this host: it needs the desktop window")
            }
            Self::BadArguments { command, reason } => {
                write!(f, "bad arguments for `{command}`: {reason}")
            }
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for CommandError {}

/// The conversation commands [`dispatch`] serves itself; the other groups
/// list theirs in their own module (see [`all_commands`]).
pub const COMMANDS: &[&str] = &[
    "agent_chat_v2",
    "agent_compact_thread",
    "agent_cancel",
    "agent_active_turns",
    "agent_load_thread",
    "agent_rewind_to_user_message",
    "agent_post_tool_result",
    "agent_enqueue_message",
    "agent_cancel_queued_message",
    "agent_grant_permission",
];

/// Commands that need a window. Answered with a clear refusal instead of
/// "unknown", so a client can hide what it cannot use.
pub const WINDOW_ONLY: &[&str] = &[
    // The browser dock: native WebView children of the window.
    "browser_eval_value",
    "browser_activate_inspector",
    "browser_capture_screenshot",
    "browser_deactivate_inspector",
    "browser_eval",
    "browser_get_url",
    "browser_local_servers",
    "browser_navigate",
    "browser_page_title",
    "browser_refresh",
    "browser_set_bounds",
    "browser_set_corner_radius",
    "browser_set_device",
    "browser_set_visible",
    "browser_set_zoom",
    "close_browser_webview",
    "create_browser_webview",
    "list_browser_windows",
    // Writes the user's clipboard; the server's clipboard is not theirs.
    "thread_copy_markdown",
    // Open something on the machine's own desktop.
    "reveal_in_explorer",
    "open_in_terminal",
    "open_ide_window",
    "agent_open_in_ide",
    // Voice input records from the window's microphone.
    "speech_transcribe_pcm",
    "speech_validate_config",
    "speech_stream_arm",
    "speech_stream_cancel",
    "speech_stream_shutdown",
    "speech_stream_stop",
    "speech_stream_validate",
    "speech_stream_write",
    "install_agent_media_permission_handler",
    // Terminal output on a Tauri `Channel`; other clients use the `_events`
    // forms in `host_commands::terminal`.
    "terminal_pty_open",
    "terminal_pty_attach",
    // This computer's clipboard and save dialog (`tools::image::gallery`).
    "chat_gallery_copy_image",
    "chat_gallery_save_as",
    // Fonts installed on the machine the window draws on.
    "system_font_families",
    // Browser sign-ins that open a page on this machine and wait for its
    // callback (`host_commands::sign_ins`).
    "codex_auth_login",
    "antigravity_auth_login",
    "commandcode_auth_login",
    // App-only features, by choice (they could be offered elsewhere later):
    // composer typing assist, which window opens at launch, and Volcano
    // Ark's sign-in, which reads cookies from a hidden WebView window.
    "typing_assist_correct",
    "typing_assist_ensure_ready",
    "typing_assist_flush",
    "typing_assist_learn",
    "typing_assist_query",
    "typing_assist_undo_correct",
    "get_launch_surface",
    "set_launch_surface",
    "ark_connect",
    "ark_disconnect",
    "ark_usage",
    // Install into this machine's PATH and Explorer menu.
    "install_aurora_cli",
    "uninstall_aurora_cli",
    "is_aurora_cli_installed",
    "install_aurora_context_menu",
    "uninstall_aurora_context_menu",
    "is_aurora_context_menu_installed",
    "web_host_start",
    "web_host_stop",
    "web_host_status",
];

/// Run `name` with `args` (a JSON object, or `null` for none).
pub async fn dispatch(
    ctx: &CommandContext,
    name: &str,
    args: Value,
) -> Result<Value, CommandError> {
    match name {
        "agent_chat_v2" => {
            let a: Request = decode(name, args)?;
            done(agent::chat(ctx.registry.clone(), ctx.emitter(), a.request).await)
        }
        "agent_compact_thread" => {
            let a: Request = decode(name, args)?;
            done(agent::compact_thread(ctx.registry.clone(), ctx.emitter(), a.request).await)
        }
        "agent_cancel" => {
            let a: TurnId = decode(name, args)?;
            done(Ok(ctx.registry.cancel(&a.turn_id)))
        }
        "agent_active_turns" => done(Ok(ctx.registry.active_conversation_turns())),
        "agent_load_thread" => {
            let a: ThreadId = decode(name, args)?;
            done(agent::load_thread(ctx.registry.clone(), a.thread_id).await)
        }
        "agent_rewind_to_user_message" => {
            let a: Rewind = decode(name, args)?;
            done(agent::rewind_to_user_message(
                &ctx.registry,
                &a.thread_id,
                a.user_message_ordinal,
            ))
        }
        "agent_post_tool_result" => {
            let a: ToolResult = decode(name, args)?;
            done(ctx
                .registry
                .post_tool_result(&a.turn_id, &a.tool_use_id, a.content, a.is_error))
        }
        "agent_enqueue_message" => {
            let a: Enqueue = decode(name, args)?;
            done(agent::enqueue_message(
                &ctx.registry,
                &a.thread_id,
                a.text,
                a.display_text,
                a.chips,
                a.origin.as_deref(),
                a.agent,
            ))
        }
        "agent_cancel_queued_message" => {
            let a: ThreadId = decode(name, args)?;
            done(ctx.registry.cancel_queued_message(&a.thread_id).await)
        }
        "agent_grant_permission" => {
            let a: Grant = decode(name, args)?;
            done(
                ctx.permissions
                    .resolve(&a.turn_id, &a.tool_name, a.granted)
                    .map_err(|_| "no pending permission request".to_string()),
            )
        }
        _ => {
            // Each group answers its own names and hands the rest on.
            macro_rules! groups {
                ($($group:ident),*) => {
                    $(if let Some(result) = $group::dispatch(ctx, name, &args).await {
                        return result;
                    })*
                };
            }
            groups!(
                settings, threads, files, shell, system, mcp, git, plans, checkpoints, subagents,
                cards, conversation, tokens, providers, sign_ins, media, insights, explorer,
                terminal, composer, delegate
            );
            if WINDOW_ONLY.contains(&name) {
                Err(CommandError::NotOnThisHost(name.to_string()))
            } else {
                Err(CommandError::Unknown(name.to_string()))
            }
        }
    }
}

/// One argument by the key Tauri gives it (a parameter `provider_id` arrives
/// as `providerId`). A missing key reads as `null`, so an `Option` argument
/// may be left out and a required one says which key was missing.
pub(crate) fn arg<T: DeserializeOwned>(command: &str, args: &Value, key: &str) -> Result<T, CommandError> {
    let value = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| CommandError::BadArguments {
        command: command.to_string(),
        reason: format!("`{key}`: {e}"),
    })
}

fn decode<T: DeserializeOwned>(command: &str, args: Value) -> Result<T, CommandError> {
    let args = if args.is_null() { Value::Object(Default::default()) } else { args };
    serde_json::from_value(args).map_err(|e| CommandError::BadArguments {
        command: command.to_string(),
        reason: e.to_string(),
    })
}

pub(crate) fn done<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, CommandError> {
    let value = result.map_err(CommandError::Failed)?;
    serde_json::to_value(value).map_err(|e| CommandError::Failed(format!("could not encode the result: {e}")))
}

// ── Arguments, keyed as Tauri keys them ─────────────────────────────────

#[derive(Deserialize)]
struct Request {
    request: AgentChatRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnId {
    turn_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadId {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rewind {
    thread_id: String,
    user_message_ordinal: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolResult {
    turn_id: String,
    tool_use_id: String,
    content: String,
    is_error: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Enqueue {
    thread_id: String,
    text: String,
    display_text: Option<String>,
    chips: Option<Vec<crate::agent_runtime::types::AttachedPromptChip>>,
    origin: Option<String>,
    agent: Option<crate::agent_runtime::types::AgentReportMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    turn_id: String,
    tool_name: String,
    granted: bool,
}

#[cfg(test)]
mod tests;
