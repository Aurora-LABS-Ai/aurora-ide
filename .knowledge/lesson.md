# Lessons Learned

Append 2-4 lines per mistake / broken assumption / project-specific warning.

## The Rust test suite never ran on Windows — FIXED (2026-07-25)
- `cargo test` died with exit `0xc0000139` STATUS_ENTRYPOINT_NOT_FOUND before `main`. This was written off in
  these notes as an environment limitation for months. It was not. **Root cause:** `tauri_build::build()`
  embeds an app manifest into BINARY targets only; a test executable is a separate target and got none, so the
  loader bound System32's `comctl32.dll` **v5.82** instead of the side-by-side **v6** assembly — and v5.82 does
  not export `TaskDialogIndirect`, which the dialog stack (rfd / tauri-plugin-dialog) statically imports.
- Fix is a `#[cfg(all(windows, test))]` `.drectve` linker directive in `lib.rs` emitting
  `/MANIFESTDEPENDENCY:"…Microsoft.Windows.Common-Controls version='6.0.0.0'…"`. `build.rs` CANNOT do this:
  `cargo:rustc-link-arg-tests` applies only to `tests/` integration targets and errors with "does not have a
  test target" — unit tests compile into the lib target. Do NOT add `/MANIFEST:EMBED` to the directive:
  `rust-lld` rejects `/MANIFEST:` inside `.drectve`. The linker writes a side-by-side `.manifest` instead,
  which the loader honours identically.
- Diagnosis method worth reusing: `dumpbin /imports` the failing exe, then check every imported symbol against
  the resolving DLL's `dumpbin /exports`. Beware false positives on forwarded exports. PATH shadowing was the
  obvious suspect (an old `VCRUNTIME140.dll` from `C:\SDKs\emulator` does sit ahead of System32) and was NOT
  the cause — verify before acting on it.
- **Consequence:** 703 unit tests had never executed once. 15 were already failing. A green `cargo check` says
  nothing about a suite that cannot launch — and `BUILTIN_TOOL_COUNT` had silently drifted 21→22 behind exactly
  this blind spot. Run the suite, don't just build it.

## A test that cannot RUN is worse than a test that does not exist (2026-07-25)
- 703 Rust unit tests had never executed once on this machine. 15 were failing and **5 of those were real
  product bugs** that had been shipping for months: context trimming that never fired at 3 user turns, a JSON
  compactor that produced invalid JSON for `workspace_tree`, a clamp that exceeded its own cap, a `TeamPhase`
  variant assigned nowhere, and a role classifier that relabelled real builders. `cargo check` was green the
  whole time. **Green compile ≠ green suite.** If the suite cannot launch, treat that as a P0 — not an
  environment quirk to note and route around.
- When a test and the implementation disagree, decide which is stale by finding the *sibling* test. The 4
  scope_guard failures encoded a superseded rule; the one test written FOR the new rule
  (`unassigned_path_is_allowed_as_open_ground`) passed and settled it. Likewise
  `register_builtin_tools_is_idempotent` asserted 16 where its own sibling asserted 15.
- Do not assert on a `display()`/`Debug` rendering when you mean to assert on a value. `{:?}` on a Windows
  path escapes the separators, so `contains("src\\app.js")` can never match. Compare `Path`s — that is
  separator-agnostic — or assert on the structured field directly.

## Portaling escapes the clipping container AND the ancestor's containment check (2026-07-25)
- The budget popover was portaled to `.agw-root` to escape `.agw-model-menu`'s `overflow: hidden`. That fixed
  clipping and immediately broke dismissal: the menu's outside-click test is `rootRef.contains(target)`, and
  the portaled panel is not a DOM descendant, so pressing the slider closed the whole picker. **Fixing the
  visual containment created a logical containment bug.**
- Convention now in place: a portaled popover owned by a menu sets `data-agw-portal-child`, and every
  outside-click handler skips `target.closest("[data-agw-portal-child]")`. Apply this to any future portaled
  popover rather than adding a one-off class check.
- `useSettingsStore.updateModel` writes to SQLite on EVERY call. Never wire it directly to a continuous
  control (range/drag): keep a local draft and commit on `pointerup`/`keyup`/`blur`. Same rule for any store
  action with a persistence side effect.

## Never substitute a default for a value that failed to arrive (2026-07-25)
- `parse_tool_input` turned unparseable tool arguments into `{}`, so an executor reported "`path` is required"
  to a model that had sent `path`. The model then looks incompetent — retrying, rephrasing, switching tools —
  while the harness is the thing at fault. This single line was the main cause of "even Opus calls the wrong
  tools in Aurora". A fallback that is indistinguishable from real data destroys the error message that would
  have explained the failure.
- Keep the failure representable end to end: encoding it as `Value::String(raw)` needed no new type, no serde
  migration, and no magic key, because every tool schema is `type:object` so a non-object is unambiguously
  broken. But sanitize at the WIRE boundary (`tool_input_for_wire`) — providers reject a non-object
  `tool_use.input` and would fail every subsequent turn, not just the malformed one.
- Distinguish "arguments never arrived" from "arguments failed validation" in the message. They demand
  different corrections from the model, and an EOF parse error additionally means "you were truncated — send
  less", which the model cannot infer any other way.
- A `DashMap`-backed tool registry ships schemas in random order every request. Tool order is part of the
  cacheable prefix (and nudges tool selection), so registration order must be stable and re-registration must
  preserve position. Aurora sends ZERO `cache_control` today — that is still open.

## A settings field nothing consumes is worse than a missing one (2026-07-25)
- Providers → "Min budget / Max budget" had shipped for budget-type reasoning models, but no surface let the
  user pick a VALUE inside that range and no adapter could receive one. The page looked complete and configured
  nothing. Before adding a control, trace the field to the outgoing request body — `ModelReasoning.type`
  ("effort" | "toggle" | "budget") is a union whose branches must ALL be handled at every layer, and the send
  path's `// toggle / budget` else-branch silently collapsed budget into a boolean for months.
