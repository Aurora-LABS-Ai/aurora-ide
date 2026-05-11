# Phase 2.3 Locked IPC Contract

**Status:** locked. Both Sub-A (Rust backend) and Sub-B (TS frontend) MUST conform to the shapes below verbatim. Any deviation is a bug.

## 1. `AgentChatRequest` — frontend → backend

Lives in `src-tauri/src/agent_runtime/ipc.rs`. Sub-A extends the existing struct **additively**; existing fields keep their semantics.

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatRequest {
    // ── unchanged ──
    pub turn_id: String,
    pub thread_id: String,
    pub user_message: String,
    pub provider_id: String,
    pub model: String,
    pub workspace_path: Option<String>,

    // ── NEW in Phase 2.3 ──
    /// Full provider configuration snapshot (api_key, base_url,
    /// custom_headers, custom_params, …). Sent verbatim from the
    /// frontend's `useSettingsStore.getLLMConfig()`. Lives in
    /// `crate::api::ProviderConfigSnapshot`.
    pub provider_config: crate::api::ProviderConfigSnapshot,

    /// Pre-rendered system prompt. Built by the frontend's existing
    /// `composeAgentSystemPrompt(...)` machinery — Sub-A never composes
    /// system prompts itself.
    #[serde(default)]
    pub system_prompt: Option<String>,

    /// IDE context block (from `getIDEContext` / `buildQueryContext`).
    /// The runtime concatenates `<ide_context>...</ide_context>` ahead
    /// of the user's clean text when assembling the API request, but
    /// persists `user_message` verbatim so the JSONL bubble stays
    /// clean. Match the existing TS behaviour in `agent-service.ts`.
    #[serde(default)]
    pub ide_context: Option<String>,

    /// Tool catalogue advertised to the model. JSON-Schema shape per
    /// tool (matches existing TS `ToolDefinition.parameters`).
    /// Phase 2.3 forwards every tool name through the FrontendBridge
    /// (see §3) — Rust does not yet have native executors.
    #[serde(default)]
    pub tools: Vec<AllowedTool>,

    /// Sampling temperature. None → provider preset default.
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Hard cap per API call. None → `RuntimeConfig::default_max_output_tokens`.
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    /// Honoured only when the provider preset advertises thinking
    /// support; impl silently drops it otherwise.
    #[serde(default)]
    pub thinking_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedTool {
    pub name: String,
    pub description: String,
    /// JSON Schema object describing the tool's input.
    pub parameters: serde_json::Value,
}
```

Wire-format note: the struct is `rename_all = "camelCase"` so the
frontend can send `{ "turnId": "...", "providerConfig": {...},
"systemPrompt": "...", "ideContext": "...", "tools": [...] }`.
This is a deliberate change from Phase 2.2's snake_case shape —
`agent_chat_v2` is brand-new IPC; nothing depends on the old shape.

## 2. `ApiFactory` signature change

`commands/agent_v2.rs` — `ApiFactory::build` takes the full snapshot:

```rust
pub trait ApiFactory: Send + Sync + 'static {
    fn build(
        &self,
        config: &crate::api::ProviderConfigSnapshot,
    ) -> Result<Arc<dyn StreamingApiClient>, RuntimeError>;
}
```

`lib.rs` replaces `StubApiFactory` with:

```rust
pub struct RealApiFactory;
impl commands::agent_v2::ApiFactory for RealApiFactory {
    fn build(
        &self,
        config: &api::ProviderConfigSnapshot,
    ) -> Result<Arc<dyn StreamingApiClient>, RuntimeError> {
        Ok(api::build_api_client(config))
    }
}
```

Sub-A also updates the test-side `MockApiFactory` to match the new
signature (still records `(provider_id, model)` so existing assertions
hold by reading `config.provider_id` / `config.model`).

## 3. Frontend tool-execution bridge

Tools execute on the **frontend** in Phase 2.3 (Rust registry stays
empty until Phase 3 ports executors). The runtime exposes two new
events and one new command:

### Event: `agent_tool_pending` (Rust → frontend)

```jsonc
{
  "turnId": "01ARZ...",
  "toolUseId": "call-abc",
  "name": "file_read",
  "input": { "path": "src/main.rs" }
}
```

Emitted on a dedicated channel `"agent_tool_pending"`. The runtime
suspends the turn and waits on a `tokio::sync::oneshot` for the
matching `agent_post_tool_result` call.

### Command: `agent_post_tool_result` (frontend → Rust)

```rust
#[tauri::command]
pub async fn agent_post_tool_result(
    state: State<'_, Arc<AgentRegistry>>,
    turn_id: String,
    tool_use_id: String,
    content: String,
    is_error: bool,
) -> Result<(), String>;
```

The registry holds a `DashMap<(turn_id, tool_use_id),
oneshot::Sender<ToolBridgeResponse>>`; this command fires the
sender. If the (turn_id, tool_use_id) is unknown, return
`Err("no pending tool call")` — the frontend treats it as a
warning and moves on.

### `FrontendBridgeExecutor`

Sub-A implements `ToolExecutor` for a `FrontendBridgeExecutor` that:

1. Emits `agent_tool_pending` with `(turn_id, tool_use_id, name, input)`.
2. Awaits the oneshot keyed by `(turn_id, tool_use_id)`, with the
   same `cancel_token` watched via `tokio::select!` so cancellation
   short-circuits a pending tool call cleanly.
3. Returns `ToolResult { content, is_error }` from the frontend's
   reply.

The bridge is registered in `TurnDriver::run_turn` per turn (so
`request.tools` is honoured exactly: only those tool names the
model is allowed to call). Tools the model invokes outside this
list still hit the registry's miss path → `is_error: true,
content: "tool not found"`.

## 4. Outgoing event channels (already shipped in Phase 2.2)

These are unchanged but documented here so Sub-B has the full
listening surface.

| Channel | Payload | When |
|---|---|---|
| `agent_event` | `AgentEventEnvelope { turnId, seq, event }` | Per assistant event (text delta, thinking, usage, message_stop, error) |
| `agent_turn_complete` | `TurnCompletion` | Once per turn on success |
| `agent_turn_error` | `{ turnId, error }` | Once per turn on cancel/error (cancellation surfaces as `error: "cancelled"`) |
| `agent_tool_pending` | `{ turnId, toolUseId, name, input }` | When the bridge needs the frontend to execute a tool |

## 5. AssistantEvent shape (already shipped)

Internally tagged `#[serde(tag = "type", rename_all = "snake_case")]`.
Variants the frontend MUST handle:

