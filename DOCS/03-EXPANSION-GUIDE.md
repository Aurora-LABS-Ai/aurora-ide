# Expansion Guide

This guide reflects the current architecture. The important change is that provider expansion is now Rust-first.

## 1. Daily Commands

| Command | Purpose |
|---------|---------|
| `pnpm tauri:dev` | Run desktop app with Tauri + Vite |
| `pnpm dev` | Frontend-only dev server |
| `pnpm test` | Run Vitest |
| `pnpm build` | Frontend production build |
| `pnpm tauri:build` | Build desktop installer |

## 2. General Feature Checklist

- add or update frontend UI under `src/components/`
- add or update state in the relevant store under `src/store/`
- add a frontend service under `src/services/` if the feature needs orchestration
- add Rust commands under `src-tauri/src/commands/` if desktop capabilities or backend ownership are needed
- register new commands in `src-tauri/src/lib.rs`
- add tests if the feature changes behavior at a service or store boundary
- update `DOCS/` when architecture or extension steps change

## 3. Adding a New Provider

Do not add a new TypeScript provider class.

### Backend steps

1. Add or extend the preset/config logic in:
   - `src-tauri/src/commands/provider_catalog/types.rs`
   - `src-tauri/src/commands/provider_kernel/presets.rs`

2. If the provider is OpenAI-compatible or Anthropic-compatible:
   - extend existing request shaping in `builders.rs`
   - extend parsing/streaming behavior in `parsers.rs` and `streaming.rs`

3. If the provider has unique quirks:
   - add a focused helper module or helper function in `provider_kernel/`
   - do not bloat `commands.rs`

4. If the provider should appear in Settings by default:
   - add it to `built_in_provider_presets()` in `provider_catalog/types.rs`

### Frontend steps

Usually no new provider class is needed.

Only update frontend if required:

- `src/services/provider-catalog.ts` types if new fields are added
- `src/store/useSettingsStore.ts` if preset hydration rules change
- provider settings UI if the provider introduces new user-visible config

## 4. Adding a New Local Provider

If the provider is local-model related, treat it as a first-class local adapter.

Use:

- `src-tauri/src/commands/local_providers/detect.rs`
- `src-tauri/src/commands/local_providers/http.rs`
- `src-tauri/src/commands/local_providers/types.rs`

If it supports lifecycle actions like Ollama:

- add a dedicated file similar to `ollama.rs`
- expose commands through `commands.rs`
- wrap them in `src/services/local-model-detector.ts`

Do not hide local-provider logic inside generic provider code if it needs detection, probing, or model management.

## 5. Adding a New Tauri Command Domain

Preferred structure:

```text
src-tauri/src/commands/my_domain/
├── commands.rs
├── mod.rs
├── types.rs
└── helpers.rs
```

Pattern:

- `commands.rs` for Tauri entry points
- `types.rs` for payloads
- helper files for real logic
- `mod.rs` for exports

Then register in `src-tauri/src/lib.rs`.

## 6. Adding a Frontend Service

Good service responsibilities:

- bridge to Tauri
- request/response mapping
- stream-state assembly
- domain-specific orchestration

Bad service responsibilities:

- giant mixed UI and protocol logic
- hardcoded provider presets duplicated from Rust
- hidden persistence logic that belongs in stores or Rust

## 7. Adding a Tool

1. Define the schema under `src/tools/definitions/`
2. Implement the executor under `src/tools/executors/`
3. Register it through the tool registry
4. Verify risk level and approval behavior
5. Test agent execution flow if the tool materially changes chat behavior

## 8. Adding Settings

Use the existing persistence pattern:

- add frontend type/state in `useSettingsStore.ts`
- ensure DB persistence paths exist
- if the setting is backend-owned, keep the source of truth in Rust and only hydrate/use it in the store

Provider-related settings should prefer Rust ownership whenever they affect provider behavior.

## 9. Files to Touch for Current Provider Work

### Frontend

- `src/services/providers/rust-provider.ts`
- `src/services/providers/rust-message-mapper.ts`
- `src/services/providers/rust-stream-state.ts`
- `src/services/provider-catalog.ts`
- `src/services/local-model-detector.ts`
- `src/store/useSettingsStore.ts`

### Rust

- `src-tauri/src/commands/provider_kernel/`
- `src-tauri/src/commands/provider_catalog/`
- `src-tauri/src/commands/local_providers/`

## 10. Verification Checklist

Before you claim a provider-related change is done:

- run `pnpm test`
- run `pnpm build`
- if Rust changed, run `cargo check --manifest-path src-tauri/Cargo.toml`
- verify at least one real provider path if the change touched live provider behavior

## 11. Current Anti-Patterns

Avoid reintroducing:

- per-provider TypeScript clients
- store-owned provider preset catalogs
- browser-side local provider probing
- one-file Rust command modules that mix types, HTTP, parsing, and command handlers