- `reasoning.default` is polymorphic: a TIER STRING for effort models, a TOKEN NUMBER for budget models. The
  Reasoning type switcher carried it across unchanged, so effort→budget produced `default:"medium"` and
  budget→effort sent `reasoning_effort:"8000"`. Coerce by type at every write site.
- Anthropic's `1024 ≤ budget < max_tokens` is a CLAMP, not a validation error to surface: a user who set 32k
  against a 64k cap and later lowers Max output must keep working, not start getting 400s.
- Popovers spawned from inside `.agw-model-menu` MUST be portaled to `.agw-root` — that menu is
  `overflow: hidden`, so an absolutely-positioned child panel is clipped. Same rule as `RailMenu`.
- Log-scale any token slider. Linear travel over 1k–64k spends the first 10% of the track on the range where
  every meaningful choice lives and the other 90% on values nobody can tell apart.

## Tool `parameters` schemas must stay in the strict-provider-safe subset (2026-07-24)
- xAI/grok (and OpenAI strict mode) REJECT `oneOf`/`anyOf`/`allOf` in a function's `parameters` with HTTP 400.
  Aurora's `file_read` used a top-level `oneOf` and it's sent every turn, so every grok request 400'd
  ("Upstream error: 400") while a plain curl worked. `additionalProperties:false` and union `"type":[...]` are FINE.
- When encoding "exactly one of A/B" in a tool schema, carry it in descriptions + runtime `execute()` validation,
  NOT `oneOf`. Bisect provider 400s by replaying the exact outgoing body field-by-field against the endpoint;
  enable the outgoing-body trace with env `AURORA_DEBUG_API=1` (api/openai_compat.rs).

## MCP "405 Method Not Allowed" means the wrong TRANSPORT, not a bad URL (2026-07-23)
- MCP has two HTTP transports and they are not interchangeable. Legacy HTTP+SSE (2024-11-05) opens with a
  GET and waits for an `endpoint` event; Streamable HTTP (2025-03-26+) POSTs JSON-RPC at the single URL.
  A Streamable HTTP server is REQUIRED by spec to answer a bare GET with 405, so "405 on connect" is a
  transport mismatch — do not go hunting through URLs, headers, or auth.
- Config keys encode the transport: `url` ⇒ legacy SSE, `httpUrl` (or `"type": "http"`) ⇒ Streamable HTTP.
  Inferring transport from "is a URL present" silently mislabels every hosted server.
- Silently ignoring an unknown config key is worse than rejecting it: a `httpUrl`-only paste used to become
  a stdio server with no command — enabled, listed, and permanently dead with no error anywhere.
- When adding a transport, remember each MCP settings surface has TWO forms (add + edit) with duplicated
  gating, and `mcp.json` round-trips through `from_config`/`to_server_configs` — write transport explicitly
  or a save silently downgrades it back to the inferred value.

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

## 2026-07-21 — Inline-vs-block code detection by className is fragile
- AgentMarkdown detected fenced code by `language-*` class; unlabeled fences (very common from models) were silently styled as INLINE code chips. The bug was invisible for months because the chip background happened to equal the code-block background — a later chip retint exposed it as gray bands behind every line.
- Lesson: never distinguish inline vs block markdown code by language class; use structural context (inside <pre> or not). When two tokens share a color by coincidence, a latent styling bug can hide behind it — changing one token can "cause" a bug that was always there.

## 2026-07-21 — One visual concept spread across several tokens needs linked controls
- The two-layer frame is painted by three tokens (canvas/rail/dock). The Appearance "Background" quick control set only canvas, so one click fractured the frame into two tones (user-visible seam band). When a design tier spans multiple tokens, the primary control must move them together; per-token pickers are for deliberate divergence only.

## 2026-07-21 — Ghost/watermark text: shadows bleed through transparent gradient fills
- A `drop-shadow` behind text painted at 5-16% alpha shows THROUGH the glyphs and turns them into dark
  silhouettes (measured lum 24 where 50 was expected). Ground "standing" letters with a floor shadow
  pseudo-element UNDER the baseline instead of a filter behind the fill.
- Size watermarks in `cqi` (container query units), never `vw`: the conversation pane is narrower than
  the window (rails/dock), so vw sizing overflows and clips the last glyph when the pane shrinks.
- Harness trap that cost two iterations: moving gradient styles to a `> span` selector without adding
  the span to the test page — the text fell back to default black and every subsequent "fix" chased a
  phantom. Verify selectors match the DOM before judging renders; sample real pixel luminance, don't
  eyeball.

