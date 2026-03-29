# Provider Kernel

This document now describes the implemented Aurora provider kernel, not just the target idea.

## 1. Goal

Aurora owns its provider contract.

The frontend should not care whether the request goes to OpenAI, Anthropic, Fireworks, DeepSeek, GLM, MiniMax, LM Studio, Ollama, or a custom-compatible endpoint. It should talk to one provider bridge and receive one normalized stream shape back.

## 2. Current Implemented Shape

### Frontend contract

The frontend uses:

- `src/services/providers/rust-provider.ts`
- `src/services/providers/rust-contract.ts`
- `src/services/providers/rust-message-mapper.ts`
- `src/services/providers/rust-stream-state.ts`

The active surface is still:

- `streamChat(request, callbacks)`
- `chat(request)`
- `cancelRequest()`

### Backend contract

Rust owns:

- canonical provider request types
- provider format selection
- request body shaping
- header construction
- streaming byte parsing
- non-streaming response parsing
- cancellation
- usage emission

Implementation lives in:

- `src-tauri/src/commands/provider_kernel/types.rs`
- `src-tauri/src/commands/provider_kernel/presets.rs`
- `src-tauri/src/commands/provider_kernel/builders.rs`
- `src-tauri/src/commands/provider_kernel/parsers.rs`
- `src-tauri/src/commands/provider_kernel/streaming.rs`
- `src-tauri/src/commands/provider_kernel/commands.rs`

## 3. Command Surface

Current Tauri commands:

- `aurora_provider_chat`
- `aurora_provider_stream`
- `cancel_aurora_provider_stream`

These are the only active provider-execution commands the frontend should rely on.

## 4. Aurora Contract Types

Key Rust-side contract types:

- `AuroraProviderConfig`
- `AuroraProviderRequest`
- `AuroraMessage`
- `AuroraToolDefinition`
- `AuroraToolCall`
- `AuroraProviderResponse`
- `AuroraAssistantMessage`
- `AuroraUsage`
- `AuroraStreamChunk`

These are defined in `types.rs` and mirrored by the frontend rust-contract mapper.

## 5. Supported Normalization Paths

The kernel currently handles:

- OpenAI-compatible request/response flow
- Anthropic-compatible request/response flow
- reasoning text from `reasoning` and `reasoning_content`
- assistant `tool_calls`
- tool call deltas while streaming
- tool usage emission
- finish reasons and stream completion

This is the critical shift from the previous architecture: normalization happens in Rust before the frontend sees the stream.

## 6. Presets and Catalog

Provider metadata is split cleanly:

- runtime/provider-format behavior:
  `src-tauri/src/commands/provider_kernel/presets.rs`
- built-in catalog shown to users:
  `src-tauri/src/commands/provider_catalog/types.rs`

That separation matters:

- the kernel decides how to talk to a provider
- the catalog decides what appears in Settings by default

## 7. Local Providers

Local providers are not treated as random custom endpoints.

Dedicated Rust module:

- `src-tauri/src/commands/local_providers/`

Current supported local flows:

- detect LM Studio
- detect Ollama
- probe custom local URLs
- list running Ollama models
- pull Ollama models with progress events
- load and unload Ollama models
- delete Ollama models

Frontend wrapper:

- `src/services/local-model-detector.ts`

## 8. Current Event Model

The frontend receives normalized events through `RustProvider` listeners.

Current event families:

- chunk events
- usage events
- error events

Chunk payloads can contain:

- content
- reasoning content
- tool call deltas
- done flag
- finish reason

`rust-stream-state.ts` is responsible for assembling the final assistant message from those normalized pieces.

## 9. What Was Removed

This provider kernel replaced the previous duplicated structure.

Removed old paths include:

- TypeScript provider-specific classes
- TypeScript provider preset catalog as the runtime source of truth
- old generic Rust `llm.rs` proxy path
- browser-owned local provider probing

The frontend still has provider-related files, but they are generic kernel-bridge files now, not vendor clients.

## 10. Design Rules Going Forward

- add provider-specific logic in Rust
- keep frontend provider code thin
- keep local-provider logic first-class
- split Rust modules by concern
- avoid bloated one-file kernels
- update both provider catalog and runtime presets when built-in provider metadata changes

## 11. Current Gaps and Boundaries

The kernel is implemented, but this is still the practical boundary:

- frontend stores still decide selected model/provider state
- prompt/context assembly remains frontend-owned
- tool execution remains frontend-orchestrated through `AgentService`

That is intentional. The provider kernel owns transport and normalization, not the entire chat application.

## 12. Verification Status

Current branch status at the time of this doc update:

- Rust provider pipeline is the active path
- local provider detection is Rust-owned
- built-in provider catalog is Rust-owned
- `pnpm test` passes
- `pnpm build` passes

