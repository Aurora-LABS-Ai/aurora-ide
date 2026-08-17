# Architecture

Aurora is a Tauri 2 desktop IDE with a React/TypeScript frontend and a Rust backend. The Rust side owns the agent turn loop, provider streaming, tools, persistence, MCP, the tree-sitter code index, checkpoints, and the browser runtime. The frontend owns UI, state orchestration, and prompt/context assembly.

**Version:** 2.0.0
**Validated against working tree:** 2026-08-17 (branch `split-css`)

## 1. System Overview

Aurora combines:

- a Monaco-based editor (tabs, explorer, terminal, Git)
- a conversation-first Agent Window (transcript, composer, right dock: Review / Canvas / Files / Browser / Terminal)
- a Rust agent runtime driving multi-turn tool loops (agent / plan / team modes)
- MCP integration, checkpoints, undo/redo, structural code indexing, local speech input

Both surfaces ship from one bundle: `src/App.tsx` branches on `window.location.pathname === "/agent-window"` — `/` mounts `MainLayout` (IDE), `/agent-window` mounts `AgentWindow`. No router library; it is a pathname check.

## 2. Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Frontend | React 18.3 + TypeScript 5.9 (Vite 8) | UI and orchestration |
| Desktop shell | Tauri 2 (Rust 2021, toolchain 1.92.0) | Desktop runtime and IPC |
| Backend | Rust | Agent loop, providers, tools, persistence |
| State | Zustand 5 | Frontend app state (~30 stores) |
| Editor | Monaco | Code editing (IDE only) |
| Sessions | JSONL files | Chat history (one file per thread) |
| Database | SQLite via `rusqlite` (schema v22) | Providers, settings, workspace state, themes |
| Transport | `reqwest` + eventsource-stream | Provider HTTP and SSE streaming |
| Search | `code_index` (tree-sitter) + vendored ripgrep sidecar | Structural symbol index and text search |

## 3. Current Directory Shape

```text
src/
├── apps/
│   ├── ide/        The editor: app/ (shell) features/ hooks/ lib/ services/ store/ ui/
│   └── agent/      The agent window: components/ services/ store/ hooks/ lib/
│                   settings/ adapters/ shared/ theme/ tools/
├── kernel/         Shared floor: ui/ lib/ store/ services/ types/
├── bridge/         agent <-> IDE glue (events -> Monaco, writes -> editor)
├── canvas-sdk/     Live-canvas SDK (consumed as TEXT by vite-canvas-plugin.ts at repo root)
└── themes/         Built-in IDE theme JSON

src-tauri/src/
├── agent_runtime/  Turn loop: conversation/ (mod, compaction, tool_exec, tool_results,
│                   context_injection, tokens, trim), session, session_store, bridge, ipc,
│                   events, types, api_client, tool_executor, recovery, context_limits,
│                   title, hooks, tool_pairing, tool_spill, tool_suggest, team/
├── api/            Provider adapters: anthropic, responses, openai_compat, deepseek, codex/,
│                   provider_kernel_adapter, pool (key rotation), client (build_api_client)
├── commands/       Tauri IPC (289 commands): agent_v2/, provider_kernel/, provider_catalog/,
│                   local_providers/, git, threads, settings, checkpoints, undo_redo, …
├── tools/          41 native tools in 11 buckets + permissions gate + tool_search
├── mcp/            MCP client (rmcp 0.1): stdio, SSE, streamable HTTP
├── code_index/     tree-sitter structural index (format v6)
├── checkpoints/    Git-CLI shadow-repo snapshots
├── undo_redo/      Per-file history stacks
├── explorer/       File explorer backend
├── agent_safety/   Bash/shell/path validation
├── context/        Legacy turn-based context engine (still registered)
├── plans/          Plan documents in the workspace (.aurora/plans/)
├── services/       api_converter, token_service, browser_runtime, webview_recovery, …
├── shell/          Shell discovery (Windows Terminal profiles, PATH, registry)
├── prompt_refine/  Local llama.cpp composer rewriter
├── typing_assist/  SymSpell autocorrect/completion
├── crash.rs        Fatal-crash reporter (Windows SEH)
└── logging.rs      aurora.log (5 MiB rotate) + UI error sink
```

### Module boundaries (enforced)

`apps/* → kernel`, never back; `apps/ide ↮ apps/agent`. Enforced at `error` level by
`no-restricted-imports` in `eslint.config.js`. Exemptions: `App.tsx`/`main.tsx` (router),
`apps/ide/app/TitleBar.tsx` (window launcher), `bridge/**`, and
`kernel/store/useSettingsStore.ts` (known debt: ~2,100-line god store awaiting a split — the
one place kernel still imports agent services).

