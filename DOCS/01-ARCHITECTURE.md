# Architecture

Aurora is a Tauri desktop IDE with a React/TypeScript frontend and a Rust backend. The current architecture is centered on a Rust-owned provider pipeline: frontend chat code talks to one provider bridge, and Rust owns provider catalog data, request shaping, streaming, cancellation, and local-provider detection.

**Version:** 1.5.0  
**Validated against branch state:** 2026-03-29

## 1. System Overview

Aurora combines:

- Monaco-based editing
- multi-turn AI chat with tool execution
- a Rust context engine for turn management and summarization
- MCP integration
- Git integration
- semantic code search
- local model support through LM Studio and Ollama

The frontend is responsible for UI, state orchestration, and prompt/context assembly. The backend is responsible for persistence, heavy filesystem/process work, and now the full LLM provider kernel.

## 2. Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Frontend | React 18 + TypeScript 5.9 | UI and orchestration |
| Desktop shell | Tauri 2 | Desktop runtime and IPC |
| Backend | Rust | Provider kernel, context engine, persistence, local integrations |
| State | Zustand | Frontend app state |
| Editor | Monaco | Code editing |
| Database | SQLite via `rusqlite` | Providers, threads, themes, settings, workspace state |
| Transport | `reqwest` | Provider HTTP and streaming |
| Search | `aurora-semantic` | Semantic indexing and retrieval |

## 3. Current Directory Shape

```text
src/
├── components/
├── hooks/
├── lib/
├── services/
│   ├── providers/
│   │   ├── base-provider.ts
│   │   ├── index.ts
│   │   ├── provider-defaults.ts
│   │   ├── rust-contract.ts
│   │   ├── rust-message-mapper.ts
│   │   ├── rust-provider.ts
│   │   ├── rust-stream-state.ts
│   │   └── types.ts
│   ├── agent-prompt.ts
│   ├── agent-service.ts
│   ├── local-model-detector.ts
│   └── provider-catalog.ts
├── store/
├── tools/
├── themes/
└── types/

src-tauri/src/
├── commands/
│   ├── local_providers/
│   ├── provider_catalog/
│   └── provider_kernel/
├── context/
├── db/
├── mcp/
├── checkpoints/
└── undo_redo/
```

## 4. Provider Architecture

### Frontend side

The frontend no longer owns per-provider implementations.

- `src/services/providers/index.ts`
  Creates and registers a single `RustProvider`.
- `src/services/providers/rust-provider.ts`
  Thin provider bridge that calls Tauri commands:
  - `aurora_provider_chat`
  - `aurora_provider_stream`
  - `cancel_aurora_provider_stream`
- `src/services/providers/rust-contract.ts`
  Defines the payload contract the frontend sends to Rust.
- `src/services/providers/rust-message-mapper.ts`
  Maps Aurora frontend message shapes to the Rust provider request contract and maps responses back.
- `src/services/providers/rust-stream-state.ts`
  Reassembles streamed content, reasoning text, and tool call deltas from backend events.

### Backend side

Rust owns the provider kernel in `src-tauri/src/commands/provider_kernel/`.

- `types.rs`
  Canonical Aurora provider request/response types
- `presets.rs`
  Provider format detection and endpoint behavior
- `builders.rs`
  Header construction and request body shaping
- `parsers.rs`
  Non-streaming response parsing
- `streaming.rs`
  SSE parsing, chunk emission, usage emission, cancellation tracking
- `commands.rs`
  Tauri entry points

### Supported provider formats

The Rust kernel currently normalizes:

- OpenAI-compatible APIs
- Anthropic-compatible APIs
- local OpenAI-compatible servers with Aurora-specific quirks

Frontend code does not branch on provider implementation anymore. It passes provider config and request data into the Rust kernel.

## 5. Provider Catalog

Built-in provider presets now live in Rust, not in the settings store.

- Rust module: `src-tauri/src/commands/provider_catalog/`
- Frontend bridge: `src/services/provider-catalog.ts`
- Store hydration: `src/store/useSettingsStore.ts`

Current built-in catalog entries:

