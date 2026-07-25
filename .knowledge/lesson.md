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
