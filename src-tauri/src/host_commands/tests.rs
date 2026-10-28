use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::agent_runtime::host::ApiFactory;
use crate::host_events::EventSink;

#[derive(Default)]
struct Recorded(Mutex<Vec<String>>);

impl EventSink for Recorded {
    fn emit_value(&self, event: &str, _payload: Value) {
        self.0.lock().unwrap().push(event.to_string());
    }
}

struct NoApi;

impl ApiFactory for NoApi {
    fn build(
        &self,
        _config: &crate::api::ProviderConfigSnapshot,
    ) -> Result<
        Arc<dyn crate::agent_runtime::api_client::StreamingApiClient>,
        crate::agent_runtime::error::RuntimeError,
    > {
        Err(crate::agent_runtime::error::RuntimeError::InvalidState(
            "no model in this test".into(),
        ))
    }
}

fn context() -> (CommandContext, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let ctx = CommandContext {
        registry: Arc::new(AgentRegistry::new(Arc::new(NoApi), dir.path().to_path_buf())),
        permissions: Arc::new(PermissionRouter::new()),
        events: Arc::new(Recorded::default()),
        db: Arc::new(Mutex::new(crate::db::Database::in_memory().expect("in-memory database"))),
        checkpoints: Arc::new(crate::checkpoints::commands::CheckpointState::new()),
    };
    (ctx, dir)
}

/// The window calls these names through Tauri; the registry must serve the
/// same names, or a browser on a headless host calls a command that exists
/// in one place and not the other.
#[test]
fn every_command_here_is_one_the_window_registers() {
    let handlers = include_str!("../lib.rs");
    for name in all_commands().chain(WINDOW_ONLY.iter().copied()) {
        assert!(
            handlers.contains(&format!("::{name},")) || handlers.contains(&format!("::{name}\n")),
            "`{name}` is not in lib.rs's generate_handler! list"
        );
    }
}

/// Commands that, called with no arguments, act on this machine: read the
/// user's real MCP config into the shared server list, launch shells to scan
/// them, run `cmd /c ver`. Their names are still checked against `lib.rs`
/// above; their groups are reached through the other names.
const ACT_ON_THE_MACHINE: &[&str] = &[
    "mcp_load_servers",
    "shell_profiles_scan",
    "shell_tools_inventory",
    "get_system_info",
    "checkpoint_init",
];

/// The sign-in group is never run here: with no arguments its commands sign
/// the user's real accounts out, import credentials, call the vendors, and
/// open a sign-in page. Each name must have its own arm in the group's match
/// instead (checked against the source).
#[test]
fn every_sign_in_command_has_its_own_arm() {
    let source = include_str!("sign_ins.rs");
    for name in sign_ins::COMMANDS {
        assert!(
            source.contains(&format!("\"{name}\" =>")),
            "`{name}` is listed in sign_ins::COMMANDS but has no match arm"
        );
    }
}

#[tokio::test]
async fn every_listed_command_is_served() {
    let (ctx, _dir) = context();
    let runnable = all_commands()
        .filter(|name| !ACT_ON_THE_MACHINE.contains(name))
        .filter(|name| !sign_ins::COMMANDS.contains(name));
    for name in runnable {
        if let Err(CommandError::Unknown(_)) = dispatch(&ctx, name, Value::Null).await {
            panic!("`{name}` is listed but dispatch does not know it");
        }
    }
}

#[tokio::test]
async fn arguments_arrive_under_the_names_tauri_uses() {
    let (ctx, _dir) = context();
    assert_eq!(
        dispatch(&ctx, "agent_cancel", json!({ "turnId": "nothing-running" })).await,
        Ok(json!(false))
    );
    assert_eq!(
        dispatch(&ctx, "agent_load_thread", json!({ "threadId": "never-made" })).await,
        Ok(json!([]))
    );
    assert_eq!(dispatch(&ctx, "agent_active_turns", Value::Null).await, Ok(json!([])));
    // snake_case is what Tauri would NOT send: refused, not guessed.
    assert!(matches!(
        dispatch(&ctx, "agent_cancel", json!({ "turn_id": "x" })).await,
        Err(CommandError::BadArguments { .. })
    ));
}

#[tokio::test]
async fn a_command_failure_keeps_its_own_message() {
    let (ctx, _dir) = context();
    assert_eq!(
        dispatch(
            &ctx,
            "agent_grant_permission",
            json!({ "turnId": "t", "toolName": "shell_execute", "granted": true })
        )
        .await,
        Err(CommandError::Failed("no pending permission request".into()))
    );
}

#[tokio::test]
async fn window_commands_are_refused_by_name_and_others_are_unknown() {
    let (ctx, _dir) = context();
    assert_eq!(
        dispatch(&ctx, "browser_eval_value", Value::Null).await,
        Err(CommandError::NotOnThisHost("browser_eval_value".into()))
    );
    assert_eq!(
        dispatch(&ctx, "no_such_command", Value::Null).await,
        Err(CommandError::Unknown("no_such_command".into()))
    );
}

/// The window's request JSON decodes and reaches the turn driver, which here
/// fails at the API client (this test has no model) with its own message.
#[tokio::test]
async fn a_turn_request_from_the_window_reaches_the_driver() {
    let (ctx, _dir) = context();
    let request = json!({
        "turnId": "turn-1",
        "threadId": "thread-1",
        "userMessage": "hello",
        "providerId": "p",
        "model": "m",
        "workspacePath": null,
        "executionMode": "chat",
        "providerConfig": {
            "providerId": "p",
            "baseUrl": "https://example.invalid/v1",
            "apiKey": "k",
            "model": "m",
            "supportsThinking": false
        }
    });
    let result = dispatch(&ctx, "agent_chat_v2", json!({ "request": request })).await;
    assert!(
        matches!(&result, Err(CommandError::Failed(message)) if message.contains("no model in this test")),
        "{result:?}"
    );
}