## 4. Agent Path (the main event)

```text
Composer (AgentComposer)
  → useAgentWindowSend → AgentService façade (src/apps/agent/services/runtime/agent-service.ts)
      composes system prompt (agent-prompt.ts), context (context-builder.ts),
      model config (model-request-config.ts), tool roster (buildAvailableTools)
  → agent-runtime-client.ts invokes Tauri command agent_chat_v2
  → commands/agent_v2/turn_driver.rs (TurnDriver) builds RuntimeConfig + per-turn ToolRegistry
  → agent_runtime/conversation/mod.rs :: ConversationRuntime::run_turn
      streams from StreamingApiClient (api/ adapters), executes tool batches,
      injects <repo_map>/<ide_context>/<aurora_task_reminder>, compacts when over budget
  → events flow back on 4 channels: agent_event, agent_tool_pending,
      agent_turn_complete, agent_turn_error
```

Tool execution is split:

- **Native (41 Rust tools)** run in-process behind the permission gate
  (`install_permission_gate`, consulting the `tool_settings` table).
- **Bridged tools** (MCP, team, skills, ask_question) round-trip through
  `agent_tool_pending` + `agent_post_tool_result` to frontend executors.

Sessions persist as JSONL (journaled per-message) under `%LOCALAPPDATA%\AuroraIDE\sessions\`,
with `.meta.json` (title/model/usage) and `.rich.jsonl` (full-fidelity tool results) sidecars.
Compaction keeps a 40k-token verbatim tail (floored at window/4), shares the conversation's
prompt cache when possible, and learns each endpoint's real context ceiling into
`<root>/limits/context-limits.json`.

## 5. Provider Architecture

Two Rust-owned paths; no per-provider TypeScript clients exist.

### Agent turns

`agent_runtime/api_client.rs` defines the `StreamingApiClient` trait; `api/client.rs::build_api_client`
dispatches on provider id to an adapter:

| Adapter | Providers | Shape |
|---|---|---|
| `anthropic.rs` | anthropic, minimax | `/v1/messages` SSE, thinking blocks |
| `responses.rs` | openai-responses | `/responses`, encrypted reasoning replay |
| `openai_compat.rs` | deepseek, glm, fireworks, openai, lmstudio, ollama, custom | chat-completions, `reasoning_content` |
| `deepseek.rs` | deepseek | doc-mandated deviations |
| `codex/` | codex | ChatGPT OAuth (PKCE), usage from chatgpt.com |

`pool.rs` rotates API keys with failover. `ReasoningReplay` (api/client.rs) is the single
answer to what a stored thinking block costs the next request per provider.

### Generic chat path (IDE chat, no tools)

`commands/provider_kernel/` — `aurora_provider_chat`, `aurora_provider_stream`,
`cancel_aurora_provider_stream`. The frontend `RustProvider`
(`src/apps/agent/services/providers/rust-provider.ts`) is the thin bridge.

### Catalog and local models

- Built-in presets (10): `commands/provider_catalog/types.rs::built_in_provider_presets` —
  fireworks, glm, anthropic, minimax, deepseek, openai, openai-responses, kenari, lmstudio, ollama.
- Frontend additions: Codex, Atlas Cloud, AgentRouter (`src/apps/agent/services/providers/built-in.ts`).
- Local detection and Ollama lifecycle: `commands/local_providers/` (detect, probe, pull/load/unload/delete).
- The model is a property of the **conversation** (`SessionMetadata.model`, resolved via
  `src/apps/agent/lib/thread/thread-model.ts`); `useSettingsStore.selectedModel` only seeds new chats.
- Per-model temperature (schema v22) resolves model → provider default → `DEFAULT_TEMPERATURE`
  in `model-request-config.ts::resolveTemperature`.

## 6. Tool System

41 native tools (`tools/mod.rs`, `BUILTIN_TOOL_COUNT = 41`):

| Bucket | Tools |
|---|---|
| file_workspace_search (10) | file_read, file_edit, file_write, move_path, delete_path, glob, grep, workspace_tree, folder_create, auroro_websearch |
| shell_editor_todo (7) | shell_execute, shell_spawn, shell_kill, shell_list_processes, shell_read_output, read_lints, todo |
| browser (16) | navigate, view, screenshot, click, fill, scroll, hover, press_key, set_viewport, emulate_media, page_outline, inspect_element, a11y_tree, get_console_logs, status, guidelines |
| plan (3) | plan_write, plan_read, plan_step_update |
| code_intel (1) | code (definition / usages / outline / modules / refresh) |
| design, canvas, transcript (3) | design_guidelines, canvas_guidelines, chapter |
| diagnostics (1) | report_aurora_issue |

Frontend-bridged: MCP (`mcp_{serverId}_{toolName}`), team tools, skills, ask_question,
artifacts, terminal_list/terminal_read. Optional `tool_search` defers the deferred-eligible
buckets behind an on-demand lookup (off by default).

Risk levels and approval: `src/apps/agent/tools/definitions/risk-levels-enhanced.ts`
(metadata) enforced by the Rust permission gate against `tool_settings` — auto / always-ask / deny.

## 7. Team (multi-agent)

`agent_runtime/team/` — the chat agent **is** the Lead. `team_dispatch` (a bridged tool) defines
members with role/task/scope; `dispatch.rs` seeds the shared brain and spawns one `member_actor.rs`
runtime per member (each a real headless `ConversationRuntime` session). Members coordinate over
`bus.rs` (channel writes persist to `channel/events.jsonl` **and** broadcast live) and `mailbox.rs`
(agent-to-agent delivery, `@lead` grants via `scope_guard.rs`). The brain lives at
`~/.aurora/projects/<projectId>/` (project.json, team.json, scope-map.json, board/tasks.json,
integration/status.json, channel/events.jsonl). Exactly-once completion notification via
`team_run_status`/`team_run_ack`; the Lead decides follow-ups — nothing auto-retriggers.

## 8. Code Index

`src-tauri/src/code_index/` — structural tree-sitter index (format v6; Rust, TypeScript/JS,
TSX/JSX, Python). Import-aware resolution cascade: Import → SameFile → SameDir → Ambiguous.
Exposes the `code` tool plus a token-budgeted `<repo_map>` (5k default / 10k max) injected on
the **first** user message (memoized — rides the provider's cached prefix). Self-checking: the
walk signature (file count + newest mtime) is re-verified before every answer. Cache at
`<root>/code-index/<sha256-16>.json`, rebuilt (never migrated) on format change. Embedding
search was removed at DB migration v12 and is not coming back. Full design and verification
recipe: [code-index-handoff.md](./code-index-handoff.md).

## 9. Persistence and Data Locations (Windows)

Root is `%LOCALAPPDATA%\AuroraIDE\` (`paths.rs::ROOT_NAME` — **not** the Tauri identifier):

```text
%LOCALAPPDATA%\AuroraIDE\
  sessions\       <thread_id>.jsonl / .meta.json / .rich.jsonl (+ .todos.json / .artifacts.json)
  data\aurora.db  SQLite (schema v22): llm_providers, provider_models, threads, workspace_state,
                  editor_state, explorer_state, checkpoints, app_settings, tool_settings,
                  custom_themes (+ legacy semantic_* tables)
  checkpoints\    one shadow git repo per workspace hash
  code-index\     <sha256-16>.json + .meta.json per workspace
  limits\         context-limits.json (learned per-endpoint ceilings)
  logs\           aurora.log (5 MiB rotate → .1) + aurora-crash.log
  reports\        aurora-issues.md (report_aurora_issue)
  config\, typing-assist\

