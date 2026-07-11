# Agent Window — Headless LSP / Code Intelligence — Implementation Plan

> **Status:** planned, not started.
> **Owner surface:** the **agent window only** (`src/agent-window/**` + `src-tauri/src/**`).
> **How to resume:** point the next session at this file. It is written to be executed top-to-bottom. Confirm the "Open decisions" (§13) first, then work the "File-by-file work breakdown" (§12).

---

## 0. Framing — read this first

**There is NO Monaco in the agent window.** The agent window renders code with a **read-only Shiki viewer** (`src/agent-window/components/FileViewer.tsx`, `useShikiTokens`), tool cards, and the Review diff. Monaco lives only in the legacy IDE. So this is **NOT** an editor-LSP integration (no `monaco-languageclient`, no squiggles, no as-you-type completion, no frontend LSP bridge).

This is a **headless LSP client**: Rust drives real language servers (rust-analyzer, pyright, typescript-language-server, gopls…) as child processes, and exposes their intelligence **to the AI agent as tools**. The value is agentic, not editorial: the agent gets **real diagnostics** and **semantic navigation** (go-to-def, find-refs, hover types, symbol search) instead of guessing with grep.

### Why now (the trigger)
`read_lints` is currently a **stub that catches nothing**. Verified this session:
- `src-tauri/src/tools/shell_editor_todo/read_lints.rs` — `execute()` emits an `agent_read_lints` event and returns a hardcoded `{"success":true,"message":"lints requested for <paths>"}`. `uses_frontend_lifecycle()` is `false`, so the runtime sends **that placeholder** to the model.
- `src/services/agent-ide-events.ts:204` — the `agent_read_lints` listener is a **deliberate no-op** (`console.debug` only, "no UI mutation").
- `src/services/agent-prompt.ts` tells the model *"After edits, run `read_lints`… and fix the issues"* — an instruction pointed at a tool that returns nothing. The tool description even claims it "Returns TypeScript, JavaScript, Rust… errors" — currently false.

**Goal of this project:** make `read_lints` return real diagnostics, and (phase 2) give the agent semantic-navigation tools — all headless in Rust, no editor UI.

---

## 1. Goals / Non-goals

**Goals**
- `read_lints` returns **real** diagnostics (severity, range, code, message, source) per file, from a real analyzer.
- Diagnostics stay fresh after the agent edits files (`file_write`/`file_edit`).
- Semantic tools for the agent (phase 2): definition, references, hover, document/workspace symbols.
- Graceful degradation: no server for a language → shell-checker fallback → honest "no analyzer available".
- Configurable + gated behind a setting (rust-analyzer is heavy).

**Non-goals**
- No editor UI, no live squiggles, no completion-as-you-type (there is no editable surface in the agent window).
- Not a replacement for `grep`/semantic search — complementary (LSP = precise/semantic, grep = fast/textual).
- Not touching the IDE's Monaco (out of scope; different surface).

---

## 2. Architecture (headless)

```
AI agent (tool call)
   │
   ▼
Rust tool (read_lints / code_definition / …)   ← native Rust tools; NO frontend hop
   │
   ▼
LspManager (Rust, src-tauri/src/lsp/)           ← lazy, one server per (workspace_root, languageId)
   │  JSON-RPC over stdio (Content-Length framing)
   ▼
child process: rust-analyzer | pyright-langserver | typescript-language-server | gopls | …
```

Because the file tools are **native Rust** and `read_lints` needs no Monaco, the whole path is Rust-only — no frontend bridge, no `agent_read_lints` event round-trip. This is simpler and more reliable than an editor integration.

Mirror the existing **MCP manager** (`src-tauri/src/mcp/manager.rs`) for child-process lifecycle patterns (spawn, stdio, restart, shutdown) — but LSP has its own JSON-RPC framing (rmcp is MCP-specific and cannot be reused for LSP).

---

## 3. Rust crate choices (decide in §13)

