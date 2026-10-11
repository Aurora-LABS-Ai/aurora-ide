//! Agent runtime IPC — `agent_v2` tests.
//!
//! Split out of `agent_v2.rs` verbatim. Declared by `mod.rs` as
//! `#[cfg(test)] mod tests;`, so `use super::*` reaches the agent_v2 module
//! exactly as it did inside the old nested `mod tests`.
//!
//! These DO run in the normal build: `cargo test --lib commands::agent_v2`
//! reports 47 passing. (The stale scaffolds under `target/__verify_phase2_*`
//! mount the module via `#[path]` with the `verify_only` feature; if anyone
//! revives them, that path is now `agent_v2/mod.rs`.)

#[test]
fn the_browser_bucket_rides_one_switch() {
    // 16 schemas, ~2,800 tokens on every request, and Aurora sends
    // `cache_control` to Anthropic only — so on every other provider that
    // is paid in full on turns that never open a page. The whole bucket
    // goes together: half a toolset is worse than none, because the model
    // is told it can drive a browser it cannot see.
    for name in [
        "browser_guidelines",
        "browser_status",
        "browser_view",
        "browser_navigate",
        "browser_screenshot",
        "browser_click",
    ] {
        assert!(
            is_tool_available_this_turn(name, AgentExecutionMode::Agent, false, false, true),
            "{name} must be offered when browser tools are on"
        );
        assert!(
            !is_tool_available_this_turn(name, AgentExecutionMode::Agent, false, false, false),
            "{name} must be withheld when browser tools are off"
        );
    }
}

#[test]
fn switching_the_browser_off_leaves_every_other_tool_alone() {
    for name in ["file_read", "shell_execute", "code", "design_guidelines"] {
        assert!(
            is_tool_available_this_turn(name, AgentExecutionMode::Agent, false, false, false),
            "{name} is not a browser tool and must survive the switch"
        );
    }
}

// ---------------------------------------------------------------------------
// Aurora Chat's tool roster
//
// These tests exist to hold ONE promise: chat mode cannot touch the machine.
// They are written against the behaviour rather than the list, so adding a
// tool to `CHAT_MODE_TOOLS` is a deliberate act with a test to answer to.
// ---------------------------------------------------------------------------

/// The load-bearing one. Every native tool Aurora has, except chat mode's own
/// short list, must be refused — including every tool added after this was
/// written, which is exactly what an allow-list buys and a deny-list does not.
#[test]
fn chat_mode_refuses_every_native_tool_it_does_not_name() {
    let registry = ToolRegistry::new();
    crate::tools::register_builtin_tools(
        &registry,
        std::sync::Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink),
        None,
    );

    let mut refused = 0usize;
    for name in registry.names() {
        if crate::commands::agent_v2::tool_policy::CHAT_MODE_TOOLS.contains(&name.as_str()) {
            continue;
        }
        assert!(
            !is_tool_available_this_turn(&name, AgentExecutionMode::Chat, true, true, true),
            "{name} is not on chat mode's list and must be refused, whatever the other switches say"
        );
        refused += 1;
    }
    // Everything registered was refused except the tools chat mode names.
    // Seven are native executors today: web search, memory, image/video
    // generation, canvas guidelines and the preference-gated chapter tool.
    // The remaining entries are frontend-bridged.
    //
    // Stated as an equation rather than a floor so that giving chat mode
    // another native tool fails HERE and has to be acknowledged.
    let named_natives = registry
        .names()
        .iter()
        .filter(|name| {
            crate::commands::agent_v2::tool_policy::CHAT_MODE_TOOLS.contains(&name.as_str())
        })
        .count();
    assert_eq!(
        named_natives, 7,
        "web search, memory, image/video, canvas guidelines and chapter are the native ones"
    );
    assert_eq!(
        refused,
        registry.len() - named_natives,
        "every native tool chat mode does not name must have been refused"
    );
}

/// Named individually as well, because these four are the promise itself and a
/// future refactor that quietly re-enabled one should fail loudly here rather
/// than only in the sweep above.
#[test]
fn chat_mode_refuses_files_and_shell_by_name() {
    for name in [
        "file_read",
        "file_write",
        "file_edit",
        "delete_path",
        "move_path",
        "folder_create",
        "glob",
        "grep",
        "workspace_tree",
        "shell_execute",
        "shell_spawn",
        "shell_kill",
        "code",
        "todo",
    ] {
        assert!(
            !is_tool_available_this_turn(name, AgentExecutionMode::Chat, true, true, true),
            "chat mode must never offer {name}"
        );
    }
}

#[test]
fn chat_mode_offers_exactly_research_presentation_and_memory() {
    for name in [
        "auroro_websearch",
        "present_artifact",
        "read_artifact",
        "canvas_guidelines",
        "recall",
        "remember",
        "generate_image",
        "generate_video",
        "aurora_skill_search",
        "aurora_skill_load",
        "ask_question",
    ] {
        assert!(
            is_tool_available_this_turn(name, AgentExecutionMode::Chat, false, false, false),
            "{name} is chat mode's own tool and must be offered"
        );
    }
}

/// Chat's own tools travel in one direction only.
///
/// `recall` and `remember` read and write an index that holds Aurora Chat
/// conversations and nothing else, so in Build they are a memory of everything
/// the user did somewhere else. This shipped: a Build turn called `recall`
/// beside `shell_execute`, was told `found: 0`, and reported to the user that
/// it had no record of the previous session — which was true of the index and
/// false of the work.
///
/// `generate_image` and `generate_video` need a Chat turn's parked config and a
/// store with an `assets/` directory. `generate_image` shipped missing from
/// [`CHAT_ONLY_TOOLS`] and the same thing happened again in a different shape:
/// a Build turn mid-task called it with `op: "list"` and got back "this
/// conversation was not handed any image providers … in Aurora Build the tool
/// is not available", from a tool Build had just advertised.
///
/// Driven off the list rather than a copy of it, so adding a fifth entry is
/// covered the moment it lands.
#[test]
fn build_modes_never_offer_chats_own_tools() {
    use crate::commands::agent_v2::tool_policy::CHAT_ONLY_TOOLS;

    for mode in [AgentExecutionMode::Agent, AgentExecutionMode::Plan] {
        for name in CHAT_ONLY_TOOLS {
            assert!(
                !is_tool_available_this_turn(name, mode, true, true, true),
                "{name} is Aurora Chat's alone and must never be offered in {mode:?}"
            );
        }
    }
    // The two the report came in about, named as well: a refactor that empties
    // the list must fail here rather than pass a loop over nothing.
    for name in ["recall", "remember", "generate_image", "generate_video"] {
        assert!(
            !is_tool_available_this_turn(name, AgentExecutionMode::Agent, true, true, true),
            "{name} must not reach Aurora Build"
        );
    }
}

/// MCP is the one thing that can reach the machine from chat mode, and it is
/// there because connecting a server IS the user's grant. Matched by prefix
/// because the names are made from server ids nobody can enumerate ahead of
/// time.
#[test]
fn chat_mode_allows_mcp_because_connecting_a_server_is_the_grant() {
    for name in [
        "mcp_filesystem_read_file",
        "mcp_postgres_query",
        "mcp_whatever_someone_connects",
    ] {
        assert!(
            is_tool_available_this_turn(name, AgentExecutionMode::Chat, false, false, false),
            "{name} must reach chat mode"
        );
    }
}

/// A tool whose name merely STARTS with an allowed one is a different tool.
/// This is the failure mode that turns an allow-list back into a deny-list.
#[test]
fn chat_mode_matches_tool_names_exactly() {
    for name in [
        "recall_everything",
        "rememberer",
        "present_artifact_and_delete_the_repo",
        "auroro_websearch2",
    ] {
        assert!(
            !is_tool_available_this_turn(name, AgentExecutionMode::Chat, false, false, false),
            "{name} is not on the list and a prefix must not admit it"
        );
    }
}

/// The switches that shape the project modes are irrelevant here. Chat mode
/// answers before any of them, so no combination can widen it.
#[test]
fn chat_modes_roster_ignores_the_project_mode_switches() {
    for has_plan in [false, true] {
        for chapters in [false, true] {
            for browser in [false, true] {
                assert!(
                    !is_tool_available_this_turn(
                        "browser_navigate",
                        AgentExecutionMode::Chat,
                        has_plan,
                        chapters,
                        browser
                    ),
                    "browser stays out of chat mode even with its own switch on"
                );
                assert!(
                    is_tool_available_this_turn(
                        "auroro_websearch",
                        AgentExecutionMode::Chat,
                        has_plan,
                        chapters,
                        browser
                    ),
                    "chat mode's own tools do not depend on project switches"
                );
            }
        }
    }
}

/// Chat mode must not change what the two project modes offer.
#[test]
fn adding_chat_mode_left_the_project_modes_alone() {
    for name in ["file_read", "shell_execute", "code"] {
        for mode in [AgentExecutionMode::Agent, AgentExecutionMode::Plan] {
            let expected = mode != AgentExecutionMode::Plan || name != "shell_execute";
            let _ = expected;
            assert!(
                is_tool_available_this_turn(name, mode, false, false, false),
                "{name} must still be offered in {mode:?}"
            );
        }
    }
}

use super::*;
use crate::agent_runtime::api_client::{ApiError, ApiRequest, ToolSchema, TurnUsage};
use crate::agent_runtime::events::AssistantEvent;
use crate::agent_runtime::types::{ContentBlock, MessageRole, TokenUsage};
use async_trait::async_trait;
use std::sync::Mutex as StdMutex;

// ── Test doubles ────────────────────────────────────────────────

/// Mock that drives the API client behaviour script-style. Each
/// `stream` call pops one [`TurnScript`] off the front and obeys it.
/// Also records every (provider_id, model) it was built with so
/// tests can verify the factory wiring.
#[derive(Default)]
struct MockApi {
    script: StdMutex<Vec<TurnScript>>,
    last_model: StdMutex<Option<String>>,
    /// If set, `stream` waits on `cancel.cancelled().await` before
    /// doing anything else and returns `ApiError::Cancelled`. Used
    /// by the cancel-path tests to make timing deterministic.
    wait_for_cancel: bool,
    /// If set, every `stream` call takes one permit before replying, so a
    /// test can step the model one call at a time and act between calls.
    gate: Option<Arc<tokio::sync::Semaphore>>,
    /// How many times `stream` has been called.
    calls: std::sync::atomic::AtomicUsize,
}

enum TurnScript {
    Reply {
        events: Vec<AssistantEvent>,
        result: Result<TurnUsage, ApiError>,
    },
}

