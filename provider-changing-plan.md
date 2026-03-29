# Provider Migration Plan: `aisdk` Integration for Aurora

## Goal

Move provider execution and provider-specific request/response shaping into Rust, using [`aisdk`](https://github.com/lazy-hq/aisdk) where it provides parity, while preserving Aurora's current frontend settings model, agent loop, context engine, tool flow, and local-model UX.

This plan is written against the current repository state in `E:\VOID-EDITOR\jules_aurora-agent-frontend`, not against a generic provider architecture.

## What This Migration Is

- Centralize LLM transport in Rust
- Replace most TypeScript provider-specific HTTP/SSE code
- Preserve the current `AgentService` contract and settings UI
- Keep the current database schema unless a later phase proves a schema change is required

## What This Migration Is Not

- Not a pure "swap one transport for another"
- Not safe to do as a single delete-and-replace change
- Not safe to assume `aisdk` covers every Aurora-specific behavior out of the box

## Current Repo Reality

Aurora currently has provider behavior in multiple layers:

### Frontend provider transport and shaping

- `src/services/providers/openai-provider.ts`
- `src/services/providers/anthropic-provider.ts`
- `src/services/providers/lmstudio-provider.ts`
- `src/services/providers/base-provider.ts`
- `src/services/providers/provider-presets.ts`
- `src/services/providers/index.ts`
- `src/services/providers/types.ts`

### Agent integration

- `src/services/agent-service.ts`

`AgentService` currently depends on:

- `provider.streamChat(...)`
- `provider.chat(...)`
- `provider.cancelRequest()`
- assistant `reasoning_content`
- assistant `tool_calls`
- tool-call round trips across turns
- non-streaming summarization calls

### Persisted provider config and UI

- `src/store/useSettingsStore.ts`
- `src/components/modals/SettingsPanel.tsx`
- `src/components/settings/LocalProviderPanel.tsx`
- `src/services/local-model-detector.ts`
- `src/types/database.ts`

The current app persists and actively uses:

- `providerType`
- `baseUrl`
- `apiKey`
- `model`
- `customModels`
- `modelAliases`
- `contextWindow`
- `maxOutputTokens`
- `customHeaders`
- `customParams`
- `defaultTemperature`
- `defaultMaxTokens`
- `supportsThinking`
- `supportsToolStream`
- `requiresApiKey`

### Existing Rust transport surface

- `src-tauri/src/commands/llm.rs`
- `src-tauri/src/commands/openai_native.rs`
- `src-tauri/src/lib.rs`

Current Rust behavior already includes:

- generic streaming proxy with cancellation
- local OpenAI-compatible streaming path
- LM Studio reasoning normalization from both `reasoning` and `reasoning_content`
- event-based chunk delivery to the frontend

## Key Constraints

### 1. Message conversion parity is mandatory

Aurora does not only send "messages". It currently performs provider-specific message conversion:

- OpenAI-compatible path preserves assistant `tool_calls`
- OpenAI-compatible path preserves tool `tool_call_id`
- OpenAI-compatible path preserves `reasoning_content`
- OpenAI-compatible path sometimes sends assistant `content = null` for tool-call turns
- GLM currently gets `tool_stream = true`
- Anthropic path converts tool results to `tool_result` blocks
- Anthropic path converts assistant tool calls to `tool_use` blocks

This logic must move to Rust before the TypeScript providers can be removed.

### 2. Settings compatibility is mandatory

The settings UI cannot truly remain "unchanged" unless the Rust layer preserves the current provider config contract.

### 3. Local provider behavior is part of the migration scope

LM Studio and Ollama are not just "OpenAI-compatible". Aurora currently has local-model-specific behavior:

- dynamic local model discovery
- local thinking capability toggles
- optional API key handling
- LM Studio reasoning normalization
- selective `stream_options` support

### 4. `aisdk` parity must be proven, not assumed

Context7 documentation for `/lazy-hq/aisdk` confirms:

- OpenAI, Anthropic, DeepSeek, Groq provider support
- dynamic OpenAI-compatible builders with `base_url`
- streaming text responses
- reasoning chunks
- tool-enabled flows

But the docs reviewed do **not** clearly prove parity for:

- custom request headers
- arbitrary extra request body params
- explicit cancellation APIs
- exact Aurora-compatible multi-turn tool message reconstruction

Those are spike items, not assumptions.

## Migration Strategy

Use a staged migration with parity gates. Do not delete the existing TypeScript providers until the Rust path is verified provider by provider.

## Phase 0: Capability Spike

### Objective

Prove where `aisdk` can replace Aurora logic directly and where Aurora still needs custom Rust adapters.

### Deliverables

- Add `aisdk` to `src-tauri/Cargo.toml`
- Create a small isolated spike module under `src-tauri/src/llm_runtime/`
- Verify compilation and one streaming request against:
  - OpenAI
  - Anthropic
  - one OpenAI-compatible local endpoint

### Questions to answer before full migration

- Can we inject arbitrary headers for custom providers?
- Can we inject arbitrary request body fields for `customParams`?
- Can we preserve GLM/DeepSeek/Fireworks special params?
- Do we need our own cancellation registry around the `aisdk` stream task?
- Can we reconstruct Aurora's exact assistant-tool/tool-result message chain in Rust?

### Decision gate

If `aisdk` cannot support `customHeaders` or `customParams` cleanly, do **not** force all providers onto it.

Fallback:

- Use `aisdk` for first-class providers where it fits
- Keep a custom Rust `reqwest` path for `custom`, LM Studio, or any provider needing raw compatibility

## Phase 1: Introduce a Rust LLM Runtime Layer

### New Rust modules

- `src-tauri/src/llm_runtime/mod.rs`
- `src-tauri/src/llm_runtime/types.rs`
- `src-tauri/src/llm_runtime/provider_factory.rs`
- `src-tauri/src/llm_runtime/message_mapper.rs`
- `src-tauri/src/llm_runtime/tool_mapper.rs`
- `src-tauri/src/llm_runtime/streaming.rs`

### Responsibilities

#### `types.rs`

Define Aurora-owned Rust-side types for:

- provider config input
- Aurora chat messages
- Aurora tool definitions
- stream events
- usage payload

These should mirror the TypeScript provider contract closely enough that `AgentService` does not need conceptual changes.

#### `provider_factory.rs`

Map Aurora `providerType` and config to one of:

- `aisdk` provider instance
- custom Rust adapter for unsupported cases

#### `message_mapper.rs`

Move current TypeScript message conversion into Rust:

- Aurora message -> OpenAI-compatible request message
- Aurora message -> Anthropic content blocks
- provider response -> Aurora assistant message

#### `tool_mapper.rs`

Normalize tool schemas and tool call delta handling across providers.

#### `streaming.rs`

Own:

- chunk emission
- usage emission
- error emission
- request cancellation bookkeeping
- final done event

## Phase 2: Add New Tauri Commands Without Removing Old Ones

### New commands

- `llm_runtime_stream`
- `llm_runtime_chat`
- `cancel_llm_runtime_stream`

### Files to modify

- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/mod.rs`

### Important rule

Do not remove:

- `llm_stream_request`
- `cancel_llm_stream`
- `openai_native_stream`
- `openai_native_chat`

yet.

They remain as fallback and rollback paths until parity is proven.

## Phase 3: Add a Single TypeScript Bridge Provider

### New frontend file

- `src/services/providers/rust-provider.ts`

### Purpose

Implement the existing `IProvider` interface but delegate transport to the new Rust commands.

It must support:

- `streamChat`
- `chat`
- `cancelRequest`
- the existing callback model:
  - `onStart`
  - `onToken`
  - `onThinking`
  - `onToolCall`
  - `onUsage`
  - `onError`
  - `onComplete`

### Files to modify

- `src/services/providers/index.ts`

### Strategy

Keep `createProvider(config)` intact at the call site, but route migrated providers to `RustProvider`.

This minimizes churn in:

- `src/services/agent-service.ts`
- `src/components/chat/ChatPanel.tsx`
- `src/components/agent/AgentModeLayout.tsx`

## Phase 4: Preserve the Current Settings Contract

### Files that remain authoritative

- `src/store/useSettingsStore.ts`
- `src/components/modals/SettingsPanel.tsx`
- `src/components/settings/LocalProviderPanel.tsx`
- `src/types/database.ts`

### Requirement

The Rust runtime must accept and honor the provider fields already produced by `getLLMConfig()`.

That means this migration is **not** allowed to silently drop:

- `customHeaders`
- `customParams`
- `defaultTemperature`
- `defaultMaxTokens`
- `supportsThinking`
- `supportsToolStream`
- `requiresApiKey`

### Database impact

No schema change is required in the first migration.

The existing `DbLLMProvider` shape already contains the fields Aurora needs. Keep the schema stable until the new runtime is proven.

## Phase 5: Provider-by-Provider Cutover

Migrate in this order:

1. OpenAI
2. Anthropic
3. DeepSeek
4. GLM
5. Fireworks
6. MiniMax
7. LM Studio
8. Ollama
9. Custom provider

### Why this order

- OpenAI and Anthropic are the cleanest parity targets
- GLM / DeepSeek / Fireworks have Aurora-specific request quirks
- LM Studio / Ollama have local-server quirks
- `custom` is the hardest to guarantee because it relies on user-supplied compatibility

### Rule

Do not cut over `custom` until `customHeaders` and `customParams` parity is proven.

## Phase 6: Validation Matrix

Run the following checks after each provider cutover.

### Request/response parity

- basic non-streaming chat works
- streaming chat works
- reasoning chunks appear where expected
- usage events still arrive
- cancellation stops generation cleanly

### Tool calling parity

- model emits tool call
- tool name and partial args stream correctly
- tool result is accepted by the next request
- follow-up assistant turn completes correctly

### Context-engine parity

- turn recording still works
- summarization still uses `provider.chat(...)`
- summarized threads still replay correctly

### Settings/UI parity

- provider can be edited in Settings
- custom model list still works
- local model detection still updates provider settings
- no regression in ready/not-ready states

### Commands

- `pnpm lint`
- `pnpm build`
- `pnpm test`
- `pnpm tauri:build` or at minimum a Rust compile gate for the new modules

## Phase 7: Cleanup Only After Full Parity

### Candidates for deletion after parity is proven

- `src/services/providers/openai-provider.ts`
- `src/services/providers/anthropic-provider.ts`
- `src/services/providers/lmstudio-provider.ts`
- `src-tauri/src/commands/openai_native.rs`

### Candidates to keep unless parity is proven unnecessary

- `src/services/providers/provider-presets.ts`
- `src/services/providers/base-provider.ts`

These should only be removed if their responsibilities are fully replaced in Rust.

### Legacy cleanup candidate

This repo still contains an older, mostly separate provider path:

- `src/services/llm-provider.ts`
- `src/services/llm-types.ts`

Those files should be audited after the new runtime is live. If they are truly unused, remove them in a separate cleanup commit.

## Files To Modify

### Rust

- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/llm_runtime/mod.rs`
- `src-tauri/src/llm_runtime/types.rs`
- `src-tauri/src/llm_runtime/provider_factory.rs`
- `src-tauri/src/llm_runtime/message_mapper.rs`
- `src-tauri/src/llm_runtime/tool_mapper.rs`
- `src-tauri/src/llm_runtime/streaming.rs`

### TypeScript

- `src/services/providers/index.ts`
- `src/services/providers/types.ts`
- `src/services/providers/rust-provider.ts`

### Likely unchanged structurally, but must be verified

- `src/services/agent-service.ts`
- `src/store/useSettingsStore.ts`
- `src/components/modals/SettingsPanel.tsx`
- `src/components/settings/LocalProviderPanel.tsx`

## Files Not In Scope For Initial Migration

- `src-tauri/src/context/*`
- `src-tauri/src/mcp/*`
- `src-tauri/src/checkpoints/*`
- `src-tauri/src/undo_redo/*`
- `src/tools/*`
- UI layout and theme systems

## Rollback Plan

Rollback must remain possible until Phase 7 completes.

### Requirements

- keep old Tauri commands registered during migration
- keep old TS providers on disk during migration
- gate provider routing in `createProvider(...)`
- migrate provider-by-provider, not all at once

If a migrated provider fails parity, route that provider type back to its current implementation and continue with the others.

## Final Recommended Execution Order

1. Add `aisdk` and run a capability spike
2. Build Rust-owned Aurora message/tool/event types
3. Add new runtime Tauri commands with cancellation
4. Add `RustProvider` in TypeScript
5. Route one provider type through the new runtime
6. Verify streaming, tools, summarization, and cancellation
7. Migrate remaining provider types one by one
8. Only then remove old provider files
9. Audit and remove legacy `src/services/llm-provider.ts` stack separately

## Bottom Line

The correct migration for this repo is:

- staged
- parity-gated
- Rust-first but not Rust-only by assumption
- settings-compatible
- tool-call-compatible
- local-model-compatible

Anything more aggressive than that is likely to break Aurora's current agent loop or provider settings model.
