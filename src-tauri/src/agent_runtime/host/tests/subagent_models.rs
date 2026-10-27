use super::subagents::{parent_turn, scripted_host, spawn, submits};
use super::*;
use crate::agent_runtime::api_client::ReasoningControl;
use crate::agent_runtime::subagents::host::{
    ModelChoice, ProviderLookup, ResolvedModel, SubagentError, SubagentHost,
};
use crate::db::{LLMProvider, ProviderModel};

pub(super) fn provider() -> LLMProvider {
    serde_json::from_value(serde_json::json!({
        "id": "mixed", "name": "Mixed", "baseUrl": "https://example.invalid",
        "apiKey": "test", "model": "parent", "contextWindow": 128000,
        "maxOutputTokens": 16000, "supportsToolStream": false, "enabled": true,
        "isCustom": true, "providerType": "openai", "requiresApiKey": true,
        "sortOrder": 0, "createdAt": "", "updatedAt": "", "defaultTemperature": 0.7,
        "customParams": {"providerField": 1, "overrideField": "provider"}
    }))
    .unwrap()
}

pub(super) fn model() -> ProviderModel {
    serde_json::from_value(serde_json::json!({
        "id": "mixed::child", "providerId": "mixed", "modelKey": "child",
        "providerType": "openai-responses", "supportsThinking": true,
        "reasoning": {"type": "effort", "default": "high"}, "temperature": 0.2,
        "extraBody": {"modelField": true, "overrideField": "model", "reasoning_replay": "off"},
        "contextWindow": 64000, "maxOutputTokens": 8000
    }))
    .unwrap()
}

#[test]
fn a_selected_child_model_keeps_its_own_wire_format() {
    let resolved =
        super::super::subagent_lookup::snapshot_for(&provider(), &model(), true).unwrap();
    assert_eq!(
        resolved.config.provider_type.as_deref(),
        Some("openai-responses")
    );
}

#[test]
fn child_model_settings_merge_extras_and_keep_explicit_zero_temperature() {
    let provider = provider();
    let mut model = model();
    model.temperature = Some(0.0);
    let resolved = super::super::subagent_lookup::snapshot_for(&provider, &model, false).unwrap();
    assert_eq!(resolved.config.default_temperature, Some(0.0));
    assert_eq!(
        resolved.config.custom_params.as_ref().unwrap()["overrideField"],
        "model"
    );
    assert_eq!(
        resolved.config.custom_params.as_ref().unwrap()["providerField"],
        1
    );
    assert!(!resolved
        .config
        .custom_params
        .as_ref()
        .unwrap()
        .contains_key("reasoning_replay"));
    let reasoning = resolved.config.reasoning.unwrap();
    assert!(reasoning.enabled);
    assert_eq!(reasoning.effort.as_deref(), Some("high"));
    assert_eq!(
        reasoning.replay,
        crate::agent_runtime::api_client::ReasoningReplayMode::Off
    );
    assert_eq!(resolved.context_window, Some(64000));
    assert_eq!(resolved.max_output_tokens, Some(8000));
    model.temperature = None;
    assert_eq!(
        super::super::subagent_lookup::snapshot_for(&provider, &model, true)
            .unwrap()
            .config
            .default_temperature,
        Some(0.7)
    );
}

#[test]
fn opencode_children_choose_the_models_wire_and_preserve_overrides() {
    let mut provider = provider();
    provider.id = "opencode-go".into();
    provider.provider_type = Some("opencode-go".into());
    let mut model = model();
    model.provider_type = None;
    for (key, expected) in [
        ("qwen3.7-plus", "opencode-go-messages"),
        ("glm-5.2", "opencode-go-chat"),
        ("gpt-5.6-luna-free", "opencode-go"),
    ] {
        model.model_key = key.into();
        assert_eq!(
            super::super::subagent_lookup::snapshot_for(&provider, &model, true)
                .unwrap()
                .config
                .provider_type
                .as_deref(),
            Some(expected)
        );
    }
    model.provider_type = Some("opencode-go-chat".into());
    assert_eq!(
        super::super::subagent_lookup::snapshot_for(&provider, &model, true)
            .unwrap()
            .config
            .provider_type
            .as_deref(),
        Some("opencode-go-chat")
    );
}

#[test]
fn invalid_model_settings_fail_before_a_request_is_built() {
    let provider = provider();
    let mut model = model();
    model.reasoning = Some(serde_json::json!({"type": "effort", "requestMode": "unknown-mode"}));
    let why = super::super::subagent_lookup::snapshot_for(&provider, &model, true).unwrap_err();
    assert!(why.contains("child") && why.contains("invalid reasoning settings"));
    model.reasoning = None;
    model.extra_body = Some(serde_json::json!(["not a field map"]));
    assert!(
        super::super::subagent_lookup::snapshot_for(&provider, &model, true)
            .unwrap_err()
            .contains("must be an object")
    );
}

