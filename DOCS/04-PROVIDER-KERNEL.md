# Provider Layer

How Aurora talks to LLM providers. Everything provider-specific lives in Rust; the frontend
never branches on provider identity.

**Updated:** 2026-08-17.

## 1. Goal

One normalized streaming contract regardless of backend — OpenAI, Anthropic, Fireworks,
DeepSeek, GLM, MiniMax, Kenari, OpenAI Responses, LM Studio, Ollama, Codex (ChatGPT), or any
custom-compatible endpoint. The frontend sends a provider snapshot and receives normalized
events.

## 2. The two paths

| Path | Used by | Entry |
|---|---|---|
| **Agent runtime** (main) | Agent Window / IDE chat turns with tools | `agent_chat_v2` → `StreamingApiClient` (`agent_runtime/api_client.rs`) |
| **Generic provider kernel** | Tool-less streaming chat (IDE chat panel) | `aurora_provider_chat` / `aurora_provider_stream` / `cancel_aurora_provider_stream` (`commands/provider_kernel/`) |

Both converge on the same adapter layer below.

## 3. Adapters (`src-tauri/src/api/`)

`client.rs::build_api_client` dispatches on `provider_id` (from `ProviderConfigSnapshot`,
which carries `provider_type` separately from the row id — `effective_provider_type()` is the
only input to wire-shape decisions):

| Adapter | Providers | Notes |
|---|---|---|
| `anthropic.rs` | anthropic, minimax | `/v1/messages` SSE, thinking blocks |
| `responses.rs` | openai-responses | `/responses`, encrypted reasoning replay from signatures |
| `openai_compat.rs` | deepseek, glm, fireworks, openai, lmstudio, ollama, custom | chat-completions shape, `reasoning_content` |
| `deepseek.rs` | deepseek | doc-mandated deviations from the compat shape |
| `codex/` | codex | ChatGPT-subscription OAuth (PKCE, `~/.codex/auth.json`), usage from chatgpt.com |

Supporting modules: `provider_kernel_adapter.rs` + `sse_shared.rs` (shared SSE framing,
body/header builders, error mapping), `pool.rs` (round-robin API-key pool with failover),
`aurora_image.rs` (`<aurora_image>` marker parsing for screenshots/mid-turn images).

## 4. Catalog and presets

- **Runtime wire behavior** is derived from the provider type via the adapters above.
- **Built-in catalog** (what Settings offers by default):
  `src-tauri/src/commands/provider_catalog/types.rs::built_in_provider_presets()` — 10 presets:
  fireworks, glm, anthropic, minimax, deepseek, openai, openai-responses, kenari, lmstudio, ollama.
  Exposed through the single command `provider_catalog_get_presets`.
- **Frontend-integrated providers**: Codex, Atlas Cloud, AgentRouter
  (`src/apps/agent/services/providers/built-in.ts` + per-provider files).
- **Custom providers**: any compatible base URL + key; custom headers/params ride the snapshot
  and override preset defaults.

## 5. Local providers

First-class, not "custom endpoints": `src-tauri/src/commands/local_providers/` —
`local_provider_detect`, `local_provider_probe_custom`, Ollama lifecycle (show / running models
/ load / unload / delete / pull with progress events / cancel pull). Frontend wrapper:
`src/apps/ide/services/local-model-detector.ts`. LM Studio default endpoint
`http://localhost:1234/v1`; Ollama `http://localhost:11434/v1`.

## 6. Per-conversation model + per-model settings

- The model is a property of the **conversation**: `SessionMetadata.model` on the thread
  sidecar (`"providerId:modelKey"`), resolved by `src/apps/agent/lib/thread-model.ts` —
  `useSettingsStore.selectedModel` only seeds new chats.
- Two writers: `thread_set_model` (user pick) and the runtime's per-turn
  `set_workspace_and_model`. The model is deliberately **not** sticky; the workspace root is.
- Per-model temperature (schema v22, NULL = inherit): model → provider `defaultTemperature` →
  `DEFAULT_TEMPERATURE = 0.8`, resolved once in `model-request-config.ts::resolveTemperature`
  (a function, not `??`, so an explicit `0` survives). Claude 5+ reject sampling — Rust strips
  it there regardless.
- Per-model connection test: `provider_test_model` fires one real 64-token turn through
  `build_api_client` (the same factory a turn uses) and reports wire shape, latency, usage.
- Vision gating: `supportsVision` per model (models.dev capability backfill ORs in) gates
  image attachments and vision-required tools.

## 7. Reasoning accounting

`ReasoningReplay` (`api/client.rs`) is the single answer to "what does a stored
`ContentBlock::Thinking` cost the next request", per provider type: `Dropped` (OpenAI
chat-completions family — never re-sent), `Text` (deepseek/glm/openrouter/lmstudio/Anthropic),
`Opaque` (Responses/Codex — replay the encrypted item; signatures priced at
`len / 5` chars-per-token). Every estimator (`estimate_message_tokens`,
`projected_request_tokens`) consults it — never count a signature as text.

## 8. Event model

Normalized chunks stream back with: content deltas, reasoning deltas, tool-call deltas, usage,
finish reason, done. The generic path emits through `RustProvider` listeners
(`src/apps/agent/services/providers/rust-stream-state.ts` reassembles the message); the agent
path wraps them in `AgentEventEnvelope`s on the `agent_event` channel.

Failures are classified from the **body**, not the status alone (`map_status_error` +
`body_names_request_fault` / `body_names_upstream_fault`): relays report dead upstreams as
HTTP 400. Recoverable stream drops retry within one model call (`MAX_STREAM_ATTEMPTS = 3`,
1s/2s backoff); context overflow force-compacts instead of retrying.

## 9. Design rules going forward

- Provider-specific logic goes in Rust adapters; keep the frontend bridge generic.
- New preset → catalog `types.rs`; new wire shape → new adapter in `api/`, wired in
  `build_api_client`.
- Keep `provider_type` (wire shape) decisions separate from `provider_id` (row identity).
- Keep the per-model test button wired to the same resolution the send path uses
  (`model-request-config.ts`) — divergence makes the test meaningless.

## 10. What was removed (do not reintroduce)

- TypeScript provider-specific client classes
- TypeScript preset catalogs as the runtime source of truth
- browser-side local provider probing
- the old generic Rust `llm.rs` proxy path
