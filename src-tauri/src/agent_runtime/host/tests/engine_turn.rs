//! A turn the engine builds from `{thread, message, mode}` (`run_engine_turn`),
//! and the model the engine resolves reaching the API client.

use super::*;

/// A database with one provider (`oa`, key `sk-db`, model `gpt-5`) and
/// Settings pointing at it.
fn database_with_provider() -> Arc<std::sync::Mutex<crate::db::Database>> {
    let db = crate::db::Database::in_memory().expect("in-memory database");
    let provider: crate::db::LLMProvider = serde_json::from_value(serde_json::json!({
        "id": "oa",
        "name": "OpenAI",
        "nickname": null,
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "sk-db",
        "model": "gpt-5",
        "contextWindow": 200000,
        "maxOutputTokens": 32000,
        "supportsToolStream": true,
        "enabled": true,
        "isCustom": true,
        "customHeaders": null,
        "customParams": null,
        "providerType": "openai",
        "defaultTemperature": null,
        "defaultMaxTokens": null,
        "requiresApiKey": true,
        "sortOrder": 0,
        "createdAt": "2026-10-28T00:00:00Z",
        "updatedAt": "2026-10-28T00:00:00Z"
    }))
    .expect("provider row");
    db.settings().save_provider(&provider).expect("save provider");
    let settings = crate::db::AppSettings {
        selected_model: "oa:gpt-5".into(),
        ..crate::db::AppSettings::default()
    };
    db.settings().save_app_settings(&settings).expect("save settings");
    Arc::new(std::sync::Mutex::new(db))
}

fn replies(text: &str) -> Arc<MockApi> {
    Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg(text), "end_turn")),
    }]))
}

#[tokio::test]
async fn an_engine_turn_runs_from_thread_and_message_alone() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = tempfile::tempdir().expect("workspace");
    let api = replies("done");
    let factory = Arc::new(MockApiFactory::from_api(api.clone()));
    let registry = Arc::new(
        AgentRegistry::new(factory.clone(), dir.path().to_path_buf())
            .with_settings_source(database_with_provider()),
    );
    let emitter = Arc::new(MockEmitter::default());
    let driver = TurnDriver::new(registry.clone(), emitter.clone());

    driver
        .run_engine_turn(EngineTurn {
            thread_id: "engine-1".into(),
            message: "hello".into(),
            mode: None,
            workspace: Some(workspace.path().to_string_lossy().into_owned()),
            client: Some("web".into()),
        })
        .await
        .expect("the turn runs");

    let built = factory.built_with_snapshot();
    assert_eq!(built[0].api_key, "sk-db", "the key came from the database row");
    assert_eq!(built[0].model, "gpt-5");
    assert_eq!(api.last_model.lock().unwrap().as_deref(), Some("gpt-5"));
    let system = api.last_system.lock().unwrap().clone().unwrap_or_default();
    assert!(
        system.len() > 1_000,
        "the engine composed the system prompt ({} bytes)",
        system.len()
    );
    assert_eq!(emitter.snapshot_completes().len(), 1);

    // The conversation now exists in its project, pinned to the model.
    let store = registry.require_store_for_thread("engine-1").expect("saved");
    let meta = store.load_metadata("engine-1").expect("meta");
    assert_eq!(meta.model.as_deref(), Some("oa:gpt-5"));
}

#[tokio::test]
async fn an_engine_turn_with_no_provider_is_refused_before_it_starts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workspace = tempfile::tempdir().expect("workspace");
    let api = replies("never");
    let db = crate::db::Database::in_memory().expect("in-memory database");
    let registry = Arc::new(
        AgentRegistry::new(
            Arc::new(MockApiFactory::from_api(api.clone())),
            dir.path().to_path_buf(),
        )
        .with_settings_source(Arc::new(std::sync::Mutex::new(db))),
    );
    let driver = TurnDriver::new(registry, Arc::new(MockEmitter::default()));

    let error = driver
        .run_engine_turn(EngineTurn {
            thread_id: "engine-2".into(),
            message: "hello".into(),
            mode: None,
            workspace: Some(workspace.path().to_string_lossy().into_owned()),
            client: None,
        })
        .await
        .expect_err("nothing to run on");

    assert!(error.to_string().contains("no model to run on"), "{error}");
    assert_eq!(api.call_count(), 0);
}

/// The window's turn with the engine's model APPLIED (not a shadow): the API
/// client must be built from the database row, not from the snapshot the
/// window sent. It was built from the window's first, then the snapshot was
/// replaced, so the request named one provider and went to another.
#[tokio::test]
async fn an_applied_engine_model_reaches_the_api_client() {
    let dir = tempfile::tempdir().expect("tempdir");
    let factory = Arc::new(MockApiFactory::from_api(replies("ok")));
    let registry = Arc::new(
        AgentRegistry::new(factory.clone(), dir.path().to_path_buf())
            .with_settings_source(database_with_provider()),
    );
    let driver = TurnDriver::new(registry, Arc::new(MockEmitter::default()));

    let mut request = make_request("turn-applied", "applied-1", "hello");
    request.execution_mode = AgentExecutionMode::Chat;
    request.model_selection = Some("oa:gpt-5".into());
    request.engine_prompt = Some(crate::agent_runtime::ipc::EnginePromptRequest {
        model: Some(Default::default()),
        shadow: false,
        ..Default::default()
    });
    driver.run_turn(request).await.expect("the turn runs");

    let built = factory.built_with_snapshot();
    assert_eq!(built[0].api_key, "sk-db", "the client's `mock-key` snapshot was replaced first");
    assert_eq!(built[0].model, "gpt-5");
}
