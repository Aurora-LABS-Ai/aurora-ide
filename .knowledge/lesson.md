# Lessons Learned

Append 2-4 lines per mistake / broken assumption / project-specific warning.

## Agent Window feature ideation must create desire, not process (2026-07-20)
- The Why Graph recommendation over-indexed on provenance, verification, and engineering trust; the user did not
  love it. For “next big thing” ideation, prioritize a visibly transformative interaction or capability first.
- Do not disguise workflow infrastructure as a flagship product idea. Lead with something users would immediately
  want to open, touch, and show someone else; reliability machinery can support it underneath.
- A second recommendation still centered hidden worktree/checkpoint machinery. The user explicitly redirected the
  brief to new visual features; describe the visible surface and interaction first, not backend value.

## Pointer capture retargets `click` — and jsdom doesn't model it (2026-07-19)
- `setPointerCapture` on pointerdown makes Chromium dispatch the eventual `click` at the CAPTURE element, not the
  child under the cursor — child onClick handlers silently die. jsdom does no such retargeting, so component tests
  stay green while the real UI is broken. Capture lazily (only once a drag threshold is crossed), never on press.
- Symptom shape to remember: "clicking X does nothing, but only when the container overflows" → the overflow
  condition gated the capture path. Test the invariant (capture NOT taken on a plain press), not just the click.