## 2026-07-22 — Probe-first for UI/design changes (user workflow)
- The user expects a VISUAL DESIGN PROBE before implementing any non-trivial UI/design change: a self-contained HTML file with several live-rendered variants (numbered cards, real tokens, real sizes, live hover, a recommendation), saved to `C:\Users\Alvan\Documents\` for them to open and pick from. Example they pointed to: `aurora-tool-icon-designs-v2.html`. I skipped this on the composer send-button work and iterated live instead, which burned many rounds and frustrated them.
- Format that works: `:root` with approximated `--agw-*` dark tokens; a `.grid` of `.card`s each with `.num` + `h3` (+ `Recommended`/`Current` pill) + `.desc` + a `.stage` rendering the actual control at real size across its states; footer with my pick + one-line rationale per variant. Inline SVG glyphs directly (NOT `<use href>` — external class CSS incl. `filter` glows can't pierce a `<use>` shadow tree).
- Apply relevant lessons BEFORE related work: check `.knowledge` at task start. New send-button probe: `C:\Users\Alvan\Documents\aurora-send-button-designs.html`.

## 2026-07-22 — Resolve skill roots from the advertised catalog
- I incorrectly looked for the required `surface` skills under the repository `.codex` folder even though the active catalog mapped them to `C:\Users\Alvan\.agents\skills`; both reads failed.
- Expand the listed skill root exactly before reading, and do not infer that a global skill is repository-local. Also reject project-overview metadata when its named product does not match the active repository.

## 2026-07-22 — Split multi-file patches around exact fixtures
- A combined process-tracking patch failed atomically because one `ShellStreamRequest` test fixture did not match the abbreviated source slice used to build the patch.
- Inspect exact constructor locations and patch owning files in small groups; verify each group before building the next dependent edit.

## 2026-07-22 — Keep PowerShell search patterns literal-safe
- A combined consistency command failed at parse time because one double-quoted `rg` regex contained an unescaped quote and closing group.
- Prefer single-quoted PowerShell patterns or split complex searches into separate commands so validation actually runs.

## 2026-07-22 — Scope whitespace checks in the CRLF-heavy worktree
- A repository-wide `git diff --check` emitted millions of line-ending-only warnings because much of this dirty worktree is already converted from LF to CRLF.
- Use task-path filters with `--ignore-space-at-eol`; never normalize or rewrite unrelated user-owned files to make the global check quiet.

## 2026-07-22 — Re-read nested JSX ternaries immediately after patching
- While adding the failed-header null branch, I left an extra closing parenthesis in the nested JSX conditional; a direct source read caught it before tests.
- After editing multi-branch JSX expressions, inspect the exact rendered conditional before moving on, then add a behavior-level regression test.

## 2026-07-22 — Correlate background servers by PID ancestry, not HTTP reachability
- I initially accepted the harness conclusion that a `200` after failed list/kill proved the latest `shell_spawn` process was alive. The persisted transcript showed stale-port contamination, and a clean process-tree probe exposed the deeper cause: Git's `bin\\bash.exe` launcher exits after handing work to `usr\\bin\\bash.exe`.
- On Windows, prefer Git's real `usr\\bin\\bash.exe`; verify wrapper PID → listener ancestry and begin lifecycle tests with a confirmed free port. A reachable port alone does not identify which spawn owns it.
- One ancestry probe also failed at PowerShell parse time because a `for` loop was piped directly. Collect loop output into an array before piping so setup and cleanup commands actually execute.

## 2026-07-22 — Do not use pnpm exec in an npm-only fixture without guarding installs
- Running pnpm-based syntax validation in the npm harness created `node_modules` and `pnpm-lock.yaml`. Keep permitted pnpm validation inside Aurora, or use an already-installed binary without allowing a package-manager install in external fixtures.
- Recursive deletion was policy-blocked, so the two generated artifacts were moved recoverably to `C:\msys64\tmp\aurora-harness-validation-cleanup-20260722`; the harness workspace was restored without touching its report changes.

## 2026-07-23 — A log that just stops is an invitation to hallucinate
- Aurora mirrored background output to a file but wrote nothing when the run ended. Truncated output is indistinguishable from a crash, so any reader has to guess — and a guess presented as fact is a hallucination the architecture caused, not the model.
- Every path out of a streaming loop is a termination and must write a terminator naming itself, including the ones that feel like non-events (spawn failure, stdout capture failure). Same for the `done` event: a cancel is as much an ending as an exit, and skipping it leaves the UI spinning.

## 2026-07-23 — Do not enqueue to a thread with no live turn
- The stop button enqueued "the user stopped this process" unconditionally. `enqueueMessage` drains at a tool-result boundary, so with no turn running the note sat in the pill and was injected into a later, unrelated turn — the agent then acted on it with no context. `useAgentTeamNotifier.ts:225` already documented the correct rule (`chat.liveTurns[threadId]`) and it was ignored.
- Prefer recording the fact where it will be read on purpose (the log file) over pushing it into the conversation. Interrupt only when someone is actually listening.
- I also described this injection path in prose as if I had traced it. Do not narrate a mechanism's behaviour from its name; open the caller and read where the value lands.

## 2026-07-25 — A React event prop is not always a real listener
- `onWheel` + `preventDefault()` looked correct and type-checked, but React attaches `wheel` at the root as passive, so the call was a no-op that only surfaced as a console warning. The same latent bug existed in two other components nobody had reported, because the symptom (the page also scrolls) reads as sloppiness rather than a defect.
- When a handler must cancel a default, check how the framework registered the listener — for `wheel`, `touchstart`, `touchmove` and `scroll` in React, bind natively with `{ passive: false }`. A silent no-op is worse than an error: it fails in the direction of "feels janky".

## 2026-07-25 — A byte cap tuned for status blobs silently destroyed the tool it was applied to
- `MAX_TOOL_RESULT_LENGTH` (8 KiB) was a sane default for grep/websearch and catastrophic for `workspace_tree`: every call fell into `compact_json_arrays`, which halves the largest array repeatedly and left 47 of 3,066 nodes — with `src/` and `src-tauri/` deleted and only a top-level `historyTruncated: true` to show for it.
- Two lessons. (1) A shared clamp needs a per-tool answer whenever the tools deliver different KINDS of thing; `file_read` already had one and nothing generalised the idea. (2) A node budget is not a byte budget — the first rebuild fit 1,200 nodes and still produced 221 KB, so it would have been shredded identically. Measure the serialized payload, not the item count.
- Corollary that keeps paying off: truncation must name itself AND the recovery step. Claude Code's own Glob says "Showing 100 of 172 … Narrow the pattern" — that one sentence is the difference between the next call being a narrowing and it being a guess.

## 2026-07-25 — `#[warn(dead_code)]` on a pub fn can mean "unfinished", not "unused"
- `ShellKind::interactive_args` was flagged dead. It was not redundant — it was the contract for wiring the PTY terminal to the shell registry, and that wiring had never been done, so the terminal still hardcoded `C:\Program Files\Git\bin\bash.exe` while the module docs claimed it no longer did. Deleting it would have cemented the bug.
- Check what a "dead" symbol was FOR before removing it. Three of six warnings here were genuine deletions, one was an unfinished feature, and one (`env::overlay_map`) was a test helper that cargo check cannot see — I deleted it, broke `cargo test`, and restored it as `#[cfg(test)]`. Run the TEST build before concluding anything is unused.