~/.aurora\
  mcp.json        MCP server config (Cursor/Claude format)
  projects\       <projectId>\ team brain per opened project
```

## 10. Theming

Two independent token systems:

- **IDE** — `--aurora-{category}-{token}` from JSON themes (`src/themes/`), injected by
  `apps/ide/services/theme-service.ts`; custom themes in SQLite. Reference: [theme-dev.md](./theme-dev.md).
- **Agent Window** — `--agw-*` from `src/apps/agent/theme/tokens.ts`, applied to `.agw-root` by
  `AgentThemeProvider`. Styles are **33 numerically ordered CSS partials** behind the
  `agent-window.css` @import manifest (`src/apps/agent/theme/agent-window/`) — numeric prefix =
  cascade order and is load-bearing; a test pins manifest ↔ directory agreement. No Tailwind
  inside the agent window.

## 11. Known Debt (open)

- `kernel/store/useSettingsStore.ts` (~2,100 lines) mixes agent config with editor prefs — the
  only eslint boundary exemption. Splitting it is the next reorg step.
- Typed IPC seam: 289 Tauri commands are string-invoked; no end-to-end type contract yet.
- `context/` engine (18 commands) is legacy alongside conversation compaction but still registered.
- Headless LSP remains unbuilt — `read_lints` uses shell checkers (tsc/cargo/ruff); semantic
  navigation is served by the tree-sitter `code` tool. Plan: [agent-window-lsp-plan.md](./agent-window-lsp-plan.md).
- Desktop control (UIA perception for the agent) is designed but deliberately not built:
  [desktop-control-plan.md](./desktop-control-plan.md).
