# Code Style & Patterns

This document describes the current implementation patterns that matter in this repo after the Rust provider-kernel migration.

## 1. Naming

| Entity | Convention | Example |
|--------|------------|---------|
| TypeScript files | kebab-case | `agent-service.ts` |
| Rust modules | snake_case | `provider_kernel`, `local_providers` |
| React components | PascalCase | `ChatPanel.tsx` |
| Zustand stores | `use` prefix | `useSettingsStore.ts` |
| Services | noun or domain service | `provider-catalog.ts`, `local-model-detector.ts` |
| Tauri commands | verb-oriented snake_case | `aurora_provider_stream` |

## 2. Organize by Concern, Not by Dumping Ground

The current codebase is moving toward small files per concern.

Good examples:

- `src/services/providers/rust-provider.ts`
- `src/services/providers/rust-message-mapper.ts`
- `src/services/providers/rust-stream-state.ts`
- `src-tauri/src/commands/provider_kernel/builders.rs`
- `src-tauri/src/commands/provider_kernel/parsers.rs`
- `src-tauri/src/commands/provider_kernel/streaming.rs`
- `src-tauri/src/commands/local_providers/detect.rs`
- `src-tauri/src/commands/local_providers/ollama.rs`

Rule:

- split transport, mapping, parsing, and orchestration into separate files
- do not rebuild giant provider files or giant catch-all command modules

## 3. Frontend/Backend Boundary Pattern

Aurora now uses a thin frontend bridge over Rust for provider-related work.

Preferred pattern:

1. frontend service or store gathers app state
2. frontend maps state into a narrow invoke payload
3. Rust command module owns provider-specific behavior
4. frontend receives normalized data only

Example domains using this pattern:

- provider catalog
- provider streaming
- local model detection
- Ollama operations

## 4. Provider Pattern

Current rule:

- frontend owns one provider implementation: `RustProvider`
- Rust owns provider-specific logic

Do:

- extend `src-tauri/src/commands/provider_kernel/`
- keep `src/services/providers/` generic
- keep message mapping and stream assembly isolated

Do not:

- add new `openai-provider.ts` / `anthropic-provider.ts` style classes
- hardcode provider presets in Zustand
- bypass the Rust provider kernel from the UI

## 5. Tauri Command Pattern

Use small command entry points that delegate to focused modules.

Pattern:

```rust
#[tauri::command]
pub async fn some_command(args: Args) -> Result<Response, String> {
    inner_module::do_work(args).await
}
```

Keep these concerns separate:

- command registration
- request building
- HTTP logic
- stream parsing
- emitted events
- type definitions

## 6. Zustand Store Pattern

Stores are responsible for:

- UI-facing state
- persistence coordination
- invoking services

Stores should not become protocol implementations.

Current examples:

- `useSettingsStore.ts` owns selected provider/model state
- provider presets are loaded through `providerCatalogService`
- `useThemeStore.ts` now degrades cleanly in non-Tauri test environments instead of assuming Tauri exists

## 7. Error Handling

Frontend:

- normalize errors close to the boundary
- keep user-facing fallbacks concise
- do not let transport-specific errors leak into components if a service can normalize them

Rust:

- return `Result<T, String>` for Tauri commands
- keep parsing/building helpers explicit
- emit stream errors through event channels before returning command failure when needed

## 8. Async Patterns

TypeScript:

- use `async/await`
- batch independent reads with `Promise.all`
- keep stream state in dedicated objects, not ad hoc mutable component logic

Rust:

- split async HTTP work from sync shaping/parsing helpers
- keep command functions thin

## 9. Configuration Pattern

Current provider configuration sources:

- built-in provider presets from Rust provider catalog
- persisted provider rows in SQLite
- local capability updates from Rust local-provider detection

Avoid stale config duplication.

If provider metadata changes, update:

- `src-tauri/src/commands/provider_catalog/types.rs`
- any matching frontend types in `src/services/provider-catalog.ts`
- settings hydration logic in `src/store/useSettingsStore.ts`

## 10. Testing Pattern

When behavior is boundary-heavy, test the seam.

Examples:

- stream and response mapping logic
- theme validation and integration behavior
- skill prompt composition
- tool runner behavior

Recent stabilization fixes reinforced two rules:

- test mode must not assume Tauri exists
- tests should match the real runtime contract, not an older prompt shape

## 11. Documentation Pattern

When architecture changes materially, update docs by replacing stale sections rather than layering patches over obsolete mental models.

For provider changes specifically:

- architecture docs
- expansion docs
- provider-kernel docs
- getting-started docs

must stay aligned with the Rust-owned pipeline.