## 2026-07-25 — A frontend cache of state the backend owns will drift, and the drift is invisible
- The background-process dock kept its own copy of what was running, keyed by thread, built from tool results. Rust already had the authoritative ledger. The copy could not be right: switching project hid a live dev server and took its stop button with it, and a window reload erased the copy while the processes ran on.
- The tell was in the store's own doc comment — "kept per thread so a background turn's dev server never appears in another chat's dock". That was a deliberate scoping decision applied to the wrong kind of fact. A *conversation artifact* (a finished run's log) is per-thread; a *running process* is per-machine. Scope by what the thing IS, not by where it was created.
- Whenever the UI mirrors backend state, add a reconcile path before shipping. Events alone are not enough: `shell-process-ended` is fire-and-forget, so anything that misses it (a reload mid-flight) leaves a permanently wrong row with no way to correct itself.

## 2026-07-29 — "The stream ended" was a token budget, and I confidently blamed the network first
- The user reported an xhigh-reasoning turn dying after ~1 min. I read the SSE drivers, found that all
  three treat EOF as a successful turn (`None => break` then `finish_reason.unwrap_or("stop")`), and
  presented that as the answer. It is a real bug — but it was NOT this bug. The actual cause only
  became visible when the user pasted the reasoning transcript: 29,048 chars ≈ 7.2k tokens against an
  8192 output cap where `xhigh` claimed 90% of it. The arithmetic was decisive and I had never done it.
- The lesson is about ordering, not about being wrong. I had the cap (`default_max_output_tokens: 8192`)
  and the tier share (`Some("xhigh") => 90`) open in front of me BEFORE I answered, and I read them as
  configuration rather than as a budget to add up. When a symptom is "it stopped early", price the
  budget first — it is cheap, arithmetic, and falsifiable — before reaching for the more interesting
  distributed-systems explanation. A plausible mechanism found by reading code is a hypothesis; a
  number that matches the observed output to within 2% is evidence.
- Corollary that actually mattered more: ASK FOR THE ARTIFACT. One paste of the truncated transcript
  settled in seconds what code-reading had been circling. It also showed the cut landed mid-identifier
  (`usePrefersReduced`), which is what ruled out a clean provider stop.

## 2026-07-29 — An event switch with one silent `break` hid a warning the backend was already sending
- Rust correctly detected the truncation and emitted `AssistantEvent::Error{recoverable:true}` telling
  the user the reply was cut off and to raise Max output. `agent-runtime-client.ts` had
  `case "error": break;` — the ONLY arm in a switch of ~15 with no callback, sitting directly above a
  `default:` that logs unknown events with `console.warn`. So an event the team explicitly modelled was
  treated worse than one nobody anticipated.
- Two things to carry forward. (1) In an exhaustive event dispatcher, a bare `break` is a claim that
  the event is intentionally ignorable; if that is true it deserves a comment saying why, and if it is
  not true it is a dropped feature. Grep for arms with no callback whenever a backend signal
  "doesn't show up". (2) The fix is not just to forward it — `onError` appended the text into
  `m.content`, which makes the AGENT appear to announce its own truncation. Runtime speech and model
  speech need different renderers, or the product loses the ability to say anything in its own voice.

## 2026-07-29 — Clamping two invariants independently satisfies one and breaks the other
- Fixing the budget, I wrote `answer.saturating_add(budget).min(CEILING).max(budget + 1)`: the `.min`
  enforced "max_tokens <= 64k", the `.max` enforced "budget < max_tokens". With a 32k answer budget on
  `xhigh` the desired budget was 96k, so the floor re-raised the total to 96,001 — back over the
  ceiling the previous call had just enforced. The test I wrote for the ceiling caught it immediately.
- When two constraints reference each other, resolve them in ONE function that returns the whole
  consistent answer (`-> Option<(budget, max_tokens)>`), not as a chain of independent clamps. And
  decide explicitly which side absorbs the loss — here reasoning shrinks and the answer allowance
  stays whole, because starving the reply was the original bug.
- Worth noting the loop test (`for answer in [...] { for effort in [...] }`) asserting both invariants
  at every size found nothing further, but it is the test that makes this class of bug non-recurring.
  Point assertions would have kept passing at the sizes I happened to pick.

## 2026-07-29 — I diagnosed the right symptom through the wrong code path, twice, before reading the data
- Sequence: (1) blamed EOF-as-success in the SSE drivers; (2) the user pasted the transcript, I did the
  token arithmetic and blamed the Anthropic `xhigh` 90% thinking carve-out; (3) the user pushed back
  — "that model has no budget slider, only effort tiers, so where are those tokens coming from?" — and
  reading the actual session + provider row showed the provider was `provider_type: "openai"`, so the
  Anthropic code I had been reasoning about was never executed at all.
- The real cause was one line of precedence in `toLlmConfig`:
  `defaultMaxTokens: provider.defaultMaxTokens ?? provider.maxOutputTokens` combined with consumers
  reading `defaultMaxTokens ?? maxOutputTokens`. A stale provider-level 8192 therefore beat the
  per-model 128000 that the resolver had just computed correctly. Nothing about reasoning, streaming,
  or Anthropic was involved in the cap itself.