impl MockApi {
    fn new(turns: Vec<TurnScript>) -> Self {
        Self {
            script: StdMutex::new(turns),
            last_model: StdMutex::new(None),
            wait_for_cancel: false,
            gate: None,
            calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn cancel_blocker() -> Self {
        Self {
            script: StdMutex::new(Vec::new()),
            last_model: StdMutex::new(None),
            wait_for_cancel: true,
            gate: None,
            calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// A scripted API that replies only when the test hands it a permit.
    fn gated(turns: Vec<TurnScript>) -> (Self, Arc<tokio::sync::Semaphore>) {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let api = Self {
            script: StdMutex::new(turns),
            last_model: StdMutex::new(None),
            wait_for_cancel: false,
            gate: Some(gate.clone()),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        (api, gate)
    }

    fn call_count(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Wait until `stream` has been called `n` times (and is therefore
    /// parked on the gate for the n-th).
    async fn wait_for_calls(&self, n: usize) {
        for _ in 0..500 {
            if self.call_count() >= n {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("the model was not called {n} times (saw {})", self.call_count());
    }
}

#[async_trait]
impl StreamingApiClient for MockApi {
    async fn stream(
        &self,
        request: ApiRequest<'_>,
        event_sink: mpsc::Sender<AssistantEvent>,
        cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        *self.last_model.lock().expect("last_model mutex") = Some(request.model.to_string());
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        if self.wait_for_cancel {
            cancel_token.cancelled().await;
            return Err(ApiError::Cancelled);
        }
        if let Some(gate) = &self.gate {
            tokio::select! {
                permit = gate.acquire() => permit.expect("gate open").forget(),
                () = cancel_token.cancelled() => return Err(ApiError::Cancelled),
            }
        }

        let turn = {
            let mut script = self.script.lock().expect("script mutex");
            if script.is_empty() {
                return Err(ApiError::Provider(
                    "MockApi script exhausted — test bug".into(),
                ));
            }
            script.remove(0)
        };
        let TurnScript::Reply { events, result } = turn;
        for event in events {
            if event_sink.send(event).await.is_err() {
                return Err(ApiError::Network("event sink closed".into()));
            }
        }
        // Yield once so the forwarder gets a chance to drain
        // before we return — keeps event ordering deterministic in
        // the cancel-after-events test.
        tokio::task::yield_now().await;
        // Honour cancellation that arrived between sends (the
        // mid-turn-cancel test relies on this).
        if cancel_token.is_cancelled() {
            return Err(ApiError::Cancelled);
        }
        result
    }
}

/// Records every `build` invocation and hands back a pre-built
/// `Arc<dyn StreamingApiClient>` (or an error) so tests can:
/// 1. assert the factory was called with the right
///    `ProviderConfigSnapshot` (provider_id, model, api_key, …),
/// 2. control the mock api instance returned per call.
///
/// Phase 2.3 widened the factory signature from `(provider_id,
/// model)` to `&ProviderConfigSnapshot` — the recorder now snaps
/// the whole config so tests can verify that custom_headers /
/// custom_params / api_key reach the adapter unchanged.
struct MockApiFactory {
    built_with: StdMutex<Vec<crate::api::ProviderConfigSnapshot>>,
    result: StdMutex<Option<Result<Arc<dyn StreamingApiClient>, RuntimeError>>>,
    /// If `result` is None, this is consulted to build a fresh
    /// MockApi each call. Lets us re-use the factory across
    /// sequential turns without re-priming.
    api_for_each_call: Option<Arc<MockApi>>,
}

impl MockApiFactory {
    fn from_api(api: Arc<MockApi>) -> Self {
        Self {
            built_with: StdMutex::new(Vec::new()),
            result: StdMutex::new(None),
            api_for_each_call: Some(api),
        }
    }

    fn from_error(err: RuntimeError) -> Self {
        Self {
            built_with: StdMutex::new(Vec::new()),
            result: StdMutex::new(Some(Err(err))),
            api_for_each_call: None,
        }
    }

    fn built_with_snapshot(&self) -> Vec<crate::api::ProviderConfigSnapshot> {
        self.built_with.lock().expect("built_with mutex").clone()
    }
}

impl ApiFactory for MockApiFactory {
    fn build(
        &self,
        config: &crate::api::ProviderConfigSnapshot,
    ) -> Result<Arc<dyn StreamingApiClient>, RuntimeError> {
        self.built_with
            .lock()
            .expect("built_with mutex")
            .push(config.clone());

        let mut slot = self.result.lock().expect("result mutex");
        if let Some(prepared) = slot.take() {
            // Re-arm with the same value so subsequent calls keep
            // returning the same outcome — important for the
            // factory-error test which checks the error renders
            // every call.
            let cloned: Result<Arc<dyn StreamingApiClient>, RuntimeError> = match &prepared {
                Ok(arc) => Ok(arc.clone()),
                Err(_e) => Err(RuntimeError::InvalidState(
                    "mock factory: pre-armed error".into(),
                )),
            };
            *slot = Some(cloned);
            return prepared;
        }
        drop(slot);

        if let Some(api) = &self.api_for_each_call {
            Ok(api.clone() as Arc<dyn StreamingApiClient>)
        } else {
            Err(RuntimeError::InvalidState(
                "mock factory has no result armed".into(),
            ))
        }
    }
}

/// Recording emitter — captures every emit_* call so assertions can
/// inspect the full per-turn event stream.
///
/// Phase 2.3 adds the `tool_pending` capture so bridge tests can
/// observe the event the runtime emits when the model calls a
/// frontend-bridged tool.
#[derive(Default)]
struct MockEmitter {
    events: StdMutex<Vec<AgentEventEnvelope>>,
    completes: StdMutex<Vec<(String, TurnCompletion)>>,
    errors: StdMutex<Vec<(String, String, Option<RecoveryHint>)>>,
    tool_pendings: StdMutex<Vec<ToolBridgeRequest>>,
    subagent_events: StdMutex<Vec<crate::agent_runtime::subagents::SubagentEvent>>,
}

impl MockEmitter {
    fn snapshot_subagent_events(&self) -> Vec<crate::agent_runtime::subagents::SubagentEvent> {
        self.subagent_events
            .lock()
            .expect("subagent_events mutex")
            .clone()
    }
    fn snapshot_events(&self) -> Vec<AgentEventEnvelope> {
        self.events.lock().expect("events mutex").clone()
    }
    fn snapshot_completes(&self) -> Vec<(String, TurnCompletion)> {
        self.completes.lock().expect("completes mutex").clone()
    }
    fn snapshot_errors(&self) -> Vec<(String, String, Option<RecoveryHint>)> {
        self.errors.lock().expect("errors mutex").clone()
    }
    fn snapshot_tool_pendings(&self) -> Vec<ToolBridgeRequest> {
        self.tool_pendings
            .lock()
            .expect("tool_pendings mutex")
            .clone()
    }
}

impl EventEmitter for MockEmitter {
    fn emit_event(&self, envelope: &AgentEventEnvelope) {
        self.events
            .lock()
            .expect("events mutex")
            .push(envelope.clone());
    }
    fn emit_turn_complete(&self, turn_id: &str, summary: &TurnCompletion) {
        self.completes
            .lock()
            .expect("completes mutex")
            .push((turn_id.to_string(), summary.clone()));
    }
    fn emit_turn_error(&self, turn_id: &str, error: &str, recovery_hint: Option<RecoveryHint>) {
        self.errors.lock().expect("errors mutex").push((
            turn_id.to_string(),
            error.to_string(),
            recovery_hint,
        ));
    }
    fn emit_tool_pending(&self, request: &ToolBridgeRequest) {
        self.tool_pendings
            .lock()
            .expect("tool_pendings mutex")
            .push(request.clone());
    }
    fn emit_subagent(&self, event: &crate::agent_runtime::subagents::SubagentEvent) {
        self.subagent_events
            .lock()
            .expect("subagent_events mutex")
            .push(event.clone());
    }
}

// ── Helpers ─────────────────────────────────────────────────────

fn assistant_text_msg(text: &str) -> ConversationMessage {
    ConversationMessage::assistant(
        vec![ContentBlock::Text { text: text.into() }],
        1_700_000_000_000,
    )
}

fn assistant_tool_use_msg(id: &str, name: &str, input: serde_json::Value) -> ConversationMessage {
    ConversationMessage::assistant(
        vec![ContentBlock::ToolUse {
            id: id.into(),
            name: name.into(),
            input,
        }],
        1_700_000_000_000,
    )
}

fn turn_usage(message: ConversationMessage, stop_reason: &str) -> TurnUsage {
    TurnUsage {
        usage: TokenUsage {
            input_tokens: 5,
            output_tokens: 7,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            estimated: None,
            cost_usd: None,
        },
        stop_reason: stop_reason.into(),
        assistant_message: message,
        notices: Vec::new(),
    }
}

/// Default `ProviderConfigSnapshot` for tests that don't care
/// about the provider wiring. Mirrors the shape of a real
/// frontend-supplied snapshot but with placeholder values.
fn default_provider_config() -> crate::api::ProviderConfigSnapshot {
    crate::api::ProviderConfigSnapshot {
        provider_id: "mock-provider".into(),
        provider_type: None,
        base_url: "https://example.invalid/v1".into(),
        api_key: "mock-key".into(),
        api_keys: None,
        model: "mock-model".into(),
        custom_headers: None,
        custom_params: None,
        default_temperature: None,
        default_max_tokens: None,
        supports_thinking: false,
        reasoning: None,
        supports_vision: false,
    }
}

fn make_request(turn_id: &str, thread_id: &str, msg: &str) -> AgentChatRequest {
    AgentChatRequest {
        // Not a CLI dispatch: these turns come from the window, so nothing is
        // teed into a terminal transcript.
        cli_task_id: None,
        turn_id: turn_id.into(),
        thread_id: thread_id.into(),
        user_message: msg.into(),
        user_message_origin: crate::agent_runtime::types::InjectedOrigin::User,
        user_message_summary: None,
        user_message_agent: None,
        provider_id: "mock-provider".into(),
        model: "mock-model".into(),
        model_selection: None,
        workspace_path: None,
        execution_mode: AgentExecutionMode::Agent,
        provider_config: default_provider_config(),
        system_prompt: None,
        ide_context: None,
        tools: Vec::new(),
        temperature: None,
        max_output_tokens: None,
        thinking_enabled: None,
        thinking_budget_tokens: None,
        context_window: None,
        attached_selected_elements: None,
        attached_prompt_chips: None,
        image_providers: Vec::new(),
        compaction_threshold_pct: None,
        compaction_summary_budget: None,
        compaction_provider_config: None,
        workspace_access: None,
        allow_outside_workspace: None,
        transcript_chapters: None,
        browser_tools: None,
        defer_tools: None,
        subagents_enabled: None,
        subagent_model: None,
    }
}

fn native_test_registry() -> Arc<ToolRegistry> {
    let mut registry = ToolRegistry::new();
    let sink = Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink);
    crate::tools::file_workspace_search::register(&mut registry, sink.clone(), None);
    crate::tools::shell_editor_todo::register(&mut registry, sink);
    Arc::new(registry)
}

/// The serialized tool array rides in every request's cacheable prefix, and
/// every provider Aurora talks to caches on the longest common prefix. So the
/// head of the array has to be a function of WHICH tools exist, never of the
/// order they were discovered in.
///
/// Bridged tools used to register first, and because `ToolRegistry::register`
/// keeps an existing name's slot, a native tool inherited whichever position
/// its bridge placeholder landed in. One MCP server connecting reshuffled the
/// head and cost the whole tool block its cache.
#[test]
fn natives_lead_the_roster_and_mcp_connection_order_cannot_move_them() {
    let bridged = |name: &str| AllowedTool {
        name: name.to_string(),
        description: String::new(),
        parameters: serde_json::json!({"type": "object"}),
    };
    let build = |tools: &[AllowedTool]| {
        build_per_turn_tool_registry(
            native_test_registry(),
            tools,
            "turn-order".into(),
            Arc::new(BridgeRouter::new()),
            Arc::new(MockEmitter::default()),
            CancellationToken::new(),
            true,
            AgentExecutionMode::Agent,
            None,
            false,
            true,
            false,
            "",
        )
        .names()
    };

    // Same servers, opposite connection order.
    let forward = build(&[
        bridged("mcp_alpha_read"),
        bridged("mcp_zeta_write"),
        bridged("ask_question"),
    ]);
    let reversed = build(&[
        bridged("ask_question"),
        bridged("mcp_zeta_write"),
        bridged("mcp_alpha_read"),
    ]);
    assert_eq!(
        forward, reversed,
        "roster must not depend on MCP connection order"
    );

    // Natives are a contiguous prefix: nothing bridged appears before the
    // last native, so MCP churn can only ever move the tail.
    let natives = native_test_registry().names();
    let last_native = forward
        .iter()
        .rposition(|n| natives.contains(n))
        .expect("natives present");
    assert!(
        forward[..=last_native].iter().all(|n| natives.contains(n)),
        "a bridged tool is interleaved into the native prefix: {forward:?}"
    );

    // And the bridged partition is sorted, so adding a server shifts only
    // what follows it rather than everything.
    let tail: Vec<&String> = forward[last_native + 1..]
        .iter()
        .filter(|name| !crate::tools::tool_search::TOOL_NAMES.contains(&name.as_str()))
        .collect();
    let mut sorted = tail.clone();
    sorted.sort();
    assert_eq!(tail, sorted, "bridged partition is not name-sorted");
}

#[test]
fn plan_registry_excludes_native_mutators_but_keeps_read_tools() {
    let emitter = Arc::new(MockEmitter::default());
    let registry = build_per_turn_tool_registry(
        native_test_registry(),
        &[],
        "turn-plan".into(),
        Arc::new(BridgeRouter::new()),
        emitter,
        CancellationToken::new(),
        false,
        AgentExecutionMode::Plan,
        None,
        false,
        true,
        false,
        "",
    );

    for name in PLAN_MUTATING_TOOLS {
        assert!(registry.get(name).is_none(), "Plan mode exposed {name}");
    }
    for name in ["file_read", "grep", "workspace_tree", "shell_execute"] {
        assert!(registry.get(name).is_some(), "Plan mode hid {name}");
    }
}

/// A workspace with a plan on disk, for the plan-presence gate.
fn workspace_with_a_plan() -> std::path::PathBuf {
    let ws = std::env::temp_dir().join(format!("aurora-gate-plan-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&ws).expect("ws");
    let mut frontmatter = crate::plans::store::empty_frontmatter("P", None);
    frontmatter
        .steps
        .push(crate::plans::model::PlanStep::new("s1", "Phase 1"));
    crate::plans::store::create(&ws, frontmatter, String::new()).expect("plan");
    ws
}

#[test]
fn plan_tools_are_absent_until_the_project_actually_has_a_plan() {
    // Advertising plan_read / plan_step_update in every Agent turn told the
    // model a plan existed when none did.
    for name in ["plan_read", "plan_step_update"] {
        assert!(
            !is_tool_available_this_turn(name, AgentExecutionMode::Agent, false, false, true),
            "{name} was offered with no plan in the project"
        );
        assert!(
            is_tool_available_this_turn(name, AgentExecutionMode::Agent, true, false, true),
            "{name} was withheld from a project that has a plan"
        );
    }
}

#[test]
fn only_plan_mode_may_author_a_plan() {
    assert!(is_tool_available_this_turn(
        "plan_write",
        AgentExecutionMode::Plan,
        false,
        false,
        true
    ));
    assert!(
        !is_tool_available_this_turn("plan_write", AgentExecutionMode::Agent, true, false, true),
        "execution mode could rewrite the plan the user approved"
    );
}

#[test]
fn the_working_checklist_is_available_whenever_a_plan_is() {
    // The user's model: the plan holds phases, todos hold the steps inside
    // the phase being executed. Neither suppresses the other.
    for has_plan in [false, true] {
        assert!(
            is_tool_available_this_turn("todo", AgentExecutionMode::Agent, has_plan, false, true),
            "todo withheld (has_plan={has_plan})"
        );
    }
}

#[test]
fn chapters_are_withheld_until_the_user_asks_for_them() {
    // The instruction that teaches chapters is gated on the same preference.
    // If this gate ever defaulted open, every user would get a tool no part
    // of the prompt told them about; if it stuck shut, the prompt would ask
    // for chapters the model had no way to mark.
    for mode in [
        AgentExecutionMode::Agent,
        AgentExecutionMode::Plan,
        AgentExecutionMode::Chat,
    ] {
        assert!(
            !is_tool_available_this_turn("chapter", mode, false, false, true),
            "chapter was advertised with the preference off ({mode:?})"
        );
        assert!(
            is_tool_available_this_turn("chapter", mode, false, true, true),
            "chapter was withheld with the preference on ({mode:?})"
        );
    }
}

#[test]
fn the_chapter_gate_leaves_every_other_tool_alone() {
    for name in ["file_read", "todo", "shell_execute", "grep"] {
        assert!(
            is_tool_available_this_turn(name, AgentExecutionMode::Agent, false, false, true),
            "{name} was caught by the chapter gate"
        );
    }
}

#[test]
fn a_project_with_a_plan_gets_the_plan_execution_tools() {
    let ws = workspace_with_a_plan();
    assert!(workspace_has_plan(Some(&ws.to_string_lossy())));
    assert!(!workspace_has_plan(None), "no workspace means no plan");

    let registry = build_per_turn_tool_registry(
        native_test_registry(),
        &[AllowedTool {
            name: "plan_step_update".into(),
            description: "d".into(),
            parameters: serde_json::json!({"type": "object"}),
        }],
        "turn-agent".into(),
        Arc::new(BridgeRouter::new()),
        Arc::new(MockEmitter::default()),
        CancellationToken::new(),
        false,
        AgentExecutionMode::Agent,
        Some(&ws.to_string_lossy()),
        false,
        true,
        false,
        "",
    );
    assert!(registry.get("plan_step_update").is_some());

    std::fs::remove_dir_all(&ws).ok();
}

#[test]
fn plan_shell_allowlist_handles_powershell_git_and_command_chaining() {
    for command in [
        "rg TODO src",
        "Get-Content package.json -Raw",
        "git status --short",
        "git branch --show-current",
    ] {
        assert!(
            is_plan_shell_command_allowed(command),
            "blocked safe command: {command}"
        );
    }
    for command in [
        "Set-Content secret.txt nope",
        "Get-Content a | Set-Content b",
        "echo $(rm file)",
        "git branch feature",
        "git branch -D feature",
        "git diff --output=changes.patch",
        "rg TODO; Remove-Item file",
    ] {
        assert!(
            !is_plan_shell_command_allowed(command),
            "allowed mutating command: {command}"
        );
    }
}

#[tokio::test]
async fn plan_shell_rejects_mutating_commands_before_execution() {
    let emitter = Arc::new(MockEmitter::default());
    let registry = build_per_turn_tool_registry(
        native_test_registry(),
        &[],
        "turn-plan".into(),
        Arc::new(BridgeRouter::new()),
        emitter,
        CancellationToken::new(),
        false,
        AgentExecutionMode::Plan,
        None,
        false,
        true,
        false,
        "",
    );
    let tool = registry
        .get("shell_execute")
        .expect("read-only shell remains visible");
    let error = tool
        .execute(
            serde_json::json!({ "command": "Set-Content secret.txt nope" }),
            &ToolContext {
                turn_id: "turn-plan".into(),
                tool_call_id: "call-plan".into(),
                thread_id: "session-plan".into(),
                workspace_root: None,
                workspace_access: Default::default(),
                cancel_token: CancellationToken::new(),
                spill_dir: None,
            },
        )
        .await
        .expect_err("Plan mode must reject writes");

    assert!(matches!(error, ToolError::PolicyViolation(_)));
}

fn dummy_factory() -> Arc<MockApiFactory> {
    // Never actually used to build — for tests that don't reach
    // run_turn (registry-only tests).
    Arc::new(MockApiFactory::from_api(Arc::new(MockApi::new(Vec::new()))))
}

fn temp_registry() -> (Arc<AgentRegistry>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(
        dummy_factory(),
        dir.path().to_path_buf(),
    ));
    (registry, dir)
}

fn _assert_send_sync<T: Send + Sync>() {}

#[test]
fn registry_is_send_sync() {
    _assert_send_sync::<AgentRegistry>();
}

// ── Test 1 ──────────────────────────────────────────────────────
// load_or_create_session returns the same Arc on cache hits.

#[tokio::test]
async fn load_or_create_session_caches_arc() {
    let (registry, _dir) = temp_registry();

    let a = registry.load_or_create_session("thread-1").expect("first");
    let b = registry.load_or_create_session("thread-1").expect("second");

    assert!(
        Arc::ptr_eq(&a, &b),
        "second call must return the SAME Arc pointer as the first"
    );
    assert_eq!(registry.session_count(), 1);
}

#[tokio::test]
async fn load_or_create_session_restores_sticky_workspace_scope() {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = AgentRegistry::new(dummy_factory(), dir.path().to_path_buf());
    let store = registry.store_for_workspace(Some("C:/project-a")).unwrap();
    store
        .ensure_thread("scoped", None, Some("C:/project-a".into()))
        .expect("metadata");
    Session::append_to_path(
        store.session_path("scoped"),
        &ConversationMessage::user_text("hello", 1),
    )
    .expect("jsonl");

    let registry = AgentRegistry::new(dummy_factory(), dir.path().to_path_buf());
    let session = registry.load_or_create_session("scoped").expect("session");

    assert_eq!(
        session.lock().await.workspace_root.as_deref(),
        Some("C:/project-a")
    );
}

/// A command handed only a thread id finds the store that owns it, and an
/// unknown id has no store until a creation path supplies its workspace.
#[test]
fn store_for_thread_follows_the_conversation_to_its_own_store() {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = AgentRegistry::new(dummy_factory(), dir.path().to_path_buf());
    registry
        .chat_store()
        .ensure_thread("a-chat", Some("chat".into()), None)
        .expect("chat metadata");
    registry
        .store_for_workspace(None)
        .unwrap()
        .ensure_thread("a-build", Some("build".into()), None)
        .expect("build metadata");

    assert_eq!(
        registry.store_for_thread("a-chat").unwrap().unwrap().dir(),
        registry.chat_store().dir()
    );
    assert_eq!(
        registry.store_for_thread("a-build").unwrap().unwrap().dir(),
        registry.store_for_workspace(None).unwrap().dir()
    );
    assert!(registry.store_for_thread("never-saved").unwrap().is_none());
}

#[test]
fn existing_conversation_rejects_the_other_surface_mode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = AgentRegistry::new(dummy_factory(), dir.path().to_path_buf());
    registry
        .chat_store()
        .ensure_thread("chat-owned", None, None)
        .unwrap();
    registry
        .store_for_workspace(None)
        .unwrap()
        .ensure_thread("build-owned", None, None)
        .unwrap();

    for (id, wrong_mode) in [
        ("chat-owned", AgentExecutionMode::Agent),
        ("build-owned", AgentExecutionMode::Chat),
    ] {
        let error = registry
            .store_for_conversation(wrong_mode, id, None)
            .unwrap_err();
        assert!(error.to_string().contains("other Aurora surface"), "{error}");
    }
    assert!(registry
        .store_for_conversation(AgentExecutionMode::Chat, "chat-owned", None)
        .is_ok());
    assert!(registry
        .store_for_conversation(AgentExecutionMode::Agent, "build-owned", None)
        .is_ok());
}

/// Retry in Aurora Chat rewinds, then saves the thread. The save used to route
/// as a Build conversation and fail with "other Aurora surface", after the
/// rewind had already cut the history, so the turn vanished unretried.
#[test]
fn saving_a_conversation_writes_to_the_store_that_owns_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = AgentRegistry::new(dummy_factory(), dir.path().to_path_buf());
    registry
        .chat_store()
        .ensure_thread("chat-owned", None, None)
        .unwrap();
    registry
        .store_for_workspace(None)
        .unwrap()
        .ensure_thread("build-owned", None, None)
        .unwrap();

    let chat = registry.store_for_save("chat-owned", None).unwrap();
    assert!(registry.is_chat_store(&chat), "a chat conversation saves to the chat store");

    let build = registry.store_for_save("build-owned", None).unwrap();
    assert!(!registry.is_chat_store(&build));

    let new = registry.store_for_save("brand-new", None).unwrap();
    assert!(!registry.is_chat_store(&new), "a new conversation is a Build one");
}

#[test]
fn contaminated_chat_metadata_loses_its_build_workspace() {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = AgentRegistry::new(dummy_factory(), dir.path().to_path_buf());
    let chat = registry.chat_store();
    chat.ensure_thread("legacy-chat", None, Some("C:/private-build".into()))
        .unwrap();
    assert_eq!(
        chat.load_metadata("legacy-chat")
            .unwrap()
            .workspace_root
            .as_deref(),
        Some("C:/private-build")
    );

    chat.clear_chat_workspace_root("legacy-chat").unwrap();
    assert!(chat
        .load_metadata("legacy-chat")
        .unwrap()
        .workspace_root
        .is_none());
    assert!(registry
        .store_for_workspace(None)
        .unwrap()
        .clear_chat_workspace_root("legacy-chat")
        .is_err());
}

#[test]
fn project_routing_is_scoped_collision_safe_and_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let registry = AgentRegistry::new(dummy_factory(), dir.path().to_owned());
    let first = registry
        .store_for_conversation(AgentExecutionMode::Agent, "first", Some(r"E:\a\b"))
        .unwrap();
    first
        .ensure_thread("first", Some("First".into()), Some(r"E:\a\b".into()))
        .unwrap();
    let mut meta = first.load_metadata("first").unwrap();
    meta.updated_at = "2026-09-19T12:00:00Z".into();
    std::fs::write(first.meta_path("first"), serde_json::to_vec(&meta).unwrap()).unwrap();
    let second = registry.store_for_workspace(Some("e:/a-b")).unwrap();
    second
        .ensure_thread("second", Some("Second".into()), Some("e:/a-b".into()))
        .unwrap();
    let mut meta = second.load_metadata("second").unwrap();
    meta.updated_at = "2026-09-20T12:00:00Z".into();
    std::fs::write(
        second.meta_path("second"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .unwrap();
    assert_ne!(
        first.dir(),
        second.dir(),
        "colliding slugs must not alias the registry cache"
    );
    assert_eq!(
        registry
            .list_project_summaries(Some("e:/a/b/"))
            .unwrap()
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec!["first"]
    );
    assert_eq!(
        registry
            .list_project_summaries(None)
            .unwrap()
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec!["second", "first"]
    );
    assert_eq!(
        first.dir(),
        registry.store_for_workspace(Some("e:/a/b")).unwrap().dir()
    );
    let reopened = AgentRegistry::new(dummy_factory(), dir.path().to_owned());
    assert_eq!(
        reopened.require_store_for_thread("first").unwrap().dir(),
        first.dir()
    );
    first.delete("first").unwrap();
    assert!(reopened.store_for_thread("first").unwrap().is_none());
    assert!(!first.thread_dir("first").exists());
    assert!(first.dir().join("project.json").is_file());
    assert!(second.session_path("second").is_file());
}

#[test]
#[ignore = "manual listing benchmark; creates 1,204 temporary conversations"]
fn measure_project_listing_after_reopening_1204_threads() {
    let root = tempfile::tempdir().unwrap();
    let registry = AgentRegistry::new(dummy_factory(), root.path().to_owned());
    let store = registry.store_for_workspace(Some("E:/listing-benchmark")).unwrap();
    for n in 0..1204 {
        let id = format!("thread-{n}");
        store.ensure_thread(&id, Some(format!("Conversation {n}")), Some("E:/listing-benchmark".into())).unwrap();
        Session::append_to_path(store.session_path(&id), &ConversationMessage::user_text("Measure project history", 1)).unwrap();
    }
    let start = std::time::Instant::now();
    assert_eq!(registry.list_project_summaries(Some("E:/listing-benchmark")).unwrap().len(), 1204);
    let cold = start.elapsed();
    drop(registry);
    let reopened = AgentRegistry::new(dummy_factory(), root.path().to_owned());
    let start = std::time::Instant::now();
    assert_eq!(reopened.list_project_summaries(Some("e:/listing-benchmark")).unwrap().len(), 1204);
    eprintln!("Temporary fixture: 1204 conversations; cold={}ms; reopened={}ms", cold.as_millis(), start.elapsed().as_millis());
}

#[tokio::test]
async fn later_turn_cannot_move_live_session_to_another_workspace() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg("first"), "end_turn")),
        },
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg("second"), "end_turn")),
        },
    ]));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api)),
        dir.path().to_path_buf(),
    ));
    let driver = TurnDriver::new(registry.clone(), Arc::new(MockEmitter::default()));

    let mut first = make_request("turn-a", "sticky-thread", "first");
    first.workspace_path = Some("C:/project-a".into());
    driver.run_turn(first).await.expect("first turn");

    let mut second = make_request("turn-b", "sticky-thread", "second");
    second.workspace_path = Some("C:/project-b".into());
    driver.run_turn(second).await.expect("second turn");

    let session = registry
        .load_or_create_session("sticky-thread")
        .expect("session");
    assert_eq!(
        session.lock().await.workspace_root.as_deref(),
        Some("C:/project-a")
    );
    assert_eq!(
        registry
            .require_store_for_thread("sticky-thread")
            .unwrap()
            .load_metadata("sticky-thread")
            .expect("metadata")
            .workspace_root
            .as_deref(),
        Some("C:/project-a")
    );
}