## "App broke with zero app changes" → check the WebView2 runtime date FIRST (2026-07-13)
- The Evergreen WebView2 runtime auto-updates silently (`C:\Program Files (x86)\Microsoft\EdgeWebView\Application\<ver>` —
  check the folder's CreationTime). A renderer crash (STATUS_BREAKPOINT sad page) that "started yesterday" matched the
  runtime install time to the hour; app code was innocent. Don't rip out recently-shipped CSS/JS on timing correlation
  alone — the runtime updates on its own clock too.
- Renderer crashes leave minidumps in `%LOCALAPPDATA%\com.aurora.agent\EBWebView\Crashpad\reports` (NOT in Windows
  Event Log — WER never sees Crashpad crashes). `cdb -z <dmp> -c ".ecxr; k 40; q"` with
  `_NT_SYMBOL_PATH=srv*<cache>*https://msdl.microsoft.com/download/symbols` symbolicates msedge.dll (~600MB PDB
  download, takes ~15 min). The dump's UTF-16 strings also carry the page URL → tells you WHICH window/route crashed.
- STATUS_BREAKPOINT = a deliberate Chromium CHECK/int3, not a JS error; page content should never be able to cause it.
  The app-side answer is `ICoreWebView2::add_ProcessFailed` + rate-limited `Reload()` (services/webview_recovery.rs),
  not chasing phantom bugs in app code. WebView2 event handlers live on the browser-side COM object and SURVIVE page
  reloads — installers called per-boot must be idempotent or they stack.

## PowerShell source scans (2026-07-10)
- Bash brace expansion (`path/{a,b}.rs`) is not valid PowerShell command syntax. Pass each path
  explicitly (or build a PowerShell array) when using `rg` from this Windows workspace.
- PowerShell does not use backslash to escape quotes in a double-quoted regex argument. Prefer a
  single-quoted `rg` pattern when it contains TypeScript string literals.

## Agent-window markdown tables (2026-07-04)
- Streamdown (agent-window `AgentMarkdown`) wraps every table in a FULL-WIDTH bordered container
  (`data-streamdown="table-wrapper"` → `w-full … rounded-xl border`). Our `.agw-md table` had
  `display:block`, which shrinks the `<table>` to its content width → the wrapper's right side stays
  empty+bordered = a "phantom extra column/row". Fix: `.agw-md table { display:table; width:100% }`
  (+ `overflow-wrap:anywhere` on cells) so columns fill the box. Don't use `display:block` on a table
  that sits inside a full-width wrapper.
- `controls={{ table:false }}` DOES remove Streamdown's copy/download bar (verified in dist), so that
  was never the empty-strip cause — the block display was.

## Agent Team "max size" counts the Lead (2026-07-04)
- `team-agent-tools.runDispatch` computed `icCap = maxTeamSize - 1` and Rust `convene`/`run_*` also do
  `ic_cap = cap - 1` (the Lead occupies one slot of `max_size`). So a user setting of "3" only ever
  staffed 2 ICs — confusing ("2 capped"). The Lead also never saw the cap (only last-dispatch runtime
  echo), so it couldn't answer "how many ICs now?". Lesson: the team-size number historically INCLUDES
  the Lead; if the UI implies "workers", translate at the dispatch boundary (pass workers+1 to Rust)
  and inject the live cap into the Lead's context — never assume the model can read settings.

## Project warnings (verified 2026-07-01)
- Rust changes need a `pnpm tauri:dev` restart — NO hot reload for the Tauri backend.
- Rust unit tests can't launch the default test binary in some envs
  (`STATUS_ENTRYPOINT_NOT_FOUND` — missing ONNX/native DLL on PATH). Standalone verify crates under
  `target/__verify_*` mount modules via `#[path]` + the `verify_only` feature to test in isolation.
- Native tool count is pinned in 3+ places (`tools/mod.rs::BUILTIN_TOOL_COUNT`, bucket `TOOL_NAMES`,
  count tests). Adding/removing a native tool means updating all of them or tests fail.
- `read_lints` today is a STUB (docs correctly say so, but its own tool description LIES that it returns
  real errors). Treat tool self-descriptions with suspicion; verify against the executor body.
- Big repo: `cargo check` / `tsc -b` on the whole project are SLOW. A shell-checker `read_lints` must scope
  to the file's crate/package + cache + cap output, or it will stall the agent turn.
- WebView2 media permission: `window.with_webview(...)` registers `add_PermissionRequested` on the MAIN-THREAD
  event loop ASYNCHRONOUSLY, so a "lazy" install from JS/React can land AFTER the first `getUserMedia` → the
  request auto-denies with NO prompt AND WebView2 caches the deny. Fix = install at window BUILD time (create
  the window in Rust via `WebviewWindowBuilder` + `install_permission_handler` right after `.build()`), never
  rely on installing it later. A JS-created window (`new WebviewWindow`) can't get this guarantee.
- Passing a Windows path through a Tauri `WebviewUrl::App("route?ws=<val>")` query needs percent-encoding
  (`\`→%5C, `:`→%3A, space→%20); the window decodes it with `URLSearchParams.get()`. No leading slash on the
  `WebviewUrl::App` route (use `agent-window`, not `/agent-window`) — matches the working CLI path.
- CRITICAL (cost me a full app freeze): a SYNC `#[tauri::command] pub fn` runs on the MAIN thread (Tauri v2
  docs). NEVER call `WebviewWindowBuilder::build()` (or any blocking-until-the-event-loop op) from a sync
  command — it deadlocks the UI (white window, X won't close, whole app frozen). If you must build a window in
  Rust from a command, use `#[tauri::command(async)]` so it runs off-main-thread. `with_webview()` is DIFFERENT:
  it only dispatches a closure to the WebView UI thread and returns immediately, so calling it from a sync
  command is safe (that's why `install_agent_media_permission_handler` never froze). The `setup()` hook CAN
  build windows synchronously because the event loop isn't blocked in a command there. Prefer JS
  `new WebviewWindow` for on-demand window creation — it's non-blocking via the event-loop proxy.

## "Broken interface" after many rapid hot edits = HMR desync, NOT a source bug (2026-07-04)
- Symptom: after ~8 quick edits across agent-window CSS + a HOOK (`useAgentAutoScroll` gained
  `useLayoutEffect` + refs), the running window showed unstyled rail (icons stacked, broken squares) and
  unclamped/giant tool `<img>` icons — while the composer stayed styled. Looked like a total CSS break.
- Reality: source was 100% clean — `postcss.parse()` on the CSS = zero errors, `tsc -b`/eslint green,
  `public/material-icons/*.svg` present. It was Vite HMR / React Fast-Refresh DESYNC: changing a hook's
  shape mid-session can't hot-swap cleanly, leaving components against stale styles/state.
- Lesson: before assuming "my last edit broke the UI", VERIFY the source (`node -e "require('postcss').parse(fs.readFileSync(css))"` + `tsc -b`). If source is clean, it's HMR — HARD RELOAD the window (Ctrl+R /
  reopen). Don't thrash the files chasing a phantom. Editing hooks/large CSS live is the usual trigger.

## Agent window has TWO workspace-path sources of truth (2026-07-04)
- The agent window shares the IDE bundle (`App.tsx`, route `/agent-window`). Its scoped path lives in
  `useAgentChatStore.projectRoot` (from `?ws=`, drives UI + per-turn pin), MIRRORED into
  `useWorkspaceStore.rootPath` via `bindRuntimeWorkspace`. Any IDE-only boot hook that writes `rootPath`
  (`useWorkspaceBootstrap`, `useCliOpen`) MUST be gated out of the agent window (`pathname === "/agent-window"`)
  or it repoints rootPath to the IDE's last folder AFTER the scoped bind — UI shows A, tools run against B.
- Lesson: when a hook is IDE-only, gate it at the EFFECT (early return), not just at one call site — there were
  two call-site twins (`restoreWorkspace` gated, `useWorkspaceBootstrap` not) and they drifted. Also: consumers
  reading a global store bypass per-turn pins; prefer the pinned `workspacePath` (ctx) over `rootPath` in tools.

## Tauri 2 capabilities are LOCAL-only unless `remote.urls` is set (2026-07-09)
- The agent/preview browser webviews load EXTERNAL/localhost URLs. In Tauri 2 a capability applies only to the
  app's own origin unless it declares `"remote": { "urls": [...] }`. Without it, an external page's
  `__TAURI_INTERNALS__.invoke(...)` is REJECTED — so every page→Rust callback (`aurora_record_browser_result`
  for screenshot/DOM/click/fill/scroll/console, `aurora_record_picked_element` for the inspector) silently
  dies / times out at 30s. `withGlobalTauri:true` does NOT grant this; it only exposes the API object. Symptom:
  one-way evals (navigate/refresh/history.back) work, anything needing a RESULT hangs. Fix lives in
  `capabilities/browser.json`.
- Corollary lesson: `browser_screenshot` returning the WRONG/previous page had NOTHING to do with capture
  targeting — it was (a) the 8 KiB model-history clamp chopping the base64 so the model saw text not an image,
  and (b) `CapturePreview` returning a stale frame from a hidden (non-compositing) webview. Always check the
  MODEL's actual received content (post-truncation, post-adapter-split), not just the UI card, when an agent
  "describes the wrong thing".

## `cargo test --lib` for the aurora crate fails to LAUNCH (STATUS_ENTRYPOINT_NOT_FOUND)
The lib-test binary links the full native stack (onnxruntime/candle/tauri) and won't start in a bare shell —
exit `0xc0000139`, even after putting `build/debug` + `src-tauri/runtime/onnxruntime` on PATH (a dependent DLL
export is missing/mismatched for the test exe specifically; the real app bundles the DLLs correctly). It is NOT
a test-logic failure — the crate compiles. To unit-test a self-contained module (e.g. `typing_assist`) without
that linkage, compile the real source files into a tiny standalone crate via `#[path = "…/module.rs"]` inside a
wrapper `mod` (so `super::` still resolves) with only the module's light deps (parking_lot/serde). This gave a
clean 199ms runtime verification of the typing-assist engine.

## Rust formatting in a dirty worktree (2026-07-11)
- Direct `rustfmt` defaults to Rust 2015 when invoked on loose files; this crate requires `--edition 2021`.
- Prefer `rustfmt --edition 2021 <touched files>` here. A crate-wide `cargo fmt --check` currently reports many
  unrelated pre-existing formatting differences, so it is not a useful completion gate for a focused change.

## Tool-call icons must stay naked (2026-07-11)
- "Give the icons life" did not authorize colored tiles. The semantic-color wrapper made dense tool rows heavier
  and visually noisy. Keep tool glyphs unwrapped and neutral unless the user approves a concrete replacement design.

## CSS patches need selector context (2026-07-11)
- A minimal patch for generic `opacity`/`background` declarations matched earlier unrelated rules. The focused token
  test caught it. For repeated CSS declarations, include the selector in every patch hunk and verify the exact block.
# 2026-07-12 — Reuse the command module's test emitter
- New `agent_v2` registry tests initially referenced a private `RecordingEmitter` from another module and failed test compilation.
- Reuse the local `MockEmitter`, which already implements the command's event and bridge contracts; compile test targets before broader verification.

# 2026-07-12 — Do not run workspace-wide rustfmt here
- `cargo fmt --all` reformatted unrelated Rust files; a first scripted restore then consumed truncated shell output and shortened several files.
- Restore clean files from HEAD in bounded chunks via `apply_patch`; format only touched files and never treat tool-rendered output as an unbounded file transport.

## Tool JSON order and persisted rich results (2026-07-16)
- Source order inside `json!` is not preserved by default `serde_json`; the live schema reached KAT as `content,path`, so
  frontend partial parsing alone could never reveal the filename early. Verify the provider-facing serialized schema,
  not the Rust literal, when UI depends on streamed argument order.
- Never persist a rich JSON tool result with a blind byte slice. It produces invalid JSON on reload and forces a raw-text
  fallback. Compact large payload fields inside the parsed value so the saved envelope stays structurally valid.

## pnpm script probing (2026-07-17)
- `pnpm dev -- --help` forwards a literal `--` to Vite in this project, so it starts instead of printing help and exiting.
- Do not use that form to probe a long-running script; inspect `package.json` directly and validate the independent production command instead.

## Pointer capture tests in jsdom (2026-07-17)
- jsdom does not define `setPointerCapture`, `hasPointerCapture`, or `releasePointerCapture`, so `vi.spyOn` fails before a component test mounts.
- Define those methods as configurable test-environment shims and remove them during cleanup; this models WebView2 without weakening production code.

## Sparkle icons are banned in Aurora (2026-07-19)
- The user considers sparkle/star glyphs "AI slop" — the `sparkle` AgentIcon was removed from the SET entirely and
  replaced by the bespoke `refine` nib glyph. Never reintroduce sparkles for AI-adjacent features; design a
  semantic bespoke mark in the AgentIcon style instead (24-box stroke primitives, like `facet`).

## Prompt-engineering a 0.5B local model (2026-07-19, smoke-tested)
- ALWAYS smoke-test prompts against the real GGUF before shipping (paths in knowledge.md). Patterns proved:
  few-shot examples are mandatory for format adherence BUT the model will parrot a concrete example verbatim when
  asked for multiple outputs — split multi-output tasks into one call per item. Explicit `--temp` matters (0.2-0.4);
  default sampling drifts. Always sanitize outputs (label leaks like "Title:", list markers) and validate/filter —
  design features so 0 usable outputs degrades to current behavior.

## Canvas is a surface, not an AI action (2026-07-17)
- Do not reuse the prompt-refinement sparkle for Canvas; it reads as generic AI decoration and ignores the Agent Window's semantic icon set.
- Canvas opens the right rail, so reuse the bespoke `panel-right` glyph and the app's flat hover treatment. Avoid hover translation on dense transcript controls because it can collide with clipped message bounds.

## Agent mutation tools need workflow-level preflight (2026-07-17)
- Sequentially applying exact-text patches can misdiagnose overlap as a missing later match. Resolve every range against the unchanged base, reject intersecting ranges with both indices, and only materialize after the whole plan passes.
- For immutable artifacts, format validation must happen before persistence. Use the backend's real patch engine to preview, validate the materialized Mermaid source, then commit with the same base tag so a race becomes a stale-version error instead of a broken snapshot.

## Combined tool forms must encode their boundary (2026-07-18)
- Optional `path` plus optional `paths` without non-empty or mutual-exclusion constraints encourages models to emit empty placeholder arrays that accidentally select the wrong executor branch.
- Put the rule in the provider-facing schema and prompt, then validate again at execution: recover only an unambiguous empty placeholder and reject genuinely conflicting forms with corrective errors.

## Terminal signals need one callback owner (2026-07-18)
- A streamed error event, terminal event, and rejected IPC result can all describe one failed turn; guarding only promise settlement does not prevent duplicate UI side effects.
- Put user notification inside the same idempotent settle function and treat the other signals as transport/recovery data, then test the full multi-signal sequence with one request id.

## Check free space before linking Aurora's Rust test target (2026-07-18)
- The CPU-only Rust test target can create hundreds of megabytes of loose codegen objects before archiving; starting it with less than 1 GB free can fill drive E and fail with OS error 112.
- Check available space first and prefer `cargo check` when the user owns runtime verification; if linking is necessary, ensure several gigabytes are free before starting.

## Shared multi-file UI must be result-driven (2026-07-18)
- The earlier horizontal-selector work was applied only to read-tool names, leaving edit results on their separate stacked renderer and hidden Review click path.
- When several tools share one visible interaction contract, derive selection from the parsed multi-file result shape and test every result family; do not stop after one tool-specific branch looks correct.

## Identify the loaded Aurora build before judging HMR (2026-07-18)
- A screenshot can be newer than a source fix while still showing old UI when the active process is the installed LocalAppData binary and no workspace Vite server is running.
- Check the exact Aurora process command line and dev-port listener before treating a post-edit screenshot as evidence that the current source renderer failed.

## MCP server ids can be prefixes of each other (2026-07-19)
- Tool names are `mcp_{sanitizedServerId}_{toolName}`; sanitization maps "-" to "_", so "browser" is a prefix of "browser-testing" and first-match parsing routes calls to the wrong server with a misleading "not connected" error.
- Any name scheme that concatenates ids with the same separator the ids may contain needs longest/advertised-match resolution, never first-match; and note the display-name cache can look right while routing is wrong.