- Lesson: when a bug report names a MODEL, resolve the whole config chain from the stored row before
  reasoning about any adapter. `provider_type` decides which thousand lines of code even run, and I
  read `claude-opus-5` and assumed "Anthropic adapter" — through a third-party OpenAI-compatible
  gateway it is not. One `.meta.json` + one DB query would have told me at the start.
- Second lesson: a defaulting chain where two fields can both supply the same value needs an explicit
  precedence comment, because `a ?? b` at the producer and `a ?? c` at the consumer silently makes `b`
  outrank `c`. The bug is invisible at both sites and only exists in their combination.
- Third: the user's domain instinct beat my code reading. "No slider, only effort tiers" was a precise
  observation about the model's `reasoning` config that directly contradicted my theory. Treat that
  kind of pushback as evidence to chase, not as something to explain away.

## 2026-07-29 — A tool schema that can't express its own contract will be "violated" by correct models
- User: "Opus 5 / Kimi K3 are very intelligent, they can't make this mistake" about `file_read` failing
  ~1% of calls with `paths: [1 item]` + `start_line`/`end_line` → "only work with single-file `path`".
  They were right, and the framing was the useful part: a frontier model producing the same malformed
  call repeatedly is evidence about the INTERFACE, not the model.
- Two compounding causes. (1) `file_read` declares `path`, `paths`, `start_line`, `end_line`,
  `max_lines` as independent optional siblings, because the real `path` xor `paths` rule needs a
  top-level `oneOf` and strict validators (xAI/grok) HTTP-400 on `oneOf`/`anyOf`/`allOf` in function
  params. So `{paths:["x"], start_line:1}` is **schema-valid** and the runtime rejected it anyway. The
  model obeyed the contract it was given; the prose description carried a rule the schema denied.
  (2) The rule was over-broad: a ONE-element `paths` names exactly one file, so a line window has
  precisely one referent — there was nothing ambiguous to reject.