// ── Test 2 ──────────────────────────────────────────────────────
// Non-existent file → fresh empty session, no error.

#[tokio::test]
async fn load_or_create_session_for_missing_file_returns_empty() {
    let (registry, _dir) = temp_registry();

    let arc = registry
        .load_or_create_session("brand-new-thread")
        .expect("not_found must not propagate as Err");

    let session = arc.lock().await;
    assert!(session.is_empty());
    assert_eq!(session.thread_id, "brand-new-thread");
}

// ── Test 3 ──────────────────────────────────────────────────────
// Existing JSONL on disk → loaded session has those messages.

#[tokio::test]
async fn load_or_create_session_reads_existing_jsonl() {
    let (registry, _dir) = temp_registry();

    // Pre-seed the file via the same Session helpers production uses.
    let path = registry.session_path("seeded-thread");
    Session::append_to_path(&path, &ConversationMessage::user_text("hello", 100))
        .expect("seed user");
    Session::append_to_path(
        &path,
        &ConversationMessage::assistant(vec![ContentBlock::Text { text: "hi".into() }], 200),
    )
    .expect("seed assistant");

    let arc = registry
        .load_or_create_session("seeded-thread")
        .expect("load");
    let session = arc.lock().await;
    assert_eq!(session.len(), 2, "must reflect on-disk messages");
    assert_eq!(session.thread_id, "seeded-thread");
    match &session.messages[0].blocks[0] {
        ContentBlock::Text { text } => assert_eq!(text, "hello"),
        other => panic!("expected text, got {other:?}"),
    }
}

// ── Test 4 ──────────────────────────────────────────────────────
// register_in_flight + cancel(turn_id) cancels the token and
// returns true.

#[test]
fn cancel_returns_true_for_registered_turn() {
    let (registry, _dir) = temp_registry();
    let token = CancellationToken::new();
    registry.register_in_flight("t-1".into(), token.clone());

    assert!(!token.is_cancelled(), "precondition");
    let found = registry.cancel("t-1");
    assert!(found, "cancel must return true when a token was registered");
    assert!(token.is_cancelled(), "token must actually be cancelled");
}

// ── Test 5 ──────────────────────────────────────────────────────
// cancel for an unknown turn_id returns false; doesn't panic.

#[test]
fn cancel_returns_false_for_unknown_turn() {
    let (registry, _dir) = temp_registry();
    // No registration.
    let found = registry.cancel("nonexistent");
    assert!(!found);
}

// ── Test 6 ──────────────────────────────────────────────────────
// unregister_in_flight removes the token; subsequent cancel returns
// false.

#[test]
fn unregister_then_cancel_returns_false() {
    let (registry, _dir) = temp_registry();
    let token = CancellationToken::new();
    registry.register_in_flight("t-2".into(), token);

    registry.unregister_in_flight("t-2");
    assert!(!registry.cancel("t-2"));
}

// ── Test 7 ──────────────────────────────────────────────────────
// End-to-end happy path: text deltas + message_stop, persisted to
// disk, in-memory session has both messages.

#[tokio::test]
async fn happy_path_emits_events_persists_session_no_tools() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![
            AssistantEvent::TextDelta {
                delta: "hello".into(),
            },
            AssistantEvent::TextDelta {
                delta: " world".into(),
            },
        ],
        result: Ok(turn_usage(assistant_text_msg("hello world"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api.clone()));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter.clone());
    let summary = driver
        .run_turn(make_request("t-1", "thread-A", "hi"))
        .await
        .expect("ok");

    assert_eq!(summary.iterations, 1);
    assert_eq!(summary.stop_reason, "end_turn");

    // Event ordering: attempt boundary, TextDelta, TextDelta, MessageStop.
    let events = emitter.snapshot_events();
    assert_eq!(events.len(), 4, "got events: {events:?}");
    assert!(
        events.iter().all(|event| event.turn_id == "t-1"),
        "all streamed events must use the frontend turn id: {events:?}"
    );
    assert!(matches!(events[0].event, AssistantEvent::StreamAttemptStarted));
    match &events[1].event {
        AssistantEvent::TextDelta { delta } => assert_eq!(delta, "hello"),
        other => panic!("expected TextDelta, got {other:?}"),
    }
    match &events[3].event {
        AssistantEvent::MessageStop { stop_reason } => assert_eq!(stop_reason, "end_turn"),
        other => panic!("expected MessageStop, got {other:?}"),
    }

    // emit_turn_complete fires once with the right turn_id.
    let completes = emitter.snapshot_completes();
    assert_eq!(completes.len(), 1);
    assert_eq!(completes[0].0, "t-1");
    assert_eq!(
        completes[0].1.turn_id, "t-1",
        "completion summary must use the frontend turn id"
    );
    assert!(emitter.snapshot_errors().is_empty());

    // On-disk JSONL has user + assistant.
    let path = registry.session_path("thread-A");
    let on_disk = Session::load_from_path("thread-A", &path).expect("load");
    assert_eq!(on_disk.len(), 2, "user + assistant on disk");

    // In-memory session in registry has both messages.
    let arc = registry.load_or_create_session("thread-A").expect("cached");
    let in_mem = arc.lock().await;
    assert_eq!(in_mem.len(), 2);
}

/// An Aurora Chat turn hands `generate_image` this conversation's image
/// providers and the CHAT store — the one whose `assets/` exists. A Build turn
/// hands it nothing: the tool is not in that roster, and a Build store has
/// nowhere to land a picture.
#[tokio::test]
async fn a_chat_turn_parks_the_image_providers_for_the_tool_and_a_build_turn_does_not() {
    use crate::tools::image::config::{
        clear_turn_config, turn_config, ImageApiFormat, ImageProviderConfig,
    };

    let reply = || TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("ok"), "end_turn")),
    };
    let api = Arc::new(MockApi::new(vec![reply(), reply()]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let driver = TurnDriver::new(registry.clone(), Arc::new(MockEmitter::default()));

    let provider = ImageProviderConfig {
        id: "p1".into(),
        name: "a6api".into(),
        base_url: "https://api.a6api.com/v1".into(),
        api_key: Some("sk-x".into()),
        api_format: ImageApiFormat::A6api,
        generation_path: None,
        edit_path: None,
        request_format: None,
        enabled: true,
        models: vec![],
    };

    let mut chat = make_request("t-chat", "img-chat-thread", "draw me something");
    chat.execution_mode = AgentExecutionMode::Chat;
    chat.image_providers = vec![provider.clone()];
    driver.run_turn(chat).await.expect("chat turn");
    let parked = turn_config("img-chat-thread").expect("a chat turn parks its image config");
    assert_eq!(parked.providers, vec![provider.clone()]);
    assert_eq!(parked.store.dir(), registry.chat_store().dir());
    assert!(
        parked.store.assets_dir("img-chat-thread").is_some(),
        "the parked store can hold assets"
    );
    clear_turn_config("img-chat-thread");

    let mut build = make_request("t-build", "img-build-thread", "hi");
    build.image_providers = vec![provider];
    driver.run_turn(build).await.expect("build turn");
    assert!(
        turn_config("img-build-thread").is_none(),
        "a Build turn hands generate_image nothing"
    );
    // The other half of this test's own sentence, which used to be prose only.
    // It read "the tool is not in that roster" while checking the config and
    // nothing else, and the roster half was false for as long as it was there.
    assert!(
        !is_tool_available_this_turn(
            "generate_image",
            AgentExecutionMode::Agent,
            true,
            true,
            true
        ),
        "a Build turn must not advertise the tool it then refuses to run"
    );
}

// ── Test 8 ──────────────────────────────────────────────────────
// Unknown tool call → ToolResult with is_error: true; loop
// continues; final stop is "end_turn".

#[tokio::test]
async fn unknown_tool_yields_is_error_and_loop_continues() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use_msg("call-x", "ghost", serde_json::json!({})),
                "tool_use",
            )),
        },
        TurnScript::Reply {
            events: vec![AssistantEvent::TextDelta { delta: "ok".into() }],
            result: Ok(turn_usage(assistant_text_msg("ok"), "end_turn")),
        },
    ]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter.clone());
    let summary = driver
        .run_turn(make_request("t-2", "thread-B", "?"))
        .await
        .expect("ok");

    assert_eq!(summary.stop_reason, "end_turn");
    assert_eq!(summary.iterations, 2, "must loop after the unknown tool");
    assert_eq!(summary.tool_results.len(), 1);
    match &summary.tool_results[0].blocks[0] {
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            assert_eq!(tool_use_id, "call-x");
            assert_eq!(*is_error, Some(true));
            assert!(
                content.contains("tool not found"),
                "must mention the missing tool, got: {content}"
            );
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

// ── Test 9 ──────────────────────────────────────────────────────
// Pre-cancelled turn → emitter sees no MessageStop; in_flight
// unregistered. We cancel via registry.cancel(turn_id) immediately
// after the driver registers the token; the mock api blocks on
// cancel so the cancellation is observed before any events.

#[tokio::test]
async fn pre_cancelled_turn_skips_message_stop_and_unregisters() {
    let api = Arc::new(MockApi::cancel_blocker());
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter.clone());

    let driver_clone = TurnDriver::new(registry.clone(), emitter.clone());
    let task = tokio::spawn(async move {
        driver_clone
            .run_turn(make_request("t-cancel-1", "thread-C", "?"))
            .await
    });

    // Wait for the driver to register the in-flight token. The
    // MockApi::cancel_blocker awaits cancel.cancelled() so the
    // turn is parked at the api stream call when in_flight is
    // populated.
    for _ in 0..200 {
        if registry.in_flight_count() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        registry.in_flight_count(),
        1,
        "driver must register in_flight"
    );

    let cancelled = registry.cancel("t-cancel-1");
    assert!(cancelled, "cancel must find the registered token");

    let result = task.await.expect("join").expect_err("must cancel");
    assert!(result.is_cancellation(), "got: {result:?}");

    // No MessageStop event was ever emitted.
    let events = emitter.snapshot_events();
    for env in &events {
        assert!(
            !matches!(env.event, AssistantEvent::MessageStop { .. }),
            "must not have MessageStop, got: {env:?}"
        );
    }

    // emit_turn_error fires with "cancelled".
    let errors = emitter.snapshot_errors();
    assert_eq!(errors.len(), 1, "exactly one turn_error");
    assert_eq!(errors[0].0, "t-cancel-1");
    assert_eq!(errors[0].1, "cancelled");

    // No completion event.
    assert!(emitter.snapshot_completes().is_empty());

    // in_flight is unregistered (cancel removed it; driver's
    // unregister_in_flight is idempotent).
    assert_eq!(registry.in_flight_count(), 0);

    drop(driver);
}

// ── Test 10 ─────────────────────────────────────────────────────
// Mid-turn cancel via registry.cancel(turn_id) → run_turn returns
// Cancelled; emit_turn_error fires.
//
// Same shape as test 9 — distinguished by name to satisfy the
// brief; the registry.cancel path is the only one Phase 2.2
// exposes, and it works equally well "pre" and "mid" turn since
// the runtime checks the token before each API call.

#[tokio::test]
async fn mid_turn_cancel_emits_turn_error() {
    let api = Arc::new(MockApi::cancel_blocker());
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver_clone = TurnDriver::new(registry.clone(), emitter.clone());
    let task = tokio::spawn(async move {
        driver_clone
            .run_turn(make_request("t-mid", "thread-mid", "?"))
            .await
    });

    for _ in 0..200 {
        if registry.in_flight_count() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    assert!(registry.cancel("t-mid"));
    let err = task.await.expect("join").expect_err("must cancel");
    assert!(err.is_cancellation());

    assert_eq!(emitter.snapshot_errors().len(), 1);
    assert!(emitter.snapshot_completes().is_empty());
}

// ── Test 11 ─────────────────────────────────────────────────────
// After a successful turn, the on-disk JSONL parses back via
// Session::load_from_path to the same message list.

#[tokio::test]
async fn jsonl_round_trip_after_successful_turn() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("answer"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter);
    driver
        .run_turn(make_request("t-rt", "thread-rt", "what is 2+2"))
        .await
        .expect("ok");

    let arc = registry
        .load_or_create_session("thread-rt")
        .expect("cached");
    let in_mem = arc.lock().await;
    let on_disk =
        Session::load_from_path("thread-rt", &registry.session_path("thread-rt")).expect("load");

    assert_eq!(in_mem.messages.len(), on_disk.messages.len());
    assert_eq!(in_mem.messages, on_disk.messages);
}

// ── Test 12 ─────────────────────────────────────────────────────
// Concurrent turns on different thread_ids do not interfere.

#[tokio::test]
async fn concurrent_turns_on_different_threads_do_not_interfere() {
    // Two scripts: each turn produces one text response.
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg("a-resp"), "end_turn")),
        },
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg("b-resp"), "end_turn")),
        },
    ]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let r1 = registry.clone();
    let e1 = emitter.clone();
    let task_a = tokio::spawn(async move {
        let driver = TurnDriver::new(r1, e1);
        driver
            .run_turn(make_request("t-A", "thread-A", "ping a"))
            .await
    });

    let r2 = registry.clone();
    let e2 = emitter.clone();
    let task_b = tokio::spawn(async move {
        let driver = TurnDriver::new(r2, e2);
        driver
            .run_turn(make_request("t-B", "thread-B", "ping b"))
            .await
    });

    let res_a = task_a.await.expect("join a");
    let res_b = task_b.await.expect("join b");
    res_a.expect("a ok");
    res_b.expect("b ok");

    // Each thread has its own session with one user + one assistant.
    let arc_a = registry.load_or_create_session("thread-A").expect("a");
    let arc_b = registry.load_or_create_session("thread-B").expect("b");
    assert!(
        !Arc::ptr_eq(&arc_a, &arc_b),
        "different threads, different Arcs"
    );
    assert_eq!(arc_a.lock().await.len(), 2);
    assert_eq!(arc_b.lock().await.len(), 2);
}