struct ModelRows;
impl ProviderLookup for ModelRows {
    fn models(&self) -> Result<Vec<ModelChoice>, String> {
        Ok(Vec::new())
    }
    fn resolve(&self, _: &str, thinking: bool) -> Result<ResolvedModel, SubagentError> {
        super::super::subagent_lookup::snapshot_for(&provider(), &model(), thinking)
            .map_err(SubagentError::Invalid)
    }
}

struct RequestSpy {
    api: Arc<MockApi>,
    seen: StdMutex<Vec<(Option<f32>, bool, Option<String>, u32)>>,
}
#[async_trait]
impl StreamingApiClient for RequestSpy {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        sink: mpsc::Sender<AssistantEvent>,
        cancel: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        self.seen.lock().unwrap().push((
            request.temperature,
            request.reasoning.enabled,
            request.reasoning.effort.map(str::to_string),
            request.max_output_tokens,
        ));
        assert_eq!(request.reasoning.control, ReasoningControl::Effort);
        self.api.stream(request, sink, cancel).await
    }
}

#[tokio::test]
async fn the_actual_child_request_uses_child_knobs_instead_of_parent_knobs() {
    let dir = tempfile::tempdir().unwrap();
    let spy = Arc::new(RequestSpy {
        api: Arc::new(MockApi::new(submits("s1", "done"))),
        seen: StdMutex::new(Vec::new()),
    });
    let registry = Arc::new(
        AgentRegistry::new(Arc::new(FixedFactory(spy.clone())), dir.path().into())
            .with_provider_lookup(Arc::new(ModelRows)),
    );
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let mut request = make_request("p", "child-knobs", "hi");
    request.temperature = Some(0.9);
    request.thinking_enabled = Some(false);
    request.max_output_tokens = Some(2000);
    let parent = parent_turn(&registry, request);
    host.spawn(
        &parent,
        crate::agent_runtime::subagents::host::SpawnRequest {
            model: Some("mixed:child".into()),
            ..spawn("Task", "task", None)
        },
    )
    .await
    .unwrap();
    assert_eq!(
        spy.seen.lock().unwrap()[0],
        (Some(0.2), true, Some("high".into()), 8000)
    );
}

struct SwitchableModel(std::sync::atomic::AtomicBool);
impl ProviderLookup for SwitchableModel {
    fn models(&self) -> Result<Vec<ModelChoice>, String> {
        Ok(Vec::new())
    }
    fn resolve(&self, pin: &str, thinking: bool) -> Result<ResolvedModel, SubagentError> {
        if self.0.load(std::sync::atomic::Ordering::SeqCst) {
            Err(SubagentError::Invalid(
                "configured child reasoning is invalid".into(),
            ))
        } else {
            ModelRows.resolve(pin, thinking)
        }
    }
}

#[tokio::test]
async fn invalid_saved_model_settings_do_not_silently_switch_to_the_parent_model() {
    let dir = tempfile::tempdir().unwrap();
    let api = Arc::new(MockApi::new(submits("s1", "first")));
    let lookup = Arc::new(SwitchableModel(std::sync::atomic::AtomicBool::new(false)));
    let registry = Arc::new(
        AgentRegistry::new(
            Arc::new(MockApiFactory::from_api(api.clone())),
            dir.path().into(),
        )
        .with_provider_lookup(lookup.clone()),
    );
    let (host, _catalog) = scripted_host(Arc::new(MockEmitter::default()), registry.clone());
    let parent = parent_turn(&registry, make_request("p", "invalid-saved-model", "hi"));
    let crate::agent_runtime::subagents::host::SpawnOutcome::Finished { agent_id, .. } = host
        .spawn(
            &parent,
            crate::agent_runtime::subagents::host::SpawnRequest {
                model: Some("mixed:child".into()),
                ..spawn("Task", "first", None)
            },
        )
        .await
        .unwrap()
    else {
        panic!("synchronous fixture");
    };
    lookup.0.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        host.send_message(&parent, &agent_id, "second").await,
        Err(SubagentError::Invalid(_))
    ));
    let record = registry.subagent_tasks().get(&agent_id).unwrap();
    assert!(!record.is_running());
    assert_eq!(record.snapshot().runs, 1);
    assert_eq!(record.snapshot().model.as_deref(), Some("mixed:child"));
    assert_eq!(api.call_count(), 2, "no fallback request should be made");
}
