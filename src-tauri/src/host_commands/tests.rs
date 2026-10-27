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

#[tokio::test]
async fn every_listed_command_is_served() {
    let (ctx, _dir) = context();
    for name in all_commands() {
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