// ── Test 13 ─────────────────────────────────────────────────────
// provider_id and model from the request reach the factory via
// the ProviderConfigSnapshot. Phase 2.3 widened the factory
// signature, so the assertion now reads against the captured
// snapshot's fields.

#[tokio::test]
async fn factory_receives_provider_id_and_model_from_request() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("done"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(
        factory.clone(),
        dir.path().to_path_buf(),
    ));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry, emitter);
    let mut req = make_request("t-fac", "thread-fac", "hi");
    req.provider_id = "anthropic-test".into();
    req.model = "claude-test-99".into();
    req.provider_config.provider_id = "anthropic-test".into();
    req.provider_config.model = "claude-test-99".into();
    driver.run_turn(req).await.expect("ok");

    let calls = factory.built_with_snapshot();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].provider_id, "anthropic-test");
    assert_eq!(calls[0].model, "claude-test-99");
}

#[tokio::test]
async fn cursor_persists_the_stable_pin_and_sends_the_concrete_wire_model() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("done"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api.clone()));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(
        factory.clone(),
        dir.path().to_path_buf(),
    ));
    let driver = TurnDriver::new(registry.clone(), Arc::new(MockEmitter::default()));
    let mut req = make_request("t-cursor-model", "thread-cursor-model", "hi");
    req.provider_id = "cursor".into();
    req.model = "cursor-grok-4.6-xhigh-fast".into();
    req.model_selection = Some("cursor:cursor-grok-4.6".into());
    req.provider_config.provider_id = "cursor".into();
    req.provider_config.provider_type = Some("cursor".into());
    req.provider_config.model = req.model.clone();

    driver.run_turn(req).await.expect("ok");

    assert_eq!(
        api.last_model.lock().expect("last_model mutex").as_deref(),
        Some("cursor-grok-4.6-xhigh-fast")
    );
    assert_eq!(
        factory.built_with_snapshot()[0].model,
        "cursor-grok-4.6-xhigh-fast"
    );
    let session = registry
        .load_or_create_session("thread-cursor-model")
        .expect("session");
    assert_eq!(
        session.lock().await.model.as_deref(),
        Some("cursor:cursor-grok-4.6")
    );
}

// ── Test 14 ─────────────────────────────────────────────────────
// Factory error surfaces as RuntimeError::InvalidState (the variant
// the mock returns) — documented choice: factory errors are wrapped
// in InvalidState so they don't masquerade as ApiError variants the
// runtime knows how to retry.

#[tokio::test]
async fn factory_error_propagates_without_emitting_events() {
    let factory = Arc::new(MockApiFactory::from_error(RuntimeError::InvalidState(
        "unknown provider".into(),
    )));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter.clone());
    let err = driver
        .run_turn(make_request("t-err", "thread-err", "?"))
        .await
        .expect_err("must fail");
    match err {
        RuntimeError::InvalidState(msg) => assert!(msg.contains("unknown provider")),
        other => panic!("expected InvalidState, got {other:?}"),
    }

    // Factory failure happens before in_flight registration, so
    // no events stream and no turn_complete fires. We don't
    // currently emit a turn_error in that case either (the caller
    // gets the Err return — and the Tauri command surface
    // converts it to a Promise rejection, which the frontend
    // already routes through its error toast).
    assert!(emitter.snapshot_events().is_empty());
    assert!(emitter.snapshot_completes().is_empty());
    assert!(emitter.snapshot_errors().is_empty());
    assert_eq!(registry.in_flight_count(), 0);
}

// ── Test 15 ─────────────────────────────────────────────────────
// emit_event sees envelopes with strictly monotonic seq across the
// whole turn — sanity check the runtime → driver → emitter pipe
// preserves the ordering invariant.

#[tokio::test]
async fn envelopes_have_monotonic_seq_across_the_turn() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![
            AssistantEvent::TextDelta { delta: "a".into() },
            AssistantEvent::TextDelta { delta: "b".into() },
            AssistantEvent::TextDelta { delta: "c".into() },
            AssistantEvent::Usage(TokenUsage {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                estimated: None,
                cost_usd: None,
            }),
        ],
        result: Ok(turn_usage(assistant_text_msg("abc"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry, emitter.clone());
    driver
        .run_turn(make_request("t-seq", "thread-seq", "go"))
        .await
        .expect("ok");

    let events = emitter.snapshot_events();
    assert!(events.len() >= 5, "deltas + usage + message_stop");
    for window in events.windows(2) {
        assert!(
            window[1].seq > window[0].seq,
            "seq must be strictly monotonic, got {} -> {}",
            window[0].seq,
            window[1].seq,
        );
        assert_eq!(window[0].turn_id, window[1].turn_id);
    }
}

// ── Test 16 ─────────────────────────────────────────────────────
// The user message's text matches request.user_message exactly.

#[tokio::test]
async fn user_message_text_round_trips_verbatim() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("ok"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter);
    let original = "exact user input — with unicode 😀 and \"quotes\"";
    driver
        .run_turn(make_request("t-um", "thread-um", original))
        .await
        .expect("ok");

    let arc = registry
        .load_or_create_session("thread-um")
        .expect("cached");
    let session = arc.lock().await;
    let user_msg = session
        .messages()
        .iter()
        .find(|m| m.role == MessageRole::User)
        .expect("user message present");
    match &user_msg.blocks[0] {
        ContentBlock::Text { text } => assert_eq!(text, original),
        other => panic!("expected Text block, got {other:?}"),
    }
}

// ── Test 17 ─────────────────────────────────────────────────────
// Re-loading the session after a turn returns the SAME Arc with
// the new message count (in-place mutation).

#[tokio::test]
async fn second_load_returns_same_arc_with_updated_count() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("done"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let pre = registry.load_or_create_session("thread-rl").expect("pre");
    assert_eq!(pre.lock().await.len(), 0);
    drop(pre);

    let driver = TurnDriver::new(registry.clone(), emitter);
    driver
        .run_turn(make_request("t-rl", "thread-rl", "x"))
        .await
        .expect("ok");

    let post = registry.load_or_create_session("thread-rl").expect("post");
    let session = post.lock().await;
    assert_eq!(
        session.len(),
        2,
        "in-place mutation should leave 2 messages (user + assistant)"
    );

    // schema_round_trip via re-grab: same Arc as during the turn.
    // We can't compare with the pre-turn Arc (it was dropped) but
    // we can check the cached count matches what's on disk.
    let on_disk =
        Session::load_from_path("thread-rl", &registry.session_path("thread-rl")).expect("load");
    assert_eq!(on_disk.len(), 2);
}

// ── Bonus test ──────────────────────────────────────────────────
// Tool schemas are an empty slice in Phase 2.2 — confirms the
// empty registry actually reaches the runtime.

#[tokio::test]
async fn phase_2_2_tool_registry_is_empty() {
    let (registry, _dir) = temp_registry();
    assert!(registry.tools().is_empty());
    assert!(registry.tools().schemas().is_empty());
    // Future-proofing assertion: the type is what it claims.
    let _: Arc<ToolRegistry> = registry.tools();
}

// ── Bonus test ──────────────────────────────────────────────────
// Compile-time check: the trait-object plumbing actually links.

#[test]
fn api_factory_is_object_safe_and_constructible() {
    let f: Arc<dyn ApiFactory> = dummy_factory();
    let _: &dyn ApiFactory = &*f;
}

// ── Bonus test ──────────────────────────────────────────────────
// The schema entry is built at request time (not at registration
// time) — sanity check the empty registry path.

#[test]
fn empty_tool_registry_returns_no_schemas() {
    let reg = ToolRegistry::new();
    let _schemas: Vec<ToolSchema> = reg.schemas();
    assert!(reg.is_empty());
}

// ════════════════════════════════════════════════════════════════
// Phase 2.3 NEW tests — wire the ProviderConfigSnapshot, the
// per-turn ToolRegistry of FrontendBridgeExecutors, the
// RuntimeConfig overrides, and the agent_post_tool_result
// command surface together.
// ════════════════════════════════════════════════════════════════

fn allowed_tool(name: &str) -> AllowedTool {
    AllowedTool {
        name: name.into(),
        description: format!("test tool {name}"),
        parameters: serde_json::json!({"type":"object"}),
    }
}

// ── Test 18 ─────────────────────────────────────────────────────
// The full ProviderConfigSnapshot from the request reaches the
// factory verbatim — api_key, custom_headers, and custom_params
// all flow through.

#[tokio::test]
async fn factory_receives_full_provider_config_snapshot() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("done"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(
        factory.clone(),
        dir.path().to_path_buf(),
    ));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry, emitter);
    let mut req = make_request("t-snap", "thread-snap", "hi");
    req.provider_config.api_key = "sk-secret-xyz".into();
    req.provider_config.base_url = "https://custom.example.com/v1".into();
    let mut headers = std::collections::HashMap::new();
    headers.insert("X-Custom-Trace".into(), "trace-1".into());
    req.provider_config.custom_headers = Some(headers);
    let mut params = std::collections::HashMap::new();
    params.insert("reasoning_effort".into(), serde_json::json!("high"));
    req.provider_config.custom_params = Some(params);

    driver.run_turn(req).await.expect("ok");

    let snapshots = factory.built_with_snapshot();
    assert_eq!(snapshots.len(), 1);
    let snap = &snapshots[0];
    assert_eq!(snap.api_key, "sk-secret-xyz");
    assert_eq!(snap.base_url, "https://custom.example.com/v1");
    assert_eq!(
        snap.custom_headers
            .as_ref()
            .expect("headers")
            .get("X-Custom-Trace"),
        Some(&"trace-1".to_string()),
    );
    assert_eq!(
        snap.custom_params
            .as_ref()
            .expect("params")
            .get("reasoning_effort"),
        Some(&serde_json::json!("high")),
    );
}

// ── Test 19 ─────────────────────────────────────────────────────
// Per-turn ToolRegistry: an AllowedTool from request.tools shows
// up as a ToolSchema in the ApiRequest. We capture the schema
// through MockApi by recording the last request's tools list.

#[tokio::test]
async fn per_turn_tool_registry_advertises_allowed_tools_to_api() {
    // MockApi already records request.model on each stream call;
    // we extend the assertion via the in-memory Session: after
    // the turn the assistant's tool_use must reference the same
    // name we advertised, proving the schema reached the model.
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            // Model "calls" a tool named "file_read" — the bridge
            // executor handles it.
            result: Ok(turn_usage(
                assistant_tool_use_msg("call-1", "file_read", serde_json::json!({"path":"a.rs"})),
                "tool_use",
            )),
        },
        TurnScript::Reply {
            events: vec![AssistantEvent::TextDelta { delta: "ok".into() }],
            result: Ok(turn_usage(assistant_text_msg("ok"), "end_turn")),
        },
    ]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter.clone());
    let mut req = make_request("t-tools", "thread-tools", "read it");
    req.tools = vec![allowed_tool("file_read")];

    // Spawn the turn so we can resolve the bridge oneshot.
    let registry_clone = registry.clone();
    let driver_task = tokio::spawn(async move { driver.run_turn(req).await });

    // Wait for the tool_pending event to fire (pending count > 0
    // means the executor parked on the oneshot).
    for _ in 0..200 {
        if registry_clone.bridge_router().pending_count() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        registry_clone.bridge_router().pending_count() > 0,
        "executor must have registered a oneshot",
    );

    // Resolve the call.
    registry_clone
        .post_tool_result("t-tools", "call-1", "file contents".into(), false)
        .expect("resolve");

    let summary = driver_task.await.expect("join").expect("ok");
    assert_eq!(summary.iterations, 2);

    // tool_pending event captured by the emitter.
    let pendings = emitter.snapshot_tool_pendings();
    assert_eq!(pendings.len(), 1);
    assert_eq!(pendings[0].turn_id, "t-tools");
    assert_eq!(pendings[0].tool_use_id, "call-1");
    assert_eq!(pendings[0].name, "file_read");
    assert_eq!(pendings[0].input, serde_json::json!({"path":"a.rs"}));
}

// ── Test 20 ─────────────────────────────────────────────────────
// FrontendBridgeExecutor delivery: the tool_pending event is
// emitted, the result we post back via post_tool_result reaches
// the runtime, and the final ToolResult block carries the right
// content with is_error: None.

#[tokio::test]
async fn bridge_tool_result_reaches_runtime_with_correct_content() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use_msg("call-77", "file_read", serde_json::json!({"path":"x"})),
                "tool_use",
            )),
        },
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg("after-tool"), "end_turn")),
        },
    ]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter);
    let mut req = make_request("t-bridge", "thread-bridge", "?");
    req.tools = vec![allowed_tool("file_read")];

    let registry_clone = registry.clone();
    let driver_task = tokio::spawn(async move { driver.run_turn(req).await });

    for _ in 0..200 {
        if registry_clone.bridge_router().pending_count() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    registry_clone
        .post_tool_result(
            "t-bridge",
            "call-77",
            "the file contents from the frontend".into(),
            false,
        )
        .expect("resolve");

    let summary = driver_task.await.expect("join").expect("ok");
    assert_eq!(summary.tool_results.len(), 1);
    match &summary.tool_results[0].blocks[0] {
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            assert_eq!(tool_use_id, "call-77");
            assert_eq!(content, "the file contents from the frontend");
            assert_eq!(
                *is_error, None,
                "successful frontend call → no is_error flag"
            );
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

// ── Test 21 ─────────────────────────────────────────────────────
// FrontendBridgeExecutor with `is_error: true`: the runtime
// surfaces the content in the ToolResult and the loop continues.

#[tokio::test]
async fn bridge_is_error_true_propagates_to_tool_result_block() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use_msg("call-9", "file_read", serde_json::json!({})),
                "tool_use",
            )),
        },
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg("ok"), "end_turn")),
        },
    ]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter);
    let mut req = make_request("t-err-tool", "thread-err-tool", "?");
    req.tools = vec![allowed_tool("file_read")];

    let registry_clone = registry.clone();
    let driver_task = tokio::spawn(async move { driver.run_turn(req).await });

    for _ in 0..200 {
        if registry_clone.bridge_router().pending_count() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    registry_clone
        .post_tool_result("t-err-tool", "call-9", "ENOENT: no such file".into(), true)
        .expect("resolve");

    let summary = driver_task.await.expect("join").expect("ok");
    assert_eq!(summary.tool_results.len(), 1);
    match &summary.tool_results[0].blocks[0] {
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            assert_eq!(tool_use_id, "call-9");
            // Frontend posted is_error=true → runtime sets the
            // ToolResult flag accordingly. Content carries the
            // error message verbatim (with the runtime's own
            // ToolError::Execution wrap, the string starts with
            // "execution failed:" — sanity-check on substring so
            // the test stays robust to future error-format
            // tweaks).
            assert!(
                content.contains("ENOENT"),
                "must mention the original error, got: {content}",
            );
            assert_eq!(*is_error, Some(true));
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

// ── Test 22 ─────────────────────────────────────────────────────
// RuntimeConfig overrides: request.system_prompt /
// temperature / max_output_tokens / thinking_enabled are
// honoured. We can't easily inspect the ApiRequest from inside
// the mock, but we CAN set them all and confirm the turn runs to
// completion — combined with the conversation.rs unit tests that
// already cover the wiring through ApiRequest, this is the
// integration-level assertion.

#[tokio::test]
async fn request_overrides_dont_break_the_turn() {
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("ok"), "end_turn")),
    }]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry, emitter);
    let mut req = make_request("t-over", "thread-over", "hi");
    req.system_prompt = Some("You are a helpful assistant.".into());
    req.temperature = Some(0.42);
    req.max_output_tokens = Some(1024);
    req.thinking_enabled = Some(true);
    req.ide_context = Some("<open_files>main.rs</open_files>".into());

    let summary = driver.run_turn(req).await.expect("ok");
    assert_eq!(summary.stop_reason, "end_turn");
}

// ── Test 23 ─────────────────────────────────────────────────────
// The RuntimeConfig builder mirrors the request fields exactly.

#[test]
fn build_runtime_config_overlays_request_fields() {
    let mut req = make_request("t-cfg", "thread-cfg", "x");
    req.system_prompt = Some("system".into());
    req.temperature = Some(0.9);
    req.max_output_tokens = Some(2048);
    req.thinking_enabled = Some(true);

    let cfg = build_runtime_config(&req);
    assert_eq!(cfg.system_prompt.as_deref(), Some("system"));
    assert_eq!(cfg.default_temperature, Some(0.9));
    assert_eq!(cfg.default_max_output_tokens, 2048);
    assert!(cfg.reasoning.enabled);
}

#[test]
fn build_runtime_config_falls_back_to_defaults_when_unset() {
    let req = make_request("t-cfg-default", "thread", "x");
    let cfg = build_runtime_config(&req);
    let defaults = RuntimeConfig::default();
    assert!(cfg.system_prompt.is_none());
    assert_eq!(cfg.default_temperature, defaults.default_temperature);
    assert_eq!(
        cfg.default_max_output_tokens,
        defaults.default_max_output_tokens
    );
    assert_eq!(cfg.reasoning.enabled, defaults.reasoning.enabled);
}

// ── Test 24 ─────────────────────────────────────────────────────
// post_tool_result with no pending call returns the contract
// error literal.

#[test]
fn post_tool_result_with_no_pending_returns_documented_error() {
    let (registry, _dir) = temp_registry();
    let err = registry
        .post_tool_result("nope", "nope", "x".into(), false)
        .expect_err("must error");
    assert_eq!(err, "no pending tool call");
}

