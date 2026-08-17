# Expansion Guide

How to add things to Aurora, against the current architecture (apps/kernel frontend, Rust-owned
runtime and tools). The general rule: put code in the module that owns the concern, and keep
the model-facing surface single-sourced from Rust.

## 1. Daily Commands

| Command | Purpose |
|---------|---------|
| `pnpm tauri:dev` | Run desktop app with Tauri + Vite |
| `pnpm dev` | Frontend-only dev server |
| `pnpm test` | Run Vitest |
| `pnpm build` | Frontend production build |
| `pnpm tauri:build` | Build desktop installer |
| `cargo check --lib --tests` (in `src-tauri/`) | Fast Rust gate |

## 2. General Feature Checklist

- frontend UI under `src/apps/<product>/components|features/…` (concern-grouped, never a folder root)
- state in the owning store (`src/kernel/store/` if shared, else `src/apps/<product>/store/<concern>/`)
- a frontend service under `src/apps/<product>/services/<concern>/` if orchestration is needed
- Rust commands under `src-tauri/src/commands/` if backend ownership is needed — **registered in `lib.rs` `generate_handler!`**
- tests at the seam you changed; update `DOCS/` when architecture or extension steps change

## 3. Adding a Native Agent Tool

1. Implement in the owning bucket `src-tauri/src/tools/<bucket>/` (create the bucket if a new
   domain; add its `mod` to `tools/mod.rs`).
2. Add the name to the bucket's `TOOL_NAMES` const.
3. Bump `BUILTIN_TOOL_COUNT` and the derived `count_without_browser` in `tools/mod.rs` — tests
   assert the arithmetic.
4. Wrap with `install_permission_gate` if it mutates anything; declare its risk level in
   `src/apps/agent/tools/definitions/risk-levels-enhanced.ts` (metadata for the UI).
5. Give it a transcript presence: icon mapping (`AgentIcon` + `toolIcon()`), a result branch in
   `tool-result.ts` (say *which* answer came back), and a dynamic title in `ToolCallCard` if the
   label depends on arguments.
6. Tests: bucket-level unit tests + card/parser tests frontend-side.

Tool descriptions are executable policy — when a tool's guidance changes, update the
description in the same change, and **replace** (don't supplement) prompt lines that point the
model at an older way.

## 4. Adding a Frontend-Bridged Tool

For tools whose state lives in the window (MCP, team UI, skills, ask_question):

1. Define the schema in `src/apps/agent/tools/definitions/<domain>-tools.ts`.
2. Implement the executor in `src/apps/agent/services/<concern>/`.
3. The runtime bridges it automatically: any `AllowedTool` carried on the request gets a
   `FrontendBridgeExecutor`; results return via `agent_post_tool_result`.

## 5. Adding a New Provider

Do **not** add a TypeScript provider class.

1. Wire format: extend `src-tauri/src/api/` — usually `openai_compat.rs` covers an
   OpenAI-compatible endpoint; a genuinely different wire shape gets its own adapter file
   registered in `client.rs::build_api_client`.
2. Catalog entry (Settings by default): add to `built_in_provider_presets()` in
   `src-tauri/src/commands/provider_catalog/types.rs`.
3. Frontend only if user-visible config appears: types in
   `src/apps/agent/services/providers/`, hydration in `useSettingsStore`.
4. Reasoning replay policy: if the provider streams thinking differently, extend
   `ReasoningReplay` (`api/client.rs`) — never leave it implicit.
5. Local-model providers (detection, lifecycle) go in `src-tauri/src/commands/local_providers/`
   as a first-class adapter, not a "custom endpoint" hack.

## 6. Adding a Tauri Command Domain

```text
src-tauri/src/commands/my_domain/
├── mod.rs          # exports (+ module doc)
├── commands.rs     # #[tauri::command] entry points (thin)
├── types.rs        # payloads
└── …               # real logic in focused files
```

Then register in `src-tauri/src/lib.rs` `generate_handler!`. Anything touching disk/DB must be
`async` (sync commands run on the UI thread — the thread-safety test enforces this). Add an
arm to `commands/command_thread_safety.rs` if the command can block.

## 7. Adding Settings

Backend-owned (preferred when behavior depends on it): add a field to `AppSettings`
(Rust `settings.rs`: struct + read arm + save call), then hydrate/use from
`useSettingsStore`. Follow the exact round-trip pattern of an existing field
(e.g. `titleMaker*`, `allowOutsideWorkspace`).

Agent-window UI settings are declared once in `src/apps/agent/settings/settings-catalog.ts`
(leaf, no JSX) — Settings search and the command center both read that catalog; a second list
will drift.

## 8. Adding an IDE Theme Token

Follow `DOCS/theme-dev.md` §"Adding a new token": type → both default token sets → every
built-in theme JSON → (optional) Tailwind alias / Monaco mapping → doc table. The agent window
has its own token set (`src/apps/agent/theme/tokens.ts` → `--agw-*`); a new visual role there
means a token, never a hardcoded value.

## 9. Verification Checklist

Before claiming done:

- `pnpm test`, `pnpm build` (and `tsc -b` implicitly via build)
- Rust changed → `cargo check --lib --tests`, plus `cargo test --lib` for the touched modules
- new/changed tool → its card renders and its result parses
- provider change → `scripts/probe-provider.mjs` or a real turn against a live endpoint
- UI change → eyes in `pnpm tauri:dev` (most Rust changes need a restart; frontend hot-reloads)

## 10. Anti-Patterns to Refuse

- per-provider TypeScript clients; store-owned provider catalogs
- advertising native tools from TS definitions (Rust registry is the only roster source)
- one-file Rust command modules mixing types, HTTP, parsing, and handlers
- Tailwind utilities or hardcoded colors in the agent window
- files dropped at a folder root instead of the concern that owns them
- new CSS partials without a numeric prefix, or reordering existing ones (cascade order is load-bearing)