- `text_delta { delta }` — append to current assistant message
- `thinking { text, signature? }` — append to current thinking block
- `tool_use { id, name, input }` — show a tool card in pending state
  *(model announced the call; Rust will then emit `agent_tool_pending`
  on the bridge channel)*
- `usage { input_tokens, output_tokens, ... }` — update usage indicator
- `message_stop { stop_reason }` — close out the current assistant
  message
- `error { message, recoverable }` — show as inline error event

## 6. JSONL persistence

Phase 2.3 keeps Phase 2.2's `<agent_root>/agent_v2/{thread_id}.jsonl`
location. The frontend renders existing history via
`agent_load_thread(threadId)` returning `Vec<ConversationMessage>`.
The legacy thread-service JSONL layer (`<workspace>/.aurora/threads/`)
stays in place for backward compatibility but the new Rust runtime
DOES NOT read or write it. Sub-B switches the chat UI to read from
`agent_load_thread` for any thread that has a v2 log; if the v2 log
is missing, fall back to the legacy `threadService.loadThread` path
(so existing user threads keep rendering until they are touched by
the new runtime, at which point a v2 log is created on first turn).

## 7. What Sub-B is NOT cutting in Phase 2.3

These TS modules MUST keep working — Sub-A depends on the JSON they
produce being passed through unchanged in `AgentChatRequest`:

- `src/services/agent-prompt.ts` (system-prompt composer)
- `src/services/context-builder.ts` (`getIDEContext`, `buildQueryContext`)
- `src/services/agent-execution-mode.ts`
- `src/services/mcp-tools.ts` (the system-prompt summary path)
- `src/tools/definitions/**` (tool schemas — fed into `request.tools`)
- `src/tools/executors/**` (executors — driven by the bridge)
- `src/services/agent-tool-runner.ts` (executor dispatcher with approvals)
- `src/store/useChatStore`, `useThreadStore`, `useTaskStore`, `useCheckpointStore`, `useAuditStore`

What Sub-B DOES cut from `agent-service.ts`:

- The provider.streamChat loop and iteration cap path
- `prepareAgentContext`'s call to `context_*` Rust commands
  (replaced by the new `agent_chat_v2` IPC carrying everything in one shot)
- `recordAssistantResponse` / `runSummarizationIfNeeded` calls into
  the legacy `context_*` commands (the new runtime persists itself;
  summarization moves to Phase 4)

The slimmed-down `agent-service.ts` becomes a façade that constructs
`AgentChatRequest` and delegates to the new `agent-runtime-client.ts`.

## 8. Verification expectations per subagent

### Sub-A
- Standalone verify crate `__verify_phase2_3a/` with at least:
  - All 91 existing `__verify_phase2_2e/` tests still pass with the new factory signature
  - New: `AgentChatRequest` round-trips through serde with the camelCase shape
  - New: `RealApiFactory::build` returns the right `ProviderKind` for each provider_id
  - New: `FrontendBridgeExecutor` emits `agent_tool_pending` and unblocks on `agent_post_tool_result`
  - New: cancelling a turn while parked on a tool bridge returns `RuntimeError::Cancelled` cleanly
  - New: `agent_post_tool_result` for an unknown `(turn_id, tool_use_id)` returns Err
- `cargo check --lib --no-default-features --features cpu-only` clean (only the existing dead-code warns)

### Sub-B
- New `src/services/agent-runtime-client.ts` with focused unit tests
  (Vitest) covering:
  - Building `AgentChatRequest` from real-shaped settings input
  - Subscribing to event channels and routing payloads to mock store
    handlers in the right order
  - Bridge round-trip: receive `agent_tool_pending`, dispatch via
    `agent-tool-runner`, post result via mock invoke
- The chat UI compiles cleanly (`pnpm tsc --noEmit`)
- A manual smoke checklist (printed to the subagent's report) the
  parent agent will run after integration:
  1. Open Aurora, send "hi" — assistant streams a response
  2. Send "read package.json" — `file_read` tool fires through bridge
  3. Stop button cancels mid-stream cleanly
  4. New chat creates a fresh thread with empty history
  5. Existing legacy threads still render (no v2 log path)