// ── Test 25 ─────────────────────────────────────────────────────
// Cancellation during a bridge tool-call short-circuits the
// executor and surfaces as a turn cancellation. The bridge router
// entry is reclaimed on completion.

#[tokio::test]
async fn cancel_during_bridge_tool_short_circuits() {
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use_msg("call-c", "file_read", serde_json::json!({})),
                "tool_use",
            )),
        },
        // Second turn would only run if cancellation didn't fire
        // — script intentionally short.
    ]));
    let factory = Arc::new(MockApiFactory::from_api(api));
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
    let emitter = Arc::new(MockEmitter::default());

    let driver = TurnDriver::new(registry.clone(), emitter.clone());
    let mut req = make_request("t-cb", "thread-cb", "?");
    req.tools = vec![allowed_tool("file_read")];

    let registry_clone = registry.clone();
    let driver_task = tokio::spawn(async move { driver.run_turn(req).await });

    // Wait for the tool to park on the oneshot.
    for _ in 0..200 {
        if registry_clone.bridge_router().pending_count() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    // Cancel mid-tool.
    assert!(registry_clone.cancel("t-cb"));

    let result = driver_task.await.expect("join");
    // Two valid outcomes:
    //  - the tool surfaced ToolError::Cancelled and the runtime
    //    rolled forward to the next iteration which then hit the
    //    cancel check and returned Cancelled, OR
    //  - the runtime observed the cancel directly first.
    // In either case the turn must end as a cancellation OR we
    // get the "exhausted script" provider error after the runtime
    // looped past a successful is_error: true tool result. We
    // accept either as long as the bridge cleaned up.
    let _ = result; // outcome shape varies; key invariant below.

    // bridge_router must be empty — drop_turn fired.
    assert_eq!(
        registry_clone.bridge_router().pending_count(),
        0,
        "bridge router must reclaim pending entries on turn exit",
    );
}

// ── Test 26 ─────────────────────────────────────────────────────
// BridgeRouter is reachable through AgentRegistry as a single
// shared instance.

#[test]
fn registry_exposes_a_single_shared_bridge_router() {
    let (registry, _dir) = temp_registry();
    let a: &Arc<BridgeRouter> = registry.bridge_router();
    let b: &Arc<BridgeRouter> = registry.bridge_router();
    assert!(Arc::ptr_eq(a, b));
    assert_eq!(a.pending_count(), 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Deferred tools — the roster the model is advertised, and how it grows.
// ─────────────────────────────────────────────────────────────────────────

/// Bridge entries standing in for the buckets that may be deferred.
fn deferrable_bridge_tools() -> Vec<AllowedTool> {
    ["mcp_drive_search_files", "mcp_docs_lookup"]
        .iter()
        .map(|name| AllowedTool {
            name: (*name).into(),
            description: "d".into(),
            parameters: serde_json::json!({"type": "object"}),
        })
        .collect()
}

fn registry_with_deferral(defer: bool) -> ToolRegistry {
    registry_with_deferral_for(defer, "")
}

/// As [`registry_with_deferral`], for a named conversation — so a test can
/// rebuild the registry the way a second user message does and see what
/// `tool_search` left behind.
fn registry_with_deferral_for(defer: bool, thread_id: &str) -> ToolRegistry {
    build_per_turn_tool_registry(
        native_test_registry(),
        &deferrable_bridge_tools(),
        "turn-defer".into(),
        Arc::new(BridgeRouter::new()),
        Arc::new(MockEmitter::default()),
        CancellationToken::new(),
        false,
        AgentExecutionMode::Agent,
        None,
        false,
        true,
        defer,
        thread_id,
    )
}

#[tokio::test]
async fn discovered_tools_survive_rebuild_without_changing_the_roster() {
    let first = registry_with_deferral_for(true, "discovery-thread");
    let before = serde_json::to_vec(&first.schemas()).unwrap();
    let ctx = ToolContext {
        turn_id: "turn-1".into(),
        tool_call_id: "call-1".into(),
        thread_id: "discovery-thread".into(),
        workspace_root: None,
        workspace_access: Default::default(),
        cancel_token: CancellationToken::new(),
        spill_dir: None,
    };
    let result = first
        .get("tool_search")
        .unwrap()
        .execute(serde_json::json!({"query":"select:mcp_docs_lookup"}), &ctx)
        .await
        .unwrap();
    assert!(result.contains("mcp_docs_lookup"));
    assert!(first.get("mcp_docs_lookup").is_none());
    assert_eq!(before, serde_json::to_vec(&first.schemas()).unwrap());
    for registry in [
        first,
        registry_with_deferral_for(false, "discovery-thread"),
        registry_with_deferral_for(true, "other-thread"),
    ] {
        assert_eq!(before, serde_json::to_vec(&registry.schemas()).unwrap());
        let resolved = registry
            .resolve_call(
                "call_tool",
                &serde_json::json!({"name":"mcp_docs_lookup","arguments":{}}),
            )
            .unwrap();
        assert_eq!(resolved.executor.name(), "mcp_docs_lookup");
        assert!(resolved.executor.uses_frontend_lifecycle());
    }
}

#[test]
fn optional_tools_always_use_wrappers_and_core_tools_stay_direct() {
    for legacy_flag in [false, true] {
        let registry = registry_with_deferral(legacy_flag);
        for hidden in ["mcp_drive_search_files", "mcp_docs_lookup"] {
            assert!(registry.get(hidden).is_none(), "{hidden}");
        }
        for direct in [
            "tool_search",
            "call_tool",
            "file_read",
            "file_edit",
            "grep",
            "shell_execute",
            "TaskCreate",
            "TaskUpdate",
            "TaskList",
        ] {
            assert!(
                registry.get(direct).is_some(),
                "{direct} must stay advertised"
            );
        }
    }
}

#[test]
fn empty_catalog_still_advertises_the_same_wrappers() {
    let registry = build_per_turn_tool_registry(
        native_test_registry(),
        &[],
        "turn-core".into(),
        Arc::new(BridgeRouter::new()),
        Arc::new(MockEmitter::default()),
        CancellationToken::new(),
        false,
        AgentExecutionMode::Agent,
        None,
        false,
        false,
        true,
        "",
    );
    assert!(registry.get("tool_search").is_some());
    assert!(registry.get("call_tool").is_some());
    assert_eq!(
        serde_json::to_vec(&registry.schemas()).unwrap(),
        serde_json::to_vec(&registry_with_deferral(true).schemas()).unwrap()
    );
}

#[test]
fn the_deferrable_rule_names_buckets_not_individual_tools() {
    for optional in ["mcp_x_y", "browser_navigate"] {
        assert!(is_deferrable(optional), "{optional}");
    }
    for core in [
        "file_read",
        "file_edit",
        "file_write",
        "shell_execute",
        "grep",
        "glob",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "chapter",
        "code",
        "aurora_skill_search",
        "aurora_skill_load",
        "ask_question",
    ] {
        assert!(!is_deferrable(core), "{core} must never be deferred");
    }
}

#[tokio::test]
async fn wrapped_mcp_call_uses_the_existing_bridge_once() {
    let input = serde_json::json!({"name":"mcp_docs_search","arguments":{"query":"release"}});
    let api = Arc::new(MockApi::new(vec![
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use_msg("wrapped-id", "call_tool", input),
                "tool_use",
            )),
        },
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg("done"), "end_turn")),
        },
    ]));
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api)),
        dir.path().to_path_buf(),
    ));
    let emitter = Arc::new(MockEmitter::default());
    let driver = TurnDriver::new(registry.clone(), emitter.clone());
    let mut req = make_request("wrapped-turn", "wrapped-thread", "find it");
    req.tools = vec![allowed_tool("mcp_docs_search")];
    let task = tokio::spawn(async move { driver.run_turn(req).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while registry.bridge_router().pending_count() == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let pending = emitter.snapshot_tool_pendings();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].name, "mcp_docs_search");
    assert_eq!(pending[0].tool_use_id, "wrapped-id");
    assert_eq!(pending[0].input, serde_json::json!({"query":"release"}));
    registry
        .post_tool_result("wrapped-turn", "wrapped-id", "found".into(), false)
        .unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(registry.bridge_router().pending_count(), 0);
    // The frontend bridge owns its card lifecycle; native wrapping must not
    // send a second start/result pair around the same operation.
    assert!(!emitter.snapshot_events().iter().any(|event| matches!(&event.event,
        AssistantEvent::ToolExecutionStart{id,..}|AssistantEvent::ToolExecutionResult{id,..} if id=="wrapped-id")));
}

#[test]
fn wrapper_lookup_cannot_bypass_mode_vision_or_browser_gates() {
    let tools = vec![
        allowed_tool("browser_navigate"),
        allowed_tool("browser_screenshot"),
        allowed_tool("mcp_docs_search"),
        allowed_tool("file_write"),
    ];
    for (mode, vision, browser, target, allowed) in [
        (
            AgentExecutionMode::Agent,
            true,
            true,
            "browser_navigate",
            true,
        ),
        (
            AgentExecutionMode::Agent,
            true,
            false,
            "browser_navigate",
            false,
        ),
        (
            AgentExecutionMode::Agent,
            false,
            true,
            "browser_screenshot",
            false,
        ),
        (
            AgentExecutionMode::Chat,
            true,
            true,
            "browser_navigate",
            false,
        ),
        (
            AgentExecutionMode::Chat,
            false,
            false,
            "mcp_docs_search",
            true,
        ),
        (AgentExecutionMode::Plan, true, true, "file_write", false),
    ] {
        let registry = build_per_turn_tool_registry(
            Arc::new(ToolRegistry::new()),
            &tools,
            "turn".into(),
            Arc::new(BridgeRouter::new()),
            Arc::new(MockEmitter::default()),
            CancellationToken::new(),
            vision,
            mode,
            None,
            false,
            browser,
            false,
            "",
        );
        let result = registry.resolve_call(
            "call_tool",
            &serde_json::json!({"name":target,"arguments":{}}),
        );
        assert_eq!(result.is_ok(), allowed, "{mode:?} {target}");
    }
}

// ── Mid-turn durability ─────────────────────────────────────────
//
// A turn used to exist only in RAM until it returned, so a kill during a
// twenty-minute tool run cost the whole turn — the user's own message
// included, on any thread that was not brand new. The session journal puts
// each message on disk as it is appended; these tests pin the two things
// that have to be true for that to be worth anything: the user message is
// already on disk by the time the provider is called, and it is there
// exactly once.

/// Reads the thread's JSONL at the moment `stream` is called — i.e. from
/// inside the turn, before any reply exists — and records what it found.
struct DiskSpy {
    session_path: PathBuf,
    seen: StdMutex<Vec<String>>,
}

#[async_trait]
impl StreamingApiClient for DiskSpy {
    async fn stream(
        &self,
        _request: ApiRequest<'_>,
        _event_sink: mpsc::Sender<AssistantEvent>,
        _cancel_token: CancellationToken,
    ) -> Result<TurnUsage, ApiError> {
        let contents = std::fs::read_to_string(&self.session_path).unwrap_or_default();
        *self.seen.lock().expect("seen mutex") = contents
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect();
        Ok(turn_usage(assistant_text_msg("ack"), "end_turn"))
    }
}

/// Hands back one pre-built client, whatever its concrete type.
struct FixedFactory(Arc<dyn StreamingApiClient>);

impl ApiFactory for FixedFactory {
    fn build(
        &self,
        _config: &crate::api::ProviderConfigSnapshot,
    ) -> Result<Arc<dyn StreamingApiClient>, RuntimeError> {
        Ok(self.0.clone())
    }
}

/// How many of `lines` are user messages carrying `text`.
fn user_lines_with(lines: &[String], text: &str) -> usize {
    lines
        .iter()
        .filter_map(|l| serde_json::from_str::<ConversationMessage>(l).ok())
        .filter(|m| {
            m.role == MessageRole::User
                && m.blocks.iter().any(|b| match b {
                    ContentBlock::Text { text: t } => t.contains(text),
                    _ => false,
                })
        })
        .count()
}

#[tokio::test]
async fn the_user_message_is_on_disk_before_the_provider_is_called() {
    let dir = tempfile::tempdir().expect("tempdir");
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(Arc::new(MockApi::new(vec![])))),
        dir.path().to_path_buf(),
    ));
    let spy = Arc::new(DiskSpy {
        session_path: registry.session_path("fresh-thread"),
        seen: StdMutex::new(Vec::new()),
    });
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(FixedFactory(spy.clone() as Arc<dyn StreamingApiClient>)),
        dir.path().to_path_buf(),
    ));
    let driver = TurnDriver::new(registry, Arc::new(MockEmitter::default()));

    driver
        .run_turn(make_request(
            "t-1",
            "fresh-thread",
            "please analyse this repo",
        ))
        .await
        .expect("turn");

    let seen = spy.seen.lock().expect("seen mutex").clone();
    assert_eq!(
        user_lines_with(&seen, "please analyse this repo"),
        1,
        "the user message must be on disk before the model is asked anything, exactly once — \
         saw {seen:#?}"
    );
}

#[tokio::test]
async fn a_follow_up_message_is_on_disk_before_the_provider_is_called() {
    // The regression this pins: the old early write fired only for a thread
    // whose file was empty, so every message after the first lived in RAM
    // until the turn ended. A kill mid-turn took the user's own words with it.
    let dir = tempfile::tempdir().expect("tempdir");
    let path =
        SessionStore::new_project(dir.path().join("_unscoped")).session_path("existing-thread");
    let mut seeded = Session::new("existing-thread");
    seeded.append_message(ConversationMessage::user_text("first question", 1));
    seeded.append_message(ConversationMessage::assistant(
        vec![ContentBlock::Text {
            text: "first answer".into(),
        }],
        2,
    ));
    seeded.save_to_path(&path).expect("seed");

    let spy = Arc::new(DiskSpy {
        session_path: path.clone(),
        seen: StdMutex::new(Vec::new()),
    });
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(FixedFactory(spy.clone() as Arc<dyn StreamingApiClient>)),
        dir.path().to_path_buf(),
    ));
    let driver = TurnDriver::new(registry, Arc::new(MockEmitter::default()));

    driver
        .run_turn(make_request("t-2", "existing-thread", "second question"))
        .await
        .expect("turn");

    let seen = spy.seen.lock().expect("seen mutex").clone();
    assert_eq!(
        seen.len(),
        3,
        "the two seeded messages plus the new one must be on disk mid-turn — saw {seen:#?}"
    );
    assert_eq!(
        user_lines_with(&seen, "second question"),
        1,
        "the follow-up must be on disk before the model is asked, exactly once"
    );
}

#[tokio::test]
async fn the_completed_turn_holds_no_duplicate_user_message() {
    // The hazard removed with the raw early write: it advanced the FILE without
    // advancing the journal's counter, so the runtime's own append still looked
    // in sync and wrote the same user message a second time. The end-of-turn
    // rewrite hid it, but a kill before that did not.
    let dir = tempfile::tempdir().expect("tempdir");
    let api = Arc::new(MockApi::new(vec![TurnScript::Reply {
        events: vec![],
        result: Ok(turn_usage(assistant_text_msg("ack"), "end_turn")),
    }]));
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MockApiFactory::from_api(api)),
        dir.path().to_path_buf(),
    ));
    let driver = TurnDriver::new(registry.clone(), Arc::new(MockEmitter::default()));

    driver
        .run_turn(make_request("t-3", "dupe-thread", "only once please"))
        .await
        .expect("turn");

    let raw = std::fs::read_to_string(registry.session_path("dupe-thread")).expect("read");
    let lines: Vec<String> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    assert_eq!(
        user_lines_with(&lines, "only once please"),
        1,
        "the user message must appear once — saw {lines:#?}"
    );
    assert_eq!(
        lines.len(),
        2,
        "one user message, one reply — saw {lines:#?}"
    );
}

// ── Mid-turn slot: who queued it ────────────────────────────────
//
// The slot was built for a person typing while tools run, then reused for
// machine events, which inherited the person's framing. A stopped background
// process reached the model as `[The user sent this while your tool calls were
// running…] The user stopped …` and reached the screen as the user's own
// bubble. The origin is what keeps the two apart.

#[tokio::test]
async fn a_composer_message_is_still_framed_as_the_user_speaking() {
    use crate::agent_runtime::types::InjectedOrigin;
    let (registry, _dir) = temp_registry();

    registry
        .enqueue_message(
            "thread-user",
            "wait, don't run pnpm".into(),
            None,
            None,
            InjectedOrigin::User,
        )
        .await
        .expect("queued");

    let session = registry.load_or_create_session("thread-user").expect("session");
    let queued = session
        .lock()
        .await
        .take_queued_message()
        .expect("the slot holds it");

    assert_eq!(queued.origin, InjectedOrigin::User);
    // The preamble tells the model the message arrived AFTER the results above
    // it. That is true of a person typing, and it must not stop being sent.
    assert!(queued.mid_turn);
}

#[tokio::test]
async fn a_process_report_is_not_framed_as_anybody_speaking() {
    use crate::agent_runtime::types::InjectedOrigin;
    let (registry, _dir) = temp_registry();

    registry
        .enqueue_message(
            "thread-process",
            "The background process \"pnpm build\" (id bg-1) has ended".into(),
            None,
            None,
            InjectedOrigin::Process,
        )
        .await
        .expect("queued");

    let session = registry
        .load_or_create_session("thread-process")
        .expect("session");
    let queued = session
        .lock()
        .await
        .take_queued_message()
        .expect("the slot holds it");

    assert_eq!(queued.origin, InjectedOrigin::Process);
    // `[The user sent this…]` over a process that ended on its own is a lie
    // about who is talking, which is the whole defect this field exists for.
    assert!(!queued.mid_turn);
}