/// The interface's start-up calls, against a real (in-memory) database.
#[tokio::test]
async fn settings_read_back_what_was_written() {
    let (ctx, _dir) = context();
    assert_eq!(dispatch(&ctx, "has_providers", Value::Null).await, Ok(json!(false)));

    let set = dispatch(&ctx, "set_setting", json!({ "key": "probe", "value": "42" })).await;
    assert_eq!(set, Ok(Value::Null));
    assert_eq!(
        dispatch(&ctx, "get_setting", json!({ "key": "probe" })).await,
        Ok(json!("42"))
    );

    let settings = dispatch(&ctx, "get_app_settings", Value::Null).await.expect("settings");
    assert!(settings.get("selectedModel").is_some(), "{settings}");

    // A required argument left out says which one.
    let missing = dispatch(&ctx, "get_setting", json!({})).await;
    assert!(
        matches!(&missing, Err(CommandError::BadArguments { reason, .. }) if reason.contains("`key`")),
        "{missing:?}"
    );
}

/// The file panel's calls, end to end in a temp folder.
#[tokio::test]
async fn files_are_created_read_renamed_and_deleted() {
    let (ctx, dir) = context();
    let path = |name: &str| dir.path().join(name).to_string_lossy().to_string();

    let wrote = dispatch(
        &ctx,
        "write_file_content",
        json!({ "path": path("notes/a.txt"), "content": "hello" }),
    )
    .await;
    assert_eq!(wrote, Ok(Value::Null));
    assert_eq!(
        dispatch(&ctx, "read_file_content", json!({ "path": path("notes/a.txt") })).await,
        Ok(json!("hello"))
    );

    let listed = dispatch(&ctx, "read_directory", json!({ "path": path("notes") }))
        .await
        .expect("listing");
    assert_eq!(listed[0]["name"], json!("a.txt"), "{listed}");

    let renamed = dispatch(
        &ctx,
        "rename_path",
        json!({ "oldPath": path("notes/a.txt"), "newPath": path("notes/b.txt") }),
    )
    .await;
    assert_eq!(renamed, Ok(Value::Null));
    let meta = dispatch(&ctx, "read_file_with_meta", json!({ "path": path("notes/b.txt") }))
        .await
        .expect("meta");
    assert_eq!(meta["content"], json!("hello"));
    assert_eq!(meta["size"], json!(5));

    // A failure keeps the command's own message.
    let again = dispatch(&ctx, "create_folder", json!({ "path": path("notes") })).await;
    assert!(
        matches!(&again, Err(CommandError::Failed(m)) if m.starts_with("Folder already exists")),
        "{again:?}"
    );

    assert_eq!(
        dispatch(&ctx, "delete_path", json!({ "path": path("notes") })).await,
        Ok(Value::Null)
    );
    assert!(!dir.path().join("notes").exists());
}

/// Plans, git and checkpoints answer for a folder that has none of them.
/// Checkpoints are opt-in per workspace.
#[tokio::test]
async fn an_empty_folder_has_no_plans_no_repository_and_checkpoints_off() {
    let (ctx, dir) = context();
    let root = dir.path().to_string_lossy().to_string();

    assert_eq!(
        dispatch(&ctx, "plan_list", json!({ "workspaceRoot": root })).await,
        Ok(json!([]))
    );
    assert_eq!(
        dispatch(&ctx, "plan_get_active", json!({ "workspaceRoot": root })).await,
        Ok(Value::Null)
    );
    assert_eq!(
        dispatch(&ctx, "git_is_repository", json!({ "workspacePath": root })).await,
        Ok(json!(false))
    );

    let enabled = dispatch(&ctx, "checkpoint_get_enabled", json!({ "workspacePath": root })).await;
    assert_eq!(enabled, Ok(json!(false)));
    let on = json!({ "workspacePath": root, "enabled": true });
    assert_eq!(dispatch(&ctx, "checkpoint_set_enabled", on).await, Ok(Value::Null));
    assert_eq!(
        dispatch(&ctx, "checkpoint_get_enabled", json!({ "workspacePath": root })).await,
        Ok(json!(true))
    );
    let off = json!({ "workspacePath": root, "enabled": false });
    assert_eq!(dispatch(&ctx, "checkpoint_set_enabled", off).await, Ok(Value::Null));
    let created = dispatch(
        &ctx,
        "checkpoint_create",
        json!({ "workspacePath": root, "threadId": "t", "messageId": "m" }),
    )
    .await
    .expect("a disabled workspace answers, not fails");
    assert_eq!(created["success"], json!(false));
    assert_eq!(created["error"], json!("Checkpoints disabled for this workspace"));
}

/// A command run from the browser streams its output as the same events the
/// window gets.
#[tokio::test]
async fn a_streamed_command_reaches_the_host_events() {
    let (ctx, dir) = context();
    let recorded = Arc::new(Recorded::default());
    let ctx = CommandContext { events: recorded.clone(), ..ctx };
    let output = dispatch(
        &ctx,
        "execute_command_stream",
        json!({
            "requestId": "stream-test",
            "command": "echo streamed",
            "cwd": dir.path().to_string_lossy(),
            "timeoutMs": 30_000
        }),
    )
    .await
    .expect("the command runs");
    assert_eq!(output["exit_code"], json!(0), "{output}");
    let events = recorded.0.lock().unwrap().clone();
    assert!(events.iter().any(|e| e.starts_with("shell-stream")), "{events:?}");
}