- Fix: coerce a single-element `paths` + line window into the single-file form and serve the read; keep
  the error only for 2+ files, and reword it to name the recovery that PRESERVES intent ("re-issue with
  `path`…") instead of "omit them", which told the model to throw away what it wanted.
- Generalisable rule: when a schema cannot encode a constraint, the runtime must be as permissive as
  the schema is, and resolve every unambiguous input instead of failing it. Prose in a description is a
  hint, not a validator. Audit any tool whose docs say "exactly one of" — that phrase marks a contract
  the schema probably isn't enforcing.

## 2026-07-30 — When the model "misbehaves", read the text we hand it before touching the tools
An agent inside Aurora filed 7 complaints about its own environment. **Three were caused by Aurora's own
prompt and tool-description text instructing the behaviour being complained about**, not by missing features:
- `shell_list_processes` literally said "read that file with file_read to see what a running process has
  printed". Its 15-call polling loop was obedience, not incompetence.
- `getMcpToolsSummary()` injected a whole second tool inventory in display-name form and then told the model a
  prefixed callable name existed without printing one. It reached for the useless inventory because we made it
  the prominent one.
- `agent-prompt.ts` said to prefer friendly MCP names — meant for prose, read as naming policy for calls.
Rule: before adding a tool or a flag to fix agent behaviour, `grep` the prompt and every tool `description`
for what we already told it. A tool description is executable policy; the model follows it exactly.

## Same session — an agent's self-report is a hypothesis, not a bug report
5 of 7 asks were real, but 2 diagnoses were wrong in ways that would have driven the wrong fix:
- "There is no formula I can derive [for MCP callables]" — the exact callable was in the tool schema the whole
  time. The symptom was real; the stated cause was not.
- It asked for `auto_lint: true` on every edit, not knowing `read_lints` runs `tsc -b` / `cargo check` /
  `compileall` over the WHOLE project. Building it as asked would make a 5-file refactor 5 full builds.
Verify every claim against the code, including the ones that sound authoritative — and re-check the harness
layer it names. I also asserted `getMcpToolsSummary` was legacy-IDE-only; the agent window reaches it through
`AgentService` too, so the report was right and I was wrong.

## Same session — derive counts in tests, never hardcode them
`tools/mod.rs` had `assert_eq!(reg.len(), 22)` in two tests plus a module doc claiming "10 + 6 = 16 … total
24" against a real 30. The prose had drifted three separate times because `builtin_tool_count_is_correct`
guards the constant and never the comment. Adding one tool broke both literals. Now derived from the bucket
`TOOL_NAMES` arrays, with the single intentional-change tripwire left in `BUILTIN_TOOL_COUNT`. If a test
asserts a total that a sibling array already knows, compute it.

## 2026-07-31 — "One system" was the bug, not the fix
- A plan and a todo list were unified so there would be "exactly one answer to where am I". The
  unification was the defect: a plan is COARSE and per-project (phases the user approved), a todo
  list is FINE and per-thread (the steps of the phase being executed). They are different
  granularities of different things, so suppressing one to serve the other produced a checklist that
  could never move in a planned project, and a `todo_update` tool the prompt told the model to prefer
  while the runtime refused to run it.
- The tell was in the user's own words — "plan could be three phase; in phase one he will create a
  todo for five steps". When a user describes a workflow that the architecture forbids, the
  architecture is wrong. Do not defend a unification because it sounds principled; check whether the
  two things being unified are the same KIND of thing.
- Second lesson, and the reason this shipped broken for so long: the panel was a frontend
  reconstruction of state Rust already owned, built by parsing tool-call ARGUMENTS of one tool. Every
  other tool that changed the list was invisible to it. This is the same class as the background
  process dock (2026-07-25) and it recurred within a week. **A frontend copy of backend state will
  drift, and parsing arguments is strictly worse than reading results** — arguments only tell you
  what was asked for, never what happened, and they only cover the one tool you happened to watch.
- Third: an event nobody can route is an event nobody can use. `emit_todo_write` carried `{todos}`
  with no thread id because the sink is app-global, so a window running several conversations could
  not apply it and simply ignored it. When adding an event, ask "what does the receiver need to know
  WHERE this belongs" before "what data does it carry".
- Fourth: the transcript printed the tool's model-facing `message` verbatim ("Marked t2 as completed.
  Nothing in progress; next up is t3."). A result string is read by BOTH the model and the user, so
  it must name things the way a person needs (task titles) and the renderer must not fall back to
  dumping it. Grep for other tools whose `message` reaches `tool-result.ts`'s 60-char passthrough.
- Fifth, caught by a test I nearly overrode: the composer-rail chip counted `completed + cancelled`
  and the panel counted `completed`. I "unified" them onto the panel's number and broke the rail's
  test, whose NAME stated the intent ("counts a cancelled todo as closed, not outstanding"). The rail
  was right — the panel's own `allDone` already treated cancelled as terminal, so it rendered
  "Tasks complete 2/3". When a test disagrees, read its name for the intent before changing it.

## 2026-08-01 — "Sometimes shows" was one deterministic bug, not flakiness

- An owner-reported intermittent UI symptom ("not showing and sometimes show") turned out to be two
  DIFFERENT code paths producing the same widget: the optimistic live message (always wrong, ~0ms
  span) and the reloaded-from-disk message (always right). Nothing was flaky. When a symptom reads as
  intermittent, first ask whether two sources feed the same render — the "sometimes" is usually which
  source you happened to be looking at.
- A derived-value guard can hide its own input bug: `turnWorkedMs` returns `null` for `span <= 0`,
  which is correct defensively but meant a broken timestamp failed SILENTLY as an absent element
  rather than as a visible "0s". Guards that map bad input to "render nothing" make upstream bugs
  invisible.
- Do not take an agent's self-diagnosis at face value. Of its two tool complaints, one was exactly
  right (`browser_click` / `:has-text()`) and one had the right symptom with the wrong mechanism
  (the console buffer is already 500 entries with uncaught-error capture; the page reload wipes it,
  it is not "consumed"). Verify against the source before acting on either.

## 2026-08-01 — Consolidating tools: the rename is the risk, not the schema

- Folding three tools into one was mechanical. The real hazard was that every model has `TodoWrite`
  baked into its training data, and edit-distance suggestion CANNOT bridge a rename — `todo_write` is
  six edits from `todo`. Without an explicit retirement table the first turn of every conversation
  would have burned an iteration on an unknown-tool dead end. When you rename a tool, ask what the
  model will call INSTEAD and make that name resolve.
- A `nativeRustOwned` TS tool definition is filtered before the request, but `build_per_turn_tool_
  registry` DOES register a bridge executor for every `AllowedTool` the frontend sends. So a stale TS
  name is only harmless while that flag is set — check the flag, do not assume the frontend defs are
  inert.
- Consolidating by name silently changes name-based gates. `todo_read` was allowed in Plan mode and
  `todo_write`/`todo_update` were not; one tool makes that distinction inexpressible. Decide the new
  answer deliberately (here: withhold entirely) rather than discovering it from whichever list the
  merged name happens to land in.
- A portaled hover popover needs a close GRACE PERIOD, not just enter/leave handlers on both
  elements. The gap between trigger and card belongs to neither, so mouse-leave fires before
  mouse-enter and the card dies mid-reach. Same trap as any hover menu with an offset.
- React derives `onMouseEnter`/`onMouseLeave` from DELEGATED `mouseover`/`mouseout`. A raw-DOM test
  dispatching `mouseenter` never reaches the handler and looks like a component bug. Dispatch
  bubbling `mouseover`/`mouseout` with a `relatedTarget`.
- Do not assert DOM removal on anything inside `AnimatePresence` — the element stays mounted for its
  exit tween, so the assertion tests framer-motion's clock. Assert the state the component controls
  (`aria-expanded`), which is also what a screen reader observes.

## 2026-08-01 (later) — A field named `session_id` that is not the session's conversation

- `Session` has BOTH `session_id` (fresh UUID per load) and `thread_id` (the conversation). Every
  tool-layer consumer of `ctx.session_id` actually wanted the thread; the name made the wrong one
  look right, and three separate features (todo sidecar + event, plan run claims, background log
  cleanup) silently keyed off an id that changed on every restart. When two ids of the same shape
  coexist, the field name is the whole defence — rename rather than reassign, so the next reader
  cannot repeat it.
- Making a tool render NOTHING removed the only evidence that it ran. The broken event path above
  had been live for a session and was invisible precisely because I had just silenced the tool's
  transcript row. Silence and failure look identical; if a tool is silent, its effect must be
  verifiable somewhere the user can actually see.
- `tsc --noEmit -p tsconfig.json` and `tsc -b` are NOT the same check here — the project-references
  build caught a bad field in a test file the flat run passed. Run `pnpm build` before claiming
  typecheck is clean.

## 2026-08-02 — A `scroll` event is not user intent, and a self-scrolling hook will cancel itself
- Two owner-reported agent-window bugs had ONE cause. `useAgentAutoScroll`'s scroll listener treated
  every `scroll` event as "the reader deliberately left the bottom" — cancelling the follow loop and
  dropping the entry anchor. But the hook is the most prolific scroller in the window: the follow lerp
  assigns `scrollTop` once per frame and the entry anchor assigns it on every re-pin. **It was
  reacting to itself.**
  * "Jump to latest" moved ~25% per click: frame 1 of the lerp scrolled → that fired `scroll` → still
    >140px from the bottom → `cancelFollow()` killed the rAF loop one frame in. The animation
    strangled itself, so the button looked like it advanced "lil by lil".
  * Opening a thread landed above the newest message: the anchor's own re-pin scroll set
    `initialAnchorRef = false`, and the 800ms fixed window expired while messages were still loading
    async and markdown/Shiki/images were still growing the transcript. After that, growth only
    followed `if (isStreaming)` — false for a restored thread — so the reader was stranded.
- RULE: if a component both scrolls programmatically and listens for scrolling, `scroll` can only be
  used to OBSERVE position. Reader intent must come from INPUT events — `wheel`, `touchstart`, a
  `pointerdown` whose `offsetX > clientWidth` (scrollbar gutter only, so clicking a tool card doesn't
  stop a stream from following), and navigation keys. Same family as the passive-`wheel` lesson from
  2026-07-25: the framework/browser event you reach for first often isn't reporting what you assume.
- RULE: an "entry window" for async-growing content must be a QUIET PERIOD (restarted on every
  growth), never a fixed delay from mount. A fixed 800ms expires mid-layout on exactly the long
  conversations that need it most. Keep a hard cap too, or a view that never stops growing pins the
  reader forever.
- Also: an explicit "go to the bottom" should SNAP past a few screens rather than glide. A lerp across
  50 screens is not continuity, it is a wait — and the reader asked to BE at the bottom, not to travel
  there. Extracted as a pure `shouldSnapToBottom(distance, viewportHeight)` so the threshold is
  testable without a layout engine (jsdom models none of scrollHeight/ResizeObserver/rAF).
- Trap while fixing: adding `setShowJump(false)` inside `jumpToBottom` tripped
  `react-hooks/set-state-in-effect`, because that function is called from an effect as well as from
  the button. A helper invoked from both effects and handlers must stay setState-free — the scroll
  event already reconciles it.

## 2026-08-02 — The harness corrupted a valid glob, then the model looked wrong for sending it
- SYMPTOM (owner pasted a live tool result): `grep` failed with
  `rg: error parsing glob '**/*.{ts': unclosed alternate group; missing '}'`. Note the glob in the
  message is TRUNCATED — the model had sent `**/*.{ts,tsx}`, which is correct.
- CAUSE: `commands/mod.rs::parse_glob_patterns` was `value.split(',')`. The comma is BOTH Aurora's
  list separator and glob alternation syntax, so `**/*.{ts,tsx}` was cut into `**/*.{ts` and `tsx}`
  before ripgrep ever saw it. Reproduced exactly against the bundled `rg`: the fragment emits the
  owner's error verbatim, the whole glob returns files.
- This is the same family as the 2026-07-30 finding ("read the text we hand it before touching the
  tools") but the mirror image of it: there the prompt TOLD the model to misbehave; here the harness
  silently MUTATED correct input. Both end with a competent model looking incompetent. **When a tool
  rejects a value, check whether the value in the error is the value the model actually sent** — a
  truncated echo in an error message is the tell.
- RULE: never `split(sep)` a value when `sep` is also syntax inside that value. Splitting must be
  depth-aware — top-level commas only, skipping `{…}` alternation, `[…]` classes, and `\` escapes.
  Malformed input is forwarded verbatim rather than repaired: ripgrep names the real problem better
  than a guess at intent.
- Contributing gap: the `glob` property in grep's schema had NO `description` at all, so nothing told
  the model that comma-separated multiples were even supported — or that braces were expected to work.
  An undocumented parameter invites exactly the input the parser mishandles. Now documents braces,
  comma lists, and `!` negation.
- The sibling `glob` TOOL was never affected — it passes its pattern straight to `--glob` with no
  splitting. Only the ripgrep-backed `grep` had the bug.

## 2026-08-02 (same session) — The glob fix alone would have made the bug WORSE, not better
- Owner ran `grep` with `glob: apps/quantumhub-client/src/**/*.{ts,tsx}` and `path:
  E:\QuantumHUB-Infrustructure` and got ZERO results. Reproduced against the real repo: the correct
  search returns **35 files**. Two independent bugs were stacked.
- BUG 1 was the comma split (fixed earlier this session). BUG 2: `grep` passed the search root as
  ripgrep's PATH OPERAND. **ripgrep anchors a slash-bearing glob to the WORKING DIRECTORY, not to the
  path operand**, so any path-qualified glob (`apps/x/src/**/*.ts`) matched nothing against an
  absolute root, while bare `**/*.rs` kept working.
- THE POINT WORTH REMEMBERING: had I shipped only the comma fix, the loud
  `unclosed alternate group` error would have become a SILENT EMPTY RESULT — the same wrong answer
  with the evidence removed. When fixing a tool that errored, re-run the ORIGINAL failing call end to
  end afterwards; a fix that merely stops the error can be a regression.
- `glob.rs` had ALREADY solved bug 2 and its comment names it exactly — "passing an absolute root made
  every such pattern silently match nothing while bare patterns like `**/*.rs` kept working — the
  worst shape of bug, since the tool looks functional" — and applies `cmd.current_dir(&search_root)`.
  `grep` never got the same treatment. **When one tool's comment documents a ripgrep footgun, grep the
  other ripgrep call sites for it the same day**; sibling tools sharing a binary share its traps.
- Fix mirrors glob.rs: run with `current_dir(search_dir)` and `.` as the operand when `path` is a
  directory (a single FILE keeps the operand form — there is no directory to run in and a glob over
  one explicit file is meaningless). Because that makes ripgrep emit `.\src\x.ts`, results are
  rejoined onto the search dir by `absolutize_rg_path` so the absolute-path output contract that file
  chips / open-in-IDE / the review panel depend on is unchanged.

## 2026-08-02 — A dropdown sized from its trigger lets one arbitrary item size the whole list
- The new project switcher set its menu width to `Math.max(triggerRect.width, 260)`. The trigger is as
  wide as the CURRENT project's name + path, so the menu's width was decided by whichever project you
  happened to be in: a long name gave a sprawling menu, a short one gave a cramped menu that scrolled
  SIDEWAYS and cut every other name mid-word (`AURORA-MELODY-INFRUSTRUCT`). Owner caught it in two
  screenshots.
- RULE: a menu is its own object and sizes to its own content budget. Derive a popover's width from
  its trigger only when it is a true dropdown of that field (a select), never when it lists peers the
  trigger is only one of.
- A horizontal scrollbar inside a dropdown always means the row layout failed — nobody scrolls a menu
  sideways, so the end of every label is simply hidden. `overflow-x: hidden` on the list, and make the
  rows truncate.
- Useful flex idiom for "name + secondary detail" rows: give the SECONDARY element `flex: 1 1 0`. A
  zero flex-basis means it claims only leftover space, so it can never push the primary element out of
  the row — it shrinks to nothing before the name loses a character. The primary gets
  `flex: 0 1 auto; min-width: 0` so it still truncates in the extreme case rather than overflowing.
- Check before adding defensive CSS: `AgentIcon` already sets `flexShrink: 0` inline, so the
  `flex: none` rules I added for its glyphs were dead, and one of them
  (`span:first-of-type:not([class])`) was guesswork about markup I had not read.

## 2026-08-02 — `will-change: transform` + `transform: scale()` rasterizes vector content once

Mermaid diagrams in the Canvas were unreadable when zoomed: a diagram that auto-fit at ~10% stayed
legible-ish, but zooming to 180% produced a blurry smear where no amount of further zoom helped.

Cause: `.agw-diagram-artwork` had `will-change: transform` (wanted, for smooth panning) and applied
zoom via `transform: translate3d(...) scale(...)`. `will-change` promotes the element to its own
compositor layer; Chromium then rasterizes that layer ONCE and lets the GPU stretch the bitmap for
later transforms — precisely what `will-change` is telling it to do. So the SVG was rasterized at fit
scale and every zoom step enlarged that bitmap instead of re-rendering the vector. Zooming was the
thing destroying the image.

RULE: never express zoom of vector/text content as `transform: scale()` on a promoted layer. Apply
zoom to the element's LAYOUT SIZE (width/height) and keep the transform for translation only — the
layer's size change forces a re-raster, so the SVG re-renders sharp at every level. The substitution
is exact when `transform-origin: 0 0`, because a scaled layer and a grown box occupy the same
rectangle; that is what let the fit/pin-point-zoom maths stay untouched (`diagramArtworkBox`, tested).

Wider tell: "content is blurry only after zooming / only on one surface" is almost never a rendering
bug in the content — look for a composited ancestor being scaled.

## 2026-08-04 — A Tauri event listener can be silently filtered out by its target KIND
- `getCurrentWindow().onDragDropEvent(...)` never fired in the agent window, so dragging a file from
  Windows Explorer into the composer did nothing — with no error anywhere. The events were arriving in
  that very webview the whole time. `Window.listen` subscribes with `{kind:'Window', label}`, and
  `manager/mod.rs::filter_target` only feeds a Window-kind listener from `Window`/`AnyLabel` emits — a
  `Webview`/`WebviewWindow`-kind emit is dropped by `event/listener.rs::emit_js_filter`. Label matching
  is NOT sufficient; the kind must match too.
- FIX: subscribe with `listen(name, handler, { target: label })`. A STRING target maps to
  `{kind:'AnyLabel'}` (event.js:72), the only kind `filter_target` matches for every emit variant
  carrying that label — and unlike `{kind:'Any'}` it stays scoped to this window, so a drop on the IDE
  window can't insert files into the agent composer.
- METHOD worth reusing: when a Tauri event "never arrives", register a second `{kind:'Any'}` listener
  for the same event name. It short-circuits the target check (listener.rs:310), so if the probe fires
  and the real listener doesn't, the problem is target filtering — not the OS, the config, or the
  runtime. That one probe replaced a long chain of plausible theories (elevation/UIPI, dragDropEnabled,
  capabilities, DPI) that were all wrong.
- Do not diagnose a UI symptom against the wrong binary: three `aurora.exe` were running (two installed
  from LocalAppData, one dev). Check `Get-CimInstance Win32_Process` command lines FIRST, and confirm
  the dev server is serving the edited module (`curl http://localhost:5173/src/...`) before trusting
  "still broken". Reading the app's own DevTools console via UIA (qg-probe `dump_tree` + the console
  filter box) beats asking for a paste.

## Tauri drag-drop events only reach Webview/WebviewWindow-kind listeners (2026-08-04)
- OS file drops onto the agent window produced no events for `getCurrentWindow().onDragDropEvent`
  (`{kind:'Window'}`) NOR for a string listen target (`{kind:'AnyLabel'}`) — yet a `{kind:'Any'}` probe saw
  everything. Root cause: on Windows the drag lands on the WEBVIEW, so tauri 2.9.5 emits from
  `manager/webview.rs::on_webview_event` → `emit_to_webview`, whose filter is
  `Webview{label} | WebviewWindow{label} => label == window_label, _ => false`. Window/AnyLabel are in the
  `_ => false` arm; `Any` bypasses via `match_any_or_filter`.
- Do NOT reason from `manager/window.rs`'s drag emit (AnyLabel, broad matrix) — that path is not the one used
  for a webview window. When source and runtime disagree, register every target kind at once in the live
  window and see which fires; that 5-minute experiment settled what two sessions of source-reading got wrong.
- Fix: `listen(ev, h, { target: { kind: 'WebviewWindow', label } })` in `useAgentExternalDrop.ts` (or
  `getCurrentWebview().onDragDropEvent`). One line; everything else in the drop chain was already correct.