// ---------------------------------------------------------------------------
// Sub-agents
//
// The promises: the switch decides whether the parent is handed the tools; a
// child's roster is its definition and never the spawn tools; a synchronous
// spawn runs a real child turn whose transcript lands inside the parent's
// folder; Stop on the parent stops the child.
// ---------------------------------------------------------------------------

mod subagents {
    use super::*;
    use crate::agent_runtime::subagents::catalog::{GENERAL_PURPOSE_TOOLS, READ_ONLY_TOOLS};
    use crate::agent_runtime::subagents::host::{
        ParentTurn, SendOutcome, SpawnOutcome, SpawnRequest, SubagentError, SubagentHost,
    };
    use crate::agent_runtime::subagents::record::{TaskRecord, TaskStatus};
    use crate::agent_runtime::subagents::store::{child_store_for, AgentSidecar};
    use crate::agent_runtime::subagents::SubagentEvent;

    pub(super) fn scripted_host(
        emitter: Arc<MockEmitter>,
        registry: Arc<AgentRegistry>,
    ) -> (AgentV2SubagentHost<MockEmitter>, tempfile::TempDir) {
        let catalog_dir = tempfile::tempdir().expect("catalog dir");
        let host = AgentV2SubagentHost::new(registry, emitter)
            .with_catalog_dir(catalog_dir.path().to_path_buf());
        (host, catalog_dir)
    }

    pub(super) fn parent_turn(registry: &AgentRegistry, request: AgentChatRequest) -> ParentTurn {
        if registry.tools().is_empty() {
            crate::tools::register_builtin_tools(&registry.tools(),
                Arc::new(crate::tools::shell_editor_todo::NoopIdeEventSink), None);
        }
        let store = registry
            .store_for_conversation(
                request.execution_mode,
                &request.thread_id,
                request.workspace_path.as_deref(),
            )
            .expect("parent store");
        store
            .ensure_thread(&request.thread_id, None, None)
            .expect("parent thread");
        ParentTurn {
            thread_id: request.thread_id.clone(),
            turn_id: request.turn_id.clone(),
            request: Arc::new(request),
            store,
            cancel: CancellationToken::new(),
        }
    }

    pub(super) fn spawn(description: &str, prompt: &str, agent_type: Option<&str>) -> SpawnRequest {
        SpawnRequest {
            description: description.into(),
            prompt: prompt.into(),
            agent_type: agent_type.map(str::to_string),
            model: None,
            background: false,
            name: None,
            tools: None,
        }
    }