- **Types:** `lsp-types` (official LSP types) — strongly recommended, avoids hand-modeling the protocol.
- **Client transport:** two options —
  - **(A) Hand-rolled** `tokio` child + a small `Content-Length` framing codec (`tokio_util::codec::Framed`) + an id→oneshot correlation map for requests, plus a notification pump for `textDocument/publishDiagnostics`. Minimal deps, full control. **Recommended.**
  - **(B) `async-lsp`** (tower-based, has a client stack). Less code but another heavy dep and a learning curve; check it exposes a clean client API (it's primarily framed for building servers).
- Reference `rmcp`'s `transport-child-process` only conceptually — don't try to reuse it.

---

## 4. Server catalog (initial, config-driven)

| languageId | command | root markers | notes |
|---|---|---|---|
| `rust` | `rust-analyzer` | `Cargo.toml` (workspace root) | heavy; indexes slowly; gate behind setting |
| `typescript`/`javascript`/`typescriptreact`/`javascriptreact` | `typescript-language-server --stdio` | `tsconfig.json` / `package.json` | or shell `tsc --noEmit` fallback |
| `python` | `pyright-langserver --stdio` | `pyproject.toml` / `setup.py` / `.git` | or shell `pyright --outputjson` |
| `go` | `gopls` | `go.mod` | phase 3 |

Extension → languageId map lives in Rust; the catalog is a `HashMap` seeded with defaults and overridable from settings (command path + args + root markers).

---

## 5. Diagnostics flow (the read_lints rewrite)

`read_lints(paths?)`:
1. Resolve each path → `(workspace_root, languageId)`. Empty `paths` → the set of files the agent has touched this session (reuse `read_tracker` — the session seen-set already exists) OR the current workspace's changed files.
2. `ensure_server(root, languageId)` — lazy spawn + `initialize`/`initialized` handshake (request `publishDiagnostics`, `hover`, `definition`, `references`, `documentSymbol`, `workspaceSymbol` capabilities).
3. `didOpen` (or `didChange` if already open) with the file's on-disk content + languageId + version.
4. Collect `textDocument/publishDiagnostics` for that URI, **with a timeout** (rust-analyzer's first diagnostics can lag while indexing — see §9). Buffer diagnostics per-URI in the manager keyed by latest version.
5. Return structured JSON: `{ file, diagnostics: [{ severity, line, col, endLine, endCol, code, source, message }], truncated?, note? }`. Cap total size; summarize counts (`N errors, M warnings`).
6. **Fallback** when no LSP server is available/installed: run the language's shell checker and parse JSON:
   - Rust: `cargo check --message-format=json` (run at crate/workspace root).
   - TS: `tsc --noEmit` (parse) or `eslint -f json`.
   - Python: `pyright --outputjson`.
   - Return the same structured shape + `source: "shell:<tool>"`.
7. When neither LSP nor a shell checker exists: return `{ available: false, note: "No analyzer for <lang>; install rust-analyzer/pyright/… or run the compiler via shell_execute." }` — honest, not a fake success.

---

## 6. Freshness after edits

After a successful `file_write` / `file_edit` / `move_path` / `delete_path`, notify the LSP manager so diagnostics reflect the new content:
- The file tools already emit `FileChangedPayload` via `IdeEventSink` (`emit_file_changed`). Add an LSP hook: either the tools call `lsp.notify_changed(&resolved_path)` directly, or a listener on the change stream calls it. Prefer a direct call in the write tools (they already have the resolved path + content).
- `notify_changed` → `didChange` (bump version, send full content — simplest; incremental sync is a later optimization) for any open doc; otherwise no-op (opened on next read_lints).

---

## 7. Semantic tools (phase 2 — optional but high value for an agentic IDE)

Expose new native Rust tools that drive LSP requests and map results to `file:line` + a code snippet:
- `code_definition(path, line, col)` → `textDocument/definition`.
- `code_references(path, line, col)` → `textDocument/references` (with `includeDeclaration`).
- `code_hover(path, line, col)` → `textDocument/hover` (type/signature/docs).
- `document_symbols(path)` → `textDocument/documentSymbol` (outline).
- `workspace_symbols(query)` → `workspace/symbol` (semantic "find symbol" across the repo — strictly better than grep for renames/impact).

These make the agent navigate by **meaning**. Each is a small native tool that calls the manager and formats results. Add to the Rust registry + the frontend definition mirror (see §11 single-source rule) or keep native-only.

---

## 8. Settings & toolchain

- **Settings section** (Agent settings, `src/agent-window/settings/AgentSettings.tsx` + `useSettingsStore` + Rust `AppSettings`): "Code intelligence".
  - Master enable (default off until stable — rust-analyzer is heavy).
  - Per-language: enable, command path override, extra args.
  - "Detect installed servers" action (check PATH) + status chips.
  - Optional: download-on-demand (phase 3).
- Persist via the established `app_settings` round-trip (Rust `AppSettings` field + read arm + save call; frontend `useSettingsStore` state/setter/default/load/save + `DbAppSettings`). Follow the exact pattern used by `titleMaker*` / `allowOutsideWorkspace`.
- **Server discovery/bundling** (decide §13): detect-on-PATH (simplest), bundle (large: rust-analyzer ~30 MB), or download-on-demand.

---

## 9. Robustness / gotchas (do not skip)

- **rust-analyzer indexing latency** — first diagnostics for a real crate can take seconds→minutes. `read_lints` must handle "not ready": wait up to a timeout, then return partial + a `"still indexing"` note; consider a **warmup** (spawn rust-analyzer on workspace open, before the agent asks). Poll `$/progress` / `window/workDoneProgress` if available to know when it settled.
- **Workspace-root resolution per language** — walk up from the file for the language's root marker (Cargo.toml / package.json / pyproject.toml). One server per `(root, languageId)`.
- **didOpen sync** — the LSP's view of a file must match disk after agent edits (§6). Version numbers per document; debounce rapid `didChange`.
- **Server not installed** — detect, fall back to shell checker, surface a settings hint. Never fake success.
- **Diagnostics volume** — cap + summarize; don't dump 500 warnings into context.
- **TS double-source** — for TS you can use either the LSP or one-shot `tsc --noEmit`. For agent `read_lints`, a one-shot compiler is often simpler than a persistent server; the plan supports **LSP-first with shell fallback**, so pick per-language.
- **Concurrency** — tool calls run sequentially (`conversation.rs`), so no intra-turn races; still guard the manager with async-safe state (Arc + Mutex/DashMap), mirroring MCP.
- **Lifecycle** — lazy spawn, reuse per root+lang, restart-on-crash with capped backoff, shutdown on app exit / workspace switch.
- **Resource gating** — master setting off by default; one rust-analyzer per workspace; kill idle servers after N minutes (phase 3).

---

## 10. Manager handle plumbing (how tools reach LspManager)

`read_lints` (and the semantic tools) need an `Arc<LspManager>`. Two options (decide §13):
- **(A) Process-global service** keyed like `read_tracker` (`OnceLock<LspManager>`) — zero `ToolContext` churn, simplest. Manager holds per-`(root, lang)` servers internally.
- **(B) `ToolContext` field** — thread `Arc<LspManager>` like `allow_outside_workspace` was; touches ~25 construction sites.

Recommend **(A)** — the manager is inherently global/singleton and per-workspace scoping is internal to it. Initialize it in `lib.rs::setup` (or lazily), managed as Tauri state too if the frontend settings need to poke it (detect/restart).

---

## 11. Single-source-of-truth rule (already in place — respect it)

This session established: **native tools are advertised to the model from the Rust registry only.** `AgentService.buildAvailableTools` filters out `nativeRustOwned` tools from `request.tools`, so the frontend TS definitions never reach the model for native tools. Therefore:
- `read_lints` stays a **native Rust tool** → its real Rust implementation is what the model sees/executes. No frontend executor, no Monaco. Good — the whole design fits.
- New semantic tools should be **native Rust** too (registered in `src-tauri/src/tools/…`), so they're single-source and never drift.
- Keep the frontend TS definition (`src/tools/definitions/editor-tools.ts` for read_lints) synced for display/approval metadata only; it is NOT sent to the model.

---

## 12. File-by-file work breakdown (execution checklist)

**Phase 0 — make read_lints real via shell checkers (fast, high value, no persistent LSP):**
- [ ] `src-tauri/src/services/diagnostics/` (new) — per-language runners: `cargo check --message-format=json`, `tsc --noEmit`, `pyright --outputjson`; parse → common `Diagnostic` struct; workspace/crate-root resolution; output cap.
- [ ] `src-tauri/src/tools/shell_editor_todo/read_lints.rs` — replace the event-emit stub: call the diagnostics service, return structured diagnostics; keep `requires_permission=false`.
- [ ] `src/services/agent-prompt.ts` — keep the "run read_lints after edits" line (now valid); tighten wording.
- [ ] `src/tools/definitions/editor-tools.ts` — fix `read_lints` description to match reality.
- [ ] `src/services/agent-ide-events.ts` — delete the dead `agent_read_lints` no-op listener (and the Rust event emit) once the stub is gone.
- [ ] Tests: diagnostics parsing per language; read_lints returns real errors on a fixture with a known error.

**Phase 1 — headless LspManager:**
- [ ] `src-tauri/src/lsp/mod.rs`, `manager.rs`, `transport.rs` (Content-Length codec + child stdio), `servers.rs` (catalog + root resolution), `types.rs`, `diagnostics.rs`.
- [ ] `Cargo.toml` — add `lsp-types` (+ codec deps if any).
- [ ] `lib.rs::setup` — init the global manager (§10-A).
- [ ] `read_lints.rs` — LSP-first, shell fallback (Phase 0 code becomes the fallback).
- [ ] File write tools — call `lsp.notify_changed()` after successful writes (§6).
- [ ] Integration test: spawn real rust-analyzer on a fixture crate, didOpen a file with an error, assert the diagnostic.

**Phase 2 — semantic tools:**
- [ ] `src-tauri/src/tools/lsp_nav/` (new): `code_definition`, `code_references`, `code_hover`, `document_symbols`, `workspace_symbols`.
- [ ] Register in `src-tauri/src/tools/*/mod.rs` + bump the registry counts (`tools/mod.rs BUILTIN_TOOL_COUNT`, bucket `TOOL_NAMES`, count tests).
- [ ] Frontend definition mirrors (display/approval only) in `src/tools/definitions/`.
- [ ] Agent-window tool-card views/icons for the new tools (`AgentIcon`, `toolIcon`, `tool-result.ts`).

**Phase 3 — settings, detection, polish:**
- [ ] Settings section + persistence (§8).
- [ ] Detect-on-PATH / download-on-demand; status UI.
- [ ] Idle-server reaping; per-workspace warmup; `$/progress` handling.

---

## 13. Open decisions (confirm at the start of the next session)

1. **Start at Phase 0 (shell checkers) or jump to Phase 1 (LSP)?** — Recommend Phase 0 first: `read_lints` becomes real in a contained Rust change, immediate agent value, zero protocol risk.
2. **Client crate:** hand-rolled `lsp-types` + framing (recommended) vs `async-lsp`.
3. **Server delivery:** detect-on-PATH (recommended v1) vs bundle vs download-on-demand.
4. **Manager handle:** global service à la `read_tracker` (recommended) vs `ToolContext` field.
5. **Semantic tools scope:** ship phase 2 now or defer until diagnostics prove out.
6. **TS strategy:** persistent typescript-language-server vs one-shot `tsc --noEmit` for read_lints.

---

## 14. Success criteria

- Agent edits a file introducing a real type/borrow error → calls `read_lints` → receives the **actual** compiler diagnostic (file, line, message) → fixes it → `read_lints` comes back clean.
- No Monaco, no editor UI touched. All new capability is native Rust exposed as agent tools, single-source (§11).
- Heavy servers gated behind a setting; graceful "no analyzer" when a toolchain is absent.