| ID | Name | Base URL | Requires API Key |
|----|------|----------|------------------|
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | Yes |
| `glm` | GLM-4.7 (Z.AI) | `https://api.z.ai/api/coding/paas/v4` | Yes |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | Yes |
| `minimax` | MiniMax M2.1 | `https://api.minimax.io/anthropic/v1` | Yes |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | Yes |
| `openai` | OpenAI | `https://api.openai.com/v1` | Yes |
| `lmstudio` | LM Studio | `http://localhost:1234/v1` | No |
| `ollama` | Ollama | `http://localhost:11434/v1` | No |

## 6. Local Provider Stack

Local provider detection and Ollama management are Rust-owned.

- Rust module: `src-tauri/src/commands/local_providers/`
- Frontend service: `src/services/local-model-detector.ts`

Rust commands exposed:

- `local_provider_detect`
- `local_provider_probe_custom`
- `local_provider_show_ollama_model`
- `local_provider_get_running_models`
- `local_provider_load_ollama_model`
- `local_provider_unload_ollama_model`
- `local_provider_delete_ollama_model`
- `local_provider_pull_ollama_model`
- `cancel_local_provider_pull`

This means browser `fetch` is no longer the source of truth for LM Studio and Ollama behavior.

## 7. Core Runtime Flow

### Chat request flow

1. User sends a message in `ChatPanel` or `AgentModeLayout`.
2. `AgentService` writes the user turn into the Rust context engine.
3. `composeAgentSystemPrompt()` resolves skills and MCP summary.
4. `context_build_messages` returns the final request message set.
5. `AgentService` calls `provider.streamChat()` on the frontend `RustProvider`.
6. `RustProvider` invokes `aurora_provider_stream`.
7. Rust emits:
   - content chunks
   - reasoning chunks
   - tool call deltas
   - usage
   - error
8. `AgentService` executes tool calls and appends tool results into the context engine.
9. Rust context finalizes the turn and may trigger summarization.

### Local detection flow

1. Settings or startup logic calls `detectLocalProviders()`.
2. Frontend invokes `local_provider_detect`.
3. Rust probes LM Studio and Ollama endpoints.
4. Rust returns normalized provider/model capability data.
5. Settings state updates provider config and capability flags.

## 8. Key Frontend Modules

| Module | File | Responsibility |
|--------|------|----------------|
| Agent orchestration | `src/services/agent-service.ts` | Tool loop, context engine integration, provider calls |
| Provider bridge | `src/services/providers/rust-provider.ts` | Single active provider path |
| Settings state | `src/store/useSettingsStore.ts` | Provider list, selected model, thinking and skills toggles |
| Local model service | `src/services/local-model-detector.ts` | Rust bridge for LM Studio and Ollama |
| Provider catalog bridge | `src/services/provider-catalog.ts` | Loads built-in provider presets from Rust |
| Context builder | `src/services/context-builder.ts` | User info, project layout, rules, skill references |

## 9. Key Backend Modules

| Module | Directory | Responsibility |
|--------|-----------|----------------|
| Provider kernel | `src-tauri/src/commands/provider_kernel/` | Provider request/response normalization |
| Provider catalog | `src-tauri/src/commands/provider_catalog/` | Built-in provider presets |
| Local providers | `src-tauri/src/commands/local_providers/` | Detection and Ollama operations |
| Context engine | `src-tauri/src/context/` | Turn storage, token budgeting, summarization |
| MCP | `src-tauri/src/mcp/` | Server lifecycle and tool calls |
| DB | `src-tauri/src/db/` | SQLite repositories |

## 10. Current Architectural Rules

- Provider-specific transport logic belongs in Rust.
- Frontend provider code stays thin and generic.
- Built-in provider metadata is loaded from Rust, not hardcoded in the store.
- Local provider capability detection is Rust-owned.
- New provider work should extend the Rust kernel, not reintroduce per-provider TypeScript clients.

## 11. Verification State

As of this documentation update:

- `pnpm test` passes
- `pnpm build` passes
- the active provider path is Rust-only
- old TypeScript provider classes are removed