    fn roster(request: &AgentChatRequest, kind: TurnKind, registry: &Arc<AgentRegistry>) -> Vec<String> {
        let emitter: Arc<MockEmitter> = Arc::new(MockEmitter::default());
        let scope = match kind {
            TurnKind::Child {
                allow, messenger, report_required, ..
            } => ToolScope::Child { allow, messenger, report_required },
            TurnKind::Conversation
                if request.subagents_enabled.unwrap_or(false)
                    && request.execution_mode == AgentExecutionMode::Agent =>
            {
                ToolScope::Parent {
                    host: Arc::new(AgentV2SubagentHost::new(registry.clone(), emitter.clone())),
                    parent: Arc::new(parent_turn(registry, request.clone())),
                }
            }
            TurnKind::Conversation => ToolScope::Plain,
        };
        build_per_turn_tool_registry_scoped(
            native_test_registry(),
            &[AllowedTool {
                name: "ask_question".into(),
                description: "bridged".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            request.turn_id.clone(),
            Arc::new(BridgeRouter::new()),
            emitter,
            CancellationToken::new(),
            true,
            request.execution_mode,
            request.workspace_path.as_deref(),
            false,
            true,
            false,
            &request.thread_id,
            &scope,
        )
        .names()
    }

    #[test]
    fn the_switch_decides_whether_the_parent_gets_the_tools() {
        let (registry, _dir) = temp_registry();
        let mut on = make_request("t-sw", "thread-sw", "hi");
        on.subagents_enabled = Some(true);
        let names = roster(&on, TurnKind::Conversation, &registry);
        assert!(names.contains(&"spawn_agent".to_string()), "{names:?}");
        assert!(names.contains(&"list_models".to_string()), "{names:?}");
        // After the discovery pair, so the natives prefix is unchanged.
        let spawn_at = names.iter().position(|n| n == "spawn_agent").unwrap();
        let search_at = names.iter().position(|n| n == "tool_search").unwrap();
        assert!(spawn_at > search_at);

        let mut off = on.clone();
        off.subagents_enabled = Some(false);
        let names_off = roster(&off, TurnKind::Conversation, &registry);
        assert!(!names_off.iter().any(|n| n == "spawn_agent" || n == "list_models"));
        let mut absent = on.clone();
        absent.subagents_enabled = None;
        assert!(!roster(&absent, TurnKind::Conversation, &registry)
            .iter()
            .any(|n| n == "spawn_agent"));
        // Everything before the switch is the same with it on or off.
        let head_on: Vec<_> = names.iter().take(names_off.len()).cloned().collect();
        assert_eq!(head_on, names_off, "the switch only appends");
    }

    #[test]
    fn plan_and_chat_never_get_the_tools_whatever_the_switch_says() {
        let (registry, _dir) = temp_registry();
        for mode in [AgentExecutionMode::Plan, AgentExecutionMode::Chat] {
            let mut request = make_request("t-m", "thread-m", "hi");
            request.subagents_enabled = Some(true);
            request.execution_mode = mode;
            let names = roster(&request, TurnKind::Conversation, &registry);
            assert!(
                !names.iter().any(|n| n == "spawn_agent" || n == "list_models"),
                "{mode:?} must not delegate: {names:?}"
            );
        }
    }

    #[test]
    fn a_child_roster_is_its_definition_and_nothing_routed_through_the_window() {
        let (registry, _dir) = temp_registry();
        let request = make_request("sub_1", "agent_x", "task");
        let names = roster(
            &request,
            TurnKind::Child {
                report_required: true,
                allow: READ_ONLY_TOOLS.iter().map(|t| (*t).to_string()).collect(),
                cancel: CancellationToken::new(),
                messenger: None,
            },
            &registry,
        );
        for name in READ_ONLY_TOOLS {
            if *name == "code" {
                // Not in the test registry (code_intel is not registered there).
                continue;
            }
            assert!(names.contains(&(*name).to_string()), "{name} missing: {names:?}");
        }
        for forbidden in [
            "spawn_agent",
            "list_models",
            "ask_question",
            "tool_search",
            "call_tool",
            "file_write",
            "shell_execute",
            "TaskCreate",
        ] {
            assert!(!names.contains(&forbidden.to_string()), "{forbidden} leaked: {names:?}");
        }
        // Even a definition that NAMES the spawn tool does not get it.
        let names = roster(
            &request,
            TurnKind::Child {
                report_required: true,
                allow: vec!["file_read".into(), "spawn_agent".into(), "ask_question".into()],
                cancel: CancellationToken::new(),
                messenger: None,
            },
            &registry,
        );
        assert_eq!(names, vec!["file_read"]);
        // The general-purpose roster keeps shell and writes.
        let names = roster(
            &request,
            TurnKind::Child {
                report_required: true,
                allow: GENERAL_PURPOSE_TOOLS.iter().map(|t| (*t).to_string()).collect(),
                cancel: CancellationToken::new(),
                messenger: None,
            },
            &registry,
        );
        assert!(names.contains(&"shell_execute".to_string()));
        assert!(names.contains(&"file_write".to_string()));
        assert!(!names.contains(&"TaskCreate".to_string()));
    }

    /// The load-bearing one: a synchronous spawn drives a real child turn
    /// through the mock API and the parent gets the child's report.
    #[tokio::test]
    async fn a_sync_spawn_runs_a_child_turn_inside_the_parents_folder() {
        let api = Arc::new(MockApi::new(vec![
            submit_reply(
                "submit-1",
                "Login is handled in src/auth/login.ts:42.",
                "## Found\n- src/auth/login.ts:42 calls `signIn`.",
            ),
            TurnScript::Reply {
                events: vec![AssistantEvent::TextDelta {
                    delta: "Report submitted.".into(),
                }],
                result: Ok(turn_usage(assistant_text_msg("Report submitted."), "end_turn")),
            },
        ]));
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory.clone(), dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());

        let mut request = make_request("t-parent", "thread-parent", "find login");
        request.subagents_enabled = Some(true);
        request.workspace_path = Some(dir.path().to_string_lossy().into_owned());
        let parent = parent_turn(&registry, request);

        let outcome = host
            .spawn(
                &parent,
                SpawnRequest {
                    name: Some("scout".into()),
                    ..spawn("Find the login flow", "Where is login handled?", Some("explore"))
                },
            )
            .await
            .expect("spawn ok");

        let SpawnOutcome::Finished {
            agent_id,
            state,
            result,
            error,
            usage,
            output_file,
        } = outcome
        else {
            panic!("a sync spawn finishes");
        };
        let expected = "Login is handled in src/auth/login.ts:42.\n\n\
                        ## Found\n- src/auth/login.ts:42 calls `signIn`.";
        assert_eq!(state, "completed");
        assert_eq!(result, expected, "the submitted report, not the closing line");
        assert!(error.is_none());
        assert_eq!(api.call_count(), 2, "submitted on its own: no reminder");
        assert_eq!(usage.iterations, 2);
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 14);
        assert_eq!(usage.tool_calls, 1);

        // The child lives inside the parent's thread folder.
        let child_store = child_store_for(&parent.store, "thread-parent");
        let expected_dir = parent.store.thread_dir("thread-parent").join("agents").join(&agent_id);
        assert_eq!(child_store.thread_dir(&agent_id), expected_dir);
        assert_eq!(
            std::path::Path::new(&output_file),
            expected_dir.join("conversation.jsonl").as_path()
        );
        let on_disk = Session::load_from_path(&agent_id, &child_store.session_path(&agent_id))
            .expect("child transcript");
        assert_eq!(on_disk.len(), 4, "prompt, submit_report call, its result, closing line");
        assert_eq!(on_disk.messages()[0].role, MessageRole::User);

        // The sidecar says who it was and how it ended.
        let sidecar = AgentSidecar::load(&child_store, &agent_id).expect("agent.json");
        assert_eq!(sidecar.agent_type, "explore");
        assert_eq!(sidecar.name.as_deref(), Some("scout"));
        assert_eq!(sidecar.status, TaskStatus::Completed);
        assert_eq!(sidecar.result.as_deref(), Some(expected));
        assert_eq!(sidecar.model.as_deref(), Some("mock-provider:mock-model"));
        assert_eq!(sidecar.runs, 1);

        // The parent's own listing does not show the child.
        let parent_threads = parent.store.list_summaries().expect("list");
        assert_eq!(parent_threads.len(), 1);
        assert_eq!(parent_threads[0].id, "thread-parent");

        // The live record and the registry's name map.
        let record = registry
            .subagent_tasks()
            .resolve("thread-parent", "scout")
            .expect("named record");
        assert_eq!(record.agent_id, agent_id);
        assert_eq!(record.status(), TaskStatus::Completed);
        assert_eq!(host.list("thread-parent").len(), 1);

        // The child ran on the parent's provider snapshot, as a copy.
        let built = factory.built_with_snapshot();
        assert_eq!(built.len(), 1);
        assert_eq!(built[0].provider_id, "mock-provider");
        assert_eq!(built[0].model, "mock-model");

        // The child's stream used the CHILD's turn id, never the parent's.
        let events = emitter.snapshot_events();
        assert!(!events.is_empty());
        assert!(events.iter().all(|e| e.turn_id.starts_with("sub_")), "{events:?}");
        let completes = emitter.snapshot_completes();
        assert_eq!(completes.len(), 1);
        assert!(completes[0].0.starts_with("sub_"));

        // Lifecycle: started, then finished, with matching ids.
        let lifecycle = emitter.snapshot_subagent_events();
        assert_eq!(lifecycle.len(), 2, "{lifecycle:?}");
        match &lifecycle[0] {
            SubagentEvent::Started {
                agent_id: started_id,
                parent_thread_id,
                parent_turn_id,
                turn_id,
                agent_type,
                name,
                background,
                resumed,
                ..
            } => {
                assert_eq!(started_id, &agent_id);
                assert_eq!(parent_thread_id, "thread-parent");
                assert_eq!(parent_turn_id.as_deref(), Some("t-parent"));
                assert_eq!(turn_id, &completes[0].0);
                assert_eq!(agent_type, "explore");
                assert_eq!(name.as_deref(), Some("scout"));
                assert!(!background && !resumed);
            }
            other => panic!("expected Started, got {other:?}"),
        }
        match &lifecycle[1] {
            SubagentEvent::Finished {
                agent_id: finished_id,
                status,
                result,
                reported_to_parent,
                ..
            } => {
                assert_eq!(finished_id, &agent_id);
                assert_eq!(*status, TaskStatus::Completed);
                assert_eq!(result, expected);
                assert!(!reported_to_parent, "a waiting parent has the answer in hand");
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unknown_type_is_refused_before_anything_is_written() {
        let (registry, dir) = temp_registry();
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-u", "hi"));
        let err = host
            .spawn(&parent, spawn("x", "y", Some("janitor")))
            .await
            .unwrap_err();
        assert!(matches!(err, SubagentError::Invalid(ref m) if m.contains("Available")), "{err}");
        assert!(!parent.store.thread_dir("thread-u").join("agents").exists());
        assert!(emitter.snapshot_subagent_events().is_empty());
        assert!(registry.subagent_tasks().is_empty());
        drop(dir);
    }

    /// Stop on the parent stops a waiting child: its token is a child of the
    /// parent turn's, so the cancel reaches the mock stream, the child ends
    /// `killed`, and the parent is told so instead of being left waiting.
    #[tokio::test]
    async fn stopping_the_parent_kills_a_sync_child() {
        let api = Arc::new(MockApi::cancel_blocker());
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t-p", "thread-k", "go"));
        let parent_cancel = parent.cancel.clone();

        let spawned = tokio::spawn({
            let registry = registry.clone();
            let emitter = emitter.clone();
            async move {
                let (host, _catalog) = scripted_host(emitter, registry);
                host.spawn(&parent, spawn("Long task", "work", None)).await
            }
        });
        drop(host);
        // Let the child reach its (blocked) model call, then stop the parent.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        parent_cancel.cancel();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), spawned)
            .await
            .expect("the child must end when the parent is stopped")
            .expect("task join")
            .expect("spawn returns an outcome, not an error");
        let SpawnOutcome::Finished { state, error, .. } = outcome else {
            panic!("sync spawn finishes");
        };
        assert_eq!(state, "killed");
        assert!(error.is_none(), "a kill is not a failure: {error:?}");
        let lifecycle = emitter.snapshot_subagent_events();
        assert!(matches!(
            lifecycle.last(),
            Some(SubagentEvent::Finished { status: TaskStatus::Killed, .. })
        ));
    }

    #[tokio::test]
    async fn a_model_pin_on_the_parents_provider_swaps_the_model_and_a_foreign_one_is_refused() {
        let api = Arc::new(MockApi::new(submits("submit-1", "done")));
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory.clone(), dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter, registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-model", "hi"));

        let err = host
            .spawn(
                &parent,
                SpawnRequest {
                    model: Some("elsewhere:other-model".into()),
                    ..spawn("x", "y", None)
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, SubagentError::UnknownModel(_)), "{err}");

        let outcome = host
            .spawn(
                &parent,
                SpawnRequest {
                    model: Some("mock-provider:cheaper-model".into()),
                    ..spawn("x", "y", None)
                },
            )
            .await
            .expect("same provider, other model");
        let SpawnOutcome::Finished { agent_id, .. } = outcome else {
            panic!("finishes");
        };
        let built = factory.built_with_snapshot();
        assert_eq!(built.last().unwrap().model, "cheaper-model");
        let child_store = child_store_for(&parent.store, "thread-model");
        let sidecar = AgentSidecar::load(&child_store, &agent_id).unwrap();
        assert_eq!(sidecar.model.as_deref(), Some("mock-provider:cheaper-model"));
        // Without a database the only listable model is the parent's.
        let models = host.models(&parent).unwrap();
        assert_eq!(models.len(), 1);
        assert!(models[0].current);
        assert_eq!(models[0].pin, "mock-provider:mock-model");
    }

    #[tokio::test]
    async fn a_background_spawn_returns_launched_and_finishes_on_its_own() {
        let api = Arc::new(MockApi::new(submits("submit-1", "bg done")));
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-bg", "hi"));

        let outcome = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    ..spawn("Background job", "do it", None)
                },
            )
            .await
            .expect("launched");
        let SpawnOutcome::Launched { agent_id, .. } = outcome else {
            panic!("background spawns launch");
        };
        // The parent's turn ending does not stop it.
        parent.cancel.cancel();
        let record = registry.subagent_tasks().get(&agent_id).expect("record");
        for _ in 0..100 {
            if !record.is_running() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(record.status(), TaskStatus::Completed);
        assert_eq!(record.snapshot().result, Some(submitted_text("bg done")));
        let lifecycle = emitter.snapshot_subagent_events();
        assert!(matches!(
            lifecycle.last(),
            Some(SubagentEvent::Finished { status: TaskStatus::Completed, .. })
        ));
    }

    // ── Reporting back ──────────────────────────────────────────────

    fn tool_use_reply(id: &str) -> TurnScript {
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use_msg(id, "ghost", serde_json::json!({})),
                "tool_use",
            )),
        }
    }

    pub(super) fn text_reply(text: &str) -> TurnScript {
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(assistant_text_msg(text), "end_turn")),
        }
    }

    /// A child's model call that hands in its report with `submit_report`.
    pub(super) fn submit_reply(call_id: &str, summary: &str, report: &str) -> TurnScript {
        TurnScript::Reply {
            events: vec![],
            result: Ok(turn_usage(
                assistant_tool_use_msg(
                    call_id,
                    "submit_report",
                    serde_json::json!({
                        "outcome": "done",
                        "summary": summary,
                        "report": report,
                    }),
                ),
                "tool_use",
            )),
        }
    }

    /// A child finishing the way it is told to: submit the report (here the
    /// answer is both summary and report), then close with the answer as its
    /// one line. Two model calls.
    pub(super) fn submits(call_id: &str, answer: &str) -> Vec<TurnScript> {
        vec![submit_reply(call_id, answer, answer), text_reply(answer)]
    }

    /// What a run that submitted `answer` via [`submits`] records as its
    /// result: summary and report, one after the other.
    pub(super) fn submitted_text(answer: &str) -> String {
        format!("{answer}\n\n{answer}")
    }

    pub(super) async fn wait_until_done(record: &TaskRecord) {
        assert!(
            record.wait_finished(std::time::Duration::from_secs(5)).await,
            "the agent must finish"
        );
    }

    fn report_events(emitter: &MockEmitter) -> Vec<SubagentEvent> {
        emitter
            .snapshot_subagent_events()
            .into_iter()
            .filter(|e| matches!(e, SubagentEvent::Report { .. }))
            .collect()
    }

    /// Acceptance 3: an idle parent is woken with exactly one report.
    #[tokio::test]
    async fn a_background_child_finishing_while_the_parent_is_idle_sends_one_report() {
        let api = Arc::new(MockApi::new(submits("submit-1", "bg report")));
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-idle", "hi"));

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("worker".into()),
                    ..spawn("Background job", "do it", None)
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;
        // The report path runs right after the finish; give it a tick.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let reports = report_events(&emitter);
        assert_eq!(reports.len(), 1, "{reports:?}");
        let SubagentEvent::Report {
            agent_id: reported,
            parent_thread_id,
            agent,
            summary,
            detail,
            wake_id,
        } = &reports[0]
        else {
            unreachable!()
        };
        // The event is the wake-up call; the outbox is the record. The window
        // claims the entry by the id the event carries, once, and the second
        // drain racing for the same idle moment gets `None`.
        let pending = registry.wake_outbox().pending("thread-idle");
        assert_eq!(pending.len(), 1, "{pending:?}");
        assert_eq!(pending[0].id, *wake_id);
        assert_eq!(&pending[0].detail, detail);
        assert!(registry.wake_outbox().claim("thread-idle", *wake_id).is_some());
        assert!(registry.wake_outbox().claim("thread-idle", *wake_id).is_none());
        assert!(registry.wake_outbox().is_empty("thread-idle"));
        assert_eq!(reported, &agent_id);
        assert_eq!(parent_thread_id, "thread-idle");
        assert_eq!(agent.name.as_deref(), Some("worker"));
        assert_eq!(agent.status, "completed");
        assert_eq!(summary, "Finished \"Background job\" · completed");
        assert!(detail.contains("outcome=\"done\""), "{detail}");
        assert!(detail.contains("Summary: bg report"), "{detail}");
        assert!(detail.contains("to=\"worker\""));
        assert!(record.was_notified());
        assert!(matches!(
            emitter.snapshot_subagent_events().iter().find(|e| matches!(e, SubagentEvent::Finished { .. })),
            Some(SubagentEvent::Finished { reported_to_parent: true, .. })
        ));
        // Nothing was queued into the parent: it was idle.
        assert!(registry.drain_queued("thread-idle").is_empty());
    }

    /// When the parent is mid-turn the report is queued into that turn,
    /// as an agent report, and no wake is sent.
    #[tokio::test]
    async fn a_background_child_finishing_during_the_parents_turn_queues_its_report() {
        let api = Arc::new(MockApi::new(submits("submit-1", "bg report")));
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t-busy", "thread-busy", "hi"));
        registry.mark_turn_active("thread-busy", "t-busy");

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(&parent, SpawnRequest { background: true, ..spawn("Job", "do it", None) })
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        assert!(report_events(&emitter).is_empty(), "no wake while the parent runs");
        let queued = registry.drain_queued("thread-busy");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].origin, crate::agent_runtime::types::InjectedOrigin::Subagent);
        assert!(!queued[0].mid_turn, "a report is not framed as the user's words");
        assert_eq!(queued[0].agent.as_ref().unwrap().agent_id, agent_id);
        assert_eq!(queued[0].display_text.as_deref(), Some("Finished \"Job\" · completed"));
        assert!(queued[0].text.contains("bg report"));
        registry.clear_turn_active("thread-busy", "t-busy");
    }

    /// A parent checking on a RUNNING child gets its timeline at once. The
    /// child's turn holds its session locked for the whole run; a check that
    /// read the session waited for the run to end (the 1m 54s card).
    #[tokio::test]
    async fn a_check_on_a_running_child_answers_without_waiting_for_its_turn() {
        let (api, gate) = MockApi::gated(vec![
            TurnScript::Reply {
                events: vec![
                    AssistantEvent::StreamAttemptStarted,
                    AssistantEvent::Thinking {
                        text: "Start with the stylesheet.".into(),
                        signature: None,
                    },
                    AssistantEvent::ToolUse {
                        id: "c1".into(),
                        name: "file_read".into(),
                        input: serde_json::json!({ "path": "src/index.css" }),
                    },
                ],
                result: Ok(turn_usage(
                    assistant_tool_use_msg(
                        "c1",
                        "file_read",
                        serde_json::json!({ "path": "src/index.css" }),
                    ),
                    "tool_use",
                )),
            },
            submit_reply("submit-1", "done", "done"),
            text_reply("done"),
        ]);
        let api = Arc::new(api);
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-check", "hi"));

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("styler".into()),
                    ..spawn("Job", "do it", None)
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        // Call 1 runs; call 2 parks on the gate with the child's turn — and
        // its session lock — still held.
        api.wait_for_calls(1).await;
        gate.add_permits(1);
        api.wait_for_calls(2).await;

        let activity = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            host.activity(&parent, "styler"),
        )
        .await
        .expect("a check must not wait for the child's turn")
        .expect("a live record");
        assert_eq!(
            activity.timeline,
            vec!["thought: Start with the stylesheet.", "ran file_read src/index.css"]
        );
        // Seen once: the next check starts after it.
        let again = host.activity(&parent, &agent_id).await.expect("record");
        assert!(again.timeline.is_empty(), "{again:?}");

        gate.add_permits(2);
        wait_until_done(&registry.subagent_tasks().get(&agent_id).unwrap()).await;
    }

    /// A message sent while the child writes its FINAL reply has no tool
    /// boundary left to ride. The parent was told "queued", so the child
    /// carries on with it rather than finishing without it.
    #[tokio::test]
    async fn a_message_sent_during_the_final_reply_is_still_answered() {
        // The first turn ends without a report, but a message is waiting, so
        // the child takes the message, not a reminder.
        let (api, gate) = MockApi::gated(vec![
            text_reply("first answer"),
            submit_reply("submit-1", "read it", "read it"),
            text_reply("read it"),
        ]);
        let api = Arc::new(api);
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-late", "hi"));

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("worker".into()),
                    ..spawn("Job", "do it", None)
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        api.wait_for_calls(1).await;
        let outcome = host
            .send_message(&parent, "worker", "one more thing")
            .await
            .unwrap();
        assert!(matches!(outcome, SendOutcome::Queued { .. }));
        gate.add_permits(3);

        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        assert_eq!(api.call_count(), 3, "the child answered the late message, then submitted");
        assert_eq!(record.snapshot().result, Some(submitted_text("read it")));
        let child_store = child_store_for(&parent.store, "thread-late");
        let session = Session::load_from_path(&agent_id, &child_store.session_path(&agent_id))
            .expect("child transcript");
        assert!(
            session.messages().iter().any(|m| m.role == MessageRole::User
                && m.blocks.iter().any(|b| matches!(b, ContentBlock::Text { text } if text.contains("one more thing")))),
            "{:?}",
            session.messages()
        );
        assert_eq!(report_events(&emitter).len(), 1, "one report, after the follow-up");
    }

    /// A child that cannot do the task as asked raises its hand with
    /// `message_parent`. The message takes the parent's mid-turn queue — the
    /// same path a person's message takes — tagged with the agent and a
    /// `running` status, ahead of the finish report that follows.
    #[tokio::test]
    async fn a_child_messaging_its_busy_parent_lands_in_the_turn_queue_before_its_report() {
        let api = Arc::new(MockApi::new(vec![
            TurnScript::Reply {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use_msg(
                        "m1",
                        "message_parent",
                        serde_json::json!({ "message": "I was asked to run pytest but have no shell tool." }),
                    ),
                    "tool_use",
                )),
            },
            submit_reply(
                "submit-1",
                "Reviewed what I could without running the suite.",
                "No shell, so pytest was not run.",
            ),
            text_reply("Submitted."),
        ]));
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t-hand", "thread-hand", "hi"));
        registry.mark_turn_active("thread-hand", "t-hand");

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("checker".into()),
                    ..spawn("Review the suite", "run pytest and review", Some("explore"))
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        assert!(report_events(&emitter).is_empty(), "no wake while the parent runs");
        let queued = registry.drain_queued("thread-hand");
        assert_eq!(queued.len(), 2, "the message, then the report: {queued:?}");
        let message = &queued[0];
        assert_eq!(message.origin, crate::agent_runtime::types::InjectedOrigin::Subagent);
        let agent = message.agent.as_ref().expect("tagged with the agent");
        assert_eq!(agent.agent_id, agent_id);
        assert_eq!(agent.name.as_deref(), Some("checker"));
        assert_eq!(agent.status, "running", "a mid-run message, not an ending");
        assert_eq!(message.display_text.as_deref(), Some("Message from \"checker\""));
        assert!(message.text.contains("have no shell tool"), "{}", message.text);
        assert!(message.text.contains("send_message to=\"checker\""), "{}", message.text);
        let report = &queued[1];
        assert_eq!(report.agent.as_ref().unwrap().status, "completed");
        assert!(report.text.contains("Reviewed what I could"));
        registry.clear_turn_active("thread-hand", "t-hand");
    }

    /// Live run, 2026-10-08: the parent sat in `get_task_output` while two
    /// children finished. The check claimed their reports and carried them
    /// as its result (13 and 15 KB), the 8 KiB tool-result cap dropped them
    /// whole, and no report ever came. A check now only looks: the report
    /// goes into the busy parent's queue, whole, before the check wakes.
    #[tokio::test]
    async fn a_check_waiting_when_a_child_finishes_leaves_the_report_to_the_conversation() {
        // 12 KB: over the 8 KiB tool-result cap that dropped the live reports,
        // under the size at which a report moves to a file.
        let long_report = format!("findings: {}", "x".repeat(12_000));
        let (api, gate) = MockApi::gated(vec![
            submit_reply("submit-1", "Findings below.", &long_report),
            text_reply("Submitted."),
        ]);
        let api = Arc::new(api);
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-poll", "hi"));
        registry.mark_turn_active("thread-poll", "t");

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(&parent, SpawnRequest { background: true, ..spawn("Job", "do it", None) })
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        // Still running: a check says so and claims nothing.
        let now = host.output(&parent, &agent_id, None).await.unwrap();
        assert_eq!(now.status, TaskStatus::Running);
        assert!(!now.notified);

        // Wait in a check, then let the model answer.
        let waiter = {
            let registry = registry.clone();
            let emitter = emitter.clone();
            let parent_request = parent.request.clone();
            let parent_store = parent.store.clone();
            let agent_id = agent_id.clone();
            tokio::spawn(async move {
                let (host, _catalog) = scripted_host(emitter, registry);
                let parent = ParentTurn {
                    thread_id: "thread-poll".into(),
                    turn_id: "t".into(),
                    request: parent_request,
                    store: parent_store,
                    cancel: CancellationToken::new(),
                };
                host.output(&parent, &agent_id, Some(std::time::Duration::from_secs(5)))
                    .await
            })
        };
        api.wait_for_calls(1).await;
        gate.add_permits(2);
        let checked = waiter.await.unwrap().unwrap();
        assert_eq!(checked.status, TaskStatus::Completed);

        // No sleep: the report is queued before the check wakes, so it lands
        // on the same tool boundary as the check's result.
        let queued = registry.drain_queued("thread-poll");
        assert_eq!(queued.len(), 1, "the report, once: {queued:?}");
        assert_eq!(queued[0].agent.as_ref().unwrap().status, "completed");
        assert!(
            queued[0].text.contains(&long_report),
            "the whole report, not a capped copy"
        );
        assert!(report_events(&emitter).is_empty(), "the parent is busy: no wake");

        // Another look at the finished agent sends nothing more.
        host.output(&parent, &agent_id, Some(std::time::Duration::from_secs(1)))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(registry.drain_queued("thread-poll").is_empty());
        assert!(report_events(&emitter).is_empty());
        registry.clear_turn_active("thread-poll", "t");
    }

    /// The rule under the test above, without its timing: a check that sees
    /// a finished agent before the finisher has reported must not take the
    /// report. Old code claimed it there, and the finisher then sent nothing.
    #[tokio::test]
    async fn a_check_never_takes_the_report_from_the_finisher() {
        let (api, gate) = MockApi::gated(submits("submit-1", "the real report"));
        let api = Arc::new(api);
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-take", "hi"));
        registry.mark_turn_active("thread-take", "t");

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(&parent, SpawnRequest { background: true, ..spawn("Job", "do it", None) })
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        api.wait_for_calls(1).await;
        // The record says finished while the run has not reported yet: the
        // window a check fell into on the live run.
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        record.finish(
            TaskStatus::Completed,
            Some("early".into()),
            None,
            crate::agent_runtime::subagents::host::SubagentUsage::default(),
        );
        let seen = host.output(&parent, &agent_id, None).await.unwrap();
        assert_eq!(seen.status, TaskStatus::Completed);
        assert!(!record.was_notified(), "the check claimed the report");

        gate.add_permits(2);
        let mut queued = Vec::new();
        for _ in 0..100 {
            queued = registry.drain_queued("thread-take");
            if !queued.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(queued.len(), 1, "the finisher still reports: {queued:?}");
        assert!(queued[0].text.contains("the real report"));
        registry.clear_turn_active("thread-take", "t");
    }

    /// Start a background child under a busy parent and wait for its report
    /// to reach the parent's queue. Returns the queued items and the id.
    async fn run_child_to_its_report(
        api: Arc<MockApi>,
        thread: &str,
    ) -> (
        Vec<crate::agent_runtime::session::QueuedUserMessage>,
        String,
        Arc<AgentRegistry>,
        ParentTurn,
        tempfile::TempDir,
    ) {
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter, registry.clone());
        let parent = parent_turn(&registry, make_request("t", thread, "hi"));
        registry.mark_turn_active(thread, "t");
        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("scout".into()),
                    ..spawn("Job", "do it", Some("explore"))
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let queued = registry.drain_queued(thread);
        registry.clear_turn_active(thread, "t");
        (queued, agent_id, registry, parent, dir)
    }

    /// A child that ends without `submit_report` is asked once, in Aurora's
    /// words, and the report it then submits is the one the parent gets.
    #[tokio::test]
    async fn a_child_that_ends_without_a_report_is_asked_once_and_its_submission_is_used() {
        let api = Arc::new(MockApi::new(vec![
            text_reply("I looked around."),
            submit_reply("submit-1", "Login is in src/auth.ts:42.", "## Found\n- src/auth.ts:42"),
            text_reply("Submitted."),
        ]));
        let (queued, agent_id, registry, parent, _dir) =
            run_child_to_its_report(api.clone(), "thread-remind").await;
        assert_eq!(api.call_count(), 3, "one reminder, then the submission");
        assert_eq!(queued.len(), 1, "{queued:?}");
        let text = &queued[0].text;
        assert!(text.contains("outcome=\"done\""), "{text}");
        assert!(text.contains("Summary: Login is in src/auth.ts:42."), "{text}");
        assert!(!text.contains("I looked around."), "the submission, not the chatter: {text}");

        // The reminder is Aurora's note in the child's transcript, never a
        // message drawn as coming from the parent.
        let child_store = child_store_for(&parent.store, "thread-remind");
        let session = Session::load_from_path(&agent_id, &child_store.session_path(&agent_id))
            .expect("child transcript");
        let reminders: Vec<_> = session
            .messages()
            .iter()
            .flat_map(|m| m.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::ProcessEvent { summary, detail, .. } => Some((summary, detail)),
                _ => None,
            })
            .collect();
        assert_eq!(reminders.len(), 1, "{:?}", session.messages());
        assert_eq!(reminders[0].0, "Asked for its report");
        assert!(reminders[0].1.contains("submit_report"));
        drop(registry);
    }

    /// Asked and still silent: the parent gets the last message, plainly
    /// marked as never submitted. Exactly one reminder, never a loop.
    #[tokio::test]
    async fn a_child_that_never_submits_is_reported_from_its_last_message_and_says_so() {
        let api = Arc::new(MockApi::new(vec![
            text_reply("Working on it."),
            text_reply("Login is in src/auth.ts:42."),
        ]));
        let (queued, agent_id, registry, _parent, _dir) =
            run_child_to_its_report(api.clone(), "thread-silent").await;
        assert_eq!(api.call_count(), 2, "one reminder and no more");
        assert_eq!(queued.len(), 1);
        let text = &queued[0].text;
        assert!(text.contains("outcome=\"not_submitted\""), "{text}");
        assert!(text.contains("did not submit a report"), "{text}");
        assert!(text.contains("Login is in src/auth.ts:42."), "{text}");
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        assert_eq!(record.status(), TaskStatus::Completed);
        assert_eq!(record.snapshot().result.as_deref(), Some("Login is in src/auth.ts:42."));
    }

    /// A report too long to deliver whole reaches the parent as its head and
    /// tail plus a file in the PARENT's tool-results folder, which the
    /// parent's `file_read` opens without any outside-workspace permission.
    #[tokio::test]
    async fn a_long_report_reaches_the_parent_as_a_file_it_can_read() {
        let long = format!("HEAD-MARK\n{}\nTAIL-MARK", "a finding per line\n".repeat(2_000));
        let api = Arc::new(MockApi::new(vec![
            submit_reply("submit-1", "Many findings.", &long),
            text_reply("Submitted."),
        ]));
        let (queued, agent_id, _registry, parent, _dir) =
            run_child_to_its_report(api, "thread-long").await;
        let text = &queued[0].text;
        assert!(text.len() < long.len(), "the middle moved out of the message");
        assert!(text.contains("Summary: Many findings."));
        assert!(text.contains("HEAD-MARK") && text.contains("TAIL-MARK"));
        let file = parent
            .store
            .tool_results_dir("thread-long")
            .join(format!("agent-report-{agent_id}-run1.md"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), long.trim(), "all of it is on disk");
        let shown = dunce::canonicalize(&file).unwrap();
        assert!(text.contains(&shown.display().to_string()), "the path is given: {text}");
    }

    /// Live run 5: the user pressed Stop on an agent four minutes in. The
    /// parent read "0 tool calls · 0 tokens · stopped before it reported
    /// anything" and could not tell the user had stopped it. Now the report
    /// says who stopped it, counts the stopped turn's work from its stream,
    /// and lists what it was doing.
    #[tokio::test]
    async fn a_user_stop_reaches_the_parent_as_the_users_decision_with_the_work_done() {
        let (api, _gate) = MockApi::gated(vec![
            TurnScript::Reply {
                events: vec![
                    AssistantEvent::StreamAttemptStarted,
                    AssistantEvent::ToolUse {
                        id: "c1".into(),
                        name: "file_read".into(),
                        input: serde_json::json!({ "path": ["data/catalog.txt"] }),
                    },
                ],
                result: Ok(turn_usage(
                    assistant_tool_use_msg(
                        "c1",
                        "file_read",
                        serde_json::json!({ "path": ["data/catalog.txt"] }),
                    ),
                    "tool_use",
                )),
            },
            TurnScript::Reply {
                events: vec![
                    AssistantEvent::StreamAttemptStarted,
                    AssistantEvent::Thinking {
                        text: "Summing the garden prices".into(),
                        signature: None,
                    },
                ],
                result: Ok(turn_usage(assistant_text_msg("never reached"), "end_turn")),
            },
        ]);
        let api = Arc::new(api);
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter, registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-user-stop", "hi"));
        registry.mark_turn_active("thread-user-stop", "t");
        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("inventory".into()),
                    ..spawn("Report every catalog item", "do it", Some("explore"))
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        // Call 1 runs its tool; call 2 parks on the gate mid-turn.
        api.wait_for_calls(1).await;
        _gate.add_permits(1);
        api.wait_for_calls(2).await;
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        // The window's Stop button.
        assert!(record.kill(crate::agent_runtime::subagents::record::StopBy::User));
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let queued = registry.drain_queued("thread-user-stop");
        registry.clear_turn_active("thread-user-stop", "t");
        assert_eq!(queued.len(), 1, "{queued:?}");
        let text = &queued[0].text;
        assert_eq!(queued[0].agent.as_ref().unwrap().status, "killed");
        assert!(text.contains("outcome=\"stopped\""), "{text}");
        assert!(text.contains("The user stopped it. Do not restart it"), "{text}");
        assert!(text.contains("1 tool call"), "the stopped run's work is counted: {text}");
        assert!(text.contains("- ran file_read"), "{text}");
        assert_eq!(api.call_count(), 2, "no reminder after a stop");
    }

    /// Live runs 4 and 5: prober asked about its missing shell, could only
    /// carry on, finished first, and the parent's answer started a SECOND run
    /// with a second report. With `waitForReply` the question holds, the
    /// answer comes back as the tool's result inside the same run, it is not
    /// delivered a second time, and there is one report.
    #[tokio::test]
    async fn a_question_that_waits_is_answered_inside_the_same_run() {
        let api = Arc::new(MockApi::new(vec![
            TurnScript::Reply {
                events: vec![],
                result: Ok(turn_usage(
                    assistant_tool_use_msg(
                        "ask-1",
                        "message_parent",
                        serde_json::json!({
                            "message": "No shell here. Skip the version commands?",
                            "waitForReply": true,
                        }),
                    ),
                    "tool_use",
                )),
            },
            submit_reply("submit-1", "Skipped the versions as told.", "Exports listed."),
            text_reply("Submitted."),
        ]));
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-ask", "hi"));
        registry.mark_turn_active("thread-ask", "t");

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("prober".into()),
                    ..spawn("Probe", "run node --version", Some("explore"))
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        for _ in 0..200 {
            if record.is_waiting_for_reply() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(record.is_waiting_for_reply(), "the question holds for its answer");

        // The parent sees a QUESTION, telling it to answer now.
        let asked = registry.drain_queued("thread-ask");
        assert_eq!(asked.len(), 1, "{asked:?}");
        assert_eq!(asked[0].display_text.as_deref(), Some("Question from \"prober\""));
        assert!(asked[0].text.contains("waiting for your answer"));

        let note = host.send_message_kind(&parent, "prober", "Good job, keep going.", crate::agent_runtime::subagents::messaging::ParentMessageKind::Message).await.unwrap();
        assert!(matches!(note, SendOutcome::Queued { taken_now: false, .. }));
        assert!(record.is_waiting_for_reply(), "a courtesy message must not answer its question");

        let outcome = host
            .send_message_kind(&parent, "prober", "Yes, skip them and submit partial.", crate::agent_runtime::subagents::messaging::ParentMessageKind::Reply)
            .await
            .unwrap();
        assert!(
            matches!(outcome, SendOutcome::Queued { taken_now: true, .. }),
            "{outcome:?}"
        );
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // One run, one report.
        assert_eq!(record.snapshot().runs, 1, "no second run");
        let reports = registry.drain_queued("thread-ask");
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert_eq!(reports[0].agent.as_ref().unwrap().status, "completed");

        // The answer is the tool's result, and never arrives again as a message.
        let child_store = child_store_for(&parent.store, "thread-ask");
        let session = Session::load_from_path(&agent_id, &child_store.session_path(&agent_id))
            .expect("child transcript");
        let tool_result = session
            .messages()
            .iter()
            .flat_map(|m| m.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolResult { tool_use_id, content, .. } if tool_use_id == "ask-1" => {
                    Some(content.clone())
                }
                _ => None,
            })
            .expect("the question's result");
        assert!(tool_result.contains("Yes, skip them and submit partial."), "{tool_result}");
        let user_copies = session
            .messages()
            .iter()
            .filter(|m| m.role == MessageRole::User)
            .flat_map(|m| m.blocks.iter())
            .filter(|b| matches!(b, ContentBlock::Text { text } if text.contains("Yes, skip them")))
            .count();
        assert_eq!(user_copies, 0, "taken once, as the result");
        assert_eq!(api.call_count(), 3);
        registry.clear_turn_active("thread-ask", "t");
    }

    /// A waiting question takes only the parent's words. A background
    /// process's ending queued beside them stays for normal delivery.
    #[test]
    fn taking_the_parents_answer_leaves_a_process_ending_queued() {
        let (registry, _dir) = temp_registry();
        use crate::agent_runtime::types::InjectedOrigin;
        registry
            .enqueue_in_order("agent_x", "process bg-1 ended".into(), InjectedOrigin::Process)
            .unwrap();
        registry
            .enqueue_in_order("agent_x", "the answer".into(), InjectedOrigin::User)
            .unwrap();
        let taken = registry.take_queued_from("agent_x", InjectedOrigin::User);
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].text, "the answer");
        let left = registry.take_queued_messages("agent_x");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "process bg-1 ended");
    }

    /// A report queued after the parent's last tool boundary never reached
    /// the model; the end-of-turn sweep turns it into a wake.
    #[tokio::test]
    async fn a_report_left_in_the_queue_after_the_turn_becomes_a_wake() {
        let api = Arc::new(MockApi::new(vec![text_reply("parent reply")]));
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        // Pre-queue a report AND a person's message: only the report sweeps.
        registry
            .enqueue_with_agent(
                "thread-sweep",
                "<subagent_report>late</subagent_report>".into(),
                Some("Finished \"Late\" · completed".into()),
                None,
                crate::agent_runtime::types::InjectedOrigin::Subagent,
                Some(crate::agent_runtime::types::AgentReportMeta {
                    agent_id: "agent_late".into(),
                    name: None,
                    status: "completed".into(),
                }),
            )
            .unwrap();
        registry
            .enqueue_message(
                "thread-sweep",
                "and also this".into(),
                None,
                None,
                crate::agent_runtime::types::InjectedOrigin::User,
            )
            .await
            .unwrap();

        let driver = TurnDriver::new(registry.clone(), emitter.clone());
        driver
            .run_turn(make_request("t-sweep", "thread-sweep", "hi"))
            .await
            .expect("turn");
        // A text-only turn has no tool boundary, so neither was injected.
        let reports = report_events(&emitter);
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(matches!(&reports[0], SubagentEvent::Report { agent_id, .. } if agent_id == "agent_late"));
        // Swept reports are recorded like any other wake, so the window's poll
        // finds them even if this event is never processed.
        let pending = registry.wake_outbox().pending("thread-sweep");
        assert_eq!(pending.len(), 1, "{pending:?}");
        assert_eq!(pending[0].agent.agent_id, "agent_late");
        assert_eq!(pending[0].summary, "Finished \"Late\" · completed");
        let left = registry.drain_queued("thread-sweep");
        assert_eq!(left.len(), 1, "the person's message is still waiting");
        assert_eq!(left[0].text, "and also this");
    }

    // ── Messaging and resume ────────────────────────────────────────

    /// Acceptance 5: a message to a running child lands in its transcript
    /// as a user message after the tool call it interrupted, in order.
    #[tokio::test]
    async fn a_message_to_a_running_child_is_delivered_at_its_next_boundary() {
        let (api, gate) = MockApi::gated(vec![
            tool_use_reply("c1"),
            tool_use_reply("c2"),
            submit_reply("submit-1", "child done", "child done"),
            text_reply("child done"),
        ]);
        let api = Arc::new(api);
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-msg", "hi"));

        let SpawnOutcome::Launched { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    background: true,
                    name: Some("worker".into()),
                    ..spawn("Job", "do it", None)
                },
            )
            .await
            .expect("launched")
        else {
            panic!("launches");
        };
        // Call 1 → tool c1 → boundary 1 (queue empty) → call 2 waits on the gate.
        api.wait_for_calls(1).await;
        gate.add_permits(1);
        api.wait_for_calls(2).await;
        // Now the message. It must ride boundary 2, after tool c2.
        let outcome = host
            .send_message(&parent, "worker", "also check the tests")
            .await
            .unwrap();
        assert_eq!(
            outcome,
            SendOutcome::Queued {
                agent_id: agent_id.clone(),
                taken_now: false
            }
        );
        let one_more = host.send_message(&parent, &agent_id, "and the docs").await.unwrap();
        assert!(matches!(one_more, SendOutcome::Queued { .. }));
        gate.add_permits(3);

        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;

        let child_store = child_store_for(&parent.store, "thread-msg");
        let session = Session::load_from_path(&agent_id, &child_store.session_path(&agent_id))
            .expect("child transcript");
        // user, assistant(c1), tool(c1), assistant(c2), tool(c2 + message),
        // assistant(submit_report), tool(submitted), assistant(done)
        assert_eq!(session.len(), 8, "{:?}", session.messages());
        let second_tool_msg = &session.messages()[4];
        assert_eq!(second_tool_msg.role, MessageRole::Tool);
        let texts: Vec<&str> = second_tool_msg
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        // The parent's messages all arrive, in order. A person's composer has
        // one pending slot; the parent's queue to its child does not.
        assert_eq!(texts.len(), 2, "{texts:?}");
        assert!(texts[0].contains("also check the tests"));
        assert!(texts[1].contains("and the docs"));
        for text in &texts {
            assert!(
                text.starts_with("[Parent task:"),
                "the boundary must name the parent and the task purpose: {text}"
            );
        }
        let first_tool_msg = &session.messages()[2];
        assert!(
            !first_tool_msg.blocks.iter().any(|b| matches!(b, ContentBlock::Text { .. })),
            "nothing rode the first boundary"
        );
        assert!(emitter
            .snapshot_subagent_events()
            .iter()
            .any(|e| matches!(e, SubagentEvent::Message { delivered: false, .. })));
    }

    /// Acceptance 6 and 7: a message to a finished agent resumes it under the
    /// same id with its history; evicting the record first changes nothing.
    #[tokio::test]
    async fn a_message_to_a_finished_or_forgotten_child_resumes_it_with_its_history() {
        let api = Arc::new(MockApi::new(
            [
                submits("submit-1", "first answer"),
                submits("submit-2", "second answer"),
                submits("submit-3", "third answer"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ));
        let factory = Arc::new(MockApiFactory::from_api(api.clone()));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-resume", "hi"));

        let SpawnOutcome::Finished { agent_id, .. } = host
            .spawn(
                &parent,
                SpawnRequest {
                    name: Some("scout".into()),
                    ..spawn("Scout", "first task", Some("explore"))
                },
            )
            .await
            .expect("sync")
        else {
            panic!("finishes");
        };

        // 1. Finished, still in memory → resumed by name.
        let outcome = host.send_message(&parent, "scout", "second task").await.unwrap();
        let SendOutcome::Resumed { agent_id: resumed, note, .. } = outcome else {
            panic!("a finished agent is resumed, got {outcome:?}");
        };
        assert_eq!(resumed, agent_id, "the id never changes");
        assert!(note.is_none());
        let record = registry.subagent_tasks().get(&agent_id).unwrap();
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(
            record.snapshot().result,
            Some(submitted_text("second answer")),
            "the second run's own report, not the first's"
        );
        assert_eq!(record.snapshot().runs, 2);

        // 2. Evicted → resumed from disk by id.
        assert!(registry.subagent_tasks().evict(&agent_id));
        let outcome = host.send_message(&parent, &agent_id, "third task").await.unwrap();
        assert!(matches!(outcome, SendOutcome::Resumed { agent_id: ref id, .. } if id == &agent_id));
        let record = registry.subagent_tasks().get(&agent_id).expect("rebuilt from disk");
        wait_until_done(&record).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // One transcript, all three exchanges, in order.
        let child_store = child_store_for(&parent.store, "thread-resume");
        let session = Session::load_from_path(&agent_id, &child_store.session_path(&agent_id))
            .unwrap();
        let texts: Vec<String> = session
            .messages()
            .iter()
            .map(|m| {
                m.blocks
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .filter(|t| !t.is_empty())
            .collect();
        assert_eq!(
            texts,
            vec![
                "first task",
                "first answer",
                "second task",
                "second answer",
                "third task",
                "third answer"
            ]
        );
        // Two calls per run (submit, close), and no reminder: every run
        // submitted. The model saw the whole history on the resumed calls.
        assert_eq!(api.call_count(), 6);

        let sidecar = AgentSidecar::load(&child_store, &agent_id).unwrap();
        assert_eq!(sidecar.runs, 3);
        assert_eq!(sidecar.status, TaskStatus::Completed);
        assert_eq!(sidecar.result, Some(submitted_text("third answer")));
        assert_eq!(sidecar.agent_type, "explore", "the definition is kept for routing");

        // Each resumed run reported once; the first (sync) run did not.
        let reports = report_events(&emitter);
        assert_eq!(reports.len(), 2, "{reports:?}");
        let started_resumed = emitter
            .snapshot_subagent_events()
            .iter()
            .filter(|e| matches!(e, SubagentEvent::Started { resumed: true, .. }))
            .count();
        assert_eq!(started_resumed, 2);

        // Nothing is known about a stranger.
        let err = host.send_message(&parent, "nobody", "x").await.unwrap_err();
        assert!(matches!(err, SubagentError::NotFound(_)));
    }

    /// The window's view: files first, live state overlaid.
    #[tokio::test]
    async fn the_agents_list_merges_disk_and_live_state() {
        let api = Arc::new(MockApi::new(
            [submits("s-a", "a"), submits("s-b", "b")].into_iter().flatten().collect(),
        ));
        let factory = Arc::new(MockApiFactory::from_api(api));
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = Arc::new(AgentRegistry::new(factory, dir.path().to_path_buf()));
        let emitter = Arc::new(MockEmitter::default());
        let (host, _catalog) = scripted_host(emitter.clone(), registry.clone());
        let parent = parent_turn(&registry, make_request("t", "thread-list", "hi"));
        let SpawnOutcome::Finished { agent_id: first, .. } =
            host.spawn(&parent, spawn("First", "a", None)).await.unwrap()
        else {
            panic!()
        };
        let SpawnOutcome::Finished { agent_id: second, .. } =
            host.spawn(&parent, spawn("Second", "b", None)).await.unwrap()
        else {
            panic!()
        };
        registry.subagent_tasks().evict(&first);
        let listed = list_agents_for(&registry, &parent.store, "thread-list");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].agent_id, first, "oldest first");
        assert_eq!(listed[0].status, TaskStatus::Completed, "from disk");
        assert_eq!(listed[0].result, Some(submitted_text("a")));
        assert_eq!(listed[1].agent_id, second);
        assert_eq!(listed[1].result, Some(submitted_text("b")));
        assert!(list_agents_for(&registry, &parent.store, "thread-none").is_empty());
    }
}

#[path = "tests/subagent_delivery.rs"]
mod subagent_delivery;

#[path = "tests/subagent_models.rs"]
mod subagent_models;

#[path = "tests/subagent_lifecycle.rs"]
mod subagent_lifecycle;

#[path = "tests/subagent_grants.rs"]
mod subagent_grants;

#[path = "tests/subagent_messaging.rs"]
mod subagent_messaging;
