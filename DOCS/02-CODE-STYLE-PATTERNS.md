# Code Style & Patterns

Implementation patterns that matter in this repo, post-restructure (`src/apps` + `src/kernel`)
and post agent-runtime migration. The two structural rules — enforced module boundaries and
concern-grouped folders — come first because everything else follows from them.

## 1. Naming

| Entity | Convention | Example |
|--------|------------|---------|
| TypeScript files | kebab-case | `agent-service.ts` |
| Rust modules | snake_case | `provider_kernel`, `local_providers` |
| React components | PascalCase | `ChatPanel.tsx` |
| Zustand stores | `use` prefix | `useSettingsStore.ts` |
| Services | noun or domain service | `provider-catalog.ts`, `local-model-detector.ts` |
| Tauri commands | verb-oriented snake_case | `aurora_provider_stream` |
| CSS classes (agent window) | `agw-` prefix, kebab | `.agw-tool-card` |
| CSS custom props | `--agw-*` / `--aurora-*` tokens only | `var(--agw-surface)` |

## 2. Frontend structure: apps over a kernel

`src/` is organized by product, not by layer:

- `apps/ide/`, `apps/agent/` — one folder per product. Within each, files are grouped **by
  concern** (`services/runtime/`, `store/conversation/`, `components/composer/`, …). Never add
  files to a folder root.
- `kernel/` — the shared floor (stores, IPC runtime, shared UI, types). Kernel must not import
  from apps.
- `bridge/` — the deliberate exception: glue that spans both windows (agent events → Monaco,
  agent writes → editor, window close).

**Direction is enforced at `error` by `no-restricted-imports` in `eslint.config.js`**, not by
convention: `apps/* → kernel`, never `kernel → apps`, never `apps/ide ↔ apps/agent`. Exemptions
are deliberate and listed in the config (`App.tsx`/`main.tsx` router, `TitleBar.tsx` launcher,
`bridge/**`, and the `useSettingsStore.ts` split debt).

`@/*` → `src/*` is the only alias and must agree in `tsconfig.app.json`, `vite.config.ts`, and
`vitest.config.ts`. Cross-directory imports use `@/…`; sibling imports stay relative.

## 3. Frontend/Backend boundary

Preferred shape:

1. frontend service or store gathers app state
2. maps it into a narrow invoke payload
3. Rust command module owns the behavior
4. frontend receives normalized data only

Never: per-provider TypeScript clients, store-owned provider catalogs, browser-side probing of
local models, or bypassing the Rust tool registry when advertising native tools.

## 4. Zustand store pattern

Stores own UI-facing state, persistence coordination, and service invocation — never protocol
implementations. New agent-window state lands under `src/apps/agent/store/<concern>/` keyed by
what it scopes to (thread, workspace, composer, window). When two composers or two
conversations can be on screen at once, key the state by thread/composer id — a single global
"current" value silently addresses the wrong chat.

## 5. Agent-window CSS doctrine

- All agent-window styles live in `src/apps/agent/theme/agent-window/` — **33 numerically
  ordered partials** behind the `agent-window.css` @import manifest. The numeric prefix **is**
  the cascade order and is load-bearing; a test pins manifest ↔ directory agreement.
- **No Tailwind in the agent window.** Component rows own their layout in the partials, not via
  utility classes in JSX.
- Colors/sizes come from `--agw-*` tokens (set by `tokens.ts` from the active theme); the IDE
  uses `--aurora-*` tokens. No hardcoded hex/px in TSX.
- Inline styles outrank every selector — if a CSS state variant needs to override a property,
  that property cannot live inline.
- `transform`, `filter`, `backdrop-filter` create stacking contexts; check the ancestors before
  reasoning about z-index.

## 6. Tauri command pattern

Small entry points that delegate to focused modules:

```rust
#[tauri::command]
pub async fn some_command(args: Args) -> Result<Response, String> {
    inner_module::do_work(args).await
}
```

- **A sync `pub fn` command runs on the UI thread in Tauri v2.** Anything touching disk or the
  database must be `async` (+ `spawn_blocking` for heavy scans) — a test
  (`commands/command_thread_safety.rs`) reads the source and fails on the shape.
- Register every new command in the `generate_handler!` list in `lib.rs` — the registration is
  the only thing that makes it callable.
- Keep registration, request building, HTTP logic, stream parsing, and types in separate files.

## 7. Rust native tool pattern

The Rust registry (`src-tauri/src/tools/`) is the single source of truth for native tools —
the TS definitions in `src/apps/agent/tools/definitions/` are display/approval metadata only.

When adding a tool:

1. implement it in the owning bucket (`tools/<bucket>/`)
2. add the name to the bucket's `TOOL_NAMES`
3. bump `BUILTIN_TOOL_COUNT` **and** the derived `count_without_browser` in `tools/mod.rs`
   (tests assert the sum)
4. wire the permission gate if the tool is risky (`install_permission_gate`)
5. give it a card: icon (`AgentIcon` + `toolIcon()`), result parsing
   (`tool-result.ts`), and tests

## 8. Error handling

Frontend: normalize errors close to the boundary; `kernel/lib/diagnostics/error-reporter.ts`
routes `console.error` / `window.onerror` / unhandled rejections into `aurora.log`
(`console.warn` deliberately not captured).

Rust: `Result<T, String>` for commands; stream errors classified by body (an HTTP 400 can be
an upstream outage — read the body before trusting the status); `recovery.rs` turns failures
into user-facing hints on `agent_turn_error`.

## 9. Testing pattern

- Test the seam: stream/response mapping, tool result parsing, store contracts, permission
  gating, CSS token coverage (`appearance-token-coverage.test.ts` reads the manifest).
- Tests must not assume Tauri exists (jsdom), and must not write to real AppData — services
  that write app data take a path/cache-root parameter for tests.
- Vitest runs with `pnpm test` (65 files). `tsc -b` gates types; `pnpm build` gates the bundle.
- Rust: `cargo check --lib --tests` is the fast gate (~1s warm); `cargo test --lib` for logic.
  `cargo clippy` re-analyses every dependency (~8 min) — use it only for code-quality changes.
  `cargo test` does not rebuild `bin` targets.

## 10. Documentation pattern

When architecture changes materially, **replace** stale sections rather than layering patches.
The living memory is `.knowledge/knowledge.md` (what was done) and `.knowledge/lesson.md`
(what was learned) — when a static doc disagrees with them, the doc is wrong. Never put real
project, package, or customer names into `src/` or `src-tauri/src/` — fixtures use neutral names.
