# Aurora IDE — Working Memory

## RUNTIME DATA LOCATIONS (Windows) — stop hunting for these
Root is `%LOCALAPPDATA%\AuroraIDE\` (`dirs::data_local_dir()` + `ROOT_NAME = "AuroraIDE"` in
`src-tauri/src/paths.rs:22,34`). It is **NOT** `%APPDATA%\com.aurora.agent\` — that path in CLAUDE.md
is WRONG, and the `identifier`/`productName` in tauri.conf.json (`com.aurora.agent` / `Aurora`) are
not used for data paths at all. `%APPDATA%\Roaming\Aurora-Agent-IDE\Agent\Threads\` is a DEAD legacy
store (last written May 2026) — ignore it.

    C:\Users\<user>\AppData\Local\AuroraIDE\
      sessions\        <thread_id>.jsonl          — the conversation log (one ConversationMessage/line)
                       <thread_id>.meta.json      — title, workspaceRoot, model, tokenUsage, contextUsage
                       <thread_id>.rich.jsonl     — full-fidelity tool results (history copy is clamped)
                       <thread_id>.todos.json / .artifacts.json / .tool-results\
      data\aurora.db   — SQLite (llm_providers, threads, workspace_state, …) + -wal / -shm
      checkpoints\ config\ typing-assist\

`paths::sessions_dir()` returns `<root>/sessions` — the doc comment in `lib.rs` claiming
`<app_data>/agent_v2/` is STALE, there is no `agent_v2` folder on disk. To find the thread behind a
report, grep the sessions dir for a distinctive string from the transcript
(`grep -l "<symbol>" *.jsonl`) then read its `.meta.json` for model + workspaceRoot.

## 2026-07-30 — MCP naming, shell_read_output, honest timeouts, prompt (DONE, uncommitted, needs tauri:dev)
Driven by an agent self-report from inside Aurora (7 asks). 5 were real; 2 declined with reasons. Order was the
user's. **Items 1-5 done; item 6 (plan/todo) deliberately NOT started — see the next block.**

1. **MCP callable naming was Aurora's bug, not the model's.** `getMcpToolsSummary()` (`src/services/mcp-tools.ts`)
   injected a SECOND tool inventory into the system prompt listing only display names via
   `formatMcpToolLabel` — which title-cases and splits on `_`, so `events_get-response-body` rendered as
   "Events Get-response-body" and **cannot be inverted**. It then said "internally, MCP tools are callable by a
   prefixed name" without ever printing one. The real callable was in the tool schema all along, so the model had
   both and reached for the prettier, useless one. Fix: summary now prints `` `callable` — "display" `` and drops
   per-tool descriptions (already in the schemas — pure token duplication). Extracted `mcpCallableName()` /
   `mcpServerPrefix()`; the `mcp_{sanitizedServerId}_{tool}` rule had been inlined at 3 sites that could drift
   apart. `agent-prompt.ts` now separates MENTION (display name) from CALL (schema name).
   NB the agent window runs through `AgentService`, so it DOES get this summary — not just the legacy IDE path.
   `tool_suggest.rs` already recovers an underscore/hyphen slip within tolerance; left alone.
2. **`shell_read_output` (new, `shell_editor_todo/shell_read_output.rs`).** `shell_list_processes`'s own
   description told the model to "read that file with file_read", so its 15-call polling loop was COMPLIANCE.
   New tool reads by `start_line` (same contract as file_read), returns `nextStartLine`, and `wait_ms` blocks
   until output arrives or the run ends. Knows `running`/`ending` from the `[aurora]` footer, so it stops polling
   a dead process. Log path now resolves via a new `IdeEventSink::background_log_path` default-`None` trait
   method (deterministic from session+process id, so it works AFTER `cleanup_command_stream` drops the row).
   `PROCESS_LOG_FOOTER_PREFIX` exported from `commands/mod.rs` so reader and writer cannot disagree.
   `BUILTIN_TOOL_COUNT` 30 -> 31.
3. **Timeouts were lying.** `execute_command_stream` returned a timeout as `exit_code: Some(1), success: false`
   — indistinguishable from a real exit-1 failure, so the model "fixed" commands that were merely slow. Added
   `timed_out` to `CommandOutput` + `ShellRunOutput`; the killed path now returns `exit_code: None` (it never
   reported one) and `shell_execute` surfaces `timedOut` / `timeoutMs` / a `note` saying the output is PARTIAL.
   Default timeout 30s -> 120s (30s is under a cold `tsc -b`/`cargo check` here), ceiling 5min -> 30min.
   `shell_spawn` gained a `timeout` (lifetime cap, clamped, default 7d) — it previously had none at all.
   Non-streaming `execute_command` still discards output on timeout (the future is dropped); only its message
   improved. That path is read_lints + tests, not the agent's shell path.
4/5. **Prompt.** Added a `## Shell Commands` section (there was none — one line about grep timeouts). Shell
   choice, no mixed syntax, pass `timeout`, `timedOut` != failure, spawn+read_output instead of polling, kill
   what you start. `model_facing_summary()` (Rust) now names the user's default and warns off `cmd` ONLY when
   another shell exists. Also: corrected the now-wrong `file_read` bullet (a 1-element `paths` + range is
   coerced now), documented `force_full_content`, noted `read_lints` runs whole-project checkers so it should be
   batched, and replaced vague behavioural lines with a two-strikes loop breaker, unknown-tool recovery, batched
   reads, and report-outcomes-honestly.

DECLINED, with reasons: **MCP live state** ("192 events captured") — MCP has no generic runtime-state surface;
would mean hardcoding per-server knowledge. **`auto_lint: true` on every edit** — `read_lints` runs
`pnpm exec tsc -b`, `cargo check`, `python -m compileall .` on the WHOLE project, so a 5-file refactor would be
5 full builds. The real want is a fast single-file syntax check; different feature.
PARTIALLY REAL: edit staleness. `read_tracker::was_seen` already refuses editing an unread file, but tracks
*whether*, not *which version* — a content hash would catch external (Monaco/formatter) changes. Not built.

Verified: 899 Rust (was 891), 249 frontend (was 245), tsc clean, eslint clean on touched files, clippy clean on
every touched Rust file. NOT runtime-verified — no `pnpm tauri:dev` run.

## NEXT UP (not started): rebuild plan/todo as Claude-Code-style task tracking
User's words: "for plan and todo we need entire refctor" and "our aurora agentwindow agent runtime todo read
write will be same as your claude code tracking progress". So the target is **parity with Claude Code's task
tools**, not a patch on the existing ones. Required shape:
- Create and update as SEPARATE ops; update addresses one task by id and sets one field (status, subject,
  description, activeForm, owner, metadata).
- Statuses `pending -> in_progress -> completed`, plus `deleted` as a real terminal state that removes the task.
- `activeForm`: present-continuous label shown while a task is in_progress (spinner text), distinct from the
  imperative `subject`.
- Dependencies first-class: `addBlocks` / `addBlockedBy`, so ordering lives in the graph, not in list position.
- List + get, and a staleness rule (re-read before updating).
- Exactly one in_progress; never mark completed on partial work or failing tests — create a follow-up instead.
Existing problems to fold in: `todo_read` hands over plan steps with NO created/updated timestamps, a stale plan
takes over authoritatively, and there is no `plan_close`/`plan_archive` — only `plan_write` and
`plan_step_update` exist, so the sole escape is marking every step done by hand.

## Task (2026-07-25): agent harness reliability trio — DONE (uncommitted, NEEDS RUST REBUILD)
User: "frontier models like Opus call the wrong tools — our implementation has an issue; it isn't mature enough
for a large project." Audited the loop (not the tools — the tool layer is fine: read-before-edit guard, spill,
per-tool caps). Six defects found; user picked the reliability trio (1+3+4). #2 (no prompt caching at all —
`grep -c cache_control src-tauri/src` was **0**), #5 (tool calls dispatch strictly sequentially,
`conversation.rs` `for call in calls`) and #6 (no repeated-failure breaker; `stop_reason=="length"` unhandled)
are DIAGNOSED BUT NOT BUILT — #3 below was the prerequisite for #2.
- **#1 The big one: malformed tool args were silently replaced with `{}`.** `parse_tool_input`
  (`provider_kernel_adapter.rs`) and a duplicate in `anthropic.rs` both did
  `serde_json::from_str(raw).unwrap_or(json!({}))` — and a test PINNED that behaviour. A call truncated by the
  output cap or carrying a bad escape reached the executor with NO arguments, so `file_edit` answered "`path`
  is required" to a model that had sent `path`. The model can't reconcile that, so it retries, rephrases, and
  switches tools. **What looks like a model calling the wrong tool is the harness eating its arguments.**
  Fix: a failed parse now yields `Value::String(raw)` (no magic key, no type churn — every schema is
  `type:object`, so a non-object input is unambiguously broken). `conversation.rs` checks
  `malformed_tool_input()` BEFORE lookup and never dispatches; `malformed_input_error()` returns a message
  naming the tool, quoting head+tail of what actually arrived, and distinguishing an EOF parse failure
  ("cut off by the output cap — re-issue smaller") from a syntax error ("unescaped backslash…").
  `tool_input_for_wire()` sanitizes back to `{}` at both request-body sites, or one malformed block would 400
  every SUBSEQUENT turn (providers require `tool_use.input` to be an object).
  anthropic.rs now calls the shared `parse_tool_input` — it had been missing the Windows-path repair entirely.
- **#3 Tool schemas shipped in random order every request.** `ToolRegistry` is a `DashMap`; `schemas()` is
  re-read inside the turn loop and `names()` even documented "non-deterministic order". Registry now stores
  `(registration_index, executor)`; `register()` PRESERVES an existing index so `install_permission_gate`'s
  in-place re-registration can't reshuffle. This is a hard prerequisite for prompt caching (#2): a cached
  prefix that reorders every request never hits.
- **#4 Unknown tool was a dead end.** `tool not found: browser_eval`, no roster, no near-match — the model's
  only move was another guess. New `agent_runtime/tool_suggest.rs` (Levenshtein, length-scaled tolerance,
  prefix tie-break, returns None rather than a bad guess) + `ToolRegistry::unknown_tool_error()` which appends
  "Did you mean `x`?" and the real roster (summarized past 60 names so MCP-heavy workspaces don't flood).
  Payoff: DELETED the `agent-prompt.ts` paragraph enumerating withdrawn browser tools and pleading "do not
  apologise for not having them" — that text existed only to paper over this error.
- **#2 Prompt caching — Aurora sent ZERO `cache_control`.** Now sets 3 breakpoints in `build_anthropic_body`
  (Anthropic prefix order is tools → system → messages): last tool schema, the system block (which forces the
  ARRAY form — a plain string has nowhere to hang the marker), and the last content block of the last message
  (rolling, so the next iteration reads all prior history from cache and writes only the delta). Gated hard on
  `provider_id == "anthropic"` via `supports_prompt_caching` — MiniMax rides the SAME adapter and has never
  seen the field, and an unknown field is how Aurora has been 400'd before (`oneOf` on xAI). Max 4 breakpoints
  allowed; a test pins ≤ 4. Response-side `cache_read/creation_input_tokens` parsing already existed.
- **#5 Parallel dispatch.** New `ToolExecutor::concurrency_safe()` (default FALSE). `execute_tool_calls` now
  walks maximal runs of safe calls and `join_all`s them; the first unsafe call splits the batch, so
  `[read,read,write,read]` → {2},{1},{1} and relative order with writes is preserved. Result blocks always
  follow the model's CALL order, not completion order. Opted in: file_read, grep, workspace_tree,
  auroro_websearch, read_lints, shell_list_processes. Browser tools deliberately NOT opted in (one shared
  panel). `PermissionGuardedExecutor` overrides to false explicitly (prompts are answered one at a time).
- **#6 Loop breaker + `length` stop.** `FailureLoopGuard` keys on `(tool, args-json)` per batch: 2nd identical
  failure appends "SECOND time … change something concrete first", 3rd+ appends "STOP". A SUCCESS with those
  exact args clears the counter. Separately, `stop_reason ∈ {length, max_tokens}` with no pending tools now
  emits a recoverable Error event — it used to end the turn indistinguishably from a clean stop, so a
  truncated reply looked complete.
- ⚠️ **The Rust test suite had NEVER run on Windows** (0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND, recorded here as
  an environment limitation). Root-caused and FIXED — see lesson.md. 703 tests ran for the first time; 15
  failed. **All 15 now fixed**, and 5 were real product bugs, not stale tests:
  1. `trim_to_budget` iterated `user_indices[..max_cut]` — included the no-op cut at index 0 and EXCLUDED the
     largest legal boundary. Context trimming under-dropped by one turn always, and with exactly 3 user turns
     never fired at all. Now `[1..=max_cut]`. (fixed 3 tests)
  2. `compact_json_tool_content` did `if !shrink(...) { return None }` — but `false` only means "nothing
     exceeded this probe limit". `workspace_tree` (no payload-string keys) bailed instantly and never reached
     `compact_json_arrays`, written for exactly that shape; a batch `file_read` whose per-file contents are
     each under the first probe did the same. Both fell through to the blind byte clamp → invalid JSON.
  3. `truncate_tool_content` cut at exactly `cap` then APPENDED the marker, exceeding the cap it enforces.
     Now reserves `TRUNCATION_MARKER_RESERVE`.
  4. `TeamPhase::Planning` was declared and **assigned nowhere** — a convened team with locked assignments
     still reported `Forming` ("Roster not yet assembled"). runner.rs:398 even said "phase stays Planning".
     New `mark_team_planning()` called from both planning entry points. (`convene` correctly stays Forming.)
  5. `is_meta_role("review-page-owner")` → true, so a real builder got relabelled out from under the Lead.
     Rule now: inside a `…-owner` suffix a meta word is meta only when it IS the thing owned
     (`integration-owner` = meta) not when it qualifies one (`review-page-owner` = builder).
  The other 10 were stale tests: scope_guard ×4 encoded the OLD "deny anything outside your scope" rule
  (superseded by "only a PEER's scope is off-limits" — see `unassigned_path_is_allowed_as_open_ground`, which
  passes); `register_builtin_tools_is_idempotent` asserted 16 where its sibling asserts 15;
  `scan_merge_adds_new_profiles` contradicted the stale-profile pruning rule; read_lints asserted a substring
  against `display()`, which renders args with `{:?}` and so escapes Windows separators.
- Verified: **712/712 Rust tests pass** (0 failures — first fully green run ever), `cargo check --lib --tests`
  0 post-rustfmt, `tsc -b` 0, eslint 0 errors, vitest 200/200, `vite build` 0. NOT runtime-verified — needs a
  `pnpm tauri:dev` restart.

## Task (2026-07-25): type + radius system pass, and the home wordmark light (uncommitted)
User: "the next maturity gain is the UI — text rendering and the size/radius of elements."
Audited, then implemented. Probes at `C:\Users\Alvan\Documents\aurora-type-radius-system.html` and
`…\aurora-wordmark-sheen.html`.
- **Prose was never on the type scale.** The CHROME was systematised into 6 sizes long ago (with a comment
  explaining that near-duplicate sizes read as noise), but `.agw-md` still used compounding `em`: 1.4/1.22/1.08
  off a 14px base rendered **19.6 / 17.08 / 15.12px**, inline code 0.85em → **11.9px**. Fractional sizes shift
  stem weights and baselines between headings under Windows subpixel rendering — that was the "text doesn't
  feel finished" complaint. New tier `--agw-fs-h1..h4` = 20/17/15/14 and `--agw-fs-code` = 13 (which also makes
  inline code MATCH the fenced block, already `--agw-fs-md`; they disagreed by 1.1px). Code-inside-a-heading
  got explicit per-level sizes (18/16/14/13) — a shared `em` factor would have reintroduced the fractions.
- **Radius: one scale.** `themes.ts` 14→12, 10→8 (so `sm` 6 nested in `lg` 12 with 6px padding is concentric),
  added `radiusPill`, retired **55 hardcoded `999px`**. Settings' fork (`--agw-set-r-card` 16 / `-inner` 12) now
  ALIASES onto the scale — its comment said the bigger radii were deliberate, so the names stay as the one
  tuning point, but there is a single source of truth. NOT touched (would visibly reshape the most prominent
  element, and the probe never previewed it): the composer's Tailwind literal `rounded-[16px]`, and 19 bare
  `rounded` utilities. The 22px drag-drop ring is NOT drift — it is 16+6, concentric with the composer; now
  commented so nobody "fixes" it.
- **Home wordmark — per-character arrival light.** User wanted the light to move ONE GLYPH AT A TIME; a
  gradient sweep cannot do that (it is continuous, so it always straddles 2+ glyphs). So the glyph is now the
  unit of animation: `EmptyState` splits "aurora" into inline spans carrying `--agw-lit-i`, staggered
  0.11s apart with a 0.55s hold (~1.1s to cross). **`@property --agw-lit` is load-bearing** — a plain custom
  property is a token stream and cannot be interpolated, so it would never animate inside `color-mix()`.
  Fallback on an engine without @property is the old resting fill, i.e. today's look. Split is a11y-safe: the
  mark is already `aria-hidden`. The vertical (180deg) base gradient is what makes per-letter splitting safe —
  a horizontal one would have broken across the letter boxes.
- Reference implementations reviewed (tryelements TextShimmer, React Bits ShinyText): both drive it with a
  permanent JS rAF/motion loop — rejected for a home screen that sits open for hours; CSS keyframes give the
  compositor the work. Both expose a rest-between-passes control, which is why a single pass (not a loop) is
  the default here: a travelling sheen is the skeleton-LOADING gesture, and looping it forever makes an idle
  screen read as still loading.
- Verified: `tsc -b` 0, eslint 0, postcss parse OK, vitest 200/200, `vite build` 0. NOT runtime-verified.

## Task (2026-07-25): budget slider popover — 2 bugs FIXED (uncommitted)
User: "the popup opens, then vanishes as soon as I click and drag the slider."
- **Dismissal:** the panel is portaled to `.agw-root`, so it is NOT inside `.agw-model-menu` in the DOM — and
  the menu's outside-click test is pure `rootRef.contains(target)`. Pressing the slider read as a click
  outside the picker, closed the whole menu, and unmounted the panel with it. Portaling escapes the clipping
  container AND the containment check; fixing one exposed the other. Fix: the panel carries
  `data-agw-portal-child` and the menu's handler skips `target.closest("[data-agw-portal-child]")`. **Reusable
  convention — any future portaled popover owned by a menu must set that attribute.**
- **Perf:** `useSettingsStore.updateModel` issues a SQLite upsert on EVERY call, and a range input fires
  `change` on every step — so dragging was a DB round-trip per pixel. Now a local `draftPos` drives the
  control and the store is written once, on `pointerup` / `keyup` / `blur` (blur is the backstop so a pointer
  released outside the thumb still commits).

## Task (2026-07-25): reasoning BUDGET control — DONE (uncommitted, NEEDS RUST REBUILD)
User: "we don't have a budget slider for reasoning models." Audit found the value was dropped END TO END, not
just missing a control: `ModelReasoning{type:"budget",min,max,default}` already existed and models.dev already
mapped `budget_tokens` into it, but (a) the picker row rendered a control only for `type:"effort"`, (b)
`useAgentWindowSend` reduced budget models to a bare thinking on/off (`// toggle / budget` branch), and (c) no
adapter could receive a number anyway. So Providers → Min/Max budget configured a range NOTHING consumed.
- **Wire (new, first-class — NOT customParams, because the shape differs per provider):** `AgentConfig.
  thinkingBudgetTokens` → `AgentChatRequest.thinkingBudgetTokens` (agent-runtime-client, `null` when ≤0) →
  Rust `ipc.rs::thinking_budget_tokens` → `build_runtime_config` (`.filter(|b| *b > 0)`) →
  `RuntimeConfig.thinking_budget_tokens` → `ApiRequest.thinking_budget_tokens` (9 construction sites, all
  others `None` — compaction + team runners deliberately never spend the user's budget).
- **Anthropic** (`provider_kernel_adapter::anthropic_thinking_budget`) now takes `explicit` FIRST: a user
  budget wins over the effort-tier fraction and is only CLAMPED to `1024..=max_tokens-1` (clamp, not reject —
  a budget set against a big cap must survive the user lowering Max output). `0` = "no explicit budget".
- **OpenAI-compat** (`build_openai_body`) adds `budget_tokens` INSIDE the existing `thinking` object ONLY when
  the user explicitly set one; the default stays the bare `{"type":"enabled"}` we always sent, because compat
  backends 400 on unknown fields. Responses/DeepSeek/Codex paths untouched (no budget concept).
- **UI = probe variant 02** (user picked from `C:\Users\Alvan\Documents\aurora-reasoning-budget-slider.html`,
  4 variants): the row chip reuses `.agw-model-effort` verbatim so budget and effort rows keep IDENTICAL
  heights; clicking opens a 244px panel — log-scaled slider (linear spends 90% of the track on values nobody
  distinguishes; log gives each doubling equal width), presets min/4k/16k/32k/Max filtered to the model's own
  range, and a hint stating the % of the model's output cap.
  The slider CEILING is `maxOutputTokens - 1`, not `maxOutputTokens` — a budget must be strictly below
  max_tokens, so otherwise the "Max" preset produces a value the provider rejects. The only warn state left is
  the genuinely broken one: an output cap ≤ 1024, where Rust omits `thinking` and reasoning silently stops.
  ⚠️ The panel is PORTALED to `.agw-root` — `.agw-model-menu` is `overflow: hidden` and would clip it.
  Closes on outside mousedown / Escape / any scroll (a scroll strands the measured anchor).
- Writes land on `reasoning.default` (same field effort tiers use) ⇒ no new storage, no migration.
- Providers page: added a "Default budget" range row above Min/Max (`.agw-set-range` + `AgwPill`, same family
  as the compaction rows), and the model chip now reads `Reasoning · 16k`.
- **Pre-existing bug fixed on the way:** the Reasoning type segmented control carried `default` across types,
  so effort→budget left `default:"medium"` (a budget of NaN) and budget→effort sent `reasoning_effort:"8000"`.
  Both branches now coerce by type.
- Verified: `cargo check --lib --tests` clean (post-rustfmt), `tsc -b`, eslint (0 errors on touched files),
  postcss parse, `vite build` exit 0, 200/200 FE tests (1 new: budget forwarding + 0/undefined → null).
  Rust unit tests still CANNOT LAUNCH here (0xc0000139 — documented) so the 2 new adapter tests compile but
  never ran. NOT runtime-verified: needs `pnpm tauri:dev` restart, then a budget model + a real send.

## Build status (2026-07-24): `pnpm tauri build` PASSED — exit 0, release in 10m05s
Carries all four uncommitted fixes below (file_read `oneOf`, effort→`thinking` translation, effort-scaled
`budget_tokens`, empty-thinking guards). Artifacts: `build\release\aurora.exe`, plus MSI + NSIS bundles under
`build\release\bundle\` (named Aurora_**2.0.0**_x64 — CLAUDE.md still says v1.5.0, stale). `cargo check --lib`,
`--tests`, and `tsc -b` all clean. STILL UNVERIFIED AT RUNTIME: no request has been made against the new
binary — the grok `oneOf` fix and the FABLE effort→reasoning fix both need a real send to confirm.
NOTE: the Rust lib TEST BINARY still cannot launch here (0xc0000139) — new unit tests compile but never run.

## Task (2026-07-24): stray "…" rows in the transcript — FIXED (uncommitted, NEEDS RUST REBUILD)
User circled bare "…" rows appearing between tool cards on AgentRouter/Claude Opus 4.8 and asked whether they
were leaked reasoning content. They are NOT — verified by curl against the same proxy (api.443.hk):
- `/v1/chat/completions` (OpenAI-compat) for `claude-opus-4-8` returns **zero** `reasoning_content`, with or
  without a `thinking` param — only `content` + `tool_calls`. (grok-4.5 on the same proxy DOES stream it.)
- The proxy ALSO speaks native `/v1/messages` (accepts both `x-api-key` and `Authorization: Bearer`), and there
  thinking works — but ONLY with the LEGACY `thinking:{"type":"enabled","budget_tokens":N}`. The modern
  `{"type":"adaptive","display":"summarized"}` is accepted (200) and silently yields NO thinking block at all.
  Aurora's `build_anthropic_body` already sends the legacy shape, so the Anthropic path gets real reasoning.
  Tools work there too (`thinking` + `tool_use` both returned). No provider-settings change was needed.
- ROOT CAUSE of the "…": the proxy opens each thinking block with an empty `"thinking":""` delta, and
  `api/anthropic.rs` had **no empty-text guard** (unlike `openai_compat.rs`, which checks `!is_empty()`).
  Second source: `anthropic.rs` content_block_stop deliberately sends `Thinking{text:String::new()}` just to
  carry the signature. Chain: empty Thinking event → `onThinking("")` → `appendThinking(tl,"")` → a real
  `{kind:"thinking",text:""}` row (`timeline.ts:238` does NOT filter empty rows) → `AgentThinkingBlock`'s
  `{content || "…"}` (AgentThinkingBlock.tsx:68) paints "…". It lands BETWEEN TOOL CARDS because
  `appendThinking` only merges into a previous thinking segment — after a tool row it can't, so it starts a
  new empty one.
- Fix (both ends): `anthropic.rs` thinking_delta now skips zero-length deltas; `useAgentWindowSend.ts`
  `onThinking` early-returns on empty text (kills the signature-only event and covers reload/other providers).
- ⚠️ CORRECTION (same day): the `anthropic.rs` half is a REAL latent bug but is NOT what produced the user's
  "…" — every one of their providers is `provider_type:"openai"` (see the provider table below), so
  `ProviderKind::detect` routes to OpenAICompat and `anthropic.rs` never runs. The `onThinking` guard is the
  half that actually applies. Root cause on the OpenAI-compat path remains UNPROVEN — do not claim otherwise.
  Later screenshot showed the Reasoning block rendering correctly with no stray "…", so it is intermittent.
- Verify: NOT yet compiled/run — needs `pnpm tauri:dev` restart.

## Reference (2026-07-24): api.443.hk proxy + provider wiring — MEASURED, not inferred
- **DB lives at `C:\Users\Alvan\AppData\Local\AuroraIDE\data\aurora.db`** — CLAUDE.md's
  `%APPDATA%/com.aurora.agent/aurora.db` is STALE. Must copy `aurora.db` + `-wal` + `-shm` together to read it.
- User's providers (all `provider_type:"openai"` ⇒ OpenAICompat adapter ⇒ `/v1/chat/completions`):
  GREY / GROK / FABLE → `https://api.443.hk/v1`; AgentRouter → `https://agentrouter.org/v1`; plus deepseek,
  codex, openai-responses, KimChi, KAT-coder, openference, Routing Run, META.
- **Reasoning exposure is PER-PROVIDER, not per-model** (measured with curl):
  - `api.443.hk` `/v1/chat/completions` + Claude models → **0** reasoning deltas under EVERY config tried
    (`reasoning_effort:"max"`, `thinking:{enabled,budget_tokens}`, plain). grok-4.5 there DOES stream it.
  - `api.443.hk` `/v1/messages` (native Anthropic; accepts BOTH `x-api-key` and `Authorization: Bearer`) →
    real `thinking` blocks + signature, and tools work (`thinking` + `tool_use` both returned).
  - `agentrouter.org` `/v1/chat/completions` + Claude → reasoning DOES flow (confirmed by user screenshot).
- **Thinking-config compatibility on api.443.hk `/v1/messages`:** `claude-opus-4-8` gets thinking ONLY from the
  legacy `{"type":"enabled","budget_tokens":N}`; `{"type":"adaptive",...}` is accepted (200) but yields NO
  thinking block. `claude-fable-5` works with BOTH. Aurora's `build_anthropic_body` already sends the legacy
  shape ⇒ compatible with both; "modernizing" it to `adaptive` would SILENTLY kill opus-4-8 reasoning.
- The proxy is PERMISSIVE — accepts `temperature` and `budget_tokens` that real Anthropic 400s on for Fable 5,
  and caches identical prompts (two calls with the same body returned an identical thinking signature — vary
  the prompt when probing or you will "test" a cache hit).
- Aurora hardcodes `budget_tokens: 1024` (`provider_kernel_adapter.rs` build_anthropic_body); the provider
  page's effort setting does NOT feed it on the Anthropic path.

## Task (2026-07-24): grok/xAI provider HTTP 400 "Upstream error: 400" — FIXED (uncommitted, NEEDS RUST REBUILD)
User added a custom OpenAI-compat provider (api.443.hk, model grok-4.5); every agent request failed with
`Something Went Wrong / invalid request: HTTP 400: {"error":{"message":"Upstream error: 400","type":"invalid_request_error"}}`
while a plain curl worked. Root-caused by bisecting the outgoing body against the live endpoint: stream,
temperature, max_tokens, stream_options, the non-standard `thinking` field, system msg, `additionalProperties:false`,
and even a `"type":["string","number"]` union (shell_kill) ALL return 200. The single offender is a top-level
**`oneOf`** in a tool's `parameters` — xAI/grok's function-schema validator rejects `oneOf`/`anyOf`/`allOf` with
a 400 byte-identical to the user's error. `file_read` (`tools/file_workspace_search/file_read.rs`) was the ONLY
tool using `oneOf` (grepped anyOf/allOf/$ref too — none), and it's sent every turn, so every grok request died.
- Fix: removed the `oneOf` from file_read's schema. The "exactly one of path/paths" contract was redundant there —
  it's documented in the field descriptions AND enforced at runtime in `execute()` (rejects both-present + empty
  array). Updated the schema test to assert `oneOf` is absent.
- Also added an OPT-IN request trace in `api/openai_compat.rs` (env `AURORA_DEBUG_API=1`): prints the exact
  outgoing body + any non-2xx upstream response body via eprintln (project convention — no tracing crate). Inert
  by default. Lesson: keep tool `parameters` schemas to the strict-provider-safe subset (no oneOf/anyOf/allOf).
- Verify: schema logic + live-endpoint bisection confirmed; NOT cargo-checked (user owns build lock via tauri:dev)
  — their rebuild compiles it.

## Task (2026-07-23): Browser tool misuse — root cause found; TS half FIXED, Rust half PENDING
Symptom: every model fabricates deep structural selectors and loops on
"No element matches `div#root > div > div:nth-of-type(2) > main > ...`" (`tools/browser/mod.rs:455`).
Two independent causes:
- **A — prompt/registry contradiction (FIXED, `src/services/agent-prompt.ts`).** Rust `browser::register()`
  mounts SEVEN tools including `BrowserInspectElementTool`, but the system prompt said "you have exactly
  six" and listed `browser_inspect_element` among tools "intentionally removed — do not try to call them".
  So the model saw the schema advertised AND was told it doesn't exist. Fixed: six→seven, moved
  `browser_inspect_element` into the read-only group, added it to the verification loop, and added an
  explicit "where selectors come from" rule (derive from SOURCE via grep for id/data-testid/aria-label/
  class/text — a screenshot is a picture and does not reveal markup; confirm with `browser_inspect_element`
  before clicking; never retry a failed click with another guess). Display layers (`tool-display.ts`,
  `activity.ts`, `ToolSettingsTab.tsx`) already knew the tool — ONLY the prompt denied it.
- **B — no selector-discovery tool at all (FIXED with a NEW tool).** The agent's only page-observation
  channel was `browser_screenshot` (base64 PNG + URL — no DOM, no element map), while
  `inspect_element`/`click`/`fill` all REQUIRE a selector. Guessing was structurally forced.
  Registering `BrowserGetDomTool` was NOT viable: it calls `require_label` with `label` REQUIRED in its
  schema (targets a standalone `browser_open` window, not the right-rail panel), and non-`file_read` tool
  results are clamped to 8 KiB (`conversation.rs:949`) so a 200 KB DOM arrives truncated mid-tag.
  Added `browser_page_outline` instead (`tools/browser/mod.rs`): runs `PAGE_OUTLINE_JS` via
  `eval_with_result` on AGENT_BROWSER_LABEL, returns visible interactive elements each with a selector
  VERIFIED unique via `querySelectorAll(...).length === 1`. Selector priority `#id` → data-testid/name/
  aria-label → `a[href]` → tag+class → id-anchored `:nth-of-type`; framework classes (`css-`/`sc-`/`ng-`)
  skipped as build-unstable; no stable selector ⇒ emits `null` rather than a fragile path. Args:
  `selector` (scope), `query` (text/id filter), `limit` (default 60, max 200). Read-only, no permission.
- Also fixed: `BUILTIN_TOOL_COUNT` was **21 but the real total was 22** (browser bucket had grown to 7).
  `builtin_tool_count_is_correct` would have caught it, but the lib-test binary can't launch here
  (0xc0000139), so the drift sat unnoticed. Now 23 (9 + 6 + 8), with both asserts updated.
- Frontend surfaces updated for the new tool: `tool-display.ts` ("Map Page Elements"), `activity.ts`
  ("Mapping page"), `ToolSettingsTab.tsx` read-only group. Prompt rewritten to lead with
  "NEVER invent a CSS selector — get it from `browser_page_outline`".
- Verify: `cargo check` clean, `tsc -b` + eslint clean. NOT runtime-verified (needs `pnpm tauri dev`).

## Task (2026-07-23): ONE browser — IDE browser tab + standalone OS windows REMOVED (uncommitted)
User: "only one browser stays, the right-rail panel, all tools around it — no IDE browser, no separate
window." Executed.
- **Deleted files:** `components/editor/BrowserTab.tsx` (1306 lines, iframe + pop-out native window),
  `components/layout/TitleBarBrowserButton.tsx` (adopt-a-window popover), `store/useBrowserWindowsStore.ts`.
- **Rust `browser_runtime.rs::create_window` is EMBEDDED-ONLY.** The `embed: None` →
  `WebviewWindowBuilder` branch (~4.9 KB incl. the per-window Destroyed listener) is gone; `embed` is now
  required and its absence is an explicit error. Also removed the orphaned `WebviewWindowBuilder` import,
  `BrowserWindowClosedPayload`, and the `aurora:browser-window-closed` contract (embedded webviews die with
  the host; cleanup goes through `close`).
  ⚠️ GOTCHA when editing this fn: `if let Some(embed) = &opts.embed {` appears TWICE — the FIRST is the
  "window already exists → re-embed/navigate" early-return, the SECOND was the build branch. Naive
  `str.index` hits the wrong one and silently unbalances the braces.
- **Rust `tools/browser/mod.rs`:** deleted the 7 unregistered structs (`BrowserOpenTool`, `Close`,
  `ListWindows`, `GetUrl`, `GetDom`, `WaitFor`, `Eval`) and the now-orphaned `extract_label` /
  `resolve_label` / `require_label` helpers + `CreateBrowserWindow` import. Every struct in the file is
  now registered — no compiled-but-unadvertised tier.
- **Editor plumbing:** `Tab.type` is `'file'` only (`types/index.ts`), `adoptedBrowserLabel` gone;
  `openBrowserTab`/`updateBrowserTab`/`OpenBrowserTabOptions` removed from `useEditorStore`; the four
  now-vacuous `tab.type !== 'browser'` guards cleaned from TabBar/useCheckpointStore/useEditorStore/
  useWorkspaceStore (tsc found them all — the union narrowing makes them compile errors).
- **`browser-service.ts`** trimmed of exports the deletion orphaned: `browserWindowLabelFor`,
  `onBrowserWindowOpened`/`Closed`, `BrowserWindowClosedEvent`, `BrowserWindowOpenedEvent`,
  `clearInspectorSelection`, `activateStagewise`/`deactivateStagewise`, `readBrowserThemeTokens`.
- **Left dormant on purpose:** Rust stagewise methods + their Tauri commands (no frontend caller now),
  and the IDE chat's picked-element plumbing (`useChatStore.selectedElements`, `context-builder`) which
  nothing populates without the IDE browser. Out of scope for this cut; flag before relying on either.
- Verify: `cargo check` clean (no browser warnings), `tsc -b` clean, eslint 0 errors on touched files,
  `vite build` clean, 199/199 tests across 36 files. NOT runtime-verified.

## Browser: standalone OS-window mode — SCOPING (2026-07-23, superseded by the entry above)
`BrowserManager::create_window` has TWO modes: `embed: Some(EmbedConfig)` builds a child webview pinned
inside a host window, `embed: None` builds a standalone `WebviewWindowBuilder` OS window.
- `BrowserPanel.tsx` (agent right rail) and the agent tools → ALWAYS embedded. Unaffected.
- `BrowserTab.tsx:333` (`openNative`, IDE editor tab, 1306 lines) is the ONLY caller that omits `embed`
  → it is the sole source of standalone OS browser windows. `TitleBarBrowserButton.tsx` lists those
  windows and can "adopt" one back into a tab; `useBrowserWindowsStore` tracks them.
User asked for the standalone OS window to be removed entirely — scope (kill only `openNative`+adoption,
vs. delete the whole IDE BrowserTab feature) confirmed with the user before executing.

## Task (2026-07-23): Browser picks become INLINE composer pills — DONE (uncommitted, FE-only)
User: `@file` pills sit inline in the input (correct), but inspector picks appeared as a detached chip row
ABOVE it (wrong). The composer already had the answer in its own comment — `/` directives were migrated
inline earlier and the selection row was simply left behind, so the one attachment kind the user did NOT
type was the one furthest from where they type.
- `AgentComposer.tsx`: deleted the `.agw-sel-row` JSX. New module-level `buildSelectionPill(entry)` builds
  a `.agw-pill-inline.agw-pill-sel` with `data-sel=<entry.id>`, mirroring `pickCommand`'s `data-cmd` pill.
- Three-part contract, same as `/` pills: `serializeEditor` SKIPS `[data-sel]` (threaded via the store, not
  the text) · `handleInput` reconciles store→DOM (backspacing a pill calls `removeSelected`, so it can't
  ride along invisibly) · a `useEffect` on `selected` mirrors DOM←store for picks that arrive
  asynchronously from the inspector (inserts missing, removes stale on `clear()` at send).
- Insert point: at the caret ONLY when the composer already owns it, else `appendChild` — deliberately no
  `el.focus()`, or picking a second element in the Browser panel would yank focus off the page mid-pick.
- Placeholder gate is `blank && selected.length === 0`: `blank` is measured from the editor DOM, which the
  async pill sync writes to OUTSIDE React, so a pick landing on an untouched composer would otherwise leave
  the placeholder painted over the new pill. Checked against the store instead of adding `[data-sel]` to
  `syncEmpty` — one mechanism per path, and it keeps the effect setState-free (repo lints
  `react-hooks/set-state-in-effect` as an ERROR).
- Removed now-dead `.agw-sel-row` / `.agw-sel-x` CSS; `.agw-sel-chip/-tag/-text` stay (transcript bubble).
  NOTE: `.agw-cmd-row` / `.agw-cmd-chip` are also dead from the earlier `/`-inline migration — left alone.
- **Backspace couldn't delete ANY pill** (pre-existing, all three kinds — the file header claimed
  "backspace deletes a whole pill" but it never did; user had to Ctrl+A). Cause: `.agw-pill-inline` sets
  `user-select: none`, so Chromium refuses to extend a selection over the atomic span and the native
  "Backspace removes the widget" path silently no-ops. Fix: `deletePillBeforeCaret(root)` in
  `AgentComposer.tsx` removes the pill before a COLLAPSED caret (element-container → `childNodes[offset-1]`;
  text-node-at-offset-0 → `previousSibling`), wired into `handleKeyDown` after `typing.onKeyDown` (which
  owns Backspace for correction-undo) and only for bare Backspace — Ctrl/Alt and range deletes stay native.
  Calls `handleInput()` after, so the store reconcile detaches the command/pick.
- **Right-click was dead in the composer**: `App.tsx`'s global `contextmenu` handler `preventDefault()`s
  everything except INPUT/TEXTAREA/`.select-text`/`.markdown-content`. Hooks run before the
  `if (isAgentWindow) return <AgentWindow/>` early return, so it applies to the agent window too, and the
  composer is a contenteditable DIV. Added an `target.isContentEditable` allow.
- Verify: `tsc -b`, eslint (agent-window: 0 errors), `vite build`, 76/76 tests. NOT visually verified —
  caret/selection behavior and the context menu both need the real app.

## Task (2026-07-23): Long-message bounding in the transcript — DONE (uncommitted, FE-only)
Neither long-message surface was bounded, so a pasted spec ran the full height of the turn.
Two DELIBERATELY different treatments (user's call):
- **Mid-turn user message** (`.agw-injection`, the accent-bordered `user_injection` timeline row) → inline
  scroller. `.agw-injection > span` gets `max-height: calc(1.45em * 9)` + `overflow-y: auto` +
  `overscroll-behavior: contain` (so hitting the end doesn't chain-scroll the transcript) + `flex: 1 1 auto`
  (stable right edge for the scrollbar). Added to the shared `agw-scroll-fade-b` selector list, so it
  inherits the scroll-aware bottom fade — no fade at all when the text fits.
- **User message bubble** (`UserBubble`) → clamp + chevron, NOT a scroller: a nested scroll area inside a
  right-aligned bubble fights the transcript's own scroll. New `CollapsibleBubbleBody` wraps chips+text in
  `.agw-bubble-body[data-collapsed]` (`max-height: calc(1.55em * 6)` + bottom mask fade) with a full-width
  `.agw-bubble-more` chevron button underneath that rotates 180° when expanded.
- Overflow detection compares `scrollHeight` against `computed line-height × 6`, NOT the usual
  `scrollHeight > clientHeight` — that comparison goes false the moment the body expands, which would hide
  the control needed to collapse it again. `useLayoutEffect` (pre-paint, else a long message renders full
  height for a frame then snaps) + `ResizeObserver` for rail/dock width changes; falling back below the
  clamp also resets `expanded`.
- Verify: `tsc -b` + eslint clean; 59/59 agent-window component tests pass. NOT visually verified in the
  running app — needs `pnpm tauri dev`.

## Task (2026-07-23): MCP Streamable HTTP transport — DONE (uncommitted, needs Rust rebuild)
User pasted `{"mcpServers":{"untitledui":{"httpUrl":"https://www.untitledui.com/react/api/mcp"}}}` and hit
"SSE endpoint returned status: 405 Method Not Allowed". Two independent bugs:
1. **Aurora only spoke legacy HTTP+SSE** (MCP 2024-11-05: GET → `endpoint` event → POST there). That endpoint
   is **Streamable HTTP** (2025-03-26+): POST JSON-RPC at the single URL. Such servers answer a bare GET with
   405 *by spec*, so it was never a URL/auth problem. Probed live: GET→405, POST initialize→200.
2. **`httpUrl` was read nowhere in the codebase.** Both JSON importers did `raw.url ? 'sse' : 'stdio'`, so that
   paste silently produced a stdio server with no command — no error, just a dead entry.
- Rust: `McpTransportType::Http` (+ serde aliases `streamable-http`/`streamablehttp`/`streamable_http`);
  `connect_http` + `http_actor` in `mcp/manager.rs` — POSTs every frame, `Accept: application/json,
  text/event-stream`, carries `Mcp-Session-Id` (captured from the initialize response headers) and
  `MCP-Protocol-Version` (mirrors whatever the server negotiates), decodes BOTH reply representations
  (json body, or a `text/event-stream` scanned for the frame matching our id), treats 202 as Ok(Null),
  and sends a best-effort DELETE on shutdown. `handshake()` now takes a `protocol_version` param
  (legacy `2024-11-05` for stdio/sse, `2025-06-18` for http).
- `mcp/config.rs`: `McpServerEntry` gained `transport` (alias `type`) + `http_url`; `resolve_transport()`
  (explicit wins → `httpUrl`⇒http → `url`⇒sse → stdio) and `from_config()` which writes the transport
  EXPLICITLY so a save/reload round-trip can't downgrade http→sse.
- Frontend: `useMcpStore.ts` owns the shared `resolveTransport()`/`resolveServerUrl()` parsers (both settings
  surfaces import them instead of duplicating); transport unions gained `'http'`; url/headers gating moved
  from `=== 'sse'` to `!== 'stdio'` in BOTH `agent-window/settings/McpSettings.tsx` and
  `components/modals/McpSettingsTab.tsx` (each has an add-form AND an edit-form copy — 4 sites total).
- UX: agent-window segmented control is now `Stdio | HTTP | SSE` (short labels — 3 pills ellipsize in the
  half-width `.agw-mcp-grid2` cell) with a per-transport hint line under the URL field reusing
  `.agw-set-row-hint`; card subtitle names the transport ("Streamable HTTP" vs "HTTP+SSE"). Both 405 paths
  now explain the fix instead of printing a bare status.
- Verify: `cargo check` clean; 5 new config tests pass via standalone verify crate (main lib-test binary
  still can't launch — 0xc0000139); `tsc -b` + eslint clean; live handshake replayed against untitledui
  (initialize→session id, initialized→202, tools/list→7 tools, resources/list→ok). NOT yet verified in the
  running app — needs `pnpm tauri:dev` restart.

## Task (2026-07-21): OpenCode-style brand landing for new chat — DONE (uncommitted, FE-only)
User: agent window's new-chat landing should show "aurora" the way OpenCode shows its ghost wordmark;
then iterated: size OK but needs presence/depth; last "a" clips; nudge down; letters must feel like
standing characters; move group a bit to the top.
- `EmptyState.tsx`: "What should we build in X?" heading REPLACED by a giant ghost wordmark
  (`aria-hidden`, span inside `.agw-home-wordmark`); group biased above centre via container
  `padding-bottom: clamp(128px, 18vh, 200px)`; suggestions + per-project draft logic untouched.
- `agent-window.css`: `.agw-home-column { container-type: inline-size }` + wordmark sized
  `min(248px, 31cqi)` — cqi measures the PANE, fixing the last-"a" clip that vw sizing caused when
  rails squeezed the conversation. Paint = rim-lit gradient (16%→8%→5% of `--agw-text`) clipped to
  text + ::before overhead light pool + ::after floor contact shadow (0.38 dark / 0.12 light) = the
  "standing characters" depth. NO drop-shadow filter: fill is 84-95% transparent so a behind-glyph
  shadow bleeds through and silhouettes the letters (measured: lum 24 vs expected 50 at 16%).
- Verified via pixel-measured puppeteer-core harness (Temp\opencode\wordmark-harness, Edge headless):
  glyph lum 45→28 top→bottom vs bg 15; dark + light themes; tsc, eslint, postcss, 197/197 tests.

## Task (2026-07-20): Rust-owned left-rail context actions — COMPLETE
- [x] Inspect current project/chat context menus and the existing Rust command/service boundaries.
- [x] Add native project actions: reveal in file manager and open a terminal at the project root.
- [x] Add native chat actions: duplicate the conversation and render a Markdown transcript for copying.
- [x] Wire polished menu rows, explicit success/error feedback, focused tests, and full validation.

Progress: reused the existing Rust `reveal_in_explorer` and `open_in_terminal` commands instead of creating a parallel native-action layer. Added Rust-owned transcript duplication (including rich tool results and Canvas artifacts) plus native Markdown clipboard export; React now only invokes these actions and renders transient success/error feedback.

Review: project menus now expose File Explorer and terminal actions; active and archived chat menus expose duplicate and copy-as-Markdown, with grouped rows and accessible transient feedback. Verified with Rust check, Rust test-target compilation, TypeScript, targeted ESLint, production frontend build, 197/197 frontend tests, diff checks, and `graphify update .`; Rust test execution remains blocked before the harness by the documented Windows `STATUS_ENTRYPOINT_NOT_FOUND` native-DLL issue, and full Clippy remains blocked by 38 unrelated existing warnings promoted to errors.

## Task (2026-07-20): Ten net-new visual Agent Window concepts — COMPLETE
- [x] Excluded shipped surfaces and documented plans from the visual concept space.
- [x] Checked current agent-product visual patterns so the list avoids obvious parity features.
- [x] Developed ten distinct, visible, interaction-led concepts with a clear recommendation.

### Progress
- Avoided current/parity surfaces: canvases, session dashboards, browser tabs, tool-card polish, static Review,
  settings, profile analytics, shimmer controls, and the planned LSP/team/A2A work.
- Concepts focus on direct visual interaction: project activity map, context X-ray, branching conversations,
  morphing diffs, responsive preview wall, markup, time-lapse, thread covers, chapters, and live focus ribbon.

### Review
- Strongest product bets are Direct Visual Markup, Context X-Ray, and Responsive Preview Wall; each reuses
  Aurora foundations but creates an immediately visible behavior absent from the current source/plans.
- No product code changed. Recommendations include reduced-motion/static fallbacks and avoid decorative AI motifs.

## Task (2026-07-20): README refresh — DONE
- Deep-read README vs package.json, DOCS/, agent-window, agent_runtime, provider kernel, tools index.
- Rewrote README.md (~220 lines): Agent Window, Rust runtime/provider kernel, execution modes, Canvas/Team/Speech/Refine, updated docs index, fixed stale GPU/architecture claims.

## Task (2026-07-20): Net-new Agent Window feature direction — RESEARCH COMPLETE
- [x] Mapped the Agent Window's shipped capabilities from the graph, docs, and owning source modules.
- [x] Identified documented planned/pending work so the recommendation does not repeat the backlog.
- [x] Tested candidate directions against the current 2026 agent-product landscape and Aurora's foundations.

### Progress
- Ruled out isolated parallel worktrees, generic acceptance-criteria verification, and browser bug recording as
  headline bets: useful, but already recognizable product categories rather than an Aurora-defining leap.
- Strongest gap: a durable intent/provenance layer linking requirements and decisions to exact diff hunks,
  tool evidence, tests, and future code history — the current transcript/timeline/Review data is rich but ephemeral.

### Review
- Recommended an Agent Window “Why Graph” / intent-aware Review: goal coverage, orphan-change detection,
  evidence-linked completion, line-level “why does this exist?”, and contradiction/supersession across sessions.
- Verified the concept is absent from current Aurora plans/source terminology; no product code was changed.

Thin progress + working-memory layer. Append 2-4 lines per meaningful change.

## Task (2026-07-19): Left rail — rename, context menus, direct delete — DONE (uncommitted, FE-only)
User: "something is missing in the rail — think deeply, add micro-actions." Gap analysis found 3 real holes:
NO rename anywhere, NO delete for active chats (had to archive first — hidden two-step), NO right-click surface.
- `renameThread(id, title)` in useAgentChatStore: optimistic across threads/allThreads/currentThread/liveTurns,
  server via threadService.updateTitle, revert on failure, whitespace-collapse + no-op guard.
- `RailMenu` (LeftRail.tsx): right-click context menu portaled to .agw-root (CSS vars!), reuses .agw-menu glass +
  .agw-menu-item rows, viewport-clamped, closes on outside/Esc/scroll/resize/pick. Chat: Rename/Pin/Archive/Delete…;
  Archived: Open/Restore/Delete permanently…; Project: New chat here/Pin/Copy folder path.
- Inline rename: label↔input swap in the row (double-click, F2, or menu), Enter/blur commit, Escape discards with a
  dataset.cancel flag guarding the unmount-blur race (else blur would commit discarded text). Delete confirm reuses
  the existing AgentConfirm (now reachable for ACTIVE chats too).
- Verified: tsc, eslint, postcss, 191/191. Hot-reloads (no Rust).
- Menu restyle (user: "cheap-looking"): `.agw-rail-menu` ADDED to the composer-family tint rule (the rule that makes
  model/reason/mention popovers premium — base .agw-menu glass alone is NOT enough for family membership) + model-menu
  row anatomy (228px wide, 34px rows, fs-body, gap 10, subtle icon color, danger rows fully red). Message actions
  (Copy/Retry) now always visible dimmed 0.35 → full on message hover (was hidden-until-hover).

## Task (2026-07-19): file_edit streaming chip + naked suggestion chips — DONE (uncommitted, NEEDS RUST REBUILD)
- User report: single-file `file_edit` card streams as bare "Editing…" with NO file chip (file_write shows one).
  FE extraction chain is fine (streamedToolStringArguments finds any depth "path"); root cause = the MODEL emits
  old_string/new_string before any path, so nothing exists to extract. Same cure as file_write's earlier fix:
  file_edit schema description now says ALWAYS emit path(s) first (single form: `path` before old/new_string;
  batch: `target_paths` first, now "also for a single file"). Schema-nudge only — models that ignore it still get
  chips at result time.
- Suggestion chips restyled NAKED per user (pill wrapper = noise, consistent with the icon lesson): no border/bg,
  muted text + "→ " ::before marker, hover→text, active→accent. `.agw-suggest-chip` in agent-window.css.
- Placement v3 — DRUM PICKER (user's design; v2 transcript-stack rejected "lacks more"): back in the composer dock
  (old position was right, presentation was the culprit), ONE visible naked-text option; wheel-over rotates
  cyclically like a vertical cylinder (`SuggestDrum` in ConversationPane: rotateX ±42° + translateY ±18px + fade
  falloff, perspective 340px, 110ms step cooldown, ArrowUp/Down too, "i / n" marker right). Arrow ::before marker
  REMOVED per user. Click centered row → fills composer. `.agw-suggest-drum/-item/-count` CSS.
- Drum v2 (user: top/bottom "terrible", wants iOS picker): height 64px, offsets ±28px so neighbor rows STRADDLE the
  container edges (clipped mid-row), rotateX ±48°, opacity .45, and the iOS ingredient = vertical mask-image
  gradient (transparent→black 34%/66%→transparent) so half-rows dissolve at the edges like a slot reel.
- Drum v2.1: drum mount grows the dock AFTER auto-scroll released → reply tail hid behind it (user scrolled
  manually). Effect on `suggestions.length>0`: if within 160px of bottom, smooth `bottomRef.scrollIntoView`
  re-stick; readers scrolled up are left alone.
- `/suggest` manual trigger: 2nd action command in prompt-commands.ts (haystack matches /s /suggest /suggestions
  /p /prompt); onActionCommand widened to ("compact"|"suggest"); ConversationPane dispatches → new exported
  `requestReplySuggestions(threadId)` in useAgentWindowSend — gated on refinePathsConfigured ONLY (explicit intent
  bypasses the auto toggle), skips mid-turn, reads SETTLED currentThread.messages; core extracted to
  `generateSuggestionsFrom` shared with the auto path.
- Verified: cargo check, rustfmt, postcss, 191/191.

## Task (2026-07-19): Qwen3.5-0.8B migration — raw-ChatML invocation fix — DONE (uncommitted, NEEDS RUST REBUILD)
User replaced qwen2.5-0.5b with unsloth Qwen3.5-0.8B-BF16 (`C:\Users\Alvan\Documents\ALL-GGUF-MODELS\Aurora-ide\
qwen-3.5-0.8b\`, mmproj sidecar unused). New hybrid arch (Gated DeltaNet). Debug journey:
- b9957 llama-completion CRASHED 0xC0000409 (CPU+GPU, right after system_info). Latest release b10068
  (`E:\llama-bin\llama-b10068-bin-win-cuda-13.3-x64`, user downloaded) ALSO crashed identically.
- Isolation (user ran it): `-no-cnv` raw completion WORKS on the same exe+model; crash is ONLY in llama-completion's
  `--jinja -sys -st` conversation path with Qwen3.5's template (which auto-opens `<think>`). Model+build fine.
- FIX in run_completion: build ChatML ourselves (`build_chatml_prompt`) + `-no-cnv`; Qwen3-family models (path
  contains qwen3/qwen-3) get empty `<think></think>` assistant prefill = non-thinking one-shots; user text strips
  `<|im_` (turn-breakout guard). clean_output also strips leading think blocks + trailing `<|im_end|>`.
- User decisions: NO OpenAI-compatible server integration EVER (LM Studio works but rejected as backend); NO
  quantized GGUF (wants BF16); lmstudio-js SDK evaluated and rejected (Rust owns model IO).
- Smoke-verified on Qwen3.5: title "Crash on double click file" (good), dictation w/ few-shot good.
- **Suggestions v4 — few-shot playbook (harness-measured winner)**: user asked for a Python 3-prompt A/B harness
  (`scratch/smoke_suggest.py`, replays the REAL example.txt exchange: "load surface and surface psychology compare
  against this webapp" → full audit reply). Scores (avg chips/grounded over 3 runs): P1 instruction-only 1.7/1.0
  (one run degenerated to "No action" x3), P2 case-playbook 3.3/3.3, **P3 few-shot w/ 2 worked examples 4.0/4.0**.
  P3 promoted to SUGGEST_SYSTEM; exchange labels now "Developer's message:/Assistant's reply:/Suggestions:" (match
  the examples), SUGGEST_INPUT_CHARS 1200→6000 (whole reply as plain prose — grounding needs the full findings,
  ctx 8192 has room), n_predict 160. Production-shape rerun: 4/4 chips both runs. cargo check clean.
- **Suggestions v3 — USER-designed "both sides" pattern (their idea, smoke-tested best)**: ONE call; system prompt
  role-plays the model as the USER shown BOTH "My message:" (their last message, head 600 chars) and "Assistant's
  reply:" (tail 1200, plain_prose'd) → 3 numbered next replies (intent-diverse; yes/no questions get accept+decline).
  Beat every one-sided role design on the verbose no-question case. Rust `suggest_replies(user_text, assistant_text)`,
  cmd gains userText, adapter+maybeSuggestReplies pass the last USER message. temp 0.7 (+`--top-p 0.8 --top-k 20` now
  ride with ANY explicit temp in run_completion). Filter: 1-12 words, i-voice entries REMOVED from blocklist
  (role-play makes "I'll…" legit), cap 4 chips. Known limit: yes/no-ending replies often yield only 1-2 chips.
- cargo check --lib + --tests clean, rustfmt. User must point Preferences → Prompt refine llama.cpp folder to the
  b10068 folder + model to the BF16 gguf, then restart pnpm tauri:dev.

## Task (2026-07-19): Composer assists (dictation cleanup + reply suggestions) — DONE (uncommitted, NEEDS RUST REBUILD)
User picked features 1+2 from my local-model ideas, ONE shared preference toggle for both. SMOKE-TESTED the real
model first (exe `E:\llama-bin\llama-b9957-bin-win-cuda-13.3-x64`, model `C:\Users\Alvan\Documents\ALL-GGUF-MODELS\
Aurora-ide\qwen-2.5-instruct\qwen2.5-0.5b-instruct-fp16.gguf`) — findings that drove the design:
- Titles: instruction-only = lowercase echoes; FEW-SHOT examples + --temp 0.3 = real titles; model sometimes leaks
  the "Title:" label → sanitize strips it + all sentence punctuation + trailing connector words. TITLE_SYSTEM updated.
- Dictation: instruction-only only deletes "um/uh"; before→after EXAMPLE PAIR makes it fully punctuate/case/defiller.
  temp 0.2. Length-divergence guard rejects rewrites that balloon/collapse (content change ≠ cleanup).
- Suggestions: one "give 3" call FAILS on 0.5B (parrots the few-shot verbatim, or echoes the format scaffold);
  ONE CALL PER ROLE works (accept / detail question / next step) → `suggest_replies` runs 3 sequential calls,
  temp 0.4, then filters (2-10 words, no assistant-voice openers like "Please provide"/"I can") + word-overlap
  dedupe (≥60% = dup). May return 0-3; zero chips = no UI.
Rust: run_completion gained `temperature: Option<&str>` (refine keeps default sampling); clean_dictation +
suggest_replies + sanitize/filter helpers in prompt_refine/mod.rs; cmds prompt_refine_dictation/_suggest.
FE: TWO independent toggles (user corrected the one-switch design + flagged builder-facing hint copy via /surface):
`dictationCleanupEnabled` + `replySuggestionsEnabled` on useAgentRefineStore (+`dictationCleanupReady`/
`replySuggestionsReady` = own toggle AND paths; refine's own toggle NOT required); "Composer assists" section in
Preferences with two rows ("Polish voice dictation" / "Suggest quick replies"), switches disabled until paths set,
copy rewritten customer-grade (no failure-mode narration); speech hook `polishTranscript` (inside the transcribing
spinner, 6s timeout, raw fallback); `useAgentSuggestStore` (per-thread, cleared at send); maybeSuggestReplies
fires FIRE-AND-FORGET in send's try (text captured synchronously — liveTurns closes in finally), discards if a
newer turn started; chips row above composer, tap fills draft (never auto-sends), hidden while streaming.
ZERO-CHIPS BUG (user report, root-caused by replaying their real reply from example.txt): the model RAN (GPU
spikes) but every output failed the 2-10-word filter — real agent replies (long, markdown/tables) made the 0.5B
emit 13-21-word rambles/assistant-voice; empty Vec → silent no-UI. Fixes (kept MODEL-AGNOSTIC because the user is
downloading a more capable GGUF — do NOT overfit to 0.5B; question-gating + deterministic chips were built then
REVERTED on their instruction): `plain_prose` markdown stripper feeds the model prose (tables/fences/emphasis
dropped — feeding tables back made it emit pseudo-headings), reworded 3 role prompts ("reply on behalf of the
user"), filter relaxed to 1-12 words + junk-opener blocklist expanded. Swapping the model = just repointing the
Prompt refine model path (all 4 features share it).
ICON: user banned "sparkle" (AI slop) — replaced with bespoke `refine` glyph (fountain-pen nib + written line) in
AgentIcon; ALL sparkle uses rewired (refine button, both Preferences sections); `sparkle` name deleted from the set.
Verified: tsc, eslint, 191/191 FE tests, css parse. CARGO NOT CHECKED (user's pnpm dev owns the build lock — twice
killed my checks at their request); compile verifies on their next dev restart.

## Task (2026-07-19): Title maker → Preferences, Off/Local/Cloud — DONE (uncommitted, NEEDS RUST REBUILD)
User: unify chat titling with the prompt refiner. Moved the whole section out of AgentSettings into
PreferencesSettings ("Chat titles", right after Prompt refine) with a 3-way source: Off (derived first-message
title) / Local (SAME llama.cpp+GGUF as prompt refine — new Rust `generate_title_local` in prompt_refine/mod.rs,
`run_completion` extracted so refine+title share the invocation; TITLE_SYSTEM prompt, 1500-char input clamp,
n_predict 48, `sanitize_title` first-line/8-word/60-char) / Cloud (existing generate_thread_title endpoint fields,
UI moved verbatim). New `titleMakerMode` setting (store+database.ts+models.rs+settings.rs key-value, serde default;
legacy rows derive mode from titleMakerEnabled → 'cloud'; setTitleMaker({mode}) keeps the legacy bool in lockstep).
Local path gates on `refinePathsConfigured` (paths only — refine's ✦ toggle NOT required). New cmd
`prompt_refine_title` registered in lib.rs. maybeGenerateTitle switches on mode; failures keep derived title.
Verified: tsc, eslint, 189/189 FE tests, rustfmt. CARGO CHECK INTERRUPTED (user started pnpm tauri:dev which owns
the build lock — only unverified piece; their dev build compile surfaces any error; first check failed only on the
since-fixed AppSettings::default missing field). Suggestion replies = agreed future follow-up.

## Task (2026-07-19): `.rich.jsonl` sidecar — full diffs survive thread reload — DONE (uncommitted, NEEDS RUST REBUILD)
User: truncated reload diffs must show fully, git-independent, "extra metadata alongside session jsonl".
Design mirrors the established sidecar family (`<id>.jsonl` / `<id>.meta.json` / `<id>.artifacts.json`):
- **Write**: conversation.rs execute loop — for modify tools (`rich_persisted_tool`: file_edit/write/create/patch/
  search_replace/multi_search_replace), when the UI-shaped copy (`truncate_tool_content_for_ui`, 512K/128K-per-field,
  JSON-valid) differs from the clamped history copy and no error → `session.push_rich_result` (new
  `RichResultsSlot = Arc<StdMutex<Vec<RichToolResult>>>` on Session, same pattern as QueueSlot since the exec path
  only holds &Session). agent_v2 run_turn persist block drains + `store.append_rich_results` (append-only JSONL,
  best-effort). Model history stays clamped — context safety unchanged.
- **Read**: threads.rs `build_thread_state` (single funnel for ALL loads) → `store.load_rich_results` (tool_use_id→
  content map, last-wins, malformed lines skipped) → `session_to_db_messages_rich` overlays in the Tool-fold
  (non-error only). Old wrapper `session_to_db_messages` is now #[cfg(test)].
- store.delete cleans `.rich.jsonl`; FE unchanged (truncation-note stays as fallback for pre-sidecar threads +
  >512K pathological edits). Old threads can't be back-filled — marker note covers them.
- Verified: cargo check --lib + --tests clean, rustfmt touched files, 2 new Rust tests (compile-verified only —
  test exes can't launch on this machine). Runtime verify = user: restart pnpm tauri:dev, make a big edit (>8KB
  result), reopen thread → full diff.

## Task (2026-07-19): Tool-card intelligence pass — 6 features — DONE (uncommitted, FE-only)
User picked from my suggestions: durations, per-chip diff stats, chip overflow, ANSI shell, highlight cap, disarm.
- **Durations**: FE-measured only (persisting in JSONL = ~20 Rust ToolResult construction sites, rejected as too wide).
  `useAgentWindowSend` toolTimings map anchored on onToolExecutionStart→Complete/Error; approval windows recorded in
  onToolApprovalRequired and only the OVERLAP with [start,end] subtracted (native tools gate INSIDE execute; bridge
  tools gate BEFORE start). `ToolCall.durationMs` (live-only, absent on reload); card shows ≥500ms via
  `formatToolDuration`; ToolGroup header sums ("N calls · d done · 6.4s").
- **Per-chip ±**: parsed.diffs entries carry per-file added/removed → `.agw-chip-stat` inside edit chips.
- **Chip overflow**: >6 selectable chips → first 6 (selected swaps into slot 6 if hidden) + "+N" → portaled
  `.agw-chip-overflow` menu listing ONLY hidden files (user corrected: not all). Arrow-key nav focuses by
  `data-index` post-swap via rAF.
- **ANSI**: new `tool-views/ansi.ts` (SGR only: 16/256/truecolor fg + bold/dim/italic/underline; bg + non-SGR CSI +
  OSC stripped; `--agw-ansi-*` overridable palette). ShellOutputView renders spans; failed shell summary now
  "Command failed · exit N". NOTE: ESC/BEL consts must be `String.fromCharCode` — literal control chars OR `\\u`
  escapes both get mangled through the Bash tool layer here.
- **Highlight cap**: ToolCode skips Shiki > 50K chars (multiFile passes FULL contents — real path).
- **Disarm**: ConversationPane scroller onMouseDownCapture (streaming only) suppresses multi-click selection +
  collapses stale selections (WebView2 crash surface). Idle transcripts untouched.
- Also user-reported: `.agw-rv-title` uppercased filenames → new `.agw-rv-title-file` (exact case, code font) used by
  MultiFileResultsView + ToolResultView diffs head.
- Verified: 187/187 tests (12 new), tsc -b, eslint, postcss parse, production build exit 0. User watched via HMR.
- Follow-up (user screenshot): reloaded-thread diffs showed FAKE red/green rows "−[truncated 4923 bytes in persisted
  history]/+[truncated 4933…]" — Rust's compact-large-fields marker (conversation.rs:1101) lives INSIDE persisted
  oldContent/newContent/content and got diffed. tool-result.ts `splitHistoryTruncation` now strips it at all 3
  consumption points (multi-edit diffs, single diff, batch-read contents) and sets `truncated`; views render a quiet
  `.agw-rv-trunc-note` ("Showing the beginning — full change too large to keep in this conversation"). 189/189.

## Task (2026-07-19): Tool-card file chips dead + double-click STATUS_BREAKPOINT — FIXED (uncommitted, FE-only)
Two bugs, one strip (`ToolCallCard.tsx`): (1) `onTargetPointerDown` eagerly `setPointerCapture`d the chip strip
whenever it overflowed → Chromium retargets the subsequent `click` to the capture element → chip `onClick` never
fired, the click bubbled to the header and just toggled the card ("clicking files doesn't change content"). Fix:
capture lazily in pointermove only after the 3px drag threshold. (2) Double-click on a chip = word selection +
first click's expand animation/highlighter mount = the exact WebView2 150.x selection-during-layout-churn CHECK
(known STATUS_BREAKPOINT root cause, 2026-07-13). Fix: header `onMouseDown` disarm — `preventDefault` when
`detail > 1` + collapse any live selection before layout churn starts. Verified: 175/175 tests (2 new), tsc -b,
eslint. Needs interactive verify (click chips in an overflowing Read File card; double-click no longer crashes).

## Task (2026-07-14): Model selector ordering broken — grouped redesign — DONE (committed 6c54122)
Two real defects in the flat sort: (1) models missing `createdAt` all tied at 0 → default "recently added"
degenerated to cross-provider alphabetical soup; (2) `b.sortOrder - a.sortOrder` tiebreak was DESCENDING —
reversed the user's provider-page arrangement (store sorts ASC everywhere: useSettingsStore 797/1626).
New way to show: Recent strip (last 3 used, hidden while searching) + one section per provider (user's provider
order), models by sortOrder ASC; per-row provider subline dropped inside sections (header says it). Sort-cycling
button + agw:model-sort localStorage removed; stale `.agw-model-group` label CSS repurposed to section wrapper +
`.agw-model-group-label`/`-count`. Verified: tsc, eslint, postcss, 118/118.

## Task (2026-07-14): "App doesn't feel mature" — measured + 3 staged coherence passes — DONE (committed)
Diagnosis with hard numbers: 19 font sizes / 24 radii / 8 control heights / 12 transition durations — near-duplicate
values read as noise; maturity = few values ruthlessly repeated. User approved all passes + asked for checkpoint
commits for rollback. Commits: checkpoint (2906b75→…), pass 1 5280510 (type: 6-token --agw-fs-* scale, 259 CSS decls
+ TSX inline fontSize mapped), pass 2 21566d0 (radii onto theme tokens — raw px was IGNORING the user's Appearance
radius preset; settings row height unified at 30px: set-btn 32→30, seg-btn 26→24), pass 3 c80bec9 (durations 12→2:
0.12s micro / 0.18s structural; 0.28-0.5s progress kept). Verified per pass: postcss parse, tsc, 118/118, build.

## Task (2026-07-14): Composer ghost prediction wrapped to a new line — FIXED (committed 3d5f829)
Typing-assist ghost span was `appendChild`ed to the contenteditable END → landed AFTER the trailing placeholder
<br> every contenteditable keeps → rendered on line 2 despite room on line 1. Fix in useComposerTyping.showGhost:
insert at the CARET (caretAtEnd is a precondition, so caret = continuation point) via range.insertNode; fallback
inserts before a trailing <br>. Range.toString() ignores <br>, so caretAtEnd's tail===ghostText check still holds.
Needs interactive verify (user watching hot reload).

## Task (2026-07-14): Settings/provider controls felt "cheap" — pressed-state + focus pass — DONE (uncommitted, CSS-only)
User: settings (esp. providers page) interactions feel like decoration, not controls; colors are theirs, feel is off.
Root cause: NO `:active` (pressed) state existed on ANY control in agent-window.css except the composer send button;
several controls also lacked focus-visible rings; the seg control's active shadow popped (not in transition).
- Added pressed states to: `.agw-icon-btn`, `.agw-settings-nav-item`, `.agw-set-btn` (+ primary/danger/success
  variants), `.agw-seg-btn`, `.agw-prov-item`, `.agw-csel-trigger`, `.agw-csel-item`. Theme-proof shade formula:
  `color-mix(hover 88%, var(--agw-text) 12%)` — deepens correctly in light AND dark with any user palette.
- Focus-visible rings added where missing (set-btn, seg-btn, prov-item, csel-*); seg active pill layers ring+shadow.
- `.agw-switch` knob now does the iOS press-stretch (width 18→22px held, on-state translate 18→14 so the outer
  edge stays put; spring transition carries release). Seg-btn transition now includes box-shadow; seg hover
  gained a soft fill.
- Verified: postcss parse, tsc -b, 118/118 tests, production `pnpm build` exit 0. (First build attempt hit a
  known-flaky ENOTEMPTY in scripts/sync-material-icons.mjs rmdir of public/vscode-icons — retry passed.)

## Task (2026-07-14): Agent-window streaming lag — 5 perf fixes — DONE (uncommitted, FE-only)
User: window feels laggy/unprofessional during streaming. Root cause: EVERY token → `patchTurnMessage` →
whole-transcript rebuild + re-render of every row in the active turn (tokens arrive way faster than 60fps;
long agentic turns have dozens of tool cards + markdown segments, each re-rendered per token).
- `useAgentWindowSend`: token/thinking deltas now COALESCE into one store patch per animation frame
  (rAF + 200ms timer backstop for hidden windows); every non-text event (tool upsert/result, injection,
  compaction, error, turn end) calls `flushStreamText()` first so timeline order stays exact.
- `AgentMarkdown`, `AgentThinkingBlock`: React.memo (string+bool props) — completed segments in the
  streaming turn skip Streamdown/Shiki re-work per frame.
- `ToolGroup`: React.memo with element-IDENTITY comparator over `tools` (buildRows recreates arrays but
  ToolCall objects keep identity unless actually patched) — text frames no longer re-render every card.
- `tool-result.ts`: shell output in cards clamped to 24K head + 12K tail with elision note (a multi-MB
  output used to go verbatim into a `<pre>` — jank + the WebView2 crash trigger).
- Verified: tsc -b, eslint (5 touched files), 118/118 tests. NOT live-verified (needs app run).

## Task (2026-07-14): "Transcript rolled back to compaction after grey screen" — root-caused (ANALYSIS ONLY, no code change)
Compaction is NOT the culprit — it's append-only (marker message; JSONL keeps full history; UI renders everything).
Real chain: huge shell output → WebView2 renderer crash (known 150.0.4078.65 regression, grey page) → reload wipes
in-memory `liveTurns` → `selectThread` falls back to `thread_load` (disk), and disk only has COMPLETED turns
(`save_to_path` runs at turn END; mid-turn content incl. a fresh compaction marker is memory-only). Orphaned turn
keeps running in Rust but all event listeners are per-`chat()` call → nothing re-attaches after reload, nothing
refreshes on its `agent_turn_complete`, and `selectThread` early-returns on the already-open thread. The "lost"
messages usually ARE on disk once the turn ends — switch to another chat and back to see them. Fix candidates:
(a) incremental `append_to_path` per assistant/tool message, (b) global turn-complete listener → `reloadCurrentThread`,
(c) reload-time query for in-flight turns (Rust `in_flight`) to re-attach or at least re-fetch on completion.

## Task (2026-07-13): Agent-window STATUS_BREAKPOINT crash — root-caused + auto-recovery — DONE (uncommitted, needs Rust rebuild)
User hit repeated "This page is having a problem / STATUS_BREAKPOINT" in the agent window since 2026-07-12.
- **Root cause (proved via minidump)**: WebView2 Evergreen runtime auto-updated to 150.0.4078.65 on 2026-07-11
  18:28 — hours before crashes began. Symbolicated the Crashpad dump (`%LOCALAPPDATA%\com.aurora.agent\EBWebView\
  Crashpad\reports`, cdb + msdl symbols): renderer CHECK (int3) on MOUSE-UP → `LocalFrameView::UpdateLifecycle
  PhasesInternal` → `LayoutSelection::Commit` → `FrameSelection::IsHidden/SelectionHasFocus` → re-entrant
  `Document::UpdateStyleAndLayout`. A click while a text selection exists during style/layout churn (streaming
  chat) trips a Blink re-entrancy CHECK. Runtime regression — NOT app code (scroll-fade/shimmer CSS exonerated;
  not in the stack). No newer 150.x runtime exists yet (.65 > documented .44).
- **Fix 1 — native auto-recovery**: new `services/webview_recovery.rs` — `ICoreWebView2::add_ProcessFailed`
  handler that `Reload()`s on RENDER_PROCESS_EXITED / FRAME_RENDER_PROCESS_EXITED (per Microsoft's contract),
  rate-limited 3 reloads/120s (no crash-loop), idempotent per WebView COM identity (the bootstrap command is
  called repeatedly + handlers survive reloads → would otherwise stack). Installed at all 3 window-creation
  sites: lib.rs main, lib.rs agent-mode launch, and `install_agent_media_permission_handler` (JS-created agent
  window path).
- **Fix 2 — seamless restore**: new `agent-window/hooks/useReloadRestore.ts` — snapshots the open chat
  (`{id, ws}`) to sessionStorage on selection change; `AgentWindow` boot re-selects it after `init()`. Survives
  crash-reload + Ctrl+R, fresh windows unaffected (sessionStorage is per-browsing-session). `selectThread`
  already re-attaches to live turns, so a mid-run crash recovers into the streaming transcript.
- Verified: 118/118 tests (3 new), tsc -b, eslint(touched), cargo check --lib, rustfmt(touched). NOT live-verified:
  Rust change ⇒ needs `pnpm tauri:dev` restart AND `pnpm tauri build` for the installed production app.

## Task (2026-07-12): Agent-window tool consolidation mismatches — IN PROGRESS
- Enforce Agent/Plan/Team at the Rust tool-registry boundary; Plan keeps read-only shell validation and cannot see native mutators.
- Make cross-file `file_edit` rollback-safe with stale-snapshot detection; align agent-window approvals with the current tool roster.
- Pin frontend skill tools to the turn workspace, correct the native roster count, and remove the unavailable `aurora_search` tool.
- Verify with focused Rust/TS regression tests, typecheck, lint, cargo check, and graphify update.
- Test-target compilation caught an incorrect private emitter reference in the new Plan-mode tests; switched to the existing local `MockEmitter` before continuing.
- Workspace-wide rustfmt touched unrelated files; all formatter-only changes were restored byte-for-byte from HEAD before verification resumed.
- Full frontend tests passed; typecheck caught a test mock returning `undefined` where the real skill API returns `null`, corrected before the final verification rerun.

### Review — DONE
- Rust now receives an explicit execution mode: Plan hides every native mutator and wraps `shell_execute` with a cross-shell read-only allowlist plus the existing safety validator.
- Multi-file edits validate snapshots, reject concurrent changes, and roll back every attempted write on failure; approval rows now contain only current gated agent-window tools.
- Skill search/load use the dispatching turn's workspace; dead `aurora_search` was removed and the resulting native roster is 22 tools.
- Verified: 115/115 frontend tests, 26 focused tests, targeted ESLint, TypeScript, production frontend build, `cargo check`, Rust test-target compilation, 45/45 safety tests, touched-file rustfmt, diff check, and graphify refresh. Full ESLint remains blocked by generated `build/` assets and legacy IDE violations outside agent-window scope.

## Task (2026-07-09): Profile page v2 — identity, models, hover readout, image export — DONE (uncommitted, Rust NOT compile-checked)
User: profile page needs sharing (export image), model attribution (meta.json DOES have `model`),
and chart hover detail (native title tooltip was useless).
- Rust `usage_stats.rs`: + `user_name` (env USERNAME/USER), + `top_models: Vec<ModelUsage
  {name, threads, tokens}>` — attributed from `SessionMetadata.model` per thread (whole thread's
  tokens → its recorded model; per-message attribution doesn't exist). CARGO CHECK NOT RUN (user was
  running pnpm dev) — verify on next tauri build.
- Frontend ProfileSettings: identity head (machine-name avatar + "Local profile" + Export as image
  button → canvas-rendered 1200×640 share card using LIVE --agw tokens, copied to clipboard as PNG);
  hover readout line above chart (date + tokens + turns, `data-hover` bar highlight, reserved height);
  "Most used models" section (token-proportional bars). Bar type gained `turns`.
- Chart v3 after screenshotting Codex's actual profile (PowerShell CopyFromScreen — qg-probe has no
  imaging): Codex "Token activity" is a GitHub-style CONTRIBUTION HEATMAP, not bars. Daily view is now
  `<Heatmap>`: 26 weeks × 7 days (Mon-first, aligned to current week), 5 intensity levels via
  color-mix(accent), month labels under first column of each month, hover → shared readout (setHovered
  Bar object, also used by weekly/cumulative bars which remain). `.agw-heatmap-*` CSS; future cells
  transparent; cell hover scales 1.35.
- Share card branding: loads `/aurora.png` (same asset as TitleBar); bottom-right watermark =
  32px icon + "Aurora Agent" wordmark at 0.92 alpha; header simplified to just the user name;
  footer-left "Token activity — generated locally". Logo load failure degrades to wordmark-only.

## Task (2026-07-09): Agent-window auto project rules + glass popovers — DONE (uncommitted)
User: (1) do `.aurora/*.md` rules reach the agent window? (2) @-mention dropdown looks bad; Codex
popovers are translucent/blurred.
- **Finding**: IDE auto-injects `<project_rules>` (all `.aurora/*.md`) on a chat's FIRST message
  (context-builder buildContext §3); the agent window only sent rules the user `/`-attached
  (buildRuleContext). Plain `.aurora` rules NEVER reached the agent-window runtime.
- **Fix**: `useAgentWindowSend` gained `buildAutoRulesContext` — on first message (`wasDraft`), all
  `.aurora/*.md` rules ride in ideContext as `<project_rules>`, capped at 10K chars total
  (AUTO_RULES_CHAR_BUDGET); oversized rules truncated with "read .aurora/<file> for the rest";
  `/`-attached rules excluded (they ride verbatim in buildRuleContext).
- **Glass popovers**: `.agw-menu` + `.agw-mention` now translucent (color-mix 78%/76% of their
  surface) + `backdrop-filter: blur(24px) saturate(140%)` + shared `agw-pop-in` entrance (4px rise,
  0.14s). Composer-family rule preserved (tint still from `--agw-composer-surface`). Opaque
  `@supports not (backdrop-filter)` fallback. Settings-only menus (.agw-csel-menu, .agw-prov-add-menu)
  left opaque for now.

## Task (2026-07-09): Profile/usage-stats page + composer access-mode pill — DONE (uncommitted, needs Rust rebuild)
User picked these two (via Codex head-to-head) as next features.
- **Profile page** (Settings → Personal → Profile): Rust `usage_stats_get` (commands/usage_stats.rs,
  registered in mod.rs + lib.rs invoke_handler) scans ALL SessionStore JSONLs via registry.store():
  per-day token buckets (local tz via chrono), lifetime totals, tool_use name counts (top 10),
  longest task (first→last msg ts per thread), thread/message counts. Frontend
  `settings/ProfileSettings.tsx`: stat tiles (lifetime/chats/peak day/longest task/streaks),
  Daily/Weekly/Cumulative bar chart (pure divs, `.agw-profile-*` CSS), most-used-tools bars.
  Streak math client-side ("today" = renderer tz). New "profile" SettingsSection + registry entry
  (group "Personal", fullBleed NOT used). All local — no telemetry. NOTE: no per-model attribution in
  ConversationMessage → cost-per-provider deferred (would need per-turn model logging).
- **Access pill**: `components/ModePicker.tsx` next to ModelSelector in composer top row; shows
  Agent/Plan/Team (Team when teamEnabled && !plan, mirrors useAgentWindowSend), menu writes the same
  `useSettingsStore.agentExecutionMode` as AgentSettings. `.agw-mode-*` CSS; Plan tints warning.
- cargo check + tsc -b + eslint clean (2 pre-existing set-state-in-effect errors in AgentComposer).
- NOT verified live: needs Rust rebuild (new command) — restart `pnpm tauri:dev`, open Settings →
  Profile; check chart with real history + pill switching agent↔plan.

## Task (2026-07-09): Menu-row text hierarchy — dropdown labels no longer muted at rest — DONE (uncommitted)
User: model-selector list text looked washed out vs Codex. Audit found the "muted until hover" pattern
(`color: var(--agw-text-muted)` at rest, `--agw-text` on hover) on SIX dropdown-row classes:
`.agw-model-item`, `.agw-menu-item`, `.agw-reason-item`, `.agw-csel-item`, `.agw-mention-item`,
`.agw-qp-opt`. All now rest at `var(--agw-text)` — Codex convention: menu PRIMARY labels are
full-strength, hover changes background only; secondary sublines (`.agw-model-sub`, `.agw-reason-state`)
stay subtle. Deliberately NOT changed: rail/sidebar rows, suggestion chips, icon buttons, chips/metadata
— those are quiet by design (matches Codex sidebars). Rule documented in the `.agw-model-item` comment.

## Task (2026-07-09): Agent window size persistence + providers page full-bleed relayout — DONE (uncommitted)
User: agent window always opened at hardcoded 1200×800 (must remember last size); providers settings
page should be a REAL sidebar (list flush to edge) + detail pane, not floating cards.
- **Window size**: new `agent-window/hooks/useAgentWindowBounds.ts` saves `{width,height,maximized}`
  (LOGICAL px via scaleFactor) to app_settings key `agent_window_bounds` on debounced onResized —
  resize-time not close-time (teardown race + crash safety); maximized only flips the flag so the
  floating size survives. Restored by BOTH launch paths: `adapters/window.ts` openAgentWindow (clamps
  to 820×560 min + current monitor) and `lib.rs` agent-only launch (reads via
  `app.state::<Mutex<db::Database>>().settings().get_setting`). Position NOT persisted (stays centered
  — avoids off-screen multi-monitor restores).
- **Providers relayout**: SettingsPage SectionDef gained `fullBleed` → content div `data-full-bleed`
  (padding 0, overflow hidden, flex). ProvidersSettings is now `.agw-prov-page`: `.agw-prov-side`
  (248px rail-bg sidebar, head + scroll list + pinned Add provider foot) + `.agw-prov-main` (own
  scroll, `.agw-prov-main-inner` max-width 880 padded). Old `.agw-prov-layout/.agw-prov-list(-scroll)`
  CSS pruned; detail card keeps its look but viewport max-height caps lifted (page scrolls, models
  list uncapped). models.dev hint moved from the removed page header to `.agw-prov-models-hint`
  under the Models head. tsc -b + eslint (1 pre-existing set-state-in-effect) + cargo check clean.
- NOT verified live (needs app run): resize→reopen roundtrip + the new page at min window width.
- Follow-up fix (same day): API-type pills clipped (labels wrapped into fixed 26px pills when the
  3-option segmented was stretched/squeezed). Fixed at the PRIMITIVE: `.agw-seg` gets
  `width: fit-content; max-width: 100%` (explicit width beats flex/grid stretch), `.agw-seg-btn` gets
  `white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis`. Plus narrow-width
  hardening: `.agw-prov-conn` and `.agw-prov-edit` grids collapse 2→1 col via
  `repeat(auto-fit, minmax(min(280px,100%),1fr))`; `.agw-prov-edit-toggles` wraps; `.agw-prov-cap`
  nowrap. Model rows already ellipsis-safe.
- Follow-up 2: Add-model button hung outside the card at tiny widths. `.agw-prov-addrow` now
  `flex-wrap: wrap` (+ field `flex: 1 1 200px; min-width: 0`) so Add drops below the input when tight;
  `.agw-set-btn` global `white-space: nowrap`; `.agw-set-input` global `min-width: 0` (intrinsic input
  width was blocking flex rows from shrinking — the likely root cause of the API-key/add rows pushing
  trailing buttons out). `@media (max-width: 1080px)`: provider rail 248→204, detail padding slimmed.

## Task (2026-07-09): OpenAI Responses API as a NEW provider type ("openai-responses") — DONE (uncommitted)
User: adopt OpenAI's structured-streaming standard as an ADDITIONAL provider type — NOT a replacement
for Chat Completions. Same base URL (`…/v1`), endpoint `/responses`, typed SSE events.
- New `src-tauri/src/api/responses.rs` (OpenAIResponsesAdapter): stateless (`store:false` +
  `include:["reasoning.encrypted_content"]`); reasoning items persist via JSON packed into the existing
  `Thinking.signature` field (`{"provider":"openai-responses","id","encrypted_content"}`) and replay as
  `type:"reasoning"` input items → CoT survives across tool-call iterations. Flat tool schema
  (`strict:false`), `temperature` gated off for reasoning families (gpt-5*/o1/o3/o4*/codex* → 400 otherwise),
  usage `cached_tokens` is a SUBSET of input (DeepSeek-style normalization, subtracted before emit).
- Routing: `ProviderKind::OpenAIResponses` in `api/client.rs` (ids `openai-responses`/`openai_responses`);
  plain "openai" stays on chat/completions. Catalog preset "OpenAI (Responses)" in provider_catalog;
  TS ProviderType unions + API-type pickers (agent-window ProvidersSettings segmented, legacy
  ProviderEditorDialog select) gained the third option.
- Verify: main-lib `cargo test` still hits STATUS_ENTRYPOINT_NOT_FOUND (known ONNX issue) — new standalone
  crate `src-tauri/target/__verify_responses` mounts real api/*.rs via #[path]; 67/67 pass. cargo check +
  tsc -b + eslint clean (2 pre-existing set-state-in-effect errors in ProviderEditorDialog untouched).

## Task (2026-07-04): Composer "one family" color — model/reasoning pickers follow composer surface — DONE (uncommitted)
User: Codex's model selector feels premium because it shares the input-box color; ours was split.
Wanted editing composerSurface to also move the model selector + thinking-effort picker. tsc+eslint clean.
- Root cause: `.agw-composer-pill` triggers are transparent (blend at rest), BUT the open state used
  `--agw-surface` and the popovers (`.agw-menu`) used `--agw-surface-elevated` — both separate tokens
  from `--agw-composer-surface`, so changing the input fill never moved the pickers.
- Fix (`agent-window.css`): `.agw-composer-pill[data-open]` now tints FROM `--agw-composer-surface`;
  added a composer-family rule so `.agw-model-menu, .agw-reason-menu, .agw-mention` background =
  `--agw-composer-surface` (later source order beats `.agw-menu`). Editing "Input fill" in Appearance now
  repaints the whole composer cluster. Updated the composerSurface hint copy in AppearanceSettings.

## Task (2026-07-04): Agent-window composer draft recovery + left-rail relayout — DONE (uncommitted)
User: build feature #1 (per-chat composer draft recovery) + restructure the left rail so the team
glyph and the streaming spinner don't collapse/reflow. tsc -b + eslint (touched files) clean.
- **Draft recovery**: new `agent-window/store/useAgentDraftStore.ts` (zustand+persist, `drafts` map
  keyed by threadId, or `newChatDraftKey(project)="new:<root>"` for the home). Docked composer in
  `ConversationPane` now controlled (`value`/`onValueChange` → draft key = currentThreadId); `EmptyState`
  swaps its local useState for the per-project draft key. Composer's existing `onValueChange("")` on send
  clears the draft; blank drafts are pruned. Restore path reuses AgentComposer's `[value]` effect (pills
  flatten to `@rel` text on restore — acceptable for a text-draft feature).
- **Rail relayout** (`LeftRail.tsx` + `agent-window.css`): every chat row (active + archived) gained a
  fixed leading `.agw-rail-item-glyph` slot where chat icon ↔ `agw-rail-spin` ↔ `agw-rail-done-dot` swap
  IN PLACE (was: conditional-only leading spinner, idle rows had no glyph → title reflowed). Trailing
  team badge + hover pin/archive wrapped in `.agw-rail-item-actions` reserved lane (opacity toggles keep
  layout stable, no overlap). Project rows left as-is (already have folder icon + caret leading).

## Task (2026-07-02): Team streaming/loop/UI rebuild — one source of truth — DONE (uncommitted)
User: team screen showed fake/overlapping double streams, pointless sidebar status marks, and the
completion notification retriggered the same run in a loop. cargo check + tsc -b + eslint all clean.
- **No duplicate streams**: useTeamStore only clears a DONE draft on its author's persisted event
  (a live draft survives ask_owner replies posted as the owner mid-stream); refresh() reconciles done
  drafts vs snapshot ts (poll path used to leave the settled draft next to its persisted twin); ghost
  drafts (>6min idle, lost `end`) dropped; poll 500→2000ms; new store action `clearDraft` — the
  member-transcript pull callback drops the settled draft the moment the persisted turn lands
  (baseline count tracked in the pull callback, never during render → react-hooks/refs clean).
- **Same chat interface**: MessageBubble gained optional `label`/`labelColor`; TeamScreen ChannelFeed
  + live drafts + member draft ALL render through MessageBubble (thinking block, markdown, shimmer,
  skeleton) — no more custom left/right balloons, caret, or raw `agw-team-think` divs (CSS pruned).
  Lead plan JSON + reviewer verdict JSON stream as THINKING frames (`TeamStreamer::text_as_thinking`)
  so raw JSON never streams into the chat as a message.
- **Loop killed**: Rust `TeamRunStatus.acknowledged` + `team_run_ack` cmd (dispatcher owns
  exactly-once across reloads); notifier acks at delivery, poll skips acked runs; prompts hard-forbid
  re-dispatch/auto-retry; team_dispatch tool rejects identical goal <3min after a done run.
- **Sidebar**: roster status dot+word removed; small pulse only while a member actually streams.
- **Auto-scroll**: TeamScreen main column wired to the conversation's own `useAgentAutoScroll`
  (containerRef on the scroller, contentRef wrapper) — sticks to bottom while the run streams,
  releases when the user scrolls up, re-sticks when they return; view switch snaps to latest.
- **Mentions + layout shift (follow-up)**: raw `@widget-builder-edc6e7` ids in chat/transcript prose
  now rewrite to `**@Widget Builder**` via `team-ui.prettifyMentions` (markdown:false for the plain
  status banner; tool-card args untouched); `.agw-team-main` gained `scrollbar-gutter: stable
  both-edges` + `overflow-x: hidden` + `overscroll-behavior: contain` — reasoning expand/collapse
  can't shift the centered column (symmetric gutters) or grow a horizontal scrollbar.
- **Tool-state fix (follow-up)**: two-part bug — (a) `bubblePropsEqual` compared only event COUNT, so
  a tool RESULT landing (same count, `result` filled in) never re-rendered an idle bubble → stuck
  "Didn't complete" until the NEXT tool call; comparator now also compares resolved-result count.
  (b) member transcript's last bubble lost `streaming` while the next turn's draft rendered — exactly
  the window in which tools execute → pending showed as failed; now `streaming = working && lastId`.
- **Team screen v2 (follow-up)**: group chat messages/drafts wrapped in `.agw-team-bubble` tinted per
  member color (label colored, `bubbleTint` color-mix); sidebar member names plain text + `agw-shimmer`
  while that member streams (no dots/status); "Team chat" row gets an accent unread dot
  (`.agw-team-unread`, seen-count updated only in click handlers) when messages land while a member
  tab is open; integration-gate chips (Build/Lint/Test) REMOVED from the sidebar (backend gate + model
  data in team_status untouched); `GATE_TONE`/`GateChip` deleted.
- **team_dispatch v2 — agent-defined teams (follow-up)**: the tool is now plain: the dispatching
  agent DEFINES the team in the call — `members: [{role, task, scope[]}]` (required; task = the
  member's full instructions, written from the agent's own conversation context; scope = owned
  paths). New Rust `DispatchMember` (types.rs, mirrored in types/team.ts) + `run_assigned_planning`
  (runner.rs): convene exactly that roster, lock scopes, seed one board task per member, post the
  Lead's brief (goal + assignments), run member standups — NO separate lead planning model call, so
  no fresh-context "lead" re-planning from a bare goal. dispatch.rs/commands wire `members` through;
  auto-planner remains only as fallback when members is absent (legacy path). Executor validates
  entries (role/task/scope) with model-readable errors; integer `members` (team size) is GONE from
  the schema. lead_answer (@lead) now also sees the board assignments. Rejected approach: a
  "context briefing" param with heavy prompt framing — user wants it as an ordinary tool.
- **Lead grant verified**: new Rust test `lead_mention_answers_and_grants_scope_access` (ask_owner
  to="lead" → coordinator reply, GRANT applied via assign_scope, directive stripped, path moves to
  asker, old owner loses it, check_write allows). Compile-verified (`--no-run`; test exes still can't
  launch on this machine — 0xc0000139 DLL env issue).
- **Orphan IC tools fixed**: IC roster was 8/14 dead names (search_replace, file_patch, multi_search_
  replace, file_delete, folder_delete, file_create, multi_file_read, file_exists) — schemas silently
  dropped so ICs had NO edit/delete/move tool. Now mirrors the real registry (file_read, workspace_
  tree, grep, auroro_websearch + file_write, file_edit, move_path (dual-guarded), delete_path,
  folder_create) with stale-name aliases; ~340 lines of dead legacy tool methods deleted.
- **@lead**: mentioned_teammates already matched "@lead"; owner_answer now routes lead → new
  `lead_answer` (coordinator persona, sees ownership map + chat) which can end with `GRANT: <paths>`
  → applied via assign_scope (non-overlap kept), directive stripped, human note appended.
- Also fixed pre-existing test-compile breakage: ToolContext/AgentChatRequest test initializers
  missing allow_outside_workspace + compaction fields (19 sites). NOTE: `cargo test` binaries fail to
  LAUNCH on this machine (0xc0000139 DLL entrypoint, onnxruntime-class env issue) — compile verified.

## Active task: native code-intelligence / `read_lints` (DOCS/agent-window-lsp-plan.md)

**Goal:** make `read_lints` return REAL diagnostics (currently a stub), then add headless
LSP + semantic-nav tools for the agent. All native Rust, single-source (no frontend hop).

### Verified state (2026-07-01) — plan doc matches reality
- `src-tauri/src/tools/shell_editor_todo/read_lints.rs` — STUB. Emits `agent_read_lints`
  event, returns hardcoded `{"success":true,"message":"lints requested for …"}`. No real diagnostics.
- `src/services/agent-ide-events.ts:204` — `agent_read_lints` listener is a deliberate no-op (console.debug).
- `src/services/agent-prompt.ts:60` — instructs model to "run read_lints after edits" (points at a stub).
- `src/tools/definitions/editor-tools.ts:40` — `readLintsTool` desc claims it returns TS/JS/Rust errors (false today).
- No existing `src-tauri/src/lsp/` or `diagnostics/` module — greenfield.

### Key architecture facts (owning modules / patterns)
- Native tools impl `ToolExecutor` (async `execute(input, ctx) -> Result<String, ToolError>`).
  `ToolContext` = { turn_id, tool_call_id, session_id, workspace_root: Option<PathBuf>, cancel_token }.
- Registered via `tools::register_builtin_tools(&registry, sink, browser_mgr)` in `lib.rs::setup` (~line 607).
  Count pinned by `tools/mod.rs::BUILTIN_TOOL_COUNT` (26) + per-bucket `TOOL_NAMES` + count tests.
- Dependency injection: constructor (like `IdeEventSink`) OR process-global singleton
  (`read_tracker` via `OnceLock`, `MCP_MANAGER` via `lazy_static`).
- `read_tracker` (file_workspace_search/read_tracker.rs) = per-session seen-set → use for empty `paths`.
- Freshness hook points (write tools that emit `FileChangedPayload`): `file_write.rs`, `file_edit.rs`,
  `move_path.rs`, `delete_path.rs` in `tools/file_workspace_search/`.
- MCP manager (`mcp/manager.rs`) = reference for child-process lifecycle: actor-per-server, tokio::process,
  mpsc+oneshot id correlation, stderr drain, request timeout, kill_on_drop. BUT it's newline-JSON (MCP);
  LSP needs Content-Length framing → reuse the PATTERN, not the code.
- Single-source rule: `AgentService.buildAvailableTools` filters `nativeRustOwned` → native schemas come
  from Rust only; frontend TS defs are display/approval metadata.
- Toolchains available: `tsc -b` + `eslint .` (package.json), `cargo` (Rust). Cargo dep `lsp-types` NOT yet added.

### The move (recommended, decisions resolved)
- **Phase 0 first** (1 contained PR): native `lsp` module w/ shell-checker diagnostics; rewrite `read_lints`
  to return structured diagnostics; fix FE no-op + descriptions + prompt. Immediate honest value.
- **Phase 1**: headless LSP client (hand-rolled `lsp-types` + Content-Length framing, actor-per-(root,lang)
  mirroring MCP). read_lints = LSP-first, shell fallback. Add `notify_changed` in write tools.
- **Phase 2**: semantic-nav native tools (definition/references/hover/document+workspace symbols).
- **Phase 3**: settings, detect-on-PATH, warmup, idle reaping.
- Decisions: hand-rolled client (not async-lsp); detect-on-PATH (no bundle); global singleton handle
  (like MCP_MANAGER; Phase 0 is stateless so needs none); defer semantic tools to Phase 2; TS = LSP-first + tsc fallback.
- Module refinement vs doc: put Phase 0 checkers under a single `src-tauri/src/lsp/` owner (e.g. `lsp::shell`)
  instead of `services/diagnostics/`, so Phase 1 `lsp::manager`/`lsp::transport` land in the same module (no later move).

### Status: PLAN ONLY — no code changes yet. Awaiting go-ahead on Phase 0.

## Task (2026-07-02): Agent-window TEAM end-to-end audit (analysis only, no edits yet)
Ran 3 explore subagents (FE / Rust / legacy). Full end-to-end mapped. Key facts:
- Dispatch: FE `useAgentWindowSend` derives `executionMode="team"` from `teamEnabled && !plan` → shared
  `AgentService` exposes `team_*` (gated by `filterToolsForExecutionMode`) → model calls `team_dispatch`
  → `team-agent-tools.runDispatch` → `requestOpenTeamView()` + `team_dispatch` Tauri cmd → Rust
  `TeamDispatcher::dispatch` spawns detached planning→build→integration task; returns immediately.
- Completion: Rust posts `✅/❌` System event authored `lead` (meta:None). FE `useAgentTeamNotifier`
  detects by string-prefix, injects "[Automatic team notification]" turn to Lead chat.
- CRITICAL root causes of "runs failing": (I2) Windows atomic rename of team.json/session.jsonl fails
  Access-denied while FE polls them open → `?` aborts whole run; (I1) integration gate is a NO-OP —
  dispatch never passes settings' build/lint/test cmds; (I3) no timeout on model calls + cancel token
  never fired → hung provider stick-locks one-run guard; (I4) panic/poisoned mutex stick-locks guard;
  (I5) review verdict classifier false-positives on the word "change" → forced rework→fail.
- Notifier bugs (FE): (A1) not scoped to window projectId → cross-project leak; (A2) uses global
  `sending` not open-thread liveTurns; (A4) can spawn junk-titled new chat; no poll fallback (I10).
- Legacy: `src/components/team/*` + `/team-view` are DEAD (remove after editing App.tsx + agent-ide-events.ts).
  BUT `src/components/agent/*` (IDE Agent Mode via MainLayout isAgentMode) and `useTeamRunNotifier`
  are STILL LIVE in the IDE — removing them = real feature removal, needs explicit decision.
- Subagent transcripts: FE=de8f8d46, Rust=ec1d536e, legacy=9eeefa12.
### Status: audit done; fix plan drafted; awaiting user decision on IDE Agent Mode retirement scope.

## Task (2026-07-02): Team fixes + IDE Agent Mode full retirement — DONE (uncommitted)
User decision: `full_retire`. Executed in one pass; `tsc -b` + eslint clean, `cargo check --lib` clean.
- **Seam** (terminal meta): Rust dispatch emits canonical `"done"`/`"failed"`; both notifiers
  (`useAgentTeamNotifier`, and pre-deletion `useTeamRunNotifier`) + `types/team.ts` tolerate
  done/failed/complete(d)/success/failure. No more emoji-only fallback.
- **C1** workspace.rs: `with_io_retry` (12 tries) around rename/append/session writes → Windows
  Access-denied-under-read resilience. **C3**: `TEAM_MODEL_CALL_TIMEOUT`=300s wraps model joins in
  runner + build_runner. **C4** dispatch.rs: `catch_unwind` always calls `finish()`, poison-tolerant
  `lock_runs`/`lock_handles`. **C5**: rewrote `verdict_from_str` (no "change" false-positives).
- **C2** integration gate wiring: added `teamGateBuild/Lint/Test` through Rust `AppSettings`
  (models.rs + repositories/settings.rs, key-value store so NO migration), FE `DbAppSettings`,
  `useSettingsStore` (+`setTeamGate`), agent-window `TeamSettings.tsx` (was local useState),
  and `team-agent-tools.runDispatch` merges `optionalGate(args) ?? settingsGate()`.
- **H2/H4** `useAgentTeamNotifier`: per-thread `liveTurns[threadId]` check (not global `sending`);
  added app-lifetime `team_run_status` safety poll (7s) deduped with the live stream on runId.
- **Cleanup**: dead `.agw-team-post*`/`.agw-team-avatar*` CSS removed (kept live `agw-team-kind`).
- **Phase 3 (full_retire)**: deleted `src/components/agent/*` (AgentModeLayout etc.), `useTeamRunNotifier`,
  IDE `TeamSettingsTab`. Removed `isAgentMode`/`toggle/setAgentMode` from `useUiStore`; MainLayout always
  renders EditorPanel + allows ChatPanel; removed ChatHeader "Agent Mode" button; useAgentSend clamps
  stale `"team"`→`"agent"`; ChatInput cycles Agent↔Plan only; AgentSettingsTab/SettingsPanel drop Team
  subtab. KEPT `ChatPanel`+`useAgentSend` and the SHARED `agent-execution-mode.ts`/team data layer
  (agent window depends on them). Stale "Settings → Agent → Team" copy → Agent Window "Settings → Team".
### Status: ALL fixes + retirement implemented & building. Uncommitted. Not run by me (user runs app).

## Task (2026-07-02): Team live streaming + emoji removal + workspace pinning — DONE (uncommitted)
User: team view felt "stale for 1-2 min" vs instant normal chat; wanted real-time streaming, ZERO
unicode emoji, and a check on a suspected workspace/thread mismatch. One pass; cargo check + tsc -b +
eslint all clean; graphify updated.
- **Workspace pin (wsfix)**: new `TeamToolContext {workspacePath, threadId}` threaded
  agent-runtime-client → aurora-tools → team-agent-tools. `requireRepoPath`/`dispatchOrigin` now prefer
  the TURN's pinned path/thread over global `useWorkspaceStore.rootPath`/`useAgentChatStore` (fixes the
  mismatch when a background turn ran against a since-switched project).
- **Live streaming (stream-*)**: new ephemeral `TeamStreamDelta` (Rust `team::types` + `types/team.ts`),
  broadcast on NEW `team_stream` Tauri channel (never persisted). `TeamEventSink::emit_team_stream` +
  `TeamBus::stream` + `TeamStreamer` helper (start/text/thinking/end, seq-counted). Wired into
  `complete_text` (planning/standup/review) and `complete_turn` (build) — forwards TextDelta + Thinking.
  FE: `useTeamStore.liveDrafts` (keyed by agentId, `ingestStreamFrame`), cleared instantly when the
  authoritative ChannelEvent lands (group) or after `DRAFT_SETTLE_MS`=1200 (build; poll=800 hands off).
  `TeamScreen`: group drafts render as live bubbles w/ thinking + blinking caret; selected member's
  build draft renders under its transcript.
- **Emoji purge + meta (emoji-*)**: removed 🚀/✅/❌/↩/▶ from Rust message bodies. UI now drives off
  METADATA only — run scope via `meta.dispatched`, terminal via `meta.terminal` (done/failed),
  gate notes via `meta.gate`/`meta.gateStatus`. Notifier lost its emoji-body fallbacks.
- Files: FE `team/TeamScreen.tsx`, `store/useTeamStore.ts`, `hooks/useAgentTeamNotifier.ts`,
  `services/{team-client,team-agent-tools,aurora-tools,agent-runtime-client}.ts`, `types/team.ts`,
  `theme/agent-window.css`; Rust `team/{types,mod,bus,runner,build_runner,integration_runner,
  orchestrator,dispatch}.rs`, `lib.rs`.

## Task (2026-07-02): Agent-window mic permission modal — DONE (uncommitted)
User: agent window voice input showed the raw native WebView2 mic prompt (terrible); wanted a dedicated
in-app modal in the agent-window aesthetic (not IDE design). Root cause: the native auto-grant handler
(`services/webview_permissions.rs::install_permission_handler`) is only installed on windows created in
Rust (`lib.rs` main + CLI agent_mode). The agent window is normally created from JS
(`agent-window/adapters/window.ts::openAgentWindow` → `new WebviewWindow`), which never runs it → native
prompt fires. The IDE also has an in-app gate (`SpeechInputButton` ConfirmDialog); the agent window had none.
Fix (cargo check + tsc + eslint all green; graphify updated):
- **Rust**: new command `commands::speech::install_agent_media_permission_handler(app)` → looks up the
  "agent-window" webview and calls the existing `install_permission_handler`. Registered in `lib.rs`
  handler list next to the speech cmds. (Suppresses the native WebView2 mic prompt on the agent window.)
- **speech.ts**: `speechService.ensureMicPermissionHandler()` → `auroraInvoke("install_agent_media_permission_handler")`.
- **useAgentSpeech.ts**: boot effect installs the native handler once (module-guarded, `isAuroraRuntimeAvailable`
  gate); split `startRecording`→`actuallyStartRecording`; added in-app gate (`requestStart` checks
  `localStorage["aurora.speech.permissionGranted"]`, else opens modal), `confirmPermission(remember)`,
  `dismissPermission`; toggle now gates first use. Shares the remember key with the IDE (same origin).
- **AgentMicPermissionModal.tsx** (NEW): dedicated modal, `--agw-*` tokens, portaled into `.agw-root`,
  mic badge + privacy copy + remember checkbox + Not now/Allow; Esc/Enter; mounted ONLY while open
  (composer conditionally renders) so `remember` resets fresh w/o a setState-in-effect lint.
- **AgentComposer.tsx**: renders the modal from the hook's `permissionOpen/confirmPermission/dismissPermission`.
- **agent-window.css**: `.agw-mic-perm-*` styles (overlay/dialog/badge/actions).
- NOTE: 2 pre-existing `react-hooks/set-state-in-effect` errors remain in AgentComposer (value-sync +
  file-index effects) — NOT mine; whole `src/agent-window/` is still untracked in git.

## Task (2026-07-02): Left-rail "has team work" badge — DONE (uncommitted)
User: each chat (and/or the project name) in the left rail should show a team icon (like the pin label)
if that thread has previous team work. Durable source of truth = the project brain's channel log — every
run stamps `meta.originThreadId` on its lifecycle events. cargo check (exit 0, only a pre-existing
dead-code warning) + tsc -b + eslint all green.
- **Rust**: new `commands::team::team_origin_threads(repo_path) -> Vec<String>` scans `ws.read_channel(None)`
  for distinct non-empty `meta.originThreadId` (BTreeSet → stable order); empty for no-brain/no-runs, never
  errors on missing brain. Registered in `lib.rs` next to `team_channel_tail`.
- **team-client.ts**: `getOriginThreads(repoPath)` wrapper.
- **useTeamHistoryStore.ts** (NEW, agent-window/store): cross-project index `{ threadIds, projects }`;
  `refresh(roots)` folds every root's origin ids into one union, coalesces identical in-flight rebuilds
  by sorted root-set key, best-effort per root. NOT persisted (cheap to rebuild from disk).
- **LeftRail.tsx**: reads the store; effect rebuilds off a stable `projectsKey` (root SET, so sort/pin
  don't refetch) + `teamSnapshot.team.phase` (a phase change = a run just stamped a new origin). Passive
  `users`-icon badge (span, not a button) on chat rows (`teamThreadIds[thread.id]`, incl. pinned section)
  and project rows (`teamProjectSet[root]`).
- **agent-window.css**: `.agw-rail-team-badge` (always-visible accent-tinted pill) + `.agw-rail-project-team`.

## Task (2026-07-02): Mic "dead after grant" fix + team-workspace verification — DONE (uncommitted)
User: (1) worried team runs against wrong workspace (saw IDE log dispatch on `aurora-testing` after moving
there post-spawn); (2) agent-window mic icon "dead" after granting access. tsc -b clean; eslint on my files
clean (the 2 AgentComposer set-state-in-effect errors are PRE-EXISTING, lines 436/452, not mine).
- **Workspace = CORRECT by design (verified end-to-end, no code change needed).** Team dispatch pins the
  project at send: `useAgentWindowSend` L442 `projectRoot = store.projectRoot` → `AgentService.updateConfig
  {workspacePath: projectRoot}` → agent-service L296 `workspacePath = config.workspacePath ?? global` →
  input.workspacePath → AgentRuntimeClient tool ctx `workspacePath` (L888) → team-agent-tools
  `requireRepoPath(ctx)` prefers `ctx.workspacePath`. So switching projects AFTER dispatch can't move a
  running team. The `[AgentService] … workspace: aurora-testing` log is just a later regular turn on the
  surface's then-current project (both IDE ChatPanel and agent window share `AgentService`), NOT the team.
  Only fallback (no ctx) uses IDE global `useWorkspaceStore.rootPath`.
- **Mic fix** (`useAgentSpeech.ts` + `AgentComposer.tsx`): recording logic is IDENTICAL to the working IDE
  `SpeechInputButton`, so the failure is environmental to the JS-created agent WebView. Root-cause candidates:
  the native mic auto-grant handler (`install_agent_media_permission_handler`) racing/ not-installed on the
  agent window → WebView2 mic request silently auto-denies → getUserMedia rejects → error only in a tooltip
  ("dead"). Fixes: (a) boot-effect guard now only consumes its one-shot AFTER `isAuroraRuntimeAvailable()`
  (was marking done even when the bridge wasn't up → never installed); (b) `actuallyStartRecording` now
  `await`s `ensureMicPermissionHandler()` JUST-IN-TIME before getUserMedia (idempotent; guarantees the
  handler is registered before the permission request); (c) console.warn/error on every failure branch
  (model-path/mediaDevices/validation/catch) for observability; (d) composer footer shows `Microphone: …`
  inline in `--agw-removed` instead of a silent tooltip. NOTE: the Rust command was added last session — if
  the running build predates it, a Rust rebuild (`pnpm tauri:dev`) is required for the handler to exist.

## Task (2026-07-02): REVERTED the "build in Rust" mic fix — it FROZE the app (uncommitted)
The build-in-Rust approach below DEADLOCKED the whole app: `open_agent_window` was a SYNC `#[tauri::command]
pub fn`, and per Tauri v2 docs *sync commands run on the MAIN thread*. `WebviewWindowBuilder::build()` there
blocks the event loop it needs to create the WebView → white agent window that won't even close, whole IDE
frozen. Context7 (`/websites/v2_tauri_app`) confirmed: "Commands not explicitly declared async run on the main
thread… async commands prevent UI freezes by executing on a separate task." Correct Rust way would've been
`#[tauri::command(async)]`, but JS `new WebviewWindow` is already a proven non-blocking creation path, so:
- **Reverted** `open_agent_window` + its lib.rs registration + `encode_query_value` (all removed from speech.rs).
- **window.ts** back to JS `new WebviewWindow` (+ `agentWindowUrl`/`AGENT_WINDOW_URL`), PLUS a non-blocking
  `install_agent_media_permission_handler` call right after `tauri://created` (from the IDE side) for early
  handler registration. `with_webview` is non-blocking (dispatches + returns), so calling the sync install
  command never freezes — only `build()` did. Handler now installed at 3 points: after-create, window boot,
  just-in-time before getUserMedia. cargo check + tsc -b + eslint all clean.
- User must FORCE-KILL the frozen app, then `pnpm tauri:dev` rebuilds/relaunches with the safe code.
- **Cache clear + stale-grant fix (user asked to clear the "deny cache"):** Two layers — (1) Aurora only
  stores `localStorage["aurora.speech.permissionGranted"]="true"` (a GRANT, never a deny); when set, the modal
  is skipped → goes straight to getUserMedia. (2) WebView2's native permission cache (the real deny) lives in
  `%LOCALAPPDATA%\com.aurora.agent\EBWebView` (holds perms + localStorage + cookies). Wiped that whole folder
  while the app was closed = clean slate. Code fix in `useAgentSpeech.ts::actuallyStartRecording` catch: on a
  real `NotAllowedError`/`SecurityError`, call `writeMicPermissionRemembered(false)` so the stale grant clears
  and the consent modal reopens on the next click (error copy: "Microphone access was blocked. Click the mic
  again to retry."). tsc + eslint clean.

## Task (2026-07-02): Mic notice = auto-dismiss + severity colours — DONE (uncommitted)
User: the "Microphone: CrispASR completed but did not return a transcript" line stayed forever under the
composer; wanted warnings in soft yellow, errors in red, both auto-clearing after ~5s.
- **useAgentSpeech.ts**: replaced the bare `error: string|null` with `notice: MicNotice|null` where
  `MicNotice = { text, severity: "warning"|"error" }`. New `showNotice(text,severity)` sets it + arms a 5s
  (`MIC_NOTICE_TTL_MS`) auto-dismiss (a newer notice replaces + restarts the timer); `clearNotice()` cancels +
  clears; unmount clears the timer. Severity map: config/too-short/"did not return a transcript" (regex
  `return(?:ed)? (?:a )?transcript|no speech|no transcript`) = warning; device-unavailable / getUserMedia
  denial (NotAllowedError/SecurityError, also clears the stale grant) / transcribe crash = error.
- **AgentComposer.tsx**: consumes `notice: micNotice`; tooltip uses `micNotice?.text`; footer renders
  `--agw-warning` (soft yellow) vs `--agw-removed` (red) by `micNotice.severity`, else the default hint.
- The Rust source of that transcript string: `src-tauri/src/commands/speech.rs` L712 (Qwen) / L762 (Crisp).
- tsc clean; my two files ESLint-clean. The 2 `set-state-in-effect` errors at AgentComposer.tsx L436/L452 are
  PRE-EXISTING (value-sync + file-index effects), not from this change.

## [SUPERSEDED — caused freeze, see above] Mic "Permission denied, no prompt" — build in Rust
User still hit `NotAllowedError: Permission denied` with NO prompt after the just-in-time install. Real root
cause: the lazy install can't win the race — `window.with_webview(...)` POSTS the COM `add_PermissionRequested`
registration to the main-thread event loop, so it can land AFTER the WebView's first `getUserMedia`, which then
auto-denies (and WebView2 caches the deny). The IDE main window + CLI agent_mode never hit this because they
install the handler synchronously at BUILD time in `lib.rs::setup`. The IDE-opened agent window was built from
JS (`new WebviewWindow`), so it only got the racy lazy install. cargo check + tsc -b + eslint all green.
- **Rust** `commands::speech::open_agent_window(app, workspace_root?)`: focuses an existing "agent-window" or
  builds it via `WebviewWindowBuilder` (route `agent-window?ws=<enc>`, 1200x800, min 820x560, center) and
  installs `webview_permissions::install_permission_handler(&window)` right after `.build()` — same timing as
  the proven CLI path. `encode_query_value` percent-encodes the `?ws=` value (RFC-3986 unreserved passthrough,
  else `%XX`), decoded back by the window's `URLSearchParams.get("ws")`. Registered in `lib.rs` next to
  `install_agent_media_permission_handler`.
- **window.ts** `openAgentWindow`: now just `auroraInvoke("open_agent_window", { workspaceRoot })` — dropped the
  JS `new WebviewWindow` + `agentWindowUrl`/`AGENT_WINDOW_URL`. Boot-effect + just-in-time installs KEPT as
  harmless fallbacks (double-registration is a no-op). `focus/closeAgentWindow` still use `getByLabel`.
- User action to see the fix: it's a Rust change → `pnpm tauri:dev` recompiles + restarts; then CLOSE the agent
  window and reopen so the new build-time-install path runs (an already-open window just gets focused).

## Task (2026-07-04): Team cap = workers + rail clip + team auto-scroll — DONE (uncommitted, FE-only, no Rust rebuild)
User: "3 workers" setting only spun 2 ("2 capped"); Lead couldn't state its cap; rail team-badge+spinner clip;
team chat not auto-scrolling. tsc -b + eslint (touched) clean.
- **Cap semantics**: "Maximum team size" historically INCLUDED the Lead (`icCap = maxTeamSize-1`, Rust `ic_cap=cap-1`).
  Relabeled to **"Maximum workers"** = IC count; the Lead is separate/always present. FE-only translation at the
  dispatch boundary: `team-agent-tools.runDispatch` now `workerCap = maxTeamSize`, staffs up to `workerCap`, and
  passes `workerCap + 1` as the runtime `maxSize` (Rust reserves the Lead slot → allows `workerCap` ICs). Stepper
  max = `TEAM_SIZE_HARD_CEILING - 1` (15). No Rust change needed.
- **Lead knows its cap**: `useAgentWindowSend` injects a `<team_policy>` block into ideContext when
  executionMode==="team" stating "staff up to N workers" from live `settings.maxTeamSize` — fixes the Lead
  guessing from the last dispatch echo.
- **Rail clip**: project-row always-on indicators (team badge + spinner + done-dot) were flush siblings (no gap).
  Wrapped in `.agw-rail-project-status` (inline-flex, gap 6px) in `LeftRail.tsx` + CSS; team-badge margin-left→0.
- **Team auto-scroll**: `TeamScreen` growthKey was `channel.length` only → didn't move during token streaming
  (drafts grow without changing channel length). Now folds live draft text+thinking length into growthKey.
- **Team bubble colors**: replaced `team-ui.authorColor`'s random hash-to-360 HSL (could land muddy/clashing)
  with a curated cohesive `WORKER_PALETTE` (8 hues, one lightness/saturation family, evenly spaced) picked
  deterministically per worker id; Lead still = `--agw-accent`, system = subtle. User chose "curated palette"
  over adding a settings knob. (No `--agw-*` semantic color scale exists to derive from — only `--agw-accent`.)

## Task (2026-07-04): Agent-window workspace-path swap on dev reload — FIXED (uncommitted, FE-only)
Bug: after a Vite dev reload the agent window UI still showed workspace A's chat, but sending a message ran tools
against workspace B (the IDE's last-opened folder). Root cause = TWO sources of truth + an ungated IDE bootstrap.
- **Lifecycle**: agent window = same bundle as IDE (`App.tsx`, route `/agent-window`). `AgentWindow` reads `?ws=`
  → `useAgentChatStore.init(A)` sets `projectRoot=A` (UI/display + per-turn pin) and `bindRuntimeWorkspace(A)`
  raw-setStates `useWorkspaceStore.rootPath=A`. Neither store is persisted; on reload both reset then re-derive.
- **The bug**: `App.tsx:79 useWorkspaceBootstrap()` ran UNCONDITIONALLY (its twin `restoreWorkspace()` at :98 is
  gated `!isAgentWindow`). In the agent window it `await`ed `databaseService.getWorkspaceState()` and
  `setRootPath(B)` (last IDE workspace) — landing AFTER the synchronous `bindRuntimeWorkspace(A)`, so rootPath
  deterministically ended at B. `projectRoot` stayed A → UI unchanged. Consumers reading `rootPath` directly
  (team `requireRepoPath`, `aurora-tools.readWorkspacePath`, `context-builder`, `agent-service` fallback) → B.
- **Where the path is persisted**: SQLite `workspace_state.workspace_path`, written by `setRootPath`→
  `useEditorStore.saveWorkspace()`, read back by `getWorkspaceState()`. The agent window should never touch this.
- **Fix**: gate BOTH `useWorkspaceBootstrap` and `useCliOpen` to no-op on `location.pathname === "/agent-window"`
  (early return inside each effect — hook call order stays stable). Now rootPath stays = projectRoot = A.

## Task (2026-07-04): Threads "moved" A→B — deeper cause + sticky scope — Rust FIX (uncommitted, needs rebuild)
Follow-up to the workspace-swap bug: whole conversations created in workspace A showed up under B. The FE gate
(prev task) removes the TRIGGER (rootPath drift), but the MOVE happened via a second mechanism in Rust.
- **Mechanism**: a thread's project scope (`SessionMetadata.workspace_root`) was RE-STAMPED every turn from the
  turn's `request.workspace_path` — in BOTH `ensure_thread` (agent_v2.rs:714) and `set_workspace_and_model`
  (agent_v2.rs:715). `model` was already sticky (`if meta.model.is_none()`), but `workspace_root` OVERWROTE. So
  any turn that ran with workspace B (during the rootPath-drift window) permanently flipped that thread's scope
  to B on disk; the list filter (`workspace_root == projectRoot`) then showed it under B.
- **Fix** (`session_store.rs`): made `workspace_root` STICKY in both fns — adopt a scope only when the thread has
  none yet (fresh, or legacy-unscoped adopting its first scope), NEVER overwrite an existing one. Scope now
  changes only via deliberate action, never as a turn side effect. Added tests
  `workspace_scope_is_sticky_and_never_moves_on_a_later_turn` + `legacy_unscoped_thread_still_adopts_first_scope`.
- **NOT auto-repaired**: threads already flipped to B keep `workspace_root=B` in their `<id>.meta.json` sidecar
  (app_data/agent_v2). These fixes stop FURTHER moves; they don't move leaked threads back (can't tell which
  B-tagged threads were originally A). Repair = rewrite specific sidecars or add a "move chat to project" action.
- **Rust change → needs `pnpm tauri:dev` recompile/restart** (frontend HMR won't pick it up).

## Task (2026-07-04): Team chat opens-at-top + empty-bubble flash + tool card auto-expand — DONE (uncommitted, FE-only)
Three agent-window UX fixes. tsc -b + eslint (touched) clean.
- **Opens at top / no auto-scroll on entry**: TeamScreen UNMOUNTS on leave + REMOUNTS on return (AgentShell:179
  `centerView === "team" ? <TeamScreen/> : <ConversationPane/>`); the scroller is rendered only once
  `initialized`. The old `useAgentAutoScroll` reset-snap ran in a POST-paint `useEffect` (visible top flash) and
  its scroll-listener/ResizeObserver bound once on hook mount — against a not-yet-present container. Fix
  (`useAgentAutoScroll.ts`): reset snap now in `useLayoutEffect` (pre-paint, no flash) + an `initialAnchorRef`
  window (800ms) that HARD-pins to bottom on any content growth even when idle (absorbs async markdown/highlight);
  scroll-listener + ResizeObserver effects gained `resetKey` dep so they re-bind when the scroller mounts. Cleared
  the anchor when the user scrolls up. TeamScreen `resetKey` now `${initialized?"ready":"load"}:${sel}` so the
  anchor re-fires when the scroller appears.
- **Empty "bubble" flash while loading**: added `TeamChatSkeleton` (shimmer placeholders, `.agw-team-skel*` CSS).
  Shown in the not-initialized+loading state, and in `MemberTranscript` until its FIRST `getAgentTranscript` pull
  returns (`loaded` state) instead of the "hasn't posted yet" empty flash (poll can take up to 800ms).
- **Tool card auto-expanded during run**: `ToolCallCard` `defaultOpen` was `running || failed` → cards expanded
  and showed raw args/stream while executing. Now `defaultOpen = status === "failed"` only (running/done collapse
  by default; click to inspect; manual `override` still wins).

## Task (2026-07-04): browser tools → single right-rail panel (no spawned windows) — DONE (uncommitted)
Agent was spawning standalone native browser windows (`browser_open` → `browser-agent-<uuid>`). The agent window
already has a dedicated embedded Browser panel in its right dock (`browser-agentwin`, host `agent-window`, built by
`BrowserPanel.tsx`). Reworked the agent browser surface to drive ONLY that panel.
- **Removed from agent roster**: `browser_open`, `browser_close`, `browser_list_windows` (window mgmt is meaningless
  with one browser). Roster now 6: `browser_navigate`, `browser_screenshot`, `browser_get_console_logs`,
  `browser_click`, `browser_fill`, `browser_scroll`. Structs kept (unregistered) for the human-driven IPC path.
- **Hard-pinned label**: all tools drop the `label`/`windowLabel` arg and target `AGENT_BROWSER_LABEL =
  "browser-agentwin"`. Descriptions rewritten to say "the agent window's right-rail Browser panel."
- **Auto-open coordination** (`browser/mod.rs::ensure_agent_browser`): Rust can't build the embedded webview (needs
  host bounds), so it emits `aurora:agent-open-browser` (new `BrowserManager::request_open_agent_browser` +
  `has_window`) and polls ~6s until the webview exists. Frontend `useAgentBrowserOpen` (mounted in AgentShell) listens
  and calls `openTab("browser")` → `BrowserPanel` mounts → builds `browser-agentwin`. `browser_navigate` then drives it.
- **Also updated**: system prompt browser section (`agent-prompt.ts`), approval groups (`ToolsSettings.tsx`), tests.
- Verified `cargo check --lib --tests` ✓, `tsc -b` ✓. Rust change ⇒ needs `pnpm tauri:dev` recompile.

## Task (2026-07-04): file_edit multi-FILE editing in one call — DONE (uncommitted)
Expanded the single `file_edit` tool to edit MANY files in one atomic call (was single-file only;
`multi_search_replace` had been folded away). No new tool — same tool handles single edit, batch-to-one-file,
and batch-across-files.
- **Contract**: `edits[]` items may now carry their own `path`; top-level `path` is the default (and is now
  optional — `required: []`). Single-edit form still requires top-level `path`.
- **Rust** (`file_edit.rs::run_batch`): group edits by resolved path (first-seen order); per-file read-before-edit
  guard; **two-phase atomic** commit — validate every file with `apply_multi_search_replace(write:false)`, and only
  if ALL plan cleanly do we commit each with `write:true`. Any failure ⇒ nothing written. 1 distinct file ⇒ reuse
  the existing single-file `render_response` (UI unchanged); >1 ⇒ new `{multiFile:true, files:[{path,fullPath,
  oldContent,newContent,linesAdded,linesRemoved}], filesEdited, totalReplacements}` shape.
  `SearchReplaceItem` gained `Clone` (needed for the two-phase re-plan). Failure/needs-read have multi-file
  renderers that name the offending file.
- **Frontend**: `tool-result.ts` parses `multiFile` results into new `diffs[]`; `review.ts` folds each file into the
  Review set; `ToolResultView.tsx` renders one labelled `DiffView` per file (`.agw-multi-diff*` CSS);
  `ToolCallCard` counts `diffs` in hasDetail + focuses the first file for Review.
- Verified: `cargo check --lib` ✓, `tsc -b` ✓, eslint(touched) ✓. Rust unit tests added (multi-file success,
  atomic-rollback-on-failure, top-level-path fallback). NOTE: Rust change ⇒ needs `pnpm tauri:dev` recompile.

## Task (2026-07-04): shimmer speed + file_edit missing-path error — DONE (uncommitted)
- **Shimmer too slow**: `.agw-shimmer` (running tool / reasoning label sweep) was 20s/pass → barely moved. Now 3s
  (`agent-window.css` ~1589). Compaction marker keeps its own slower 30s duration (separate, calm marker).
- **`file_edit` "`path` must be a string"**: agent tried multi-FILE edits by nesting a `path` inside each `edits`
  item; top-level `path` is required and per-item `path` is unsupported (single-file tool). Replaced the terse
  error with `missing_path_message()` in `file_edit.rs`: if any `edits` item carries a `path` → "edits ONE file
  per call … make a separate file_edit call for each file"; if edits present but no per-item path → names the
  top-level `path`; else plain. 3 unit tests added.

## Task (2026-07-06): Atlas Cloud provider + usage card — RESEARCH DONE, impl pending
Goal: add Atlas Cloud as a provider in the agent-window Providers page (`src/agent-window/settings/ProvidersSettings.tsx`);
clicking it shows a usage/quota card, below it the normal OpenAI-compatible add-model flow.
- **Verified API (live, with a real key)** — all `Authorization: Bearer <key>`; CORS is OPEN (reflects Origin
  `http://tauri.localhost`, allows `authorization`), so plain frontend `fetch()` works — NO Rust HTTP proxy needed
  (same pattern as `services/models-dev.ts`).
  - Chat (OpenAI-compat): `https://api.atlascloud.ai/v1` — `/v1/models` (132+ models), `/v1/chat/completions`.
  - Billing/usage PUBLIC API base: `https://api.atlascloud.ai/public/v1` (source: AtlasCloudAI/mcp-server
    `src/constants.ts`). Endpoints:
    - `GET /balance` → `{available,cash,bonus,subscription_bonus,frozen, credit_grant:{status,granted,used,
      remaining_overdraft,overdrawn}, account:{id,name,type}}` where money = `{value:"0.000000",currency:"usd"}`.
    - `GET /model-usage` and `GET /usage` → daily buckets of requests/tokens.
    - `GET /model-costs` → daily buckets of spend.
    - List params: `start_date`,`end_date` (YYYY-MM-DD, **required**, range ≤180 days), `scope=self|account`,
      `group_by[]=model_type|model|api_key`, `model_types[]`, `model_ids[]`, `limit`(≤1000), `page`. Response:
      `{object:"list",scope,data:[{object,date,start_at,end_at,partial,results:[...]}],has_more,next_page,request_id}`.
    - Error shape: `{"error":{"type","code","message","param"},"request_id"}`. `/meta` = null (not real).
  - Console billing URL (fallback deep link): `https://www.atlascloud.ai/console/billing`.
- **CODING PLAN findings**: the catalog exposes dedicated `*-coding` model variants (Anthropic Claude family):
  `anthropic/claude-opus-4.8-coding`, `claude-sonnet-4.6-coding`, `claude-haiku-4.5-20251001-coding`, etc.
  A coding-plan key returns `403 {"code":403,"msg":"invalid token for coding plan, this model not support coding plan"}`
  on `/v1/chat/completions` for non-entitled models. The billing PUBLIC API still authenticates fine for such keys.
  → USAGE IS RETRIEVABLE for coding-plan keys via `/public/v1/{usage,model-usage,model-costs}` (per-key daily buckets)
  and allowance via `/balance` (`subscription_bonus` + `credit_grant`). There is NO separate public "weekly prompt
  quota / requests-per-5h" endpoint and NO `x-ratelimit-*` headers were observed — that lives in the web console only.
- **Plan**: add `atlascloud` preset in Rust `provider_catalog/types.rs` (providerType "openai", base
  `https://api.atlascloud.ai/v1`, requiresApiKey true, seed strong coding models) + a frontend
  `services/atlascloud.ts` (typed fetch + period aggregation) + an `AtlasCloudUsageCard` rendered at the top of
  `ProviderDetail` when `provider.id==="atlascloud"` || baseUrl host is `atlascloud.ai`. Rust change ⇒ needs
  `pnpm tauri:dev` recompile.
- **CODING PLAN QUOTA — the real endpoint (KEY WORKS!)**: `POST https://api.atlascloud.ai/api/v1/codeplan/get`
  with `Authorization: Bearer <apikey>` (empty body, `content-length: 0`) → **200**. NO session cookie / NO
  `x-account-id` needed (the console uses cookie+x-account-id, but the API key alone works on both `api.` and
  `console.` hosts). GET = 404 (POST only). `x-api-key` header = 401 (must be Bearer). CORS OPEN for POST +
  authorization from `http://tauri.localhost`. Response:
  `{"code":"200","data":[{PlanName:"Plus",PlanType:"monthly",Price:"50",Status:"active",DailyQuota:"5500000",
  total_quota:"165000000",weekly_cap:"82500000",weekly_used:"0",weekly_remaining:"82500000",balance:"82500000",
  used_quota:"1424794.936",StartedAt:<ms>,ExpiredAt:<ms>,AutoRenewal,plan_uuid,SubscriptionID,AccountID,PlanID}]}`.
  Numbers are quota units (fractional used_quota ⇒ credit/weighted unit, not raw token count) — display as
  raw+percent. Empty `data:[]` ⇒ no coding plan (pay-as-you-go) → fall back to `/public/v1/balance` + costs.
  Card should call codeplan/get FIRST; coding-plan users see daily/weekly/monthly quota bars.
- **CODING PLAN HISTORY**: `GET https://api.atlascloud.ai/api/v1/codeplan/costs?pageNo=1&pageSize=N&startTime=<ms>&endTime=<ms>`
  with `Authorization: Bearer <apikey>` → **200**, CORS OPEN. Response:
  `{"code":"200","data":{"total":46,"pageNo","pageSize","items":[{finishTime:<ms>,chatId,model,modelCost:"7186.64",
  planId,amount:"7186.64",remain:"81075205.064",usage:{input,output,cache,amount:"0"},apikeyName:"AURORA"}]}}`.
  - **UNIT MODEL (verified)**: `modelCost`/`amount`/`remain`/`used_quota`/`total_quota`/`DailyQuota`/`balance` are all
    Atlas **credits** (weighted per model), NOT raw tokens. Real tokens live in item `usage.{input,output,cache}`;
    `usage.amount:"0"` = $ cost (plan-covered). Live remaining = `balance - used_quota` (== latest item `remain`,
    verified 82,500,000 - 1,424,794.936 = 81,075,205.064).
  - Both `codeplan/get` (POST) and `codeplan/costs` (GET) accept the API key on BOTH `api.` and `console.` hosts; use
    `api.atlascloud.ai` for consistency. Card: 1 `codeplan/get` for headline; page `codeplan/costs` for a period to
    aggregate tokens + per-model + recent-activity list.

## Task (2026-07-06): Atlas Cloud provider + usage card — IMPLEMENTED (uncommitted, FE-only, no Rust rebuild)
Shipped entirely in the frontend (CORS reflects origin + allows `authorization`, verified for BOTH `localhost:5173`
and `tauri.localhost`), so it hot-reloads — deliberately did NOT add a Rust preset/proxy. `tsc -b` ✓, eslint(new files) ✓.
- **credits→tokens (VERIFIED):** per-token multiplier = `price_per_1M × 1.815` (`CREDIT_PER_PRICE_UNIT`). Kimi K2.7 Code
  input $0.95→1.72, output $4→7.26 exactly match the console multiplier table. Console `GET /api/v1/models?sort=new`
  (Bearer key, 200) returns 414 models incl. 132 `type:"Text"` LLMs with `price.actual.{input,output,cache}_price`
  ($/1M) + `contextLength`/`maxCompletionTokens`. The card's "tokens left" prefers the account's OWN effective rate
  (Σcredits/Σtokens from `codeplan/costs`, incl. cache) so it reflects real usage mix; falls back to account-wide rate,
  then price-blend. `-coding` suffix is NOT required (user confirmed `zai-org/glm-5.2` works on the plan).
- **Files:** NEW `src/services/atlascloud.ts` (typed fetch: codeplan/get, codeplan/costs paged, balance, models;
  `isAtlasCloudProvider`, `deriveAtlasOrigin`, multiplier/rate/summary math, fmt helpers, `ATLAS_CLOUD_PRESET` w/ 12
  seeded coding models + real pricing). NEW `src/agent-window/settings/AtlasCloudUsageCard.tsx` (carousel: Plan ·
  Tokens left · Usage[24h/7d/30d] · Recent · By model; payg fallback via `/public/v1/balance`; idle/loading/error
  states). `ProvidersSettings.tsx` renders it at top of `ProviderDetail` when `isAtlasCloudProvider`. `useSettingsStore`
  injects `ATLAS_CLOUD_PRESET` right after `getPresets()` (covers fresh-install + merge paths). CSS `.agw-atlas-*`
  appended to `agent-window.css` (pure `--agw-*` tokens).
- NOTE: account `name` is "" via API key; card labels identity by the key name (`apikeyName`, e.g. "AURORA") from costs.
- Profile v4: tools list behind a collapse (.agw-profile-collapse); model names via prettyModel (catalog label else cleaned key); heatmap now FILLS the card (cols flex:1, cells aspect-ratio 1/1, radius 26%), Mon/Wed/Fri/Sun day rail, Less→More legend.

## Task (2026-07-09): Codex-as-provider feasibility (analysis only, no code)
User dropped opencode's Codex plugin into `codex-oauth/` (codex.ts + optional ws pool). Findings:
- opencode = OAuth PKCE (auth.openai.com, Codex CLI client id, localhost:1455 callback, device-code alt)
  + fetch shim rewriting /v1/responses → chatgpt.com/backend-api/codex/responses with Bearer + ChatGPT-Account-Id.
- Aurora's `openai-responses` Rust adapter ALREADY matches the Codex dialect (store:false, instructions,
  encrypted reasoning, codex temp-gating, base_url+/responses). Missing: OAuth token lifecycle (refresh ~1h),
  "Sign in with ChatGPT" UI, catalog preset w/ fixed model list. Plan: Rust codex_oauth module + CodexAdapter
  wrapper around OpenAIResponsesAdapter + preset. Endpoint is undocumented/personal-use-blessed — flag ToS.

## Task (2026-07-09): Codex (ChatGPT subscription) provider — DONE (uncommitted, needs Rust rebuild)
User: add Codex like opencode did, with an Atlas-style usage card; reuse existing machine auth if possible.
- **Auth (Rust `api/codex/auth.rs`)**: `~/.codex/auth.json` ($CODEX_HOME) is the SINGLE token store, shared
  with Codex CLI — existing CLI sign-in works with zero setup; Aurora's browser PKCE login (port 1455,
  Codex client id, `codex_cli_simplified_flow`) writes the same file; refresh is single-flight, re-reads
  inside the lock, WRITES BACK rotated tokens (CLI never breaks), and read-modify-writes raw JSON so
  unknown CLI keys survive. Logout deletes the file (UI confirms it signs out the CLI too).
- **Adapter (`api/codex/adapter.rs`)**: ProviderKind::Codex (id "codex") → reuses build_responses_body +
  drive_responses_stream; strips `max_output_tokens` (codex backend rejects it); headers Bearer +
  ChatGPT-Account-Id + originator "aurora" + session_id + OpenAI-Beta responses=experimental; POSTs
  https://chatgpt.com/backend-api/codex/responses; one forced-refresh retry on 401; friendly 429 copy.
- **Usage (`api/codex/usage.rs`)**: GET chatgpt.com/backend-api/wham/usage (same as codex CLI /status),
  defensive Value parse → {planType, primary/secondary windows (usedPercent, windowMinutes,
  resetsInSeconds), credits}. Commands: codex_auth_status/login/cancel_login/logout, codex_usage_get
  (commands/codex.rs, registered in lib.rs).
- **FE**: services/codex.ts (invoke wrappers + CODEX_PRESET: models gpt-5.5/5.4/5.4-mini/5.3-codex-spark,
  requiresApiKey:false, pricing pinned $0 so models.dev enrichment can't backfill platform prices);
  preset injected in useSettingsStore next to ATLAS; CodexUsageCard.tsx (sign-in states + window meters,
  rides .agw-atlas-* CSS + new .agw-codex-*); ProvidersSettings hides head + connection block for codex.
- **Verify**: tsc -b ✓; eslint (only the pre-existing ProvidersSettings set-state-in-effect) ✓;
  cargo check --lib --tests ✓; target/__verify_responses extended to mount api/codex → 76/76 pass
  (9 new codex tests). NOT verified live: needs `pnpm tauri:dev` rebuild → open agent window →
  Settings → Providers → Codex (user is signed in to Codex CLI, so card should show usage instantly).
- GitNexus MCP tools were not connected this session — impact/detect_changes not run; changes are
  additive (new module + registrations) with the only shared-symbol edits in api/client.rs detect/factory.
- **Live-test follow-ups (same day)**: (1) Codex chat WORKS end-to-end (user confirmed streaming +
  tools against aurora-testing). (2) Reasoning-effort 400 ("Unsupported parameter: reasoning_effort"):
  the composer effort picker ships Chat-Completions-dialect `customParams.reasoning_effort`, but the
  Responses API (codex + openai-responses) only takes nested `reasoning.effort`. Fixed in
  `build_responses_body` (responses.rs): after the custom-params merge, `reasoning_effort` is removed
  and folded into the `reasoning` object (user-explicit `reasoning` keys win; `summary:"auto"` added
  when supports_thinking so the thinking UI streams — FE turns thinking_enabled OFF for effort models).
  2 new tests; verify crate now 78/78. (3) Startup log "Failed to upsert provider model: FOREIGN KEY
  constraint failed" seen once on first run with the new preset — provider_models row raced the
  llm_providers row; benign after the provider row lands (models seeded fine on next boot) but worth
  a look if it recurs.
- **FK error ROOT-CAUSED + FIXED (not benign-raced as first noted)**: merge path in
  useSettingsStore.initializeFromDatabase seeded provider_models rows for NEW presets (codex) before
  the llm_providers parent row existed → FK 787. Fix: new-preset provider rows are now
  `databaseService.saveProvider`-persisted (non-custom, id not in DB) right before the model-seeding
  loop. Applies to any future preset too. tsc + eslint clean.
- **Header quota tooltip**: ContextRing.tsx — when the selected model is codex (`selectedModel`
  primitive selector startsWith "codex:"), the existing context tooltip gains a "ChatGPT plan"
  section: 5-hour + weekly rows ("N% left" colored by bandColor, mini bar, "resets in Xh Ym").
  Fetched on hover/focus via module-level `getCodexUsageCached()` (60s TTL, error → section omitted);
  no effect, no polling. Reuses .agw-ctx-* CSS. tsc + eslint clean.

## Task (2026-07-09): browser tools — fix wrong-page screenshots + full tool functionality + in-card image — DONE (uncommitted, needs Rust rebuild)
Symptom (user-observed): agent's `browser_screenshot` described a DIFFERENT page than the one visibly in the
right-rail Browser panel; caption showed `(0×0 px)`. Root-caused THREE compounding bugs, all in the
embedded-browser refactor that had only ever been `cargo check`'d, never run live:
- **Model never saw the image (primary hallucination cause)**: `conversation.rs::truncate_tool_content`
  clamps every non-read tool result to 8 KiB for MODEL history. `browser_screenshot` was NOT exempt, so the
  base64 was chopped mid-string → closing `</aurora_image>` dropped → provider adapter (`split_aurora_images`)
  couldn't split the image → model got a few KB of raw base64 as TEXT and "saw" nothing → described the page
  from prior context (the localhost landing page it was building). FIX: `truncate_tool_content` now returns
  early (untruncated) when `s.contains("<aurora_image ")`. Downscale bounds the size so this is safe.
- **Stale native frame**: Windows `ICoreWebView2::CapturePreview` returns the LAST PAINTED surface; a hidden
  webview (`IsVisible=false` — set on address-bar focus via `hideAgentBrowser`, and on dock-tab switch) stops
  compositing → returns the previous page's frame. `screenshot()` never showed/settled first. FIX: before
  native capture, `window.show()` + `sleep(180ms)` so a fresh frame composites. (Minor known glitch: if the
  agent screenshots while a non-Browser dock tab is active, the webview shows over it until next interaction.)
- **0×0 dimensions + full-res base64**: native path hardcoded width/height 0 and sent full-res base64. FIX:
  new `downscale_png` (added `image` crate, png-only) decodes → downscales to ≤1400px wide → re-encodes;
  real dims reported; `finalize_screenshot` base64s the DOWNSCALED png for the model.
- **In-card image (new UX)**: `finalize_screenshot`/`save_screenshot` write the downscaled PNG to
  `<app_cache>/aurora-screenshots/shot-<uuid>.png` (pruned >1h) and return `path`. Tool result header now
  carries `src`/`width`/`height` attrs (adapter ignores them, only reads media_type). MODEL copy keeps the
  full `<aurora_image>` block (vision). UI copy: `conversation.rs::screenshot_ui_payload` emits lean JSON
  `{"screenshot":{path,width,height,url}}` — NO base64 in the thread store. Frontend: `tool-result.ts` parses
  it into `ParsedToolResult.screenshot`; `ToolResultView` renders `<ScreenshotResult>` (thumbnail via
  `convertFileSrc(path)`, click → shared `AgentImageModal` preview — same viewer as chat images); `ToolCallCard`
  `hasResult` includes `screenshot?.path` so the card is expandable but still COLLAPSED by default. New
  `.agw-tool-shot*` CSS.
- **Remote IPC (fixes ALL other browser tools)**: `capabilities/browser.json` had NO `remote` field → in Tauri
  2, capabilities apply to LOCAL app URLs only, so external/localhost pages couldn't `invoke`
  `aurora_record_browser_result` / `aurora_record_picked_element` → `browser_get_console_logs` / `click` /
  `fill` / `scroll` / `get_dom` / inspector picks all timed out (30s) or returned nothing. FIX: added
  `"remote": { "urls": ["http://*","https://*"] }`. (The two record commands only relay data INTO Aurora; no
  fs/shell exposure, so acceptable.)
- Files: Cargo.toml (image crate), services/browser_runtime.rs (show+settle, downscale/save/finalize),
  tools/browser/mod.rs (result header src/w/h), agent_runtime/conversation.rs (truncate exemption +
  screenshot_ui_payload + 2 tests), capabilities/browser.json, tool-result.ts, ToolResultView.tsx,
  ToolCallCard.tsx, theme/agent-window.css.
- Verified: `cargo check --lib` ✓ (only a pre-existing unrelated dead-code warning), `tsc -b` ✓,
  eslint(touched) ✓. NOT verified live: lib test binary can't launch here (STATUS_ENTRYPOINT_NOT_FOUND, known
  ONNX-DLL env issue); new pure-fn tests compiled + traced by hand. Needs `pnpm tauri:dev` rebuild to confirm.

## Task (2026-07-09 cont.): browser screenshot — lean JSONL persistence + modal-behind-webview + close lag + reload — DONE (uncommitted, needs Rust rebuild)
Follow-ups after the first screenshot fix, from live use on GPT-5.5 (Codex):
- **Model coverage confirmed**: Codex/GPT-5.5 uses `api/responses.rs` (input_image) and openai_compat uses image_url — BOTH call the shared `provider_kernel_adapter::split_aurora_images`, gated on vision. So the screenshot reaches every vision provider, not just Anthropic.
- **Raw base64 shown on reload → FIXED**: persisted threads carry the MODEL-history copy, not the lean UI event. Two-part fix: (1) frontend `tool-result.ts::parseScreenshotResult` now handles BOTH the lean JSON (live) AND the raw `<aurora_image ... src=.. w.. h..>BASE64</aurora_image>` block (reload) — extracts `src`/dims/base64, renders the image, NEVER dumps base64; runs BEFORE the non-JSON code fallback. (2) **JSONL is now lean**: `conversation.rs::truncate_tool_content` LEANIFIES aurora_image results (`leanify_aurora_images`) — strips the base64 BODY but keeps the `src`/`width`/`height` header + caption, ONLY for blocks that HAVE a `src` (no-src = disk save failed = keep inline base64 as the only copy). The model gets the image back via `split_aurora_images` REHYDRATING from `src` (reads the PNG off disk at request-build time, `rehydrate_image_from_src`). Net: JSONL stores a path not megabytes, base64 isn't re-uploaded every turn, reload shows the image from the directory. Backward-compatible (old threads with inline base64 still render/send).
- **Prune is now count-based** (`prune_old_screenshots` keeps newest 300, was age>1h) so reloaded threads still find their PNGs days later. `ScreenshotResult` falls back to embedded base64 via `<img onError>` when the file is gone.
- **Image modal opened BEHIND the browser → FIXED**: the embedded browser is a native webview that paints above ALL DOM. `AgentImageModal` now `hideAgentBrowser()` on open / `showAgentBrowser()` on close (covers screenshot card, chat images, composer annotate). `showAgentBrowser` is now SELF-GATING (only shows when dockOpen && active tab is browser) so no caller can resurrect it over another tab.
- **Browser lingered ~1s after dock close → FIXED**: `AgentShell` keeps the inner panel FIXED-width during the close glide (only the outer clips), so the native webview's bounds never update → it floated until unmount. `RightDock` now hides the webview the instant `dockOpen` flips false (subscribes to dockOpen), not at `onTransitionEnd`.
- Files: api/provider_kernel_adapter.rs (rehydrate_image_from_src + split_aurora_images empty-body branch), agent_runtime/conversation.rs (leanify_aurora_images + truncate change + tests), services/browser_runtime.rs (count-based prune), agent-window: BrowserPanel.tsx (self-gating show + workspace import), RightDock.tsx (dock-close hide), AgentImageModal.tsx (hide/show browser), tool-views/tool-result.ts (parseScreenshotResult raw+JSON), tool-views/ToolResultView.tsx (base64 fallback + onError), ToolCallCard.tsx (hasResult base64).
- Verified: `cargo check --lib` ✓, `tsc -b` ✓, eslint(changed) ✓ (BrowserPanel has PRE-EXISTING react-refresh export warnings — it's a new/untracked file that already exported close/hide/showAgentBrowser; no new violations added). Rust lib test binary still can't launch here (STATUS_ENTRYPOINT_NOT_FOUND). Needs `pnpm tauri:dev` for live confirm.
- KNOWN residual: rail/webview close is now INSTANT hide (no linger) but not a bounds-glide synced to `railGlideMs` — if the abrupt hide vs the animated panel looks off, the next step is animating the webview bounds over the glide duration. Flagged to user.

## Task (2026-07-09 cont.): browser webview SLIDES with the rail glide (open/close) — DONE (uncommitted, FE-only, no Rust rebuild)
The embedded browser popped in/out statically instead of sliding with the right dock's open/close animation.
Root cause: the native webview can't be clipped by DOM `overflow`, and its bounds were synced from a
ResizeObserver on the FIXED-width inner (`.agw-shell-side-inner`), which never changes during the glide — only
the OUTER `.agw-shell-side` animates `width` (right-pinned inner revealed by its overflow clip).
- **Fix (BrowserPanel)**: `measure()` now anchors the webview's X to the ANIMATING outer's left edge
  (`el.closest(".agw-shell-side")`) while keeping width = the panel's fixed width — so the page slides in/out
  from the right WITHOUT reflowing. The ResizeObserver now ALSO observes that outer element, so it fires every
  glide frame and drives `setBrowserBounds` in lockstep with the rail (same proven path as drag-resize).
- **Close no longer instant-hides**: reverted RightDock's `!dockOpen` hide (it killed the slide-out). RightDock
  now only hides on TAB switch (`active !== browser`, instant, no glide). Dock close: the webview slides out
  with the rail, then unmounts (`onTransitionEnd` → dockMounted false) → BrowserPanel cleanup hides it.
- **Glide OFF (0ms) safety (AgentShell)**: a 0ms width change fires NO `transitionend`, so `dockMounted` would
  never reset and the dock content (native webview) would stay mounted/shown off-screen. Derived
  `dockContentMounted = railGlide ? dockMounted : dockOpen` (same for rail) so glide-off unmounts immediately;
  glide-on keeps the state-backed flag so content survives the slide-out. (Also fixes a latent original bug
  where glide-off left dockMounted stuck true after the first open.)
- Geometry note: `.agw-shell-side` = animating outer (overflow:hidden, transition:width, driven by
  Appearance→Motion `railGlideMs`); `.agw-shell-side-inner.agw-shell-side-right` = right-pinned fixed-width
  content. `closest(".agw-shell-side")` matches the OUTER (inner's class token differs), graceful fallback to
  body.left if not found.
- Files: BrowserPanel.tsx (outer-anchored measure + observe outer), RightDock.tsx (revert instant-hide),
  AgentShell.tsx (derived mounted flags). tsc ✓, eslint(changed) — only PRE-EXISTING set-state-in-effect
  (orig lines 95/98) + BrowserPanel react-refresh export warnings remain; no NEW violations. FE-only, hot-reloads.

## Agent Window — per-provider custom headers (2026-07-10)
- Added `CustomHeadersEditor` in `src/agent-window/settings/ProvidersSettings.tsx` (mirrors the existing
  `ExtraBodyEditor` "Extra request fields", but provider-level string key/value → `provider.customHeaders`).
  Rendered in the connection block after the API-key field. "Add header" appends a row; empty keys dropped.
- Pipeline already existed end-to-end — this was UI-only. `provider.customHeaders` → store config snapshot →
  `useAgentWindowSend` (customHeaders on providerConfig) → agent-runtime-client → Rust
  `provider_kernel/builders.rs::build_headers` (+ `provider_kernel_adapter.rs`) which inserts each header on
  top of the auth header. Applies to OpenAI-compat and Anthropic-compat formats. tsc ✓, FE-only, hot-reloads.

## Agent Window — model selector rebuild (2026-07-10)
- `src/agent-window/components/ModelSelector.tsx` rewritten: flat sorted list (was provider-grouped),
  richer rows, and merged reasoning config so it's the ONE place to configure a model.
  - **Sort button** in header cycles Recently added / Recently used / A–Z. Sort mode persists in
    localStorage (`agw:model-sort`); per-model usage recency in `agw:model-recent` (stamped on pick).
  - Rows enriched by joining `getAvailableModels()` (canonical, provider-ready gated) with the `models`
    slice for capabilities/reasoning/id. Shows **Vision** + **Tools** capability chips.
  - **Reasoning merged inline**: compact on/off switch (`.agw-mswitch`) + effort chip (`.agw-model-effort`,
    click cycles level) per row → writes `updateModel(id, { reasoning })`. Standalone `ReasoningPicker.tsx`
    DELETED and its `<ReasoningPicker/>` removed from `AgentComposer.tsx`.
  - Letter avatars replaced with a dedicated premium **model** glyph. Added glyphs to
    `shared/AgentIcon.tsx`: `model` (iso cube), `sort`, `eye`.
  - Popover widened 320→384px. All new CSS in `theme/agent-window.css` is `--agw-*` token-driven (no
    hardcoded colors).
- tsc ✓ project-wide (0 errors), eslint(changed) clean. Pre-existing set-state-in-effect errors in
  AgentComposer (lines 436/452) are untouched/unrelated. FE-only, hot-reloads.

## Agent Window — model selector follow-up (2026-07-10)
- Moved `<ModelSelector/>` from the composer TOP row into the BOTTOM-RIGHT action cluster (where the
  reasoning pill used to sit) in `AgentComposer.tsx`; top row now holds only `<ModePicker/>`.
- Popover now anchors `right:0` (transformOrigin right) since the trigger sits at the right edge.
- Trigger shows the selected model's reasoning **effort** inline (`.agw-model-trigger-effort`, accent chip)
  when reasoning is ON and the model exposes effort levels.
- REMOVED the box/cube "model" glyph (it copied the reference screenshot) from `AgentIcon.tsx` and dropped
  the avatar from both the trigger and the rows — rows are now clean text (name + caps + provider + reasoning
  controls). `sort` and `eye` glyphs kept. tsc ✓, eslint(ModelSelector) clean.

## Agent Window — composer layout prefs in Appearance (2026-07-10)
- Two new persisted prefs on `useAgentThemeStore` (partialized): `modelSelectorPosition: "top"|"bottom"`
  (default "bottom") and `showModeChip: boolean` (default true). Setters `setModelSelectorPosition` /
  `setShowModeChip`.
- Appearance settings (`AppearanceSettings.tsx`) → new **Composer** section: "Model selector position"
  (Top/Bottom segmented) + "Show mode chip" switch. Mode is still switchable via Settings → Agent
  (`AgentSettings.tsx` agentExecutionMode), so hiding the chip strands nobody.
- `AgentComposer.tsx` reads both prefs: renders `<ModelSelector align="left">` in the top row when
  position==="top", else `<ModelSelector align="right">` in the bottom-right cluster; `<ModePicker/>`
  only when showModeChip; the whole top row is omitted when it would be empty.
- `ModelSelector` gained an `align?: "left"|"right"` prop driving popover anchor (left:0 / right:0 +
  transformOrigin). tsc ✓ (0 errors); the only eslint errors are the pre-existing AgentComposer
  set-state-in-effect (now lines 441/457, shifted, untouched).

## Agent Window — prefs relocation + composer fix + rail project meta (2026-07-10)
- MOVED the Composer prefs (model selector position + show mode chip) OUT of Appearance INTO
  `PreferencesSettings.tsx` (Settings → Preferences, "Window" group). Store stays `useAgentThemeStore`
  (already persisted); only the UI section relocated. Appearance no longer references those prefs.
- FIX: hiding the mode chip collapsed the composer. The top control row is conditionally removed when
  empty, which dropped the editor's top padding. Added `hasTopRow` in `AgentComposer.tsx`; editor wrapper
  now uses `pt-3` when the top row is absent, `pt-1` when present. No more squeeze.
- LEFT RAIL two-line project rows (`LeftRail.tsx`): each project now shows a meta subtitle
  "N chats · <relative last-activity>" (e.g. "12 chats · 2d ago") via new `describeAge()` +
  `projectMeta` memo (non-archived count + latest updatedAt from allWithLive). Projects untouched ≥30d get
  `data-stale` → dimmed at rest, full on hover. CSS: `.agw-rail-project-text/-meta`, project-main is now
  two-line (min-height 34px); Archived header keeps its single-line flex via a scoped override.
- tsc ✓ (0 errors). eslint clean on all changed files except the pre-existing AgentComposer
  set-state-in-effect (now lines 444/460, shifted, untouched).

## Agent Window — mode folded into model picker + count dedupe (2026-07-10)
- REMOVED the standalone Agent/Plan chip (`ModePicker.tsx` deleted) and the `showModeChip` pref
  (dropped from `useAgentThemeStore` + Preferences). `modelSelectorPosition` pref stays.
- Agent/Plan now lives INSIDE the model picker (`ModelSelector.tsx`), reading the same
  `useSettingsStore.agentExecutionMode` / `setAgentExecutionMode` / `teamEnabled`:
  - Trigger pill gained a LEADING mode glyph (shield=agent/team, book=plan → warning-tinted via
    `.agw-model-trigger[data-plan]`), giving the bare trigger its identity.
  - Dropdown header now has a compact 2-segment Agent|Plan toggle (`.agw-model-mode/-btn`, agent=accent,
    plan=warning) where the "Model" title was; sort button kept.
- BUG FIX: model count was shown twice (header badge + footer). Removed the header `.agw-model-count`
  badge; count stays only in the footer ("N models · M providers").
- AgentComposer top band now only ever holds the model selector (when top-positioned); still always
  reserved (`.agw-composer-band` min-height, currently 24px). tsc ✓ 0 errors; lint clean except the
  pre-existing AgentComposer set-state-in-effect (now 439/455).

## Active task (2026-07-10): Agent-window end-to-end source audit
- Plan: trace the real UI → send hook → runtime/model loop → provider adapters → native tools →
  persistence/cancellation flow; run existing frontend/Rust checks; fix only confirmed root causes.
- Priority checks: re-entrancy and stop behavior, tool-result/model-history integrity, provider/model
  configuration, error recovery, reload persistence, workspace pinning, and important untested seams.
- Scope added from live report: MCP stdio startup failures currently collapse to a generic stdout-closed
  message because stderr is only logged, not retained; mid-turn injected text can overflow its timeline row.

## Review (2026-07-10): Agent-window end-to-end source audit
- Fixed listener cleanup/recovery, sticky thread workspace ownership, background injection routing, parallel
  approvals, stale-thread rendering, mid-turn injection wrapping, and injection persistence across reload/API history.
- MCP startup failures now include bounded stderr/stdout and process status; live probing identified the enabled
  PostgreSQL MCP's real failure as a refused local database connection rather than an unexplained stdout close.
- Replaced the false-green `read_lints` acknowledgement with real workspace TypeScript/Rust checks and explicit
  results. Verified 102 frontend tests, production build, targeted ESLint, Rust compile, and touched Rust formatting.

## Active extension (2026-07-11): diagnostics + command center
- Extend `read_lints` with Python project detection: prefer configured Ruff, otherwise run Python's native syntax
  compiler; keep commands fixed, workspace-scoped, and return real failures.
- Add one agent-window command center with fuzzy search across actions, settings, projects, and chats; persist a
  user-recorded keyboard shortcut in Preferences and expose quick layout/status toggles.

## Review (2026-07-11): diagnostics + command center
- `read_lints` now selects TypeScript, Rust, and Python checks; Python uses configured Ruff or native `compileall`
  syntax diagnostics, with explicit command output/failure instead of acknowledgements.
- Added the Ctrl+K command center across settings, projects, chats, dock tools, navigation, and quick switches;
  Preferences records and persists a replacement chord. Verified 104 tests, build, targeted ESLint, Rust check/format.

## Active task (2026-07-11): Appearance token wiring audit
- Trace each `AgentThemeTokens` field through CSS/component consumers and correct semantic ownership rather than
  changing labels to excuse wrong wiring. Confirmed elevated surfaces currently leak into quiet settings buttons.
- Confirmed `overlay` is misused as two dropdown fills while real modal scrims are hardcoded; `info` and
  `bubbleAssistant` have no effective consumer. Add precise per-control descriptions and a token-coverage test.

## Review (2026-07-11): Appearance token wiring audit
- Separated quiet/elevated/hover/chip ownership; all modal backdrops now consume `overlay`, dropdowns no longer do,
  and Info + assistant-message tokens have real rendered consumers. Added editable popover shadow.
- Every token row now explains its exact targets. Reset now restores syntax highlighting and panel motion too.
  Added regression coverage for all token consumers/owners; 107 tests, production build, ESLint, and CSS parse pass.

## Active task (2026-07-11): Tool UI + composer-chip fidelity
- Tool headers use one neutral inline glyph regardless of family; add restrained semantic tint/tile ownership and
  simplify shell results so command/cwd/timeout are not repeated above and inside the result panel.
- `@` picker serializes workspace-relative paths (OS drop/picker uses absolute paths), so the model does receive them.
  Bubble reconstruction loses root files/spaces; `/` chips disappear after Rust reload because only inspector chips persist.
- Persist exact file and command display metadata on the user `ConversationMessage`, then render the same composer pill
  family in the bubble. Keep directive effects in existing context/skill channels; metadata remains display-only.

## Composer typing assistance (2026-07-11): local autocorrect + inline completion
- New native Rust subsystem `src-tauri/src/typing_assist/` (engine.rs = one trie built from SymSpell's English
  unigram + a bigram index; correction via a native banded Damerau-Levenshtein walk over the same trie — NO
  external symspell crate; lexicon.rs = personal learning persisted to JSON; common_misspellings.rs = curated map).
  Modeled on the reference app at `C:\Users\Alvan\Documents\auto-correction-pvt-alvan` (TypeAssist) — that project
  was reference-only; we did NOT port C#, we reimplemented the experience natively. User explicitly rejected an
  AI/LLM engine — statistical only.
- Dictionaries ship as Tauri resources (`src-tauri/resources/typing-assist/*.txt`, BOM stripped, mapped in
  tauri.conf.json), copied to `%LOCALAPPDATA%/AuroraIDE/typing-assist/` on first activation (`paths::typing_assist_dir`).
  Engine lazily built (~200ms) on first toggle-on. Commands: `typing_assist_ensure_ready|query|correct|learn|
  undo_correct|flush` (state = `Arc<TypingAssistState>` managed in lib.rs).
- Frontend: `useAgentTypingStore` (4 independent persisted toggles: autocorrect/completion/nextWord/learn),
  `adapters/typing-assist.ts` (IPC), `hooks/useComposerTyping.ts` (ghost-text controller), wired into
  `AgentComposer.tsx` (a `data-ghost` span skipped by `serializeEditor`; → accepts ghost only when caret at end;
  autocorrect fires on boundary via execCommand so native Ctrl+Z survives; Backspace within 8s undoes+never-corrects).
  Preferences UI section added in `PreferencesSettings.tsx` (icon `type`). Defaults: all off except `learn`.
- Verified: `cargo check` clean; engine logic proven via a standalone `#[path]` harness (all cases pass, 199ms build).
  NOT yet verified interactively in the running Tauri WebView (ghost render / accept / in-DOM correction) — needs
  `pnpm tauri:dev`. Two pre-existing set-state-in-effect ESLint errors remain in AgentComposer.tsx (not from this work).

## Composer prompt-refine (2026-07-11): ✦ button rewrites the prompt via local llama.cpp
- Optional composer feature: a ✦ (sparkle) button rewrites the typed prompt clearer WITHOUT changing intent,
  fully local. Decision journey (important): rejected candle in-process AND crates (llama-cpp-2/llama-gguf/rig)
  in favor of **shelling out to the user's own prebuilt `llama-completion.exe`** — the user's insight "I have the
  exe, why use crates?". No server (avoids port conflicts), no C++ build, native GGUF tokenizer via `--jinja`.
- The exact clean one-shot invocation (validated on llama.cpp b9957): `llama-completion -m MODEL --jinja -sys SYS
  -p TEXT -st --no-display-prompt --color off -n N -c 8192 -ngl NGL --no-warmup`. `-st` = exits cleanly (modern
  `llama-cli` is conversation-only and refuses `-no-cnv`; `llama-completion` is the non-interactive tool). stdout =
  refined text + a trailing `[end of text]` we strip; logs → stderr. ~1.5s incl. load on GPU.
- Backend `src-tauri/src/prompt_refine/mod.rs` (RefineConfig/RefineState/validate/refine + cancel by request_id
  via a killable child registry) + `commands/prompt_refine.rs` (`prompt_refine_validate|run|cancel`). LENGTH GUARD:
  `MAX_INPUT_CHARS = 8000` (backend rejects; composer disables the button past it) so a pasted log can't overflow
  the 8192 context. `CREATE_NO_WINDOW` so no console flashes on Windows.
- Frontend: `useAgentRefineStore` (enabled/llamaDir/modelPath/device, persisted), `adapters/prompt-refine.ts`,
  `hooks/useComposerRefine.ts` (typewriter reveal + one-click undo via stored innerHTML; button phases
  idle→refining→refined). New `sparkle` glyph in `shared/AgentIcon.tsx`. Preferences section (folder/model pickers,
  device, Validate) in `PreferencesSettings.tsx`. Pills serialize to `@path` (what the agent gets anyway) and are
  preserved verbatim by the model; the visual pill flattens to text after refine.
- Verified end-to-end via standalone `#[path]` harness against the user's real model + b9957 build: validate ready,
  refine preserves `@src/auth.ts` + intent (1.73s), 18k-char input rejected. tsc + eslint clean. NOT yet driven in
  the live WebView (button/typewriter/undo). User's llama.cpp: `E:\llama-bin\llama-b9957-bin-win-cuda-13.3-x64`;
  test model: `C:\Users\Alvan\Documents\ALL-GGUF-MODELS\Aurora-ide\qwen-2.5-instruct\qwen2.5-0.5b-instruct-fp16.gguf`.

## Tool-call polish + durable composer pills (2026-07-11)
- Shell details suppress redundant generic command/cwd/timeout chips and render one focused `$ command` row,
  with cwd retained only as hover context. Tool icons remain naked and inherit the row's neutral color.
- Composer file pills snapshot title, serialized reference, and absolute path. File and `/` pills now flow through
  AgentService → runtime IPC → JSONL → DB projection → timeline and replay with the composer pill classes.
- `@` picker references remain workspace-relative in model text; OS-picked/dropped paths remain absolute. The model
  receives that `@path` text (not automatic file contents) and can resolve/read it with file tools.
- Review: 111 frontend tests pass (110 full-suite + the focused render regression added afterward), production build
  and touched-file ESLint pass, and `cargo check --lib --tests` passes. Rust test execution remains subject to the
  documented native test-binary DLL launch limitation; all Rust tests compile.

## Active: Preferences section restore (2026-07-11)
- Root cause: `useAgentUiStore` intentionally persisted nothing and defaulted `settingsSection` to `tools`, so
  generic Settings openers remembered only the current WebView session and reset to Tools after reload/reopen.
- Plan: add one failing store regression, persist only `settingsSection`, default first-run users to Preferences,
  then run the focused test, lint/typecheck, full tests/build, and refresh graphify.
- Implemented with the existing Zustand `persist` middleware and `partialize`; `view` and `centerView` remain
  transient, while generic openers restore the last page and explicit section openers update it.
- Review: regression passed, targeted ESLint + TypeScript passed, full suite 112/112 passed, and production build passed.

## Active: Bubble-pill alignment + skeleton token (2026-07-11)
- Screenshot confirms sent file pills align by their bottom edge instead of the surrounding text midpoint.
- The initial assistant skeleton incorrectly uses `surfaceElevated`; plan is to assert and switch it to a
  translucent `textSubtle` fill, and vertically center inline pills with the shared CSS rule.
- Implemented: `.agw-pill-inline` uses middle alignment; `.agw-skeleton span` uses `textSubtle` at a controlled
  parent opacity. Elevated surface no longer affects the pre-response placeholder.
- Review: focused token/bubble regressions, full 112-test suite, TypeScript, ESLint, production build, and graph refresh pass.

## Active: `file_edit` exact-match audit (2026-07-12)
- UI follow-up was stopped and its in-progress skeleton opacity change reverted at the user's request.
- Active `file_edit` routes through `editor_ops::plan_multi_search_replace`, which normalizes CRLF/LF on source,
  `old_string`, and `new_string` and restores the source convention. CRLF alone cannot explain an exact-match miss.

## Active: Agent response skeleton brightness tune (2026-07-11)
- Plan: validate where the pre-response skeleton is styled and reduce its brightness slightly without changing flow.
- Verified source: `src/agent-window/components/MessageBubble.tsx` renders the skeleton, and
  `src/agent-window/theme/agent-window.css` hardcodes the visual intensity.
- Implemented: lowered `.agw-skeleton` base opacity and reduced `agw-pulse` peak/trough values to make the placeholder
  less bright while keeping loading affordance visible.

## Active: Skeleton direction fix (2026-07-11)
- User requested directional shimmer; pulse animation felt wrong for pre-response loading affordance.
- Replaced `.agw-skeleton span` pulse with a dedicated gradient sweep animation moving left-to-right.
- Added reduced-motion fallback (`prefers-reduced-motion`) to disable the sweep for accessibility.

## Active: Skeleton static regression follow-up (2026-07-11)
- Issue repro: skeleton looked static/white after direction change on user environment.
- Used Graphify to re-validate ownership (`MessageBubble.tsx` render path + agent-window theme CSS).
- Fix: enforce `display:block` on `.agw-skeleton span` (width/height always apply), set initial
  background position, and remove reduced-motion hard stop so the sweep always animates for this placeholder.

## Active: Skeleton direction+brightness correction (2026-07-11)
- User feedback: sweep still felt reversed and placeholder still too bright.
- Adjusted shimmer travel to explicit left-to-right perception by flipping background-position keyframe direction.
- Dimmed the skeleton further by lowering container opacity and reducing center highlight contrast in the gradient.

## Active: Skeleton speed + Aurora shimmer parity (2026-07-11)
- User requested a tiny extra dim, extreme faster sweep, and Aurora-label shimmer parity with tool-call shimmer.
- Skeleton tuned down slightly again (`opacity` + lower center highlight contrast).
- Skeleton sweep speed set to 10x faster (`0.19s`), and model/Aurora streaming text now reuses `agw-shimmer`
  (left-to-right sweep style matching tool-call "Running..." labels).

## Active: Skeleton brightness + true left→right direction (2026-07-11)
- User: skeleton still too bright and moving the wrong way. Root cause: `.agw-skeleton span` keyframe swept
  `background-position` `-200% → 200%` (right→left), the OPPOSITE of the working `agw-shimmer` reference (`200% → -200%`).
- Fix in `src/agent-window/theme/agent-window.css`: reversed `agw-skeleton-sweep` to `200% → -200%` (initial pos `200%`)
  so it matches the tool-call "Running…" sweep; dimmed via container `opacity 0.64 → 0.42` and highlight
  center stop `var(--agw-text) 45% → 24%` (outer stops `72% → 55%`).
- Verified: `appearance-token-coverage.test.ts` still passes (skeleton keeps `--agw-text-subtle`, no `--agw-surface-elevated`).

## Active: AURORA label sweep (kill pulse) + skeleton extra dim (2026-07-11)
- User: AURORA streaming label reads as a pulse (should sweep like the tool "Running…" label); skeleton still too bright.
- AURORA label (`MessageBubble.tsx:323`) already used `.agw-shimmer` (same class as `ToolCallCard` "Running…"). Root cause of
  the pulse: `.agw-shimmer` had a WIDE bright zone (`text-subtle 20% → text 50% → text-subtle 80%`) on a 200% canvas, so on a
  short word the whole word brightens/dims instead of a highlight travelling.
- Fix (`agent-window.css`): rewrote `.agw-shimmer`. IMPORTANT gotcha: `background-size:300%` STILL pulsed — at 300% the
  bright band parks OFF the word at both position extremes, so you only see it cross the centre = brighten/dim pulse.
  Correct geometry is `background-size:200% 100%; background-repeat:no-repeat` with a narrow highlight (`subtle 45% → text 50%
  → subtle 55%`) and keyframe `100% 0 → 0 0`: at 200% the band stays ON the word and sweeps left-edge → right-edge (true
  directional sweep). Applies to ALL shimmer labels (AURORA, Running, Thinking, team names) = the parity the user asked for.
- Follow-up: even after the 200% fix, ONLY the AURORA label still faded before the right edge. Cause was NOT the animation:
  the label `<span>` is a direct child of `agw-msg-assistant` (`display:flex; flex-direction:column`), so `align-items:stretch`
  stretched it to the FULL message width (~360px) while "AURORA" only fills ~70px. The 200% shimmer canvas was then sized to
  the whole row, so the sheen swept mostly over empty (text-clipped, invisible) space and faded before the visible right edge.
  Fix: `alignSelf:"flex-start"` on the label inline style (`MessageBubble.tsx`) → span shrinks to text width, sweep spans the
  glyphs. Other shimmer labels were unaffected because they live in shrink-to-fit (inline / flex-row) contexts.
- FINAL `.agw-shimmer` settled state: symmetric gradient `text-subtle 0/28% → text 50% → text-subtle 72%/100%`,
  `background-size:200% 100%`, TILING (no `no-repeat`), keyframe `200% 0 → 0% 0` (DECREASING position = left→right; one full
  200% period = seamless single sweep, no pop), `animation: agw-shimmer 2.5s linear infinite`. Gotchas learned:
  no-repeat causes a hard reset/pop; INCREASING position reverses direction; scrolling a 400% (2×) period runs ~4× too fast.
  Speed is just the duration (2.5s) — tune that number alone.

## Active: Shimmer inventory → Appearance setting (2026-07-11)
- Ground-truth catalog of ALL agent-window shimmers written to `DOCS/agent-window-shimmer-inventory.md` (11 places).
- Two families: (A) shared `.agw-shimmer` text sweep — AURORA label, "Thinking…", tool "Running…", team member name,
  compaction chip (chip overrides duration to 30s); (B) standalone — model-chip name (`agw-model-name-shimmer` 2.4s) +
  icon shine (`agw-model-icon-shimmer` 1.9s), pre-response skeleton bars (`agw-skeleton-sweep` 1.6s), team/atlas skeleton
  lines (`agw-skel-shimmer`/`agw-atlas-shimmer` 1.4s), speech recording visualizer (`agw-mic-sweep`).
- NEXT (planned, not started): an Appearance setting to control these (speed/intensity/reduced-motion). Family A is already
  unified so one knob covers it; reduced-motion already neutralizes the model chip only — a global toggle should cover all.

## Convention: popover role token `--agw-popover-surface` (2026-07-11)
- Context-window tooltip (`ContextRing` → `.agw-ctx-card`) didn't match the composer surface once themed. Rather than couple
  the tooltip to `--agw-composer-surface` (a leaky one-off), adopted a 3-tier token pattern (user chose this).
- Added Tier-3 role alias in `.agw-root` (agent-window.css:19): `--agw-popover-surface: var(--agw-surface-elevated);`.
- Routed the GENERIC floating-popover family through it (all marked by `--agw-shadow-pop`): `.agw-menu` (model selector,
  glass mix), `.agw-addmenu` (+ dropdown), `.agw-br-suggest` (browser suggestions), `.agw-ctx-card` (context tooltip).
- Deliberately NOT changed: the composer `@`/`/` picker (~line 3341) — it's a separate "composer sub-family" tinted from
  `--agw-composer-surface` on purpose. Rule of thumb: map surfaces by ROLE, not by resemblance to a neighbor component.
- To retheme all popovers at once, edit `surface-elevated` (or later promote `--agw-popover-surface` to a real store token).

## Convention: modal scrim role token `--agw-modal-blur` (2026-07-11)
- Bug: setting the "Modal backdrop" (`--agw-overlay`) token transparent left the delete-confirmation modal with NO backdrop,
  while the command center still showed one. Root cause: a modal's backdrop PRESENCE comes from `backdrop-filter: blur()`,
  not the `overlay` tint. Command center + mic-permission had blur; confirm dialog + image preview did NOT.
- Fix (same role-token pattern as popovers): added `--agw-modal-blur: blur(8px) saturate(0.85);` in `.agw-root`
  (agent-window.css:26) and routed ALL FOUR full-window modal overlays through it — `.agw-img-overlay`,
  `.agw-confirm-overlay`, `.agw-mic-perm-overlay`, `.agw-command-overlay` (each `backdrop-filter` + `-webkit-` = the token).
- Result: every modal has a backdrop by DEFAULT (the blur), consistent with the command center; `--agw-overlay` now only
  TINTS on top. NOTE: the AppearanceSettings hint for `overlay` ("The full-window scrim behind dialogs…") is now slightly
  inaccurate (it's the tint, not the scrim presence) — candidate copy tweak if revisited.
- Left untouched (NOT modal scrims): `.agw-menu`/composer-picker glass (blur 24px) and other panel blurs.

## Question panel (`ask_question`) polish (2026-07-11)
- `.agw-qp` fill now tracks `--agw-composer-surface` (was surface-elevated) — it's part of the composer stack (tucks behind
  the composer), softened toward `--agw-conversation` for the seam. Composer-family, not popover-family.
- `.agw-qp-other` input: removed the `box-shadow` focus RING (it was the only text input ringing on `:focus`); now matches
  `.agw-set-input` convention (default `--agw-border` → focus `--agw-border-strong`, no halo). Option BUTTONS keep their
  `:focus-visible` ring (keyboard-only) — that's correct; only text inputs go ringless.
- Open/close animation: a CSS `translateY` transform read as "not smooth like the task list." The whole window animates
  SIZE, not transform (task panel + rail sections use Framer `height:0→auto`; rail open/close uses a CSS width transition).
  FINAL: `QuestionPrompt` wraps the card in Framer `AnimatePresence` + `motion.div` (`height 0→auto`, opacity, `exit height 0`,
  `0.22s ease [0.16,1,0.3,1]`) — same as the task panel, so it glides open and collapses closed behind the composer.
  The composer tuck (`-12px`) + `overflow:hidden` now live on the motion wrapper; `.agw-qp` card keeps `margin:0 auto` +
  `padding-bottom:12px`. Removed the old `agw-qp-rise/-fall` keyframes and the `shown`/`closing` manual state.
- FOOTER redesigned: the full-width `.agw-qp-foot` (giant Skip/Continue bar) is GONE. Skip (✕) and Continue (✓, accent-tinted)
  are now compact `.agw-icon-btn`s in the header (`.agw-qp-meta`), with a `.agw-qp-sep` before the collapse chevron.
  Composer `.agw-ce` min-height 44→24 experiment was REVERTED (user said misread).

## Shell tool card — command row height (2026-07-11)
- Symptom: `shell_execute` card "renders the entire response" / expands huge. Root cause was NOT the output (that's capped:
  `.agw-rv-body` 280px, `ShellOutputView` trims to 600 lines/60k chars). It was the COMMAND row: `.agw-shell-command code`
  used `white-space:pre-wrap` with no height cap, so a long command wraps into many vertical lines and balloons the card.
- Fix (`agent-window.css`): `.agw-shell-command code` → `flex:1; min-width:0; line-height:1.5; max-height:54px (~3 lines);
  overflow-y:auto` + thin scrollbar; row `align-items:baseline`→`flex-start` so the `$` stays pinned while the command scrolls.
- Reminder: whole `src/agent-window/` is UNTRACKED (not in HEAD) — no git baseline to diff against for regressions here.

## Tool dropdowns — lock area + scroll-aware bottom fade (2026-07-11)
- Grouped run (≥6 calls, e.g. 10-file edit) used to balloon the message. `ToolGroup.tsx` inner body now gets class
  `agw-tool-group-body` (only when `grouped`) → `max-height:400px; overflow-y:auto` = a fixed "lock area" the cards scroll in.
  Also capped `.agw-multi-diff` (single multi-file-edit call that stacks one diff per file) at 400px scroll.
- Bottom scroll fade on EVERY tool-dropdown scroll body (`agw-tool-group-body, multi-diff, rv-body, tool-result, diff,
  diffview, tool-stream, shell-command code`). Implemented SCROLL-AWARE via `@keyframes agw-scroll-fade-b` +
  `animation-timeline: scroll(self block)` (longhands, `animation-duration:auto`): fade present while more-below, retracts to
  nothing at the bottom, and NO fade when content fits (timeline inactive). Non-SDA engines no-op (graceful). Chose this over a
  static `mask-image` because static dims short/non-overflowing content wrongly.

## Failed-tool auto-expand + multi-edit raw-JSON fixes (2026-07-11)
- Failed tool cards stayed expanded (annoying when loaded from history). `ToolCallCard.tsx`:
  `defaultOpen = status === "failed"` → `status === "failed" && isActivelyStreaming`. Live failure shows its error; a
  history-loaded (or turn-ended) failed card collapses like the rest.
- Multi-file "Edit File" result rendered as RAW JSON. Root cause: parser only fired its multi-file branch on
  `parsed.multiFile === true`. Live Rust `render_multi_success` (file_edit.rs) DOES emit `multiFile:true`+`oldContent` (works),
  but a compacted/history-loaded result was `{files:[{fullPath,linesAdded,linesRemoved,newContent}]}` (no `multiFile`, no
  `oldContent`) → fell through to the raw-JSON dump (tool-result.ts:493).
- Fix (`tool-result.ts`): branch now fires on any `files[]` whose items carry `newContent`/`oldContent` (or `multiFile:true`).
  Both sides present → real red/green diffs (`out.diffs`). Only `newContent` → render the resulting file syntax-highlighted
  via `out.code`/`out.codePath` (single) or concatenated with `// ── path ──` headers (multi). Never raw JSON. Always sets
  `stat` (+N/−N) + summary. Non-edit `files[]` (grep paths = strings, multi_file_read = `content`) don't match → safe.
- NOTE: red/green needs `oldContent`; a history result that dropped it shows the after-file instead. If red/green in history
  is wanted, the persisted result must keep `oldContent` (producer/persistence trace not yet done).
- Ran `pnpm tauri build` after these (user request).
- Skeleton token color IS theme-driven: bars derive from dark theme `text:#ededed`/`textSubtle:#727272` (`themes.ts`) via
  color-mix — not hardcoded white. Dimmed further: container `opacity 0.42→0.30`, highlight `text 24%→14%`, edges `subtle 55%→40%`.
- Verified: token-coverage test still 4/4 pass.

## Active: batch `file_read` Windows-path corruption (2026-07-13)
- Reproduced the failure boundary in `api/provider_kernel_adapter.rs`: streamed tool arguments are decoded with plain
  `serde_json::from_str`. An unescaped absolute Windows path can therefore turn `\r`, `\n`, or `\t` path prefixes into
  control characters, while prefixes such as `\U` make the complete tool input invalid.
- Scope is native tool-input parsing plus regression tests for `path` and `paths`; no agent-window UI or theme changes.
- Plan: normalize only absolute Windows path JSON strings before decoding, preserve already-correct doubled backslashes,
  compile/test the focused Rust target, then update graphify.

### Review
- `parse_tool_input` now repairs odd backslash runs only inside unmistakable drive-letter path strings before JSON decoding.
  This covers both `path` and every entry in `paths`, including sequences that previously decoded as CR/LF/tab.
- Added regression cases for a single raw Windows path, a two-path batch, and already-correct paths plus ordinary `\n`
  content. `cargo check --lib --tests` passes; the filtered test binary compiled but cannot launch because of the repository's
  known Windows native-link failure (`STATUS_ENTRYPOINT_NOT_FOUND`). No UI files were touched.

## Task (2026-07-16): Finish manual `/compact` command — DONE (uncommitted)
- Completed the partial cross-boundary flow: slash action → composer handler → agent-window send hook → AgentService/runtime
  client → `agent_compact_thread` → forced Rust compaction, persisted marker, live compaction card, and context-ring update.
- Fixed the incomplete client implementation that referenced nonexistent listener/request methods and would wait forever for
  `agent_turn_complete`; manual compaction now resolves from its own IPC result while routing scoped compaction events.
- Cleared the two Rust compiler warnings by removing the unused workspace predicate and unnecessary mutable test binding.

### Review
- Verified 119/119 frontend tests, TypeScript build, targeted ESLint, production frontend build, and `cargo check --lib --tests`.
- Rust sources are warning-free; the only remaining cargo warning is emitted by third-party `esaxx-rs` passing `-std=c++11`
  to MSVC, outside Aurora source.

## Analysis (2026-07-16): Rich live tool-execution narration
- The runtime already emits distinct argument-stream, tool-ready, execution-start, approval, and execution-result signals.
  The agent window discards those distinctions: its local ToolCall stores only name/arguments/result and infers three states,
  so preparing, approval, and executing all render as the same `Running…`.
- Presentation logic is split across `activity.ts`, `tool-display.ts`, `ToolCallCard.tsx`, and `tool-result.ts`; coverage is
  strongest for file/search/shell results and generic for several browser/process/editor tools.
- Recommended first implementation: preserve lifecycle phase in the existing frontend ToolCall and render deterministic,
  tool-aware phrases from current name/args/events. Do not parse model prose or add phrase fields to every tool schema.

## Task (2026-07-16): Reveal tool target while the model is still emitting
- Reuse the existing completed-state file icons and target labels as soon as partial tool arguments expose a path, command,
  query, process, or browser target; cover the complete native tool roster without changing the Rust protocol.
- Keep the change inside the existing agent-window presentation path, add one focused regression check, then verify the
  TypeScript/lint/test surfaces and the running agent-window behavior.

### Review — DONE
- Partial argument objects now retain completed paths, arrays, commands, queries, URLs, selectors, and process identifiers,
  so the live header and tool card reveal their real target before a large trailing payload finishes streaming.
- Tool action glyphs now follow the QuantumHUB bare 16px/1.5px house style with distinct browser, process, diagnostics,
  task, and workspace actions; `Read File` uses a document-plus-magnifier while extension-aware file chips stay unchanged.
- Verified in the running Aurora window, 134/134 frontend tests, targeted ESLint, TypeScript through the production build,
  `git diff --check`, and a successful production frontend build.

### Reality change
- A live KAT `file_write` still rendered `Writing…` while its task panel already showed `Creating store-crud.test.ts`.
  The earlier fix only helps when the model serializes `path` before the large `content` field; field order is not reliable.
- Re-opened the task: trace the actual streamed argument order and add an earliest-reliable filename source rather than
  assuming every provider follows JSON-schema property order.

### Reality change — live verification and disk hydration
- The current KAT session proved the native schema was reaching the model with alphabetically sorted properties:
  persisted `file_write` inputs were serialized as `content,path`, so a large body could finish before the filename arrived.
  Enabled `serde_json/preserve_order`, documented `path`-first writes, and added `target_paths` as early UI metadata for
  multi-file edits.
- Completed write cards leaked `File written: E:\...` from the result message. The chip already owns the filename, so
  result summaries now suppress messages that repeat a relative or absolute target path.
- Disk-reloaded edit results exposed raw JSON because model-history persistence blindly cut non-read results at 8 KiB in
  the middle of `newContent`/`oldContent`. Future history now keeps valid JSON and shrinks only payload strings; existing
  broken entries recover diffs from the saved tool arguments or source content from the truncated fields.
- Batch reads previously discarded each `files[].content` in the UI parser. The rich result now retains and renders every
  file as a basename-labelled, extension-aware syntax-highlighted code block.

### Review — implementation complete, manual verification handed to user
- Live target contract: `serde_json` now preserves schema insertion order, `file_write` advertises `path` before `content`,
  and multi-file `file_edit` exposes an early `target_paths` list. The frontend also parses incomplete path strings and
  renders every edit target as a wrapping horizontal chip row.
- Toolbar privacy/polish: visible chips always use basenames and extension icons; completed and failed summaries suppress
  full target paths instead of showing `E:\...`.
- Disk hydration: large persisted JSON results shrink content fields without breaking the envelope. Already-saved broken
  read/edit results recover highlighted source or argument-backed diffs, and batch reads render each file's syntax content.
- Verification completed: 143/143 full frontend tests passed before the final basename failure-summary regression; the
  final focused suite passed 25/25, targeted ESLint and TypeScript passed, the production frontend build passed, Rust
  `cargo check --lib --tests` passed, touched Rust files passed rustfmt, and the final Tauri dev binary linked and launched.
  Rust test execution remains blocked by the known Windows `STATUS_ENTRYPOINT_NOT_FOUND` test-binary issue. Per user request,
  the final visual/manual product verification is intentionally left to the user.
- Ran `graphify update .` after the implementation. The Codex-started Tauri dev process tree was stopped before handoff.

## Artifact Canvas implementation (2026-07-17)
- Added a thread-owned artifact sidecar contract with immutable backend-generated `v1`, `v2`, … snapshots and persisted artifact/version selection.
- Wired the frontend `present_artifact` bridge to the existing right dock; current conversations open Canvas, while background conversations save without stealing focus.
- Added sandboxed HTML/SVG preview, native Markdown rendering, source view, artifact/version controls, restoration, and deletion ownership.
- TypeScript compilation and renderer tests pass; Rust compiled, but the Windows test executable hit the known `STATUS_ENTRYPOINT_NOT_FOUND` loader failure before tests could run.
- Manual QA startup note: `scripts/tauri-dev-stable.mjs` fails at `spawn pnpm.cmd` with Node 22 `EINVAL`; use direct `pnpm exec tauri dev` for this verification rather than changing the unrelated launcher.

### Review — Artifact Canvas complete
- Verified 149/149 frontend tests, targeted ESLint (zero errors), TypeScript, production build, `cargo check --lib --tests`, touched Rust formatting, and `git diff --check`.
- Rust unit-test execution remains blocked before test startup by the known Windows `STATUS_ENTRYPOINT_NOT_FOUND`; Rust library and test targets compile successfully.
- Manual desktop inspection was handed to the user; the Codex-started Tauri process tree and orphaned linker were stopped so they cannot conflict with the user launch.
- Ran `graphify update .` after the final implementation.

## Dev startup asset generation (2026-07-17)
- Removed unconditional icon regeneration from `dev` and `build`: all 2,677 generated Material/VS Code SVGs are committed, so rewriting them on every launch was redundant and generated unnecessary filesystem activity.
- Added explicit `pnpm icons:sync` for dependency/icon-theme updates. The reported long Tauri wait remains Rust compilation/linking, which runs concurrently after the icon script finishes.

## Agent Window interaction repair (2026-07-17)
- Fix the shell divider so pointer capture survives crossing the Canvas iframe and every release/cancel/blur ends the drag.
- Preserve a usable conversation width and make the composer size against its column rather than viewport breakpoints.
- Replace Canvas native Artifact/Version selects with the shared Aurora custom selector architecture.
- Keep Canvas visibility and expansion user-owned: conversation loading restores data only, while new presentations may reveal Canvas compactly without forcing expansion.

### Review — Canvas interaction and revision workflow complete
- Canvas now uses captured, defensively terminated divider drags, a protected conversation minimum, responsive composer controls, custom Aurora selectors, and a dedicated non-expandable chat launcher.
- Canvas remains closed when a user left it closed, never restores or forces expanded mode, and new/updated artifacts reveal only the compact dock.
- Added atomic exact-text patch revisions that still persist complete immutable snapshots, plus `read_artifact` for full historical source or focused line-numbered excerpts before patching.
- Verified 154/154 frontend tests, targeted ESLint, TypeScript/production build, Rust `cargo check --lib --tests`, rustfmt, and `git diff --check`; manual visual QA remains with the user by request.

## Canvas launcher visual correction (2026-07-17)
- Replaced the generic prompt-refinement sparkle with Aurora's existing `panel-right` glyph in both the chat launcher and Canvas dock tab; removed the decorative icon tile.
- Removed the hover translation and gradient swap, using the standard flat hover surface and an inset focus ring so the control cannot lift into or clip against its message container.
- Focused launcher tests, targeted ESLint (zero errors), CSS parsing, and the production build pass; visual confirmation remains with the user by request.

## Active: first-class Canvas diagrams (2026-07-17)
- Mermaid 11.12.2 is already installed, so reuse it rather than adding Excalidraw or building a diagram engine. Add `mermaid` as a persisted artifact kind across the tool, frontend, and Rust contract.
- Render Mermaid lazily in a dedicated Aurora diagram viewport with strict security, theme tokens, pan/zoom/fit, grid, clear error states, Source mode, immutable versions, and the existing exact-text patch flow.
- Keep the first version agent-authored and view-focused; do not add a parallel mutable drawing document or duplicate persistence system.

### Reality change — artifact patch overlap diagnostics
- Live agent feedback exposed that sequential patch mutation can erase a later overlapping `find`, which is then falsely reported as absent even though it exists in the saved base.
- Preflight every patch match against the unchanged base, reject intersecting ranges atomically, and name both conflicting patch indices before applying any replacement.

### Review — diagram artifacts, safe revisions, and timeline seams complete
- Added a first-class immutable Mermaid artifact kind with lazy strict-mode rendering, Aurora theme tokens, responsive pan/zoom/fit controls, source inspection, and diagram-specific size/error handling.
- Patch revisions now plan every match against one unchanged base, reject overlap/dependency/ambiguity/no-op/stale cases actionably, and preview Mermaid patches through the same Rust engine before syntax validation and commit. Invalid updates never create a version.
- Reasoning and grouped-tool headers now share a restrained Aurora-token divider inspired by the supplied reference while preserving the existing icons, chronology, collapse state, focus behavior, and responsive layout.
- Focused frontend regressions passed 25/25 before the final input/no-op guards; final TypeScript and targeted ESLint are clean, Rust test targets compile, and Rust execution remains blocked before the harness by the known Windows `STATUS_ENTRYPOINT_NOT_FOUND`. Runtime/visual verification remains with the user as requested.
- Handoff state: the user is running `pnpm dev`; do not launch, stop, reload, or otherwise interfere with that session. The user owns final runtime and visual acceptance.

## Active: harden `file_read` single/batch input contract (2026-07-18)
- Make the Rust-owned model schema distinguish one-file `path` calls from non-empty multi-file `paths` calls and document that the forms must never be combined.
- Defensively recover the observed `path` plus empty `paths` payload as a single-file read, while rejecting genuinely ambiguous or malformed combinations with actionable errors.
- Add focused regressions for the emitted schema and executor behavior, then compile the Rust test target and refresh the project graph without touching the user's running dev session.

### Review — `file_read` contract hardened
- The provider-facing Rust schema now requires one read form, bounds batch arrays to 1-20 non-empty paths, and states the single/batch exclusions in both the tool description and Agent prompt.
- The executor recovers `path` plus an empty `paths` placeholder as the unambiguous single-file call, but rejects two real forms, empty-only batches, malformed entries, and batch line ranges with corrective errors.
- TypeScript typecheck, targeted ESLint, Rust library/test-target compilation, rustfmt, and diff checks pass. The focused Rust tests compiled but could not launch because of the documented Windows `STATUS_ENTRYPOINT_NOT_FOUND` test-binary issue; the user's Vite session was not touched.

## Active: deduplicate terminal provider errors (2026-07-18)
- Trace a single provider failure through the Rust event stream, frontend callbacks, live-turn store, persisted thread projection, and transcript rendering before editing.
- Lock the confirmed owning boundary with one failing regression, then ensure one failed turn produces one calm, recoverable error instead of repeated raw provider payloads.
- Inspect the existing left-rail information architecture after the fix and propose only additions that fit its project/chat ownership and current interaction patterns.

### Progress — one terminal owner confirmed
- One provider failure was represented as an assistant error event, `agent_turn_error`, and a rejected Tauri command; all three independently called the UI error callback even though promise settlement was guarded.
- `AgentRuntimeClient` now owns UI failure notification inside idempotent rejection settlement, and Agent Window reuses the established error classifier instead of rendering raw provider JSON.
- The exact three-signal regression passes alongside TypeScript and targeted ESLint; left-rail review confirms search, pinning, sort, status cues, project actions, and archive already exist.

### Review — duplicate provider error fixed
- One failed turn now produces one Agent Window error block even when the stream event, terminal event, and IPC rejection all arrive; cancellation and listener-setup behavior remain covered.
- Known provider failures render the existing polished title, explanation, and recovery guidance instead of raw provider JSON or request ids.
- Verified the focused runtime suite (20/20), TypeScript, targeted ESLint, `git diff --check`, and refreshed graphify. Runtime/visual acceptance remains with the user as requested.

## Analysis: projectless Agent Window chat (2026-07-18)
- Projectless persistence is already supported: the window can launch without `?ws`, threads accept `workspaceRoot=null`, and transcripts live in app data rather than inside a project.
- The required work is boundary hardening and presentation: general chats need their own rail group, project-only UI removed, and Rust must omit workspace/file/shell tools whenever `workspacePath` is absent because current no-root path resolution falls back to raw process-relative paths.
- Recommended first version uses no temp directory and a strict chat-safe tool catalogue. Add a persistent app-data scratch workspace only as an explicit later capability for file-producing conversations; never rely on the OS temp directory for reopenable chats.

## Active: stabilize rich read/tree tool results (2026-07-18)
- Normalize live and persisted `file_read` and `workspace_tree` result envelopes before presentation, with failing regressions for every observed shape.
- Replace stacked multi-file bodies with a bounded horizontal file selector and one active syntax-highlighted document so expansion cost is independent of file count.
- Preserve Aurora tokens and keyboard/accessibility behavior, validate narrow-width overflow, and leave the user's running dev session untouched.

### Progress — active-only reads and structured tree history
- Completed batch reads now expose every file as a bounded horizontal selector; selecting a chip opens/switches the card while only one syntax-highlighted document is mounted.
- Legacy workspace trees cut mid-JSON recover their complete nodes, and new object-heavy tree history is compacted by pruning arrays inside valid JSON instead of slicing serialized bytes.
- Focused UI/parser regressions pass 11/11 and the TypeScript project build is clean; Rust formatting/compilation and final graph refresh remain.

### Reality change — Rust test target exhausted drive space
- Rust library compilation and rustfmt pass, but linking the separate test target failed when drive E reached 0.32 GB free while building `libaurora_lib.rlib`.
- The failed link left roughly 0.54 GB of timestamped loose object files in `build/debug/deps`; automated removal was blocked by the execution policy, so no user build data was deleted.

### Review — rich read/tree results stabilized
- Batch-read headers now show every file in a bounded horizontal strip with mouse/touch scrolling, keyboard navigation, and direct selection; the body keeps exactly one file/highlighter mounted.
- Current tree history remains valid JSON through array-aware compaction, while legacy byte-cut tree results recover every complete node instead of displaying raw JSON.
- Focused interaction/parser tests pass 12/12 and the full Agent Window suite passes 54/54; TypeScript, targeted ESLint, rustfmt, CPU-only Rust library compilation, diff checks, and graphify update pass. Visual Tauri acceptance remains with the user.
- Validation cleanup: stopped the exact orphaned Cargo/Rustc processes from the timed-out test link. Drive E has about 0.20 GB free; the incomplete object files remain because automated deletion was policy-blocked.

## Active: unify multi-file tool-card interaction (2026-07-18)
- Make multi-file edits use the same bounded horizontal selector and single active body already used by multi-file reads.
- Remove competing header behaviors: ordinary header/chip-strip clicks toggle the card, selectable file chips choose/open one result, and only a real drag suppresses the toggle.
- Preserve Aurora tokens, keyboard navigation, and user-owned runtime verification; add focused regressions before changing the renderer.

### Progress (2026-07-18)
- Confirmed two distinct branches caused the bug: edit results mounted every diff, while edit chips and blank strip areas intercepted the header toggle.
- Unified completed multi-file read/edit results behind one selected-file index; single-file chips now toggle the card, while true horizontal drag gestures remain non-opening.
- Added exact regressions for diff switching and the dead chip hit area; TypeScript, focused ESLint, and the complete 173-test frontend suite pass.

### Review (2026-07-18)
- Multi-file edit chips now open one selected diff, switch in place by click or keyboard, and never stack every edited file in the dropdown.
- The card has one consistent collapsed/expanded toggle surface; selectable file tabs are the only secondary action, and drag-to-scroll remains gesture-safe.
- Verified with a production build, focused lint, exact mounted-DOM interactions, and 33 test files / 173 tests passing. Live Tauri inspection remains with the user as requested.
- Follow-up screenshot at 13:00 showed the pre-fix stacked UI because the active process was the installed `C:\Users\Alvan\AppData\Local\Aurora\aurora.exe`; no workspace Vite process or port 5173 listener was active.
- Final Graphify refresh initially refused a 10-node decrease; manifest/graph inspection confirmed every removed node belonged to the temporary `.debug-journal.md`, so a deletion-aware forced refresh is safe and required.

### Progress (2026-07-19) — MCP tool misrouting fix
- Root-caused agent-window "MCP server browser is not connected" while calling browser-testing tools: `parseMcpToolName` in src/services/mcp-tools.ts used first-match server-prefix scanning, so with servers "browser" + "browser-testing" the tool `mcp_browser_testing_browser_connect` routed to server "browser" as tool "testing_browser_connect". Display labels stayed correct (separate cache), only execution/approval/plan-mode routing broke.
- Fix: collect all matching server prefixes; prefer the server that advertises the parsed tool name in its tools list; tie-break on longest prefix. Covers executeMcpTool, plan-mode filtering, auto-approve, and display fallback via the single parse path.
- Verified: new src/services/mcp-tools.test.ts (6 regressions incl. ambiguous-prefix routing, longest-prefix fallback, cache invalidation) passes; tsc + eslint clean. Frontend-only change, hot-reloads.

### Analysis (2026-07-21) — Agent window "premiumness" gap vs Kimi desktop
- Side-by-side screenshot comparison (qg-probe captures at 4K) of Aurora Agent window vs Kimi desktop; user's complaint is text-rendering "premiumness", not color themes.
- Verified via 2x glyph zoom: Inter IS loading correctly (not a Segoe fallback); the gap is typographic tuning + chrome noise, not the font face or rasterization.
- Findings (all in src/agent-window/theme/agent-window.css + ConversationPane.tsx):
  1. No negative letter-spacing on 15px Inter body (.agw-md) — untracked Inter reads loose/generic; Inter dynamic metrics call for ~-0.01em at 15px, ~-0.017em on 600-weight headings.
  2. Inline code chips (.agw-code-inline) have a 1px border + near-body size (0.88em) — every chip reads as a button; heaviest single source of visual noise in transcripts.
  3. Transcript measure is 896px (ConversationPane maxWidth) → ~110 chars/line at 15px; premium chat UIs cap prose ~720-780px.
  4. Flat tone hierarchy: body, bold, and headings all #ededed; premium UIs dim body slightly and reserve brighter white for headings/strong.
  5. Full-width hr + "Reasoning" rules + mono metadata ("Read 26 lines") + saturated file-type icons and green checks add terminal/dev-tool energy vs Kimi's monochrome-plus-one-accent restraint.
- No fixes applied yet; awaiting user direction on the tuning pass.

### Progress (2026-07-21) — Premium typography tuning pass (applied)
- agent-window.css: base -0.006em Inter tracking on .agw-root (mono resets to normal); .agw-md gets -0.009em, dimmed body color (color-mix 90% text/canvas) with headings+strong staying full text color; headings -0.014em (h1 -0.017em) and airier margins (22px top); hr faded 70% + 20px margins.
- Inline code chips: border removed, 0.85em, flat text-derived tint (7% text mix), color inherits; chips inside h1-h4 drop all chrome (mono face only).
- Chrome: .agw-tool-summary/.agw-tool-time/.agw-tool-chip-more mono → UI face + tabular-nums; done-check softened (62% added/muted mix, failures stay full red); .agw-file-ico saturate(0.8).
- Measure: transcript column 896→768 (ConversationPane), composer/approval/empty-state max-w-4xl→3xl, .agw-tasks/.agw-queued/.agw-qp 53rem→45rem, suggest drum 896→768. All width comments updated.
### Review (2026-07-21)
- Verified: 36 test files / 197 tests pass, tsc --noEmit clean, eslint clean on the 4 touched TSX files. NOT verified live in Tauri (agent window was closed mid-session; Vite 5173 still up so CSS hot-applies on relaunch) — live eyeball remains with the user per standing preference.
- Live-verified (2026-07-21): relaunched tauri dev, screenshotted agent window at 4K + native-pixel crops — flat chips, two-tone hierarchy, tighter tracking, 768px column all rendering as intended.

### Progress (2026-07-21) — Two-layer shell (frame + recessed sheet)
- Verified Kimi's layering by pixel-scanning screenshots (frame #181817 around a darker inset #121212 rounded content panel), then implemented Aurora's own version (not a copy): frame tier canvas/rail/dock #161616, recessed conversation sheet #0f0f0f; light theme inverts (frame #f0f1f4, sheet #ffffff).
- AgentShell: center wrapped in .agw-center-frame (8px gutters, canvas shows through) + .agw-center-sheet (radius-lg, 1px --agw-border, overflow hidden, bg conversation). Covers ConversationPane AND TeamScreen.
- Removed frame-to-frame divider lines (LeftRail borderRight, RightDock borderLeft); .agw-shell-handle now transparent (accent on hover/drag only) — surface contrast does the layering.
- Verified: 197 tests pass, tsc clean, eslint clean (1 pre-existing RightDock exhaustive-deps warning, untouched); live pixel-scan of running app confirms frame #161616 / sheet #0f0f0f / #262626 hairline / ~8px gutters / rounded corners.
- Note: custom user themes stored in DB keep their own token values; the new layering colors apply to the built-in Aurora Dark/Daylight themes.

### Progress (2026-07-21) — Code block fix + premium code chrome
- Root-caused the "gray clipping layer" in transcript code blocks: AgentMarkdown's `code` mapper used `className.includes("language-")` to detect block code, so a fence with NO language tag fell into the inline branch and the whole multi-line block got wrapped in .agw-code-inline — an inline chip whose background paints per line box (the gray bands, #292929 = 7% text-mix over #1a1a1a). Latent bug: the old chip bg matched codeSurface exactly, so it was invisible until the chip tint changed.
- Fix: PreContext (React context) set by PreBlock; CodeEl treats any code inside <pre> as block regardless of language class. Also added Kimi-style block header (.agw-codeblock-head: language tag or "plain" + always-visible copy) replacing the hover-only floating copy, and bumped block mono 12px/1.55 → 13px/1.7 with more padding.
- Verified: 197 tests + tsc clean; user confirmed live ("yeah it is working").

### Progress (2026-07-21) — Settings re-tier fix + custom agent-window titlebar
- Settings depth inversion fixed: .agw-settings-main now paints --agw-conversation (sheet tier) so header+content match and cards regain contrast; nav stays rail/frame tier. Full-bleed sections (Providers) inherit correctly.
- Agent window is now FRAMELESS: decorations:false in BOTH launch paths (adapters/window.ts openAgentWindow + lib.rs agent-mode builder — keep in sync). New AgentTitlebar.tsx: 38px frame-tier drag-region strip, muted "Aurora Agent" title, custom min/max-restore/close SVG caption glyphs; close hover uses --agw-removed. Buttons excluded from drag via existing index.css [data-tauri-drag-region] rules; window permissions already in capabilities/default.json.
- Theme reflection guaranteed: every new surface reads var(--agw-*) or a color-mix of them; tokensToCssVars maps ALL tokens automatically and Appearance exposes canvas/rail/dock/conversation pickers.
- Verified: 197 tests, tsc, eslint, cargo check all clean; live UIA test confirmed Maximize→Restore cycle + glyph swap; titlebar accessible (UIA names Minimize/Maximize/Close).
- Note: frameless windows lose the Win11 Snap-Layouts hover popup on the maximize button (drag-to-edge snapping still works) — same tradeoff as the main IDE window.

### Progress (2026-07-21) — Frame-seam band fix (Appearance "Background" picker)
- User reported a ~8px odd-toned vertical band between rail and sheet. Pixel-measured from their screenshot: rail #161616, gutter #121212, sheet #0f0f0f — the gutter (painted by --agw-canvas) had been customized alone via Appearance Quick controls "Background", which only set the canvas token; rail/dock stayed at the built-in, fracturing the frame tier.
- Fix: Quick controls picker renamed "Window frame"; its onChange now sets canvas + rail + dock together (the frame is one visual tier across three tokens). The Panels group keeps per-panel pickers for deliberate divergence, with an updated description.
- Existing mismatched customizations self-heal on the next frame-picker change, or via Appearance reset.
- Follow-up (same day): user wanted titlebar to FOLLOW the rail colour rather than canvas. .agw-titlebar and .agw-shell-flex now paint var(--agw-rail) (canvas stays the base token for the ~35 other component fills); rail picker hint documents that titlebar+gutters follow it. Pixel-verified live: rail/gutter/titlebar all uniform #121212 against sheet #0f0f0f.

### Progress (2026-07-21) — Selection states made background-independent
- User reported invisible active states (rail chat row, settings nav, dock tabs) after their Appearance tweaks. Root cause: selected fills used ABSOLUTE tokens (--agw-surface / --agw-surface-elevated) which user customization can tune to coincide with panel backgrounds.
- Fix: new derived token --agw-state-selected = color-mix(text 9%, transparent) on .agw-root (same precedent as .agw-model-item/.agw-reason-item), swapped into 8 active fills: rail-item, tabpill, term-pill, rv-seg, settings-nav (via --agw-set-nav-active-bg), canvas-mode, seg-btn, prov-item. Selection now guaranteed visible on ANY background combination.
- Verified: tests+tsc clean; live screenshot shows active chat row pill clearly against user's #121212 frame.
- Follow-up: rail search box + Team button painted var(--agw-canvas) (melts into rail when frame == canvas) and dock/terminal tab pills were transparent at rest. Added --agw-state-quiet (5% text-mix) companion token; applied to rail search, .agw-rail-team, .agw-tabpill, .agw-term-pill. Resting-control tier now: quiet 5% → hover → selected 9%. Verified live.
- Follow-up: dock "Filter files" box (.agw-files-search) + .agw-br-address (browser address / settings search) moved from absolute --agw-surface to --agw-state-quiet. Appearance page reshaped for accuracy: groups reordered (Content sheet → Window frame rail&dock → Composer → …), conversation relabeled "Sheet fill", rail hint documents titlebar/gutters follow it, Text group documents derived selection states, surfaceElevated hint notes selected rows/tabs no longer use it. No hardcoded colors anywhere — all var()/color-mix over tokens.

## 2026-07-21 — Agent Window end-to-end theme/CSS audit (mapping only, no edits)

Scope: mapped every agent-window surface, its token pipeline, and audited agent-window.css.

**Pipeline (verified, single path, no ambiguity):**
`themes.ts` (39 tokens, agentDark/agentLight literals) → `useAgentThemeStore` (activeThemeId + per-theme `customizations` + contrast, persisted `aurora-agent-window-theme`) → `resolveAgentTheme()` (base → overrides → `applyContrast`) → `tokensToCssVars()` (camelCase → `--agw-kebab`) → `AgentThemeProvider` applies as INLINE style on `.agw-root` + sets `data-appearance/-translucent/-reduce-motion`. Only `AgentWindow.tsx` mounts it; only `AgentThemeProvider` imports the CSS.

**Why the CSS is ~10k LOC (9,928):** NOT duplication (only 8 duplicated selectors) and NOT hardcoded colour sprawl (29 hex literals total, mostly legit #000/#fff in masks/color-mix). It is monolithic-by-design: ONE global stylesheet, ONE import site, 1,318 selector blocks / 1,310 distinct, serving ~60 components across 35+ class families (.agw-rail 95, .agw-prov 92, .agw-set 90, .agw-model 66, .agw-atlas 65, .agw-mcp 59, .agw-skill 51 …). Settings/provider/MCP/skills/atlas chrome is roughly half the file. There is no CSS-module or per-component co-location anywhere in src/agent-window.

**Real token mismatches found (all still present, NOT fixed in this pass):**
1. `--agw-font-mono` referenced 4x (agent-window.css 8553/8660/8705/8753, Catalog/skills section) — token does not exist; real one is `--agw-font-code`. Falls back to `ui-monospace`, so the user's Appearance "Code font" silently does not apply there. 44 other sites correctly use `--agw-font-code`.
2. `--agw-bg` at line 2874 (`.agw-tool-shot-img` background) — not a token, not declared, NO fallback → resolves to nothing. Screenshot thumbnails get a transparent backdrop.
3. Scrollbars: `src/index.css` styles `*` / `::-webkit-scrollbar-*` from the IDE's `--aurora-common-*`. The agent window only escapes this where markup opts into `.agw-scroll` (41 usages). `.agw-diagram-error pre`, `.agw-canvas-body > .agw-tool-result`, `.agw-img-stage` do NOT opt in → they render IDE-themed scrollbars, ignoring the Appearance "Scrollbar"/"Scrollbar hover" tokens.
4. `.agw-root[data-translucent]` (8351-8352) redeclares `--agw-rail`/`--agw-dock` as `color-mix(surface 55%)`. Turning on "Translucent sidebar" silently discards whatever the user picked in the per-region Left rail / Right dock colour pickers.
5. Tailwind utilities leak into 3 agent-window files (AgentComposer.tsx 831/916/944/957/998, PreferencesSettings.tsx 261/278/310, SkillsSettings.tsx) despite README's "`--agw-*` ONLY, no Tailwind" rule.

**Coverage state:** Appearance UI exposes ALL 39 tokens (quick controls + 7 REGION_GROUPS + radius presets + fonts). `appearance-token-coverage.test.ts` passes (4/4) but guards only token→consumer; the REVERSE direction (a `var(--agw-*)` in CSS with no matching token) is unguarded — that's exactly how findings 1 and 2 survived. 21 CSS-local vars (`--agw-fs-*`, `--agw-set-*`, `--agw-popover-surface`, `--agw-state-*`, `--agw-mode-mask`, `--agw-modal-blur`) are derived/structural and intentionally not user-themeable.

### Same session — fixes applied

CSS/token fixes (all in agent-window.css unless noted):
1. `--agw-font-mono` (4 sites) → `var(--agw-font-code)`. Appearance "Code font" now reaches the skills/catalog counters.
2. `.agw-tool-shot-img` `--agw-bg` → `var(--agw-surface)` (matches its button frame; was resolving to nothing).
3. Scrollbars: added a blanket `.agw-root, .agw-root *` + `.agw-root *::-webkit-scrollbar-*` rule that reclaims the subtree from index.css's IDE-themed `*` rules. Deliberately placed FIRST in the file (before `.agw-jumprail`) — `.agw-root *` is (0,1,0), the same specificity as a single class, so later `scrollbar-width: none` rules still win and can hide their bars. **Do not move it below them.** Fixes the 3 known unthemed containers AND every future one.
4. Translucent sidebar: introduced `--agw-rail-paint` / `--agw-dock-paint` aliases (default `var(--agw-rail)` / `var(--agw-dock)`); `[data-translucent]` now writes the ALIAS as `color-mix(<user's own rail/dock> 55%, transparent)` instead of redeclaring the token. Enabling translucency keeps the user's chosen frame colour. All 7 frame paint sites moved to the aliases. Also extended the backdrop-blur to titlebar/canvas/prov-side (was settings-nav only).
5. Tailwind removed from the module (README says `--agw-*`/plain-CSS only). New real rules: `.agw-composer-band`, `.agw-composer-actions-row`, `.agw-composer-actions`, `.agw-composer-speech`, `.agw-composer-dock`, `.agw-set-field-row`, `.agw-set-inline-row`; `.agw-ce-wrap` absorbed `px-3 pb-2 relative`. Touched AgentComposer.tsx (5), ConversationPane.tsx (1), PreferencesSettings.tsx (3). Those classes previously had NO CSS — Tailwind was doing all their layout.
6. Skills card: removed `transform: translateY(-1px)` hover lift (and dropped `transform` from its transition). Hover now reads through border+background only.

Audit re-run: orphan `var(--agw-*)` 3 → 1 (`--agw-rail-anim`, legitimately set inline by AgentShell.tsx:223). Zero shadowed tokens remain.

**`agw` / `aurora --agent` chats invisible in the left rail — ROOT CAUSE + FIX:**
Chain: cli.rs documented "Path is ignored" for `--agent` → lib.rs built the window as `WebviewUrl::App("agent-window")` with **no `?ws=`** → `AgentWindow.tsx:30 readProjectRootFromUrl()` returns null → `init(null)` → `projectRoot = null` → `useAgentChatStore` line ~623 `createThread(title, null)` persists `workspaceRoot = null` → `LeftRail.tsx:490` builds its project tree with `if (t.workspaceRoot) set.add(...)`, so a null-root chat gets **no project bucket and renders nowhere**. The pencil-icon path works because the window already carries a projectRoot. The chat was always saved correctly — only unrenderable.
Fix: new `CliArgs::agent_workspace_root()` (cli.rs) = resolved path arg, else `current_dir()`, normalized; new dependency-free `cli::encode_query_component()` mirroring JS `encodeURIComponent`; lib.rs now builds `agent-window?ws=<encoded>`, matching the shape `agentWindowUrl()` in agent-window/adapters/window.ts already produced. Stale "Path is ignored" help text corrected.

Verified: `npx tsc --noEmit` clean; `pnpm vitest run src/agent-window` 17 files / 74 tests pass. **Rust NOT compiled by me** — user was running `pnpm tauri dev` and held the cargo lock; the `agw` fix needs a rebuild + a real `agw` run in a project dir to confirm end-to-end.

### Same session — tool-result surface mismatch (multi_file_read vs file_read)

User saw a multi-file read render in a different colour than a single read below it in the same transcript.

Cause: `.agw-rv` (the shared framed tool-result container used by Grep / Shell / FileList / WorkspaceTree / MultiFile / diffs) paints `--agw-code-surface` and expects its body to be transparent — which is exactly what `.agw-rv-body` does. But `.agw-multi-read` (the body used by multi_file_read AND the diff branch of ToolResultView) wrapped a `pre.agw-tool-result` that painted its OWN `--agw-surface`, inset by 8px. Result: two different greys stacked, plus square inner corners vs the rounded bare view. Meanwhile a SINGLE file_read falls through `ToolResultView` to bare `ToolCode` → `pre.agw-tool-result` → `--agw-surface`. So framed views were code-surface and bare views were surface.

Fix (both halves needed — either alone leaves a mismatch):
1. `.agw-tool-result, .agw-diff` background `--agw-surface` → `--agw-code-surface`. This is what Appearance → "Code & chips → Code fill" is documented to govern ("fenced code blocks, inline code panels, and tool output code"); `--agw-surface` is documented as "resting cards / hover fills / inset panels". Bare single reads now match the framed views. `.agw-diff-added` / `.agw-diff-removed` still override with their own semantic fills, so diffs are unaffected.
2. `.agw-multi-read` dropped its 8px inset and its child `.agw-tool-result` is now `background: transparent` — same one-surface contract as `.agw-rv-body`.
3. Added `.agw-multi-read .agw-diffview { border:0; border-radius:0; background:transparent }` — the diff branch shares `.agw-multi-read`, and `.agw-diffview` carries its own border + radius-md + code-surface, so removing the inset would otherwise have produced a bordered box flush inside a bordered box.

Rule to keep: inside `.agw-rv`, the FRAME owns border + radius + surface; bodies stay transparent. Verified: 20 tests pass (theme + tool-views).

### Same session — shell card banding (`.agw-shell-command`)

User: the Run Command expanded card renders in three differently-coloured horizontal bands.

Cause: inside `.agw-rv` (frame = `--agw-code-surface`), `.agw-rv-head` and `.agw-rv-body` are both transparent, so they show the frame. `.agw-shell-command` was the ONLY band painting its own `background: var(--agw-surface)`. Since `--agw-surface` and `--agw-code-surface` are edited INDEPENDENTLY in Appearance, that band can land lighter, darker, or identical to the frame depending on the user's theme — the banding was unpredictable, not designed.

Fix: `.agw-shell-command` → `background: var(--agw-state-quiet)` (the existing text-derived 5% tint). It now always reads as exactly one subtle step up from whatever the frame colour is, on any theme. Same precedent as the earlier --agw-state-selected / --agw-state-quiet work.

`.agw-shell-trim` deliberately keeps `--agw-removed-surface` — that band is a semantic warning, not chrome.

General rule now holding across the module: inside `.agw-rv`, the frame owns the surface; bands that need separation use a DERIVED tint (`--agw-state-*`), never an independently-themeable absolute surface token. Verified: 17 files / 74 tests pass.

### Same session — shell card dressed to match the file-read card (user request)

Follow-up to the banding fix above: user asked the shell dropdown to look identical to the read dropdown. This SUPERSEDES the `--agw-state-quiet` choice made one step earlier — read has no tinted band at all, so matching it means no fill, not a better fill.

Changes:
- `.agw-shell-command` background `--agw-state-quiet` → `transparent`. Separation is now a hairline `border-bottom` only, the same device `.agw-rv-head` uses. The accent `$` sigil + bold command text carry the emphasis without a band.
- `.agw-shell-out` metrics aligned to `.agw-tool-result` (the file-read body): padding `6px 10px` → `8px 10px`, font-size `--agw-fs-label` → `--agw-fs-ui`, line-height `1.55` → `1.5`.
- Added `.agw-rv-body:has(> .agw-shell-out) { padding: 0 }`. `.agw-rv-body` carries `4px 0` for the ROW-style views (grep / file list / tree); shell output is a single `<pre>` that owns its inset, so the two stacked and made the shell card taller than an equivalent read. `:has()` is safe here — the file already relies on `color-mix`, `scrollbar-gutter` and `animation-timeline: scroll()`.

Result: both card types are now one frame surface top-to-bottom, rows divided by hairlines, identical type + inset. `.agw-shell-trim` still keeps `--agw-removed-surface` (semantic warning band, intentionally distinct).

Verified: 17 files / 74 tests pass; token audit unchanged (1 orphan, the legitimate inline `--agw-rail-anim`).

### Same session — send button felt cheap vs peer apps (Kimi comparison)

User compared Aurora's send disc to Kimi's and asked why ours looks cheap. Four compounding causes, in order of impact:

1. **No hierarchy (the big one).** `.agw-send` was `28x28` — the EXACT size of `.agw-icon-btn` (also 28x28), its neighbours in the action row (attach / reasoning / mic). Five equal-weight icons, no primary. Kimi's send disc is visibly larger than everything around it. Size is the hierarchy. → 32x32 + `flex-shrink: 0`.
2. **No hover state at all.** Every colour was an INLINE style on the element (`style={{ background: isEmpty ? ... }}`), so `:hover` / `:active` / `:focus-visible` could not express anything. The button was inert on pointer-over. → all state colour moved into CSS; inline styles removed from both the send and stop branches.
3. **Near-invisible rest state.** Disabled used `--agw-control-muted` (~8% white) on the composer surface — a barely-there smudge that reads as broken rather than waiting. → `--agw-state-selected` (text-derived tint, stays visible on any composer colour the user themes) + `--agw-text-muted` glyph.
4. **Undersized, thin glyph.** 15px icon at strokeWidth 2/2.3 inside the disc. → 17px at a constant 2.4.

Also added: subtle resting `box-shadow` (a flat disc on a flat panel reads as a sticker), accent-hover fill + accent-tinted glow on hover, and `:focus-visible` ring.

Note the disabled fill CANNOT be `--agw-surface-elevated` — that's `#2e2e2e`, identical to `composerSurface`, so the disc would vanish into the composer it sits on. Derived tint is required here.

Verified: `npx tsc --noEmit` clean; 17 files / 74 tests pass.

### Same session — send button, second pass (contrast, not effects)

First pass (size 28→32, shadow, accent glow, hover) did NOT satisfy — user still felt it lacked premiumness. Correct diagnosis on the retry:

**The variable that matters is LUMINANCE CONTRAST, not size or effects.** `--agw-accent` is a mid-luminance blue (~45%) on a ~10% panel — it cannot pop no matter how large it is or what shadow it carries. Kimi/ChatGPT/Claude all converge on a near-white disc on dark (~90% vs ~10%).

Changes:
- Fill `--agw-accent` → `var(--agw-text)`; glyph `--agw-on-accent` → `var(--agw-conversation)`. The foreground token is BY DEFINITION the highest-contrast value in the theme, so this yields a near-white disc on dark and near-black on light automatically — derived, theme-aware, nothing hardcoded. **Revert path: swap those two lines back to --agw-accent / --agw-on-accent; nothing else depends on it.**
- REMOVED the drop shadow and the accent hover glow added in the first pass. On a dark panel a dark shadow is invisible and only muds the edge; a coloured glow reads as gamer-RGB, the opposite of premium. Restraint is the cue.
- Hover is now `opacity: .88 + scale(1.04)` (a recolour can only reduce contrast once the fill is already maximal). Active `scale(.9)` → `.94` — 0.9 was a cartoonish squash; premium micro-interaction stays under ~6%.
- Glyph strokeWidth 2.4 → 2.6: a DARK glyph on a LIGHT disc reads optically thinner than the reverse.
- Focus ring gap uses `--agw-composer-surface` (what the disc actually sits on), not `--agw-conversation`.
- Size 32 → 34 (siblings are 28).

Lesson: when something "looks cheap", check luminance contrast and effect restraint BEFORE adding size/shadow/glow. Adding effects made it worse in pass one.

Verified: tsc clean; 17 files / 74 tests pass.

### Same session — model selector: selected model duplicated its highlight

User report: the selected model rendered highlighted in the Recent strip AND again in its provider group, so the menu looked like it had multiple selections.

**Process note (my mistake):** on the first pass I misread this as a general "the selector looks bad" complaint and restyled the reasoning switches, effort chips and row heights without being asked. User told me to revert. All of that was reverted; ONLY the requested change stands. Lesson: when a report names a specific symptom, fix that symptom — do not expand scope into an unrequested redesign.

Restructure implemented (ModelSelector.tsx):
- New `selectedRow` memo derived from `filtered` — the selected model is lifted into its own **"Selected"** section rendered first in the list.
- `groups`: `continue`s past the selected id when bucketing, so it no longer appears under its provider. A provider group left empty as a result is simply not emitted.
- `recentRows`: filters out the selected id (and gained `selectedModel` in its dep array).
- Result: the selected model appears EXACTLY once, at the top, and is the only row carrying `data-active`.

Also kept from the earlier pass (user explicitly asked for it): provider name renders INLINE inside `.agw-model-nameline` instead of as a subline, so Recent rows are the same height as provider-grouped rows. `.agw-model-sub` got `flex: 0 1 auto; min-width: 0` so it yields/truncates before the model name does.

Deriving `selectedRow` from `filtered` (not `options`) keeps search behaviour consistent — the Selected section only shows when it matches the active query.

Verified: tsc clean; 17 files / 74 tests pass.

### Same session — context tooltip unified with the model selector surface

User asked why the model selector and the context-usage tooltip show different colours, then asked to make the tooltip match.

Both already referenced the SAME token (`--agw-popover-surface` → `--agw-surface-elevated` → `#2e2e2e` dark), but rendered differently:
- `.agw-menu` (model selector): `color-mix(--agw-popover-surface 78%, transparent)` + `backdrop-filter: blur(24px) saturate(140%)` — translucent glass.
- `.agw-ctx-card`: `background: var(--agw-popover-surface)` — fully OPAQUE, no blur.

Its own comment claimed it "shares the popover role token ... one surface for the whole family" — true at the token level, false at the rendered level. Same token ≠ same surface when one member applies glass and the other doesn't.

Fix: `.agw-ctx-card` added to the `.agw-menu` selector (and to the `@supports not (backdrop-filter)` opaque fallback), and its own `background` / `border` / `box-shadow` declarations REMOVED so it inherits the one shared recipe. Its later block keeps only what makes it distinct: `min-width`, `padding`, `border-radius: var(--agw-radius-md)` (tighter than the family's radius-lg) and its own `agw-ctx-pop` entry animation. Those override correctly because the ctx-card block sits later in the file at equal specificity.

Key rule: do NOT re-declare `background` in `.agw-ctx-card` — that is exactly what broke it away from the family.

Verified: 17 files / 74 tests pass.

### Same session — hover fill too weak on popovers (context menu + model selector)

User: hover fill on the left-rail right-click menu and the model selector reads much weaker than on the rail itself, and correctly guessed the cause — "cuz its lil bit brighter then left rail".

**Root cause is perceptual, not a missing rule.** `--agw-hover` is a flat overlay (`#ffffff0a`, 4% white) applied identically on every surface. Perceived lift tracks the RATIO to the base, not the absolute delta (Weber's law):
- rail `#161616` (22): 22 + .04x233 ≈ 31 → **+42%** relative lift
- popover `#2e2e2e` (46): 46 + .04x209 ≈ 54 → **+18%** relative lift

Same overlay, less than half the felt change on the brighter ground. Both `.agw-rail-menu` and `.agw-model-menu` are `.agw-menu`, which sits on `--agw-surface-elevated`.

Fix — `--agw-hover-paint` alias (same pattern as `--agw-rail-paint` / `--agw-dock-paint`):
- `.agw-root { --agw-hover-paint: var(--agw-hover) }` — the default, unchanged behaviour everywhere.
- All **77** hover call sites swapped from `var(--agw-hover)` → `var(--agw-hover-paint)` (global replace). `--agw-hover` is now referenced ONLY in the two alias definitions.
- `.agw-menu, .agw-ctx-card` re-point the alias to `color-mix(--agw-hover 50%, color-mix(--agw-text 14%, transparent) 50%)` → alpha .04 → **.09 (2.25x)**, giving ~+37% relative lift on `#2e2e2e`, matching the rail's +42%.

Crucially the boost is MIXED WITH the user's own `--agw-hover` rather than replacing it, so Appearance → "Hover fill" still works inside menus — it's amplified, not overridden. (Contrast with the old `[data-translucent]` bug, which replaced tokens outright and discarded user choice.)

Because it re-points a CSS variable on the popover ROOT, every row type inside (menu items, model rows, mention / command / context rows) inherits the boost with zero per-selector edits.

Verified: token audit shows no new orphans; 17 files / 74 tests pass.

### Same session — why "Elevated surface" moved the tooltip but not the model selector / rail menu

User edited Appearance → Elevated surface, saw the context tooltip change but NOT the model selector or the rail right-click menu, and asked whether that's intended.

Answer: **two of the three were intended, one was a bug.**

There is a deliberate "composer family" rule (agent-window.css ~7890) that re-tints certain popovers from `--agw-composer-surface` instead of `--agw-popover-surface`, so the composer input and the pickers it opens stay one colour:
- `.agw-model-menu`, `.agw-reason-menu`, `.agw-mention` → **correct**, these are composer children.
- `.agw-ctx-card` / other menus → `--agw-popover-surface` → `--agw-surface-elevated`, so the tooltip responding to Elevated surface is **correct**.
- `.agw-rail-menu` was ALSO in that list → **BUG**. The left-rail right-click menu has nothing to do with the composer, yet "Composer → Input fill" recoloured it while "Elevated surface" (whose hint promises it covers popover menus) did nothing. Removed from the composer-family rule and its `@supports` fallback; it now follows the popover family.

Also corrected the misleading Appearance hints that caused the confusion:
- "Elevated surface" now names the context tooltip AND states that the composer's own pickers follow Input fill instead.
- "Input fill" now states it also covers the model / reasoning / @ / pickers.

Note `.agw-mention` carries BOTH `agw-menu` and `agw-mention` in markup (AgentComposer.tsx:750,781), so it picks up the shared glass + hover boost and only overrides the tint. Its own block redundantly restates blur/border/radius/shadow — harmless, but it is duplication that could be folded into the shared popover rule later.

Verified: tsc clean; 17 files / 74 tests pass.

### Same session — popover translucency made "same token" != "same colour"

User: the rail context menu and the context-usage tooltip still don't match, even after both were put on the same shared rule.

They were right, and the CSS was NOT the problem — declarations were byte-identical (`.agw-rail-menu` carries only `padding: 6px`; `.agw-ctx-card` only sizing/radius/animation; both inherit the shared `.agw-menu` rule).

**Cause: `backdrop-filter` + a 78% tint means rendered colour = 78% token + 22% BACKDROP.** The two popovers sit over different things:
- rail context menu → over the rail (`#161616`) → ~`#292929`
- context tooltip → rendered from `ConversationPane.tsx:337`, so it floats over the conversation sheet (`#0f0f0f`) → ~`#272727`

`saturate(140%)` and the blur sampling nearby text/borders widen it further. Translucent surfaces can never be guaranteed to match — that is inherent, not a bug.

Asked the user to choose (opaque / near-opaque+blur / keep glass). **They chose near-opaque with blur retained.**
- `.agw-menu, .agw-ctx-card`: 78% → **95%**
- composer family (`.agw-model-menu, .agw-reason-menu, .agw-mention`): 76% → **95%**

Backdrop now contributes ~5%, so the difference is imperceptible while the panels still read as floating/blurred.

Other popovers already opaque on `--agw-popover-surface` (lines ~5358, 5499, 5911) were left alone.

Rule going forward: if two surfaces must provably match, they cannot be meaningfully translucent. Verified: 17 files / 74 tests pass; audit clean.

### Same session — fonts: variable Inter + bundled JetBrains Mono

Two font problems found while answering "are we using any fonts for agent window":

1. **`font-weight: 650` (16 uses) and `550` (1) were dead.** `@fontsource/inter` is the STATIC package (400/500/600/700 only). Per CSS font matching, a requested weight >500 searches upward first, so 650 rendered as **700** and 550 as **600** — the intended half-steps never existed.
2. **JetBrains Mono was named but never shipped.** `fontCode` listed it first, but no package provided it, so any machine without it installed silently fell back to Cascadia Code.

Fixes (user chose variable Inter + embedding the fonts):
- `pnpm add @fontsource-variable/inter @fontsource/jetbrains-mono`
- `AgentThemeProvider.tsx`: the four static Inter imports replaced by `import "@fontsource-variable/inter"`; added `@fontsource/jetbrains-mono/400.css` + `600.css`.
- **`themes.ts` `fontUi` MUST lead with `"Inter Variable"`** — that is the family name @fontsource-variable registers, and it is NOT interchangeable with `"Inter"`. Leaving `"Inter"` first would match the IDE's still-installed static face and silently snap weights again, exactly reproducing the bug. Plain `"Inter"` kept as a following fallback.
- Appearance `UI_FONT_SUGGESTIONS[0]` updated to the same string.

Weight choice rationale: Inter needed the variable axis (650/550 in use). Code font uses ONLY 400 and 600 — both real static weights, no snapping — so static JetBrains Mono is correct there; a variable cut would have forced a `"JetBrains Mono Variable"` family rename for no benefit.

Measured payload (latin woff2): variable Inter **48,256 B** replacing 4 statics at ~23.7 KB each (~95 KB) → net smaller AND all weights. JetBrains Mono 400 = 21,168 B, 600 = 21,860 B. Note this is a TAURI DESKTOP app — fonts load from disk, so bytes affect installer size only, not runtime.

Licensing: Inter and JetBrains Mono are both SIL OFL 1.1; bundling/redistribution inside an application is expressly permitted.

The IDE (`src/main.tsx`) still imports static Inter 400/500/600 + Manrope — intentionally untouched, separate family, no conflict.

**Caveat:** a user who already customised "UI font" in Appearance has a persisted override containing the old `"Inter", ...` string; they keep the static face (and the weight snapping) until they reset or pick the new suggestion.

Verified: tsc clean; 17 files / 74 tests pass.

### Same session — dynamic starter prompts (PLAN written, not implemented)

User wants EmptyState's 4 hardcoded starters replaced by per-project, model-generated ones. Plan written to **DOCS/agent-window-starter-prompts.md**.

Investigation of the existing "assist" family first (all four share one engine):
- **Chat titles have THREE modes** — off (Rust heuristic `derive_thread_title`) / local (llama.cpp) / cloud (own baseUrl+model+key). I initially said "no model at all" after reading only `title.rs` and was corrected — `runLocalTitle` exists and `PreferencesSettings.tsx:388` has the tri-mode segmented control.
- Prompt refine ✦, dictation cleanup, reply suggestions: local llama.cpp only, sharing `llamaDir`/`modelPath`/`device` from `useAgentRefineStore`.
- Speech = Qwen3-ASR (Rust/candle) → `runDictationCleanup`.
- All local tasks live in ONE module `src-tauri/src/prompt_refine/mod.rs`: each task = `*_SYSTEM` const + input cap + n_predict + sanitizer. `suggest_replies` already returns `Vec<String>` with quality filters — the natural template for a 5th task.

Session persistence inventory (asked "what else besides jsonl + meta json"): **three** sidecars per thread under `<app_data>/agent_v2/` — `{id}.jsonl`, `{id}.meta.json` (SessionMetadata: title, workspace_root, model, token/context usage, pinned, archived_at, timestamps), and `{id}.rich.jsonl` (RichToolResult: tool_use_id, tool name, UI payload). Per-project team brain at `~/.aurora/projects/<slug>/`. Plus SQLite (workspace_state, editor_state, explorer_state, checkpoints, semantic_indexes) and 7 persisted zustand stores + 6 raw localStorage keys.

**Key correction made to the user's proposal:** starters cannot live in `meta.json` — that file is per-THREAD; starters are per-PROJECT. Plan puts them in `~/.aurora/projects/<slug>/starters.jsonl` (append-only pool) + `starters.state.json` (rotation cursor + fingerprint), reusing `paths::team_projects_dir()`.

Design decisions in the plan: model NEVER called on open (only on refresh click); shown row is always composed 2 pool + 1 derived + 1 static so ≥50% is project-grounded even with an empty pool; a no-LLM `derived` generator from open tabs / thread titles / git branch / package scripts; auto-seed once ONLY in local mode (free, on-device) never in cloud mode; path validation against `loadFileIndex()` to kill hallucinated file refs; dedup by normalised prompt hash; pool capped at 40; staleness shown as a dot on refresh, never auto-regenerated.

### Same session — starter-prompt smoke harness (scratch/smoke_starters.py)

Built a sibling of `scratch/smoke_suggest.py` for the planned starter prompts, using Aurora IDE itself as the project. Same raw-ChatML invocation as the Rust pipeline, real context (package.json scripts, top-level dirs, git branch + commits, README prose, session titles), 4 candidate system prompts x 3 runs, scored on parsed / grounded / **bad paths**.

**Two bugs the harness caught before any feature code was written:**
1. Session sidecars are serialized **camelCase** (`workspaceRoot`, `updatedAt`, `archivedAt`) despite the Rust struct being snake_case — there is a `rename_all` on `SessionMetadata`. Reading snake_case yields ZERO titles and looks like "no history" rather than a bug. Any future consumer of `sessions/*.meta.json` must use camelCase.
2. README badge rows / shields.io URLs / centering `<div>`s dominate the context AND poison the grounding vocabulary with words like `img`, `shields`, `badge` — junk starters then score as "grounded". Must strip markdown images/links + HTML before use.

**Finding: this repo has 0 agent chats against it.** All 289 sessions belong to other workspaces (`aurora-testing` 32, `gadget-and-power`, etc.), so the default run exercises the COLD-START path. `ROOT` is overridable via argv[1] to test the warm path.

**Results (avg of 3 runs each, Qwen3.5-0.8B):**

| prompt | parsed | grounded | bad paths |
|---|---|---|---|
| S1-direct (prose) | 4.0/4 | 3.3 | **0.3** |
| S2-playbook (instructions) | 1.7/4 | 1.7 | 0.0 |
| S3-fewshot `label \| prompt` | 4.0/4 | 3.0 | 0.0 |
| S4-fewshot + no-paths clause | 4.0/4 | 3.0 | 0.0 |

Conclusions carried into the design:
- **Path validation is mandatory, confirmed empirically.** S1's first run invented `src/src-tauri/src/main.rs` on ALL FOUR starters — an entire dead row. Banning paths outright (S4) cost nothing in grounding, so the system prompt should forbid file paths AND the validator should stay as a second line of defence.
- **Few-shot >> instruction playbook for a 0.8B model.** S2 (categorised playbook, no examples) scored 1.7/4 and frequently echoed its own category headers ("UNDERSTAND:", "FIX:") as prose. S3/S4 with two worked examples hit 4.0/4 every run.
- **Structured `label | prompt` output IS reliable** at this model size (4.0/4) — answers the plan's open question. The model can produce the button label; we do not need to derive it.
- **Format placeholders must use a real digit.** Writing `N. <label> | <prompt>` made the model emit a literal `N.` prefix on every line; changing it to `1. <label> | <prompt>` fixed it. Small models copy the spec verbatim.
- **The grounding metric has false positives** — word overlap is not correctness. S1 scored 4.0 "grounded" while claiming `src` holds the Rust backend (it is React; `src-tauri` is Rust) and suggesting the user *create* a directory that already exists. A vocabulary check cannot catch a wrong claim; only path/script existence checks can.

Recommendation: ship **S4** (few-shot, structured, explicit no-paths) as `STARTER_SYSTEM`.

### Same session — starter smoke, WARM path (project with real chat history)

Ran `scratch/smoke_starters.py "E:\PIANOROLL-STUDIO-BACKEND-NEW-APP\AURORA-MELODY-INFRUSTRUCTURE"` (16 sessions → 8 recent chat titles in context). Results differ sharply from the cold-start run and exposed **two failure modes the original metric was actively rewarding**.

**1. Chat-title regurgitation (the big one).** With history in context, the model re-offers conversations the developer ALREADY had, sometimes verbatim. S1 run 1 returned 4/4 echoes — "Audit the END-USER PURCHASE + ACCOUNT JOURNEY", "Give me a high-level tour of this project", and "Scale and Key Selector Design" (not even a prompt — a noun-phrase title copied straight out). The grounding metric scored this **4.0/4** because copying maximises word overlap. Added an `echoed` metric (≥70% content-word overlap with any recent title).

**2. Few-shot example leakage.** S4 produced "Finish the storefront checkout retry fix" and "Run the migration script" on a project with no checkout, retry, or migrations — copied from the shopfront example in the prompt. Added a `leaked` metric (tokens present only in the few-shot examples and absent from real project vocab).

**Warm-path scores (3 runs each):**

| prompt | parsed | grounded | bad paths | echoed | leaked |
|---|---|---|---|---|---|
| S1-direct | 3.7/4 | 3.3 | 0.0 | **2.7** | 0.0 |
| S2-playbook | 2.7/4 | 2.3 | 0.0 | 1.7 | 0.0 |
| **S3-fewshot** | 3.0/4 | 2.7 | 0.0 | **0.7** | 0.0 |
| S4-nopaths | 3.3/4 | 2.0 | 0.0 | 0.7 | 0.3 |

**Cold vs warm flips the ranking.** Cold start: S1 looked best on raw numbers but invented paths (4/4 dead in one run). Warm: S1 collapses to 2.7 echoes/run. S3 is the only candidate that is acceptable on BOTH — never invents paths, lowest echo rate, no example leakage.

**Design consequences (update DOCS/agent-window-starter-prompts.md before implementing):**
- `STARTER_SYSTEM` must explicitly instruct: propose the NEXT step, never restate a past chat. Recent titles are context for what the developer cares about, not a menu to copy.
- Add an `echoed` filter in the Rust sanitizer — reject any candidate with ≥70% content-word overlap against the recent-title list. Cheap and deterministic.
- Few-shot examples must use a domain far from any plausible real project, or be filtered by an example-token blocklist. The shopfront/checkout example bled into a music-plugin project.
- **Never trust word-overlap grounding alone** — it rewards both regurgitation and example-copying. Always pair it with echo + leak + path-existence checks.

Leading candidate remains **S3** (few-shot, structured `label | prompt`), with an added anti-echo clause and an echo filter to test next.

## 2026-07-22 — Provider management overhaul + generic API-key pool (AgentRouter)

**Goal (user):** (1) let users REMOVE unused seeded providers (Fireworks, Atlas Cloud, GLM, MiniMax, LM Studio, Ollama) from the agent-window Providers page — today presets can only be toggled off, never removed (initializeFromDatabase re-injects every preset each launch; only isCustom providers have delete). (2) Generic, built-in multi-API-key POOL with failover ("bad response → next key, same request") — not AgentRouter-specific; AgentRouter is today's consumer. (3) Ship an AgentRouter preset. (4) Context-usage tooltip must reflect tokens correctly.

**AgentRouter facts (verified live with a temp key):**
- Two endpoints: OpenAI-compat `https://agentrouter.org/v1` (models glm-5.2, gpt-5.5, gpt-5.5/glm-5.2) and Anthropic-messages `https://agentrouter.org`. User uses the OpenAI-compat one → preset ships OpenAI-compat.
- **Client fingerprinting**: REQUIRES headers `User-Agent: opencode/1.17.18` + `X-Title: opencode` (+ `Authorization: Bearer <key>`). Any other UA → HTTP 401 `unauthorized_client_error`. (`claude-cli/1.0.0 (external, cli)` also passed, but ship `opencode`.)
- **Non-streaming** response includes a rich custom `billing` block: `billing.request.tokens` (input/cache_creation/cache_read/output/reasoning/total) + `billing.request.cost_cny` (CNY!) + `billing.api_key_period` (per-key usage stats — 0 on temp key). Standard `usage.prompt_tokens_details` is null.
- **Streaming** (Aurora's mode, verified): only the standard OpenAI final usage chunk (`prompt_tokens/completion_tokens/total_tokens`, `prompt_tokens_details: null`). **NO billing block, NO cost.** → Cost-from-billing is NOT achievable in streaming without a wasteful 2nd non-streaming call. Decision: skip cost; make tooltip correct via standard usage; add standard `prompt_tokens_details.cached_tokens` parsing (generic OpenAI win) since Aurora's OpenAiUsageData currently only parses DeepSeek `prompt_cache_hit_tokens`.

**Architecture notes for impl:**
- Per-turn client build: `RealApiFactory.build` (lib.rs:207) calls `api::build_api_client(config)` every turn. Team paths call build_api_client directly (build_runner/integration_runner/runner). → Wrapping the pool INSIDE build_api_client covers all paths.
- `ApiRequest<'a>` derives Copy → a pool wrapper can re-issue the same request across keys.
- ApiError variants: Network, Provider, Decode, InvalidRequest, RateLimit, Unauthorized, Cancelled. Failover-retryable (all raised at the pre-stream status check, so no emitted-content/duplicate risk) = {Unauthorized(401), RateLimit(429), Provider(5xx)}. Do NOT retry Network/Decode (may be mid-stream) / InvalidRequest(400, same for all keys) / Cancelled.
- Provider persistence: SQLite llm_providers via versioned migrations (ADD COLUMN pattern, see nickname/model_aliases migrations). apiKey is a column. Store key pool as new `api_keys TEXT` (JSON array) column. custom_params/custom_headers reach body/headers so must NOT hold keys.

**Plan (phased):**
- C. Remove providers (frontend, no rebuild): persisted `removedProviderIds` (app_settings), filter presets in initializeFromDatabase merge, Remove button for ANY provider in ProvidersSettings + a "restore hidden" affordance. Reversible (not code deletion).
- D. AgentRouter preset (frontend): OpenAI-compat, base https://agentrouter.org/v1, opencode UA+X-Title in customHeaders, seed glm-5.2 + gpt-5.5, key-pool field. Frontend preset like ATLAS/CODEX or a Rust catalog entry.
- B. Generic key pool + failover (Rust, rebuild): add `apiKeys: Vec<String>` to ProviderConfigSnapshot (api/client.rs) + snapshot builder (agent-runtime-client.ts) + LLMProvider.apiKeys + DB column; new api/pool.rs PooledStreamingClient wrapping build_single_api_client, round-robin start via AtomicUsize, failover on {Unauthorized,RateLimit,Provider}. Multi-key editor UI in ProvidersSettings.
- A. Tooltip/cache: add prompt_tokens_details.cached_tokens to OpenAiUsageData (openai_compat), verify header usage event mapping. No cost (streaming has none).

### Progress 2026-07-22 (session 1) — Rust core key-pool DONE (unverified: disk)
Implemented the generic, provider-agnostic key pool (Phase B core):
- `api/client.rs`: ProviderConfigSnapshot gains `api_keys: Option<Vec<String>>` (camelCase `apiKeys`) + `effective_keys()` (dedup/blank-strip/fallback). Split factory: `build_api_client` wraps in pool when >1 effective key, else calls new `build_single_api_client` (the old match). Tests added.
- `api/pool.rs` (NEW): `PooledStreamingClient` — per-turn round-robin via AtomicUsize cursor + failover on {Unauthorized(401), RateLimit(429), Provider(5xx)} ONLY (all pre-stream status-check errors → no duplicated output). Retries same request (ApiRequest is Copy) with next key, cloning the mpsc sender. Network/Decode NOT retried (may be mid-stream). Tests added.
- `api/mod.rs`: `pub mod pool;`.
- Patched all 6 literal ProviderConfigSnapshot constructions (ipc.rs, codex/adapter.rs, deepseek.rs, responses.rs, agent_v2.rs, client.rs tests) with `api_keys: None`.

**BLOCKER: drive E only 1.4 GB free (100% full). Cannot cargo check/build — Tauri rebuild needs several GB (OS error 112 risk per lesson). Rust changes are written-to-compile but UNVERIFIED. User must free disk on E before the Rust side can build/run.**

**Remaining (not yet done):**
- Rust: DB `api_keys TEXT` column (models.rs DbLLMProvider, schema.rs, migrations.rs new version, provider repo read/write); AppSettings `removed_provider_ids` (models.rs struct + repositories/settings.rs get/save arms); parse standard `prompt_tokens_details.cached_tokens` in OpenAiUsageData (provider_kernel_adapter.rs) → emit as cache_read so tooltip shows cache.
- Frontend: LLMProvider.apiKeys + dbToProvider/providerToDb mapping; snapshot builder (agent-runtime-client.ts buildProviderConfigSnapshot) send apiKeys; removedProviderIds store state + removeProvider/restoreProvider(All) actions + filter in initializeFromDatabase merge; ProvidersSettings.tsx Remove button (all providers) + restore-hidden affordance + multi-key pool editor; AgentRouter frontend preset (services/agentrouter.ts, OpenAI-compat, base https://agentrouter.org/v1, customHeaders {User-Agent: opencode/1.17.18, X-Title: opencode}, seed glm-5.2+gpt-5.5) injected like ATLAS/CODEX; types/database.ts AppSettings.removedProviderIds + DbLLMProvider.apiKeys.

### Progress 2026-07-22 (session 1) — FEATURE COMPLETE (frontend typechecks; Rust unverified: build pending)
Full stack implemented. Frontend `npx tsc -b --force` = exit 0 (clean). Rust written-to-compile but NOT built (user rebuilds via `pnpm tauri dev`).

**AgentRouter facts locked:** OpenAI-compat `https://agentrouter.org/v1`, Bearer auth, REQUIRES headers `User-Agent: opencode/1.17.18` + `X-Title: opencode` (else 401 unauthorized_client_error). Streaming = standard usage only (no billing/cost block; that's non-streaming only). Verified `headers.insert` override + adapter sets no default UA → custom UA header works.

**Rust (all done):** api/client.rs (apiKeys+effective_keys+split factory), api/pool.rs (PooledStreamingClient round-robin+failover on 401/429/5xx), api/mod.rs (pub mod pool), 6 snapshot literals patched, DB api_keys column (schema+migration v20 [SCHEMA_VERSION 19→20]+model+repo read idx20/write ?21), AppSettings.removed_provider_ids (struct+default+get/save arms), OpenAiUsageData.prompt_tokens_details + cache_read_tokens() helper wired into openai_compat mapping.

**Frontend (all done, typechecks):** types/database.ts (DbLLMProvider.apiKeys, AppSettings.removedProviderIds); useSettingsStore (LLMProvider.apiKeys, dbToProvider/providerToDb map, removedProviderIds state+default+load+save, removeProvider/restoreProvider/restoreRemovedProviders actions [restore uses saveToDatabaseImmediate before re-init to avoid stale debounced read], init filters removed presets BEFORE merge, AgentRouter preset injected, getLLMConfig sends apiKeys x2); provider-catalog.ts (ProviderCatalogPreset.customHeaders) + presetToProvider maps it; services/agentrouter.ts (AGENT_ROUTER_PRESET, opencode headers, glm-5.2+gpt-5.5); providers/types.ts ProviderConfig.apiKeys; agent-runtime-client.ts snapshot apiKeys (only sends when >1 non-blank); ProvidersSettings.tsx (ApiKeyPoolEditor, uniform Remove btn w/ 2-click confirm for ALL providers, removed-restore sidebar section, providerReady/keyPoolSize/hasAnyKey pool-aware); agent-window.css (removed-list + remove-btn styles).

**TEST after `pnpm tauri dev` rebuild:** (1) migration v20 runs clean; (2) AgentRouter appears in Providers with opencode headers pre-filled — paste key(s) → glm-5.2 works; (3) add 2+ keys to pool → verify round-robin/failover (kill one key); (4) Remove Fireworks/Atlas etc → gone + persists across restart → Restore brings back; (5) context tooltip tokens correct.

### Progress 2026-07-22 (session 2) - agent-window "maturity feel" audit (diagnosis only, no code changes)
User: "agent window works (runs commands, edits files) but does not FEEL mature vs Cursor/Codex - why?" Audited MessageBubble/ToolCallCard/AgentMarkdown/ConversationPane/useAgentWindowSend/useSmoothReveal: UI layer is at parity or beyond (optimistic echo, per-frame text coalescing, eased reveal, live write previews, approval-adjusted durations, shimmer thinking, compaction cards, jump rail, suggest drum). Conclusion: gap is behavioral, not visual - prime suspect is the MODEL (AgentRouter seed = GLM-5.2 vs Cursor=Claude 4.x / Codex=GPT-5-codex frontier agentic-RL models: terse narration, batched parallel reads, first-try edits, self-verifying builds), #2 relay latency rhythm (agentrouter.org hop + TTFT between tool calls), #3 voice rules exist in agent-prompt.ts but weaker models ignore them. Proposed 2-min test: run window on Claude/GPT-5.x same task -> if feel changes, UI was never the issue. Awaiting user reply on which model they run.

## 2026-07-22 — Apply Agent Window harness test summary 1

**Goal:** Apply the four recommendations from `E:\VOID-EDITOR\aurora-harness-test\aurora-agent-window-harness-test-results-summary-1.md`: vanilla HTML/CSS/JS diagnostics, unified background-process visibility, Git-aware harness guidance, and read-only browser DOM/state inspection.

**Plan:**
- Trace each report symptom to its owning tool definition, executor, backend command, and UI result renderer while preserving the heavily modified worktree.
- Implement focused fixes with strict contracts and tests; treat tool output as an expert developer-facing surface with clear recovery guidance.
- Run focused frontend/Rust validation, build checks as disk permits, and `graphify update .`; record all failures and retest evidence.

**Reality update:** `graphify query` could not start because the installed launcher raises `ModuleNotFoundError: graphify.__main__`; use scoped `rg`/source tracing as the fallback. The global `project-overview` skill describes LobeChat and is not authoritative for Aurora, so repository docs and implementation own the architecture for this task.

**User validation constraint:** After applying the fixes, run pnpm-based frontend validation only. Do not run Cargo, rustc, rustfmt, Clippy, or any other Rust command; Alvan will validate/rebuild the Rust side.

**Reality update:** The first combined process patch was rejected atomically because the `ide_event_sink.rs` test fixture context did not match the inspected slice. No source edit landed; continue with small patches against exact current snippets and verify after each group.

**Reality update:** The first source-consistency command was rejected by PowerShell parsing because a final regex embedded an unescaped double quote. No checks from that command ran; rerun with separate literal-safe `rg` expressions.

**Reality update:** Repository-wide `git diff --check` is not actionable because pre-existing broad LF→CRLF conversions make Git flag nearly every changed line as trailing whitespace. Restrict diff checks to task-owned paths and use `--ignore-space-at-eol`; do not normalize unrelated files.

**Added user finding:** Failed tools currently duplicate the raw execution error in both the ToolCallCard header and its expanded dropdown (screenshot: failed `browser_click` selector). Keep only failure affordance/icon/duration in the header; render the actionable error once inside the dropdown.

### Progress — harness recommendations and error surface implemented
- `read_lints` now runs vanilla `.js/.mjs/.cjs` through direct `node --check` args (no shell interpolation) and returns project-command guidance for uncovered HTML/CSS/JSX/TS paths.
- Background spawn/list/kill now share one stable `bg-*` identity backed by an authoritative Rust ledger registered before the async task starts; listing returns command/name/cwd/pid/start time.
- Registered bounded `browser_inspect_element` for the single agent browser with text, attributes, form state, visibility, bounds, and key styles; kept full-page DOM/eval hidden.
- Failed ToolCallCard headers no longer repeat raw result errors; the dropdown remains the single error-detail surface. The external harness is now an unstaged Git repository for follow-up testing.

**Validation reality update:** Focused UI tests pass 34/34 and the full frontend suite passes 199/199. Repository-wide `pnpm lint` fails with 66 errors/7 warnings in unrelated existing modules (MarkdownPreview, QuickOpenModal, StatusBar, SearchPanel, etc.); run task-scoped ESLint to prove these edits add no lint failure, and report the global gate honestly without expanding into a broad cleanup.

### Completion review — harness fixes
- Implemented real vanilla JavaScript syntax diagnostics and actionable HTML/CSS guidance, stable background-process spawn/list/kill identity, bounded browser element-state inspection, and a single dropdown-owned failure detail surface for Agent Window tool cards.
- Initialized the external harness as a Git repository without staging or committing its files. Focused tests pass 34/34, the full pnpm suite passes 199/199, task-scoped ESLint is clean, and `pnpm run build` succeeds.
- Repository-wide `pnpm lint` remains blocked by 66 errors/7 warnings in unrelated existing files. No Cargo, rustc, rustfmt, Clippy, or other Rust command was run; Rust validation is intentionally left to Alvan.
- Required `graphify update .` was attempted but the installed launcher still fails before project analysis with `ModuleNotFoundError: No module named 'graphify.__main__'`; graph output could not be refreshed.

## 2026-07-22 — Apply Agent Window harness test summary 2

**Goal:** Fix the two remaining regressions proven by `aurora-agent-window-harness-test-results-summary-2.md`: Node diagnostics receiving Windows verbatim (`\\?\`) paths, and `shell_spawn` process IDs disappearing before list/kill can resolve them.

**Plan:**
- Trace both values from agent-facing schema through executor routing into the native command, including whether `shell_spawn` is actually using the Rust sink or a legacy frontend executor.
- Add focused regression coverage first, then fix Windows Node-path conversion and make background-process ownership durable until the real descendant process exits or is killed.
- Run pnpm-only validation, manually audit Rust changes, and retry the required Graphify update. Do not run any Rust command.

**Root-cause evidence:** The persisted run-2 transcript proves native routing was active. Run 1's server survived because its old split `bg-*`/UUID kill path only reported success; run 2 then spawned onto the occupied port and `curl` reached the stale run-1 server. A later retest repeated the contamination by running `node server.mjs &` through `shell_execute` before `shell_spawn`. A clean Windows ancestry probe then exposed the independent product bug: `Git\\bin\\bash.exe` is a short-lived launcher that hands work to `Git\\usr\\bin\\bash.exe`, so Aurora tracked and cleaned the shim PID while npm/Node continued elsewhere. Launching `usr\\bin\\bash.exe` directly kept the listener under the tracked tree, and `taskkill /T` removed it.

**Implementation progress:** JavaScript checker arguments are now workspace-relative (preventing Windows `\\?\` paths). Shell discovery now prefers Git's real `usr\\bin\\bash.exe`, preserving the tracked PID ancestry for list/kill. Production background spawn also waits through a one-second startup window and returns early-exit output as an actionable error; process termination checks and reports the real `taskkill`/`kill` result instead of silently succeeding.

### Completion review — summary 2
- Confirmed with a live non-Rust Windows process probe that `Git\\bin\\bash.exe` loses the npm/Node tree while `Git\\usr\\bin\\bash.exe` remains its ancestor and `taskkill /T` frees the port. Ports 4173 and 4174 were clean after the probe.
- Permitted validation passed: full pnpm suite 199/199, `pnpm run build`, all three harness `node --check` calls through `pnpm exec`, and the harness test script. Task-owned source whitespace/conflict scan is clean.
- No Cargo, rustc, rustfmt, Clippy, or other Rust command was run. `graphify update .` was attempted again and remains blocked by the installed launcher's missing `graphify.__main__` module.

## 2026-07-23 — Background process termination is recorded in the log file

**Problem:** A background process's log ended wherever its output ended. A reader (the agent, later) could not tell a user stop from a crash, a clean exit, or a stalled writer — five explanations, no evidence. Verified against Claude Code's own harness: stopping a background task there leaves the same silent truncation, so this is a real class of bug, not an Aurora quirk.

**Change:** `ProcessLog` (`src-tauri/src/commands/mod.rs`) replaces the bare `Option<File>` and tracks line position, so every run now closes with one `[aurora] …` line naming how it ended: exit code, timeout, spawn failure, stopped by the user, or stopped by `shell_kill`. `StopReason` (User | Agent) is carried on `CommandStreamInfo` and set by `cancel_tracked_command_stream`, so the file distinguishes who stopped it. `cancel_command_stream` takes an optional `reason` ("user" default). `shell_spawn`'s `readOutputWith` now tells the model that the absence of an `[aurora]` line means the process is still running.

**Also fixed:** the cancel path never emitted the `done: true` meta chunk that the natural-exit path emits, so a cancelled stream's live view stayed spinning on a dead process. All loop exits now emit it. The dock's stop only enqueues a note to the agent when `liveTurns[threadId]` is set (the rule `useAgentTeamNotifier.ts` already follows) — with no live turn the queued slot has no boundary to drain at, and the note surfaces later inside an unrelated turn.

**Verified:** `rustfmt --edition 2021 --check` parses all four edited Rust files (only a pre-existing formatting diff at `mod.rs:427` remains); `tsc --noEmit` and ESLint clean on the changed TS. Five unit tests added in `commands/mod.rs` cover footer placement, the no-file case, `StopReason` parsing, and duration formatting — not run here, Rust validation is Alvan's. Nothing verified in the running app.

## 2026-07-23 — Composer picker keyboard nav + dock/drum overlap

**Arrow keys snapped back:** `AgentComposer` runs `refreshPickers` on `onKeyUp`, and `refreshMention`/`refreshSlash` called `setSel(0)`/`setCmdSel(0)` unconditionally — so the keyup of the very arrow key that moved the highlight reset it. Both refreshers now funnel through `applyMentionQuery`/`applySlashQuery`, which compare against a query ref and do nothing when the query is unchanged. Side effect: Escape now actually dismisses (previously the following keyup reopened the menu immediately). Row `onMouseEnter` → `onMouseMove` so a list scrolling under a resting cursor cannot steal the highlight, and the active row `scrollIntoView({block:"nearest"})` so keyboard-only nav can see rows past the 280px fold.

**Drum overlap:** docked cards tuck their bottom 12px behind the next element, which only works because the composer is opaque. The suggestion drum is chrome-less and mask-faded, so a tucked card showed its own open bottom edge and the drum's neighbour rows painted over the card. `ConversationPane` now sets `data-drum` on `.agw-composer-dock` when the drum will render, and the cards close themselves (border + full radius, 6px gap) instead of tucking.

**Verified:** `tsc --noEmit` and ESLint clean; CSS braces balanced. Not verified in the running app — no interactive check of the picker or the dock.

## 2026-07-25 — React `onWheel` cannot preventDefault (three canvases fixed)

**Problem:** `CanvasDiagram.tsx:183` logged "Unable to preventDefault inside passive event listener invocation." React 17+ delegates `wheel` (plus `touchstart`/`touchmove`) at the ROOT container with `{ passive: true }`, so `preventDefault()` from an `onWheel` prop is discarded by the browser. Every wheel gesture over the diagram therefore scrolled the surrounding dock at the same time as it zoomed/panned.

**Change:** the three surfaces that need to swallow the wheel now bind natively on their own element with `{ passive: false }` in a `useEffect`: the Mermaid canvas (`CanvasDiagram`), the reply-suggestion drum (`ConversationPane`), and the tool-card chip strip (`ToolCallCard`). `CanvasDiagram`'s `zoomAt(nextScale, …)` became `zoomBy(factor, …)` reading the current scale inside the `setViewport` updater, so the listener stays bound across viewport changes instead of resubscribing per zoom frame. `isControl` hoisted to module scope.

**Verified:** `tsc -b` 0, ESLint 0 on all three files, vitest 36 files / 200 tests, `vite build` 0. Not verified in the running app — no interactive wheel check.

## 2026-07-25 — workspace_tree measured: the model's first tool call loses 98.5% of the tree

**Investigation, not a change yet.** Reproduced Aurora's `workspace_tree` output shape + `conversation.rs`'s history compactor against this repo (probe script kept in the session scratchpad). Default args (`depth:3`, `include_file_stats:true`, `max_files_for_stats:300`):

- walks 3,066 nodes; reads **127 MB of file CONTENT** (sequentially, one `spawn_blocking` at a time) purely to compute `lineCount` — ten `graphify-out/*.json` files at ~11 MB each are inside the first 300 stat'd
- raw payload ≈ 469 KB (~117k tokens); `result_cap_for("workspace_tree")` = 8 KiB
- `compact_json_arrays` halves the largest array 17 times → **47 of 3,066 nodes survive (1.53%)**
- because halving keeps the FIRST half of a dirs-first-alphabetical list, the survivors are `.aurora`…`DOCS`, `example-themes`; **`src/`, `src-tauri/`, `scripts/`, `public/` are dropped entirely**. No per-directory marker says so — only a top-level `historyTruncated: true`.

**Other findings:** `grep` shells out to a bare `rg` from PATH with no bundling (`tauri.conf.json` ships only ONNX dlls + typing-assist txt) — the `grep`/`grep-regex`/`grep-searcher` crates ARE in Cargo.toml but unused anywhere. No glob/find-by-name tool exists. `read_directory` drops `node_modules|target|dist|.pnpm|.git` as entries entirely (name never reaches the tree) while `ARTIFACT_DIRS` shows the rest name-only — two different policies. Tree ignores `.gitignore`; `rg` honours it — so the tree lists files grep will never search. `size` is `content.len()` after a full read although `entry.metadata()` already had it. `file_cache::read_files_parallel` (rayon) exists and is not used here.

**Also confirmed:** the Agent Window sends NO project layout — `useAgentWindowSend.ts:974` sends only `<workspace_root>`. So `workspace_tree` really is the model's first call on every non-trivial task.

## 2026-07-25 — ripgrep is now bundled; `grep` no longer depends on the user's PATH

**Problem:** `ripgrep_search` spawned a bare `rg` from `PATH`. Nothing bundled it (`tauri.conf.json` shipped only ONNX dlls + typing-assist text), so on any machine without ripgrep — i.e. most end-user machines — the agent's primary content-search tool returned `Failed to execute rg` and the model lost code search entirely.

**Change:** vendored `rg` 14.1.1 at `src-tauri/binaries/rg-<target-triple>.exe` and shipped it via `bundle.externalBin`. New `src-tauri/src/sidecar.rs` resolves it once per process: bundled copy next to the app executable first, user's `PATH` second, `None` third (with an actionable message naming reinstall + the ripgrep URL instead of a raw spawn error). Bundled deliberately WINS over PATH — rg's `--json` event stream is a versioned interface and the parser in `ripgrep_search` is only tested against the pinned binary. `build.rs::stage_sidecar_binaries` mirrors the bundler's rename into the Cargo target dir (root + `deps/` + `examples/`) so `cargo run`, `cargo test` and `tauri dev` resolve identically to a shipped install — search working in dev and failing in the installer is the worst possible split. `files_are_identical` lost its `#[cfg(windows)]` since both stagers use it now.

**Note on git:** unlike the ONNX dlls (explicitly gitignored, "each developer populates locally"), the rg binary is left TRACKED on purpose — an untracked build input would let a clean clone or CI produce an installer with no ripgrep, silently restoring the bug. 5.16 MB. Alvan's call to override.

**Verified:** `cargo check` 0 (5 pre-existing warnings, none new); `cargo test --lib` **717/717**; confirmed `build/debug/rg.exe` and `build/debug/deps/rg.exe` staged and `--version` runs. Note `.cargo/config.toml` sets `target-dir = "build"`, so artifacts are under `build/`, not `target/`. Not verified in a packaged installer — no `tauri:build` run.

## 2026-07-25 — Workspace tools redesigned: `glob` added, `workspace_tree` rebuilt, `shell` made explicit

**`workspace_tree` rebuilt** (`tools/file_workspace_search/workspace_tree.rs`). Walk and stats are now separate passes: the walk does no file I/O, selection fits the budget, and only the SURVIVING files are stat'd (`size` from metadata, `lineCount` from a streaming byte scan, rayon-parallel, files >2 MB skip the count). Selection is one rule — every directory lists at most `q` entries, `q` found by binary search — so a directory can never vanish because an unrelated one was large. Four markers make a childless directory unambiguous: `artifact` / `hidden` / `depthLimited` / `elided: N`, plus a top-level `truncated` + `note`. Payload made terse (workspace-relative forward-slashed paths matching glob/grep, no `extension`, `largeFile` only when true, `size` only without `lineCount`, empty `children` omitted). **Measured on this repo: 469 KB payload + 127 MB read → 49 KB in 27 ms, 500 of 3069 nodes, `src`/`src-tauri`/`scripts`/`public` all present.**

**`result_cap_for("workspace_tree")` = 64 KiB** (new `MAX_TREE_RESULT_LENGTH`). The generic 8 KiB cap was below what any useful map costs, so EVERY call hit `compact_json_arrays` — the pass that left 47/3066 nodes with `src/` deleted. A default call now never reaches the compactor.

**`glob` added** (10th bucket tool; BUILTIN_TOOL_COUNT 23→24). `rg --files --null --glob`, newest-first, honours .gitignore, reports true total + recovery on truncation. **Gotcha:** ripgrep anchors slash-bearing globs to the CWD, not the path operand — so it runs *in* the search root with no path argument (passing the root as an operand made `src/**/*.ts` silently match nothing while `**/*.rs` worked).

**Shell made explicit.** `shell` is now REQUIRED on `shell_execute`/`shell_spawn` and the enum is emitted whenever ≥1 shell is usable (was ≥2, so single-shell machines had no parameter at all). The user-chosen default is gone entirely — `ShellProfiles::default_id`, `shell_profiles_set_default`, and the "Use by default" button. The fallback is derived (POSIX first, Ready>Degraded) and now only covers the terminal/diagnostics. Legacy persisted `defaultId` is ignored by serde, not fatal (pinned by a test).

**PTY terminal wired to the registry.** `shell-config.ts` hardcoded `C:\Program Files\Git\bin\bash.exe` + bare `pwsh.exe` — so a user whose Git lived elsewhere got a terminal that would not start while Settings → Shells listed the verified path. New `shell_interactive_config` command + `shell::resolve_interactive` (finally using `ShellKind::interactive_args`, which was dead). Rust returns exe + interactive flags + env overlay (incl. the MSYS PATH repair the frontend never had); the frontend appends only its prompt init. No fallback guess: an unregistered shell says so and points at Settings.

**Verified:** cargo test --lib **742/742**, zero Rust warnings; tsc 0; eslint 0 errors; vitest 36 files/200 tests; vite build 0. Not verified in the running app.

## 2026-07-25 — Dev build config was tuned for CI, not for the edit→rebuild loop

**Machine is not the bottleneck:** i5-12600K (10c/16t), 32 GB, NVMe. The config was.

**Three changes.** `.cargo/config.toml` dropped `CARGO_INCREMENTAL = "0"` — right for CI (nothing is reused between runs), exactly wrong locally, where it made every Rust edit under `tauri dev` recompile the whole `aurora` crate from scratch. Deliberately NOT replaced with `"1"`: an env var applies to every profile and would enable incremental for RELEASE too, fighting `codegen-units = 1` + `lto = true`. It now lives as `incremental = true` under `[profile.dev]`.

`[profile.dev] opt-level = 1` (which applied to `aurora` itself) moved to `[profile.dev.package.aurora] opt-level = 0`, plus `debug = "line-tables-only"` there. `[profile.dev.package."*"] opt-level = 2` is unchanged — the speech path needs it, and deps compile once.

**Why per-package scoping matters:** cargo's `"*"` glob covers dependencies only, never workspace members, so `[profile.dev]` settings apply to deps by default. Putting `debug`/`opt-level` directly on `[profile.dev]` would have invalidated candle/ONNX/tokenizers/tauri and forced a full-tree rebuild. Scoped to `[profile.dev.package.aurora]`, only Aurora rebuilds.

**Verified:** TOML re-read, package name confirmed `aurora`, no `[workspace]` section (src-tauri is the root package, so its `[profile.*]` is honoured). NOT compiled — the build dir was locked by a running `pnpm tauri dev`. Also noted but not changed: `build/` is 17.4 GB (eleven stale `__verify_phase*` crates), `lld-link.exe` is installed but unconfigured, no sccache.

## 2026-07-25 — Background process dock lost live processes on project switch

**Bug (user-reported regression):** start a background process in project A, switch to project B, come back — the dock is empty while the process is still running, and there is no way to stop it except asking the agent.

**Root cause:** `useAgentBackgroundStore` was a frontend-only shadow copy of state Rust owns. It was built ONLY from `shell_spawn` tool results and read ONLY as `byThread[currentThreadId]`, while Rust's `ACTIVE_COMMAND_STREAMS` ledger is process-global and knows nothing about threads or projects. Switching project changed the thread key → dock found nothing; reloading the window emptied the store entirely while processes kept running.

**Fix.** New `#[tauri::command] shell_background_processes()` in `commands/mod.rs` exposes the ledger to the UI (it was previously reachable only by the MODEL via `shell_list_processes`). `BackgroundTaskDock` reconciles against it on mount, on thread change, and on a 15s poll — adopting live processes it never saw and settling rows Rust no longer lists (fixes stale "Running" after a reload). The dock now renders `byThread[current]` UNION every running process from any thread: a running process is a machine-level fact, so it stays reachable and stoppable from any project; finished rows stay scoped to their thread as history.

**Also:** `settle`/`dismiss` dropped their `threadId` parameter and now search all threads by process id. Thread-scoped mutation was the second half of the bug — stopping an adopted process from another project would have silently done nothing.

**Verified:** cargo test --lib **747/747** (three new shell_spawn tests; two existing ones updated — they used `workspace_root: None` and now hit the cwd guard, which is the intended new contract), vitest 36 files/203 tests, tsc 0, eslint 0, cargo check 0.

## 2026-07-25 — Production build green; ripgrep sidecar confirmed in both installers

`pnpm tauri build` exit 0 in **5m24s** (release compile of the `aurora` crate). Artifacts: `build/release/bundle/msi/Aurora_2.0.0_x64_en-US.msi` (212 MB) and `build/release/bundle/nsis/Aurora_2.0.0_x64-setup.exe` (107 MB). Zero warnings from `aurora`; the only Rust warning is upstream (`esaxx-rs` MSVC `-std=c++11`).

**Sidecar verified end-to-end, not assumed.** `build.rs` staged `rg.exe` beside `build/release/aurora.exe` (what `sidecar::ripgrep()` resolves at runtime), and BOTH installer manifests reference it — `wix/x64/main.wxs` → `rg.exe`, `nsis/x64/installer.nsi` → `rg.exe` + `rg-x86_64-pc-windows-msvc.exe`. So `glob` and `ripgrep_search` work on a clean machine with no ripgrep on PATH.

**Deliberately NOT fixed — the "TOOL NAME" card.** `getProfessionalToolName` title-cases any unmapped name, so a model hallucinating `TOOL_NAME` renders as "TOOL NAME" mid-stream. Distinguishing unknown from known requires the tool roster, which lives in the Rust registry as the single source of truth; duplicating it in the frontend would recreate the exact drift class of bug as the dock regression above. The card already settles to a red error when the result lands.

**Reported, not fixed (pre-existing):** `toolStatus()` decides failure from an `[error]`/`[rejected]` string PREFIX rather than the structured `is_error` flag that already exists on both paths. Works today because both paths add the prefix — a convention standing in for a field.

## Task (2026-07-25): Agent Team redesigned into a real multi-agent engine — DONE (uncommitted)
User: "redesign the entire team implementation into something really matured". Brief = the "senior boss
with 5 juniors" model: members verify with real commands, ask the REAL boss and wait, investigate-only
tasks are legal, members are reachable multi-turn agents, boss steers mid-run.
- **Members are real agents**: new `team/member_actor.rs` runs each member on `ConversationRuntime`
  (compaction/trim/spill/streaming) with real registry tools (file bucket + shell_execute via agent_safety).
  Deleted `build_runner.rs` (2,334-line bespoke loop, 16-iter cap, idle nudges, alias table).
- **Real messaging**: new `team/mailbox.rs` (`TeamComms`) — mailboxes injected via the session queued-message
  slot at tool-result boundaries; `ask_member` waits on the addressed member's actual `reply` (ticketed
  oneshot, honest timeout); `ask_lead` parks on a lead inbox polled by `useAgentTeamNotifier` (2.5s) and
  injected into the REAL chat Lead; Lead answers via `team_reply` / grants via `team_grant_scope`
  (structured — `GRANT:` text parsing and all impersonation model calls deleted).
- **Done = the member's `report` tool** (done|blocked + summary); zero changed files is legal. Changed files
  tracked by the `ScopeGatedTool` decorator (runtime `Hook` can't veto → enforcement is a wrapper).
  `AgentStatus` = idle|working|waiting_input|blocked|failed|done (serde aliases load old brains);
  `TeamPhase` = forming|working|done|disbanded.
- **Dispatch rewritten**: one tokio task per member; `TeamRunStatus` carries live `members[]` + terminal
  `reports[]`; graceful cancel (token, 20s grace, then abort); 45-min watchdog; `run.json` snapshot.
  Blocked members don't fail the run — the Lead decides. Brain writes serialized via `TeamComms::lock_brain`
  (members are multi-task now; the old single-task interleave atomicity argument is gone).
- **Deleted dead regime**: `integration_runner.rs`, `run_planning` auto-planner, gate plumbing end-to-end
  (Rust AppSettings + settings repo + useSettingsStore + types), desiredIcs, 14 dead Tauri commands.
  `team_message` now actually DELIVERS into member conversations (was channel-tail-maybe).
- Verified: cargo test --lib 740/740 green (67 team tests), tsc -b clean, eslint clean. NOT runtime-tested
  yet — needs `pnpm tauri:dev` rebuild + live run (ask_lead round-trip, member shell, streaming under
  phase "working").
- **Team screen redesign probe** (user asked for complete frontend redesign): 5 live variants at
  `C:\Users\Alvan\Documents\aurora-team-screen-redesign.html` — recommended "Mission strip" (member status
  cards on top, chat below) + "Debrief" terminal state (per-member report cards). Awaiting user's pick
  before implementing.

## Team UI — FINAL VERDICT (2026-07-25, user-approved, build in progress)
Probe iterations landed on this exact design (probe: C:\Users\Alvan\Documents\aurora-team-redesign-v2.html, ★ card):
- **Team page is REMOVED.** The team lives ONLY in the agent-window right rail (like Canvas); rail is the one
  team surface; `team_show` opens the rail. Rail should be resizable later.
- **Rail = group chat, messenger style**: member bubbles stack LEFT (per-member tint + name label), Lead
  bubbles stack RIGHT (accent tint). System/lifecycle lines centered. **NO composer** — the user never texts
  the team; footer note "view only — talk to the team through the Lead".
- **Members dropdown, rail top-right**: "Members ▾" → "Team chat" entry + one row per member (state dot,
  name SHIMMERS while that member streams, file count / done / waiting). Picking a member lays their
  individual streaming view ON TOP of the group chat IN THE SAME AREA (exactly like today's chat↔transcript
  swap, but driven from the dropdown, no sidebar). "‹ Team chat" back link returns.
- **Main chat carries only TRACES, never team content** (no duplication):
  - INBOUND (member→Lead via ask_lead): the notifier-injected question turn renders as a compact PILL on the
    user side — member-colored name + "messaged you" — NOT as a full user bubble. Model still receives the
    full text; only the UI collapses it. Clicking the pill opens the Team rail.
  - OUTBOUND (Lead→team): team_message / team_reply / team_grant_scope render as their normal tool cards in
    the main chat ("sent — in Team chat"); the CONTENT renders as the Lead's right-stacked bubble in the
    group chat.
- Rationale: one conversation, two rooms, zero duplicated content; the rail sits beside the main chat which
  the ask_lead loop needs (member question pill + Lead answer + member resuming all visible at once).

## Task (2026-07-25): Team UI final build — Team panel in right dock — DONE (uncommitted)
Implemented the FINAL VERDICT design (see entry above). Frontend only; needs runtime verify.
- NEW `src/agent-window/components/team/TeamPanel.tsx` — the one team surface, a right-dock tab
  ("team" added to DockTabKind/labels/RightDock + menu, icon `users`). Group chat messenger-style:
  members left (`.agw-tp-member`, per-member tint via existing bubble pipeline), Lead RIGHT
  (`.agw-tp-lead`, accent-tinted, self-end). Members dropdown top-right uses the SHARED popover system
  (`.agw-menu` + `.agw-menu-item`, same as model selector / context tooltip — user requirement);
  names shimmer (`agw-shimmer`) while that member streams; rows show status word (waiting_input amber).
  Picking a member swaps in `MemberTranscript` (ported verbatim from TeamScreen incl. draft hand-off
  baseline logic) in the same area; `‹ Team chat` returns. NO composer — footer "view only — talk to
  the team through the Lead".
- DELETED `TeamScreen.tsx` + centerView "team" takeover: useAgentUiStore lost CenterView/openTeam/closeTeam;
  AgentShell always renders ConversationPane; LeftRail Team entry + CommandCenter "Open agent team" +
  `requestOpenTeamView` (team_show/team_dispatch) all `openTab("team")` on useAgentWorkspaceStore.
  ~20 dead `.agw-team-*` CSS rules replaced by `.agw-tp-*` (validated with postcss).
- MAIN-CHAT TRACES (MessageBubble): user-role turns matching the notifier's stable markers render as a
  compact right-side pill, NOT a bubble — `[Team question — <role> is paused` → "<role> messaged you"
  (amber pulsing dot) and `[Automatic team notification` → "Team run finished — report requested"
  (green dot). Click opens the Team tab (lazy store import to avoid an import cycle). Model still
  receives full text; only the UI collapses it. Lead's team_reply/team_message/team_grant_scope show
  as their normal tool cards; content renders in the group chat (Rust posts it as a lead channel event).
- Verified: tsc -b clean, eslint clean (touched files), agent-window vitest 17 files / 79 tests green,
  postcss parse clean. NOT runtime-verified — needs `pnpm tauri:dev`: dropdown open/swap, lead-right
  stacking, pill rendering on a real injected question, trace click opening the dock.

## Team panel polish (2026-07-25, follow-up user feedback) — DONE
- Per-member COLORED bubbles removed ("outside of professionalism"): both sides of the team group chat
  now use the ONE neutral bubble material (`--agw-bubble-user`), members left / Lead right, identity via
  name label + alignment only (Slack/Teams convention). `authorColor`/`bubbleTint` gone from TeamPanel;
  dropdown names + member-view header neutral too (status dots stay — semantic state, not identity).
- Long-message COMPACT VIEW on every settled team bubble incl. the Lead's: exported
  `CollapsibleBubbleBody` from MessageBubble (the user-bubble 6-line clamp + fade + chevron) and wrapped
  every settled group-chat message in it. Live drafts stay unclamped while streaming.
- Verified: tsc, eslint, postcss, MessageBubble vitest — all clean. Runtime verify still pending.

## Team panel bubble polish round 2 (2026-07-25) — DONE
User corrections applied, all verified (tsc/eslint/postcss/vitest 79 green):
- Long-message behavior is the TOOL-CARD contract, not clamp+expand: bubble body = `.agw-tp-clip`
  (max-height 300px, inline scroll, no chevron, no fade, no grow). CollapsibleBubbleBody stayed
  private to MessageBubble (user bubbles only).
- Bubbles are ONE neutral material both sides (`--agw-bubble-user`), members left / Lead right.
- Identity = the author NAME CHIP: `.agw-turn-label` (new stable class on MessageBubble's label span)
  gets a chip treatment inside team bubbles — `color-mix(currentColor 13%)` wash so the chip always
  matches the label color passed in (member color / muted for Lead).
- @mentions INSIDE message text render as chips (Slack convention, one uniform accent style):
  `prettifyMentions` markdown mode now emits `[@Name](#mention-<id>)`; AgentMarkdown's `a` component
  intercepts `#mention-` hrefs and renders `.agw-mention-chip` spans (never an anchor). Works in group
  chat AND member transcripts; plain mode (system banners) stays bare text.

## 2026-07-25 — Team member views became dock TABS + bubble scroll-trap fix
- User verdict: the in-place member swap ("‹ Team chat" overlay) was wrong for a tabbed dock — picking
  a member in the Members dropdown now opens `member:<agentId>` as its OWN right-dock tab (like file
  tabs: session-only, never persisted; re-dispatch mints new ids so a stale tab shows an honest "run
  has ended" state). New `MemberPanel.tsx` owns the member transcript (poll + draft hand-off + its own
  auto-scroll); `TeamPanel.tsx` is now group-chat-only. Shared bits split: pure helpers (displayName,
  statusWord/Tone, draftEvents, hasDraftContent) → `team-ui.ts`; view atoms (LiveDraftTurn,
  TeamChatSkeleton) → `team-atoms.tsx` (components-only, fast-refresh rule). Member tab pill shows the
  member's identity-color dot (`.agw-tabpill-dot`, `authorColor`).
- Scroll-trap root cause: `overscroll-behavior: contain` on `.agw-tp-clip` — Chromium treats every
  `overflow:auto` box as a scroll container, so `contain` swallowed the wheel even on SHORT bubbles,
  freezing the team feed whenever the cursor rested on a bubble. Removed `contain` there (default
  chaining: long bubble scrolls in place, then hands off to the feed). Keep this in mind for any
  future inner scroller inside a feed.
- Store: `openMemberTab(agentId, title)` in useAgentWorkspaceStore; `DockTabKind` + "member",
  `DockTabInstance.memberId`. tsc/eslint clean, 80/80 agent-window tests green. Runtime still unverified.

## 2026-07-25 — Typography audit: Aurora agent window vs T3 Code (Alpha)
- Measured both live windows with qg-probe + screen captures at the SAME 1.5x DPI (144), then read the
  shipped CSS of each. T3 Code = Electron; its renderer CSS/fonts are on disk at
  `%LOCALAPPDATA%\Programs\t3-code-desktop\resources\app.asar.unpacked\apps\server\dist\client\assets\`
  (index-BsZYMPVf.css + index-C0HqD506.js) — no asar unpacking needed for future reference probes.
- Finding (user's instinct was right, and it is NOT the typeface): T3 = DM Sans Variable, default UI
  weight **500** (160 `font-medium` vs 55 `font-semibold`, 1 bold), tracking **0** almost everywhere,
  chrome centred on 12/14px, hierarchy built with COLOR (muted #818181 on #161616). Aurora = Inter
  Variable, **81% of weight declarations are >=600** (95x600 + 15x650 + 12x700, only one 400; all 20
  inline `fontWeight` in .tsx are 600), global negative tracking (-0.006em, headings -0.014/-0.017em),
  chrome centred on 10/11px (266 of ~310 size decls <=12px), hierarchy built with WEIGHT.
  => semibold + negative tracking + 11px is what reads "dense/AI-app"; light + neutral tracking + 12px
  reads "matured". Aurora's PROSE tier (15px/1.75, whole-px heading scale, no -webkit-font-smoothing)
  is already good — the problem is the CHROME.
- Also worth stealing: T3 paints a 3.5%-opacity fractal-noise grain over `body::after`. Both apps use
  the exact same #161616 canvas; theirs reads as material, ours as a void.
- ACTED ON IT the same session (all frontend, HMR-visible, no Rust rebuild):
  * `.agw-root` gained a **weight scale** (`--agw-fw-body/medium/strong/display` = 400/500/600/700) and
    ALL 151 `font-weight` literals in agent-window.css now resolve through it (118 medium, 27 strong,
    5 display, 1 body), plus the 17 inline `fontWeight: 600` in .tsx → `var(--agw-fw-medium)`.
    Promoted back to `strong`: pane title, active tab pill, settings nav title + active row,
    `.agw-md` h1-h4 and `<strong>`. Demoted from display to strong: model effort, browser-suggest
    head, ghost-accept, skill eyebrow/badge, image-done. Loudness of the whole window is now FOUR
    numbers — retune there, never per-rule.
  * Root `letter-spacing: -0.006em` → `normal`. Tracking is applied where the SIZE earns it; the prose
    tier (`.agw-md` -0.009em) and headings (-0.014/-0.017em) keep theirs.
  * Chrome type scale moved up one step: micro 10→11, label 11→12, ui 12→13, md 13→14 (md now equals
    body deliberately; the scale is 11/12/13/14/15, five real steps).
  * `AgentIcon` "chat" (conversation header + rail thread rows) redrawn: was an outlined bubble with
    two interior text lines at the same 1.8 stroke — at 14-16px the interior collapsed into a smudge.
    Now TWO staggered pill bars (long left / short right, 2.9 stroke) = this app's own transcript shape.
    An intermediate "refined bubble" pass was rejected by the user as too similar; don't go back to it.
- Verified: tsc clean, eslint clean (4 pre-existing exhaustive-deps warnings), 17/17 agent-window test
  files green, and confirmed live in `pnpm tauri:dev` via screen capture. Comparison crops in scratchpad:
  `cmp1.png` / `cmp2.png` (before, vs T3), `icon2.png` (new glyph at 6x).

## 2026-07-25 — Composer rail: the dead footer became the ambient-state slot
- The strip under the composer only ever held "AI can make mistakes…" (or a transient mic/refine
  notice) while SIX cards stacked ABOVE the composer, each shoving the transcript down when it woke
  up. New `components/composer-rail/`: `ComposerRail.tsx` (fixed-height strip — notice slot centred,
  chip cluster absolutely positioned right so chips can never shift the text) + `RailChip.tsx`
  (glyph + tabular readout + pulsing attention dot; opens its panel UPWARD in a shared `.agw-menu`
  popover, pointerdown-capture + Esc to close, body mounted only while open so panel polling stays
  off until then).
- **The rule for adding a tenant: ambient → chip, turn-BLOCKING → card.** `ApprovalBar` and
  `QuestionPrompt` (ask_question) deliberately KEEP their docked cards — a stalled agent hidden behind
  a 12px chip is a hang the user cannot see. User picked this explicitly during the probe.
- Moved into chips: `BackgroundTaskDock` + `AgentTaskPanel`, both now taking `variant="dock"|"popover"`
  (popover = no card surface, no collapse toggle, `.agw-crail-panel` + scrolling body). Removed from
  `ConversationPane`'s composer dock. Union rule for "which processes are visible" extracted to
  `visibleProcesses(byThread, threadId)` in useAgentBackgroundStore so the chip count and the list it
  opens cannot disagree.
- Verified: tsc clean, eslint clean (4 pre-existing warnings), 18/18 test files incl. new
  `ComposerRail.test.tsx` (6 tests: disclaimer vs notice, running/total count + attention only while
  running, cancelled todo counts as closed, panel mounts only on click, one chip per system in stable
  order). Rail confirmed rendering live in tauri:dev; the CHIP + POPOVER path is not yet runtime-
  verified because nothing was spawned — first live run should start a background process and a
  todo list.

## 2026-07-28 — T3 Code (pingdotgg/t3code) capability audit vs Aurora agent window
- Cloned to scratchpad (`.../scratchpad/t3code`, shallow). Shape is NOT ours: Node WS server wrapping
  external CLI agents (codex/claude/cursor/opencode app-server over JSON-RPC) + React web app + Electron
  shell. Provider adapters, remote access, and the WS transport do NOT transfer. What transfers is the
  UI/capability model and the orchestration vocabulary (`docs/reference/encyclopedia.md` is the best file
  in the repo: command → decider → domain event → projector → read model, plus reactors and receipts).
- Confirmed gaps on our side (git grep): no git-worktree environments, no per-turn diff, no
  pending-context model in the composer, no user keybindings file, no port discovery, no plan artifact,
  no prompt stash. We DO already have: checkpoints (git CLI shadow repo), ReviewPanel, BrowserPanel +
  browser tools, terminal, command center, attachments store, team runtime.
- Ranked steal-list written for the user (worktree environments > turn diff > pending contexts > plan
  artifact > port-discovery preview > keybindings file > prompt stash > agent browser cursor >
  runtime receipts). Nothing implemented yet — awaiting direction.

## 2026-07-28 — Plan Canvas + todo rebuild (end to end, NOT runtime-verified)
- Plan mode now produces a real document: `<workspace>/.aurora/plans/<nnn>-<slug>.aurora.md`, YAML
  frontmatter + markdown body, rendered live in the Canvas. Its steps ARE the task list. Full design +
  file map in `DOCS/agent-plan-canvas.md`.
- THE load-bearing decision: **prose is a document, step status is structured state.** A plan is NOT a
  Canvas artifact — artifacts are append-only immutable versions, so a status flip would churn v2..v20
  and fight the version picker. Status flips rewrite frontmatter ONLY; `document.rs` guarantees the body
  round-trips byte-for-byte (incl. CRLF — do not normalise, it churns the user's diff every flip).
- THE other rule: **a spinner must never lie.** An `in_progress` step carries `runId` (= the claiming
  thread). The Canvas spins only when that thread is in `useAgentChatStore.liveTurns`; otherwise the
  step renders "Paused" with inline help. Covers user-stops, window-close, and returning hours later.
  A user-set in_progress (from the UI command) deliberately carries NO run claim, so it cannot spin.
- Mode split is deliberate and enforced in `agent-execution-mode.ts`: `plan_write` = **Plan mode only**
  (the one permitted write there; Agent mode must not rewrite what the user approved), `plan_step_update`
  = **Agent/Team only** (authoring != marking progress). `plan_read`/`todo_read` everywhere.
- TODOS WERE STRUCTURALLY UNFOLLOWABLE and are rebuilt: old `todo_write` emitted a Tauri event and
  forgot — no read-back tool, no persistence (store was "memory-only"), full-replace every call, no ids.
  After a compaction the agent re-invented the list from a summary. Now: durable
  `<sessions_dir>/<thread>.todos.json`, stable ids carried forward by content, new `todo_read` (list +
  cursor) and `todo_update` (one id), and EVERY result echoes the materialized list.
- UNIFICATION: a plan always wins. `todo_store::resolve()` returns Plan-or-Todos; `todo_read` projects
  plan steps transparently; `todo_write`/`todo_update` refuse to build a rival list and redirect to
  `plan_step_update`. Plan step ids ARE the todo ids. `publish_plan_as_tasks()` fires the todo event on
  every plan change so the Task panel/chip can never disagree with the Canvas.
- BUILTIN_TOOL_COUNT 24 -> 29 (+3 plan, +2 todo). Non-browser registry count 16 -> 21; both pinned in
  `tools/mod.rs` tests.
- Verified: 841 Rust tests, 182 frontend tests, tsc, eslint all green. NOT runtime-verified — needs a
  live Plan-mode conversation to confirm authoring, the spinner, and the paused state.

## 2026-07-28 — Turn durations + Project details panel (NOT runtime-verified)
- "Worked 4m" now renders greyed in every assistant turn footer beside Copy/Retry, and ticks live
  ("Working 2m") while the turn streams. NO new persistence was needed: `ConversationMessage.timestamp`
  is already on every message, so `buildTurns` just records `startedAt` (the prompting USER message —
  queueing + model latency belong to the wait) and `endedAt` (the LAST assistant message merged into
  the turn). `turnWorkedMs`/`formatWorkedDuration` in `components/timeline.ts` are pure + tested
  (5 cases incl. clock skew -> null, per-turn scoping so idle hours never land on the next turn).
  Live counter derives from a `now` clock advanced by the interval — do NOT setState inside the effect,
  eslint `react-hooks/set-state-in-effect` blocks it.
- PROJECT DETAILS opens as a right-dock TAB (`kind: "project"`, `projectRoot`), not a modal — user's
  call, and it matches the member-tab precedent. Right-click a project in the rail -> "Project details".
  New `openProjectTab(root, title)` on useAgentWorkspaceStore; `ProjectPanel.tsx` renders it.
- Backend `commands/project_stats.rs` -> `project_stats_get(workspaceRoot)`. Reuses usage_stats' scan
  shape and re-exports its DayUsage/ToolUsage/ModelUsage. KEY DIFFERENCE from usage_stats: it sums
  PER-TURN durations for "time worked" instead of last-minus-first, which counts lunch. Both are
  reported (`activeMs` vs `spanMs`). Also returns per-conversation rows, top models, top tools,
  and the 5 longest turns WITH their prompt preview (a duration alone is trivia; the prompt is
  actionable). `same_workspace()` normalises separators/case — raw string compare silently produced
  empty projects.
- Verified: 847 Rust tests, 187 frontend tests, tsc + eslint clean. NOT runtime-verified.

## 2026-07-28 — One built-in doctrine (`design_guidelines`), built-in SKILLS removed
- Aurora now ships EXACTLY ONE piece of built-in guidance: an adapted surface-philosophy doctrine.
  It is deliberately **not** a skill — skills are a user-owned catalogue (listable, searchable,
  toggleable, deletable) and this is a standing instruction. So it can never be listed or switched off.
- TWO-PART DELIVERY (user's choice): (1) `SURFACE_DOCTRINE_CORE` in `src/services/surface-doctrine.ts`
  rides in EVERY system prompt via `agent-prompt.ts` — ~10 lines of non-negotiables (no eyebrows /
  no cardify-everything / no OK-Submit / no colour-only state / a spinner must never lie / reuse
  --agw-* tokens / copy speaks to the user). (2) Full doctrine in Rust
  `src-tauri/src/tools/design/doctrine.rs`, served by the `design_guidelines` tool with
  `topic: visual|writing|both` so a copy task doesn't pay for the layout half.
- CORE lives in TS and the depth lives in Rust ON PURPOSE — each has exactly one home, so there is no
  second copy to drift. Do not duplicate CORE into Rust.
- Content is ADAPTED not ported: marketing/pricing/conversion material dropped (irrelevant to in-app
  surfaces); anti-slop gate, state coverage, a11y (WCAG 2.2 AA), and copy/psychology rules kept whole.
- BUILT-IN SKILLS DELETED (all 6). They described Aurora's own stack (typescript, react-frontend,
  tauri-rust, mcp-integration…) so they were noise in the catalogue whenever the user's workspace was
  Python/Go/anything else. `BUILTIN_SKILLS` is now `[]`; the Skills page hides the "Built-in" filter
  when its count is 0. Skills are now purely project + global.
- `skills.test.ts` used the built-ins as fixtures; rewritten against stubbed WORKSPACE skills
  (`stubWorkspaceSkills` helper) so the real behaviour (toggle gating, explicit-attachment bypass,
  MAX_ENABLED_SKILLS cap, lookup, search) is still covered. GOTCHA: a discovered skill's storageKey is
  derived from its SOURCE PATH lower-cased (`workspace:e:/repo/.aurora/skills/<id>/skill.md`), NOT its
  id — toggles and explicit keys must use that shape.
- BUILTIN_TOOL_COUNT 29 -> 30; non-browser registry 21 -> 22.
- Verified: 853 Rust tests, 193 frontend tests, tsc + eslint clean. NOT runtime-verified.

## 2026-07-29 — Agent turns ending mid-thought: output cap, not a network drop (IN PROGRESS, PAUSED)
- SYMPTOM the user hit: model on `xhigh` reasoning thought for ~1 min, then the stream "ended out of
  nowhere" with no answer and no error. Their pasted reasoning transcript (`.aurora/transcript.md`,
  29,048 chars ≈ 7.2–7.8k tokens) stops mid-identifier (`usePrefersReduced`) with zero visible reply.
- ROOT CAUSE (arithmetic, confirmed by reading the code — not runtime-observed): the output cap was
  8192 (`conversation.rs` RuntimeConfig default + 4 frontend fallbacks). `anthropic_thinking_budget`
  gave `xhigh` 90% OF that cap = 7,372 thinking tokens, leaving ~820 to answer in. On OpenAI-compat
  and Responses, reasoning bills against the same `max_tokens`. Either way reasoning ate the whole
  budget and the turn ended at the cap. The transcript size lands right on 7,372.
- SECOND BUG, why it was silent: Rust DID detect it (`conversation.rs` `is_length_stop` emits an
  `AssistantEvent::Error{recoverable:true}` saying the reply is cut off) but
  `agent-runtime-client.ts` had `case "error": break;` — the ONLY event in that switch with no
  callback. The warning was dropped on the floor, so the turn just stopped.
- THIRD BUG (latent, not what bit here): all three SSE drivers treated stream EOF as a successful
  turn (`None => break`, then `finish_reason.unwrap_or("stop")`). A dropped connection was
  indistinguishable from a real completion.
- FIXES APPLIED (uncommitted): (1) thinking budget is now ADDITIVE — tier multiples of the answer
  budget (low ½×, medium 1×, high 2×, xhigh 3×) and `max_tokens` raised to answer+budget via new
  `anthropic_max_tokens_with_thinking`, clamped to `ANTHROPIC_MAX_TOKENS_CEILING` 64k;
  `customParams.max_tokens` still overrides (it merges last). (2) default cap 8192 → 16_384 in Rust
  and a new `DEFAULT_MAX_OUTPUT_TOKENS` const replacing 4 scattered frontend fallbacks. (3) all three
  drivers now track a terminator (`[DONE]` via new `frame_has_done_marker`, OpenAI `finish_reason`,
  Anthropic `message_stop`, Responses `stop_reason`) and return `ApiError::Network` on EOF without
  one. (4) keepalives (tcp 30s + h2 20s, `http2_keep_alive_while_idle`) on the 3 streaming clients —
  deliberately still NO request timeout, a long think is legitimate. (5) runtime notices now surface:
  new `onRuntimeNotice` on `AgentCallbacks`, new `notice` timeline kind + `appendNotice`, new
  `NoticeCard.tsx` + `.agw-notice` CSS (mirrors `.agw-injection`, warning role, icon carries state so
  it isn't colour-only). Rendered as its OWN marker, never appended to message content — a runtime
  limit is not something the model said. `noticedMessages` set dedupes it against the `onError`
  prose path.
- VERIFIED SO FAR: `cargo check --lib` clean (before the new tests were added). NOT YET RUN:
  `cargo test --lib api::` — new tests were appended to `api/openai_compat.rs` and `api/anthropic.rs`
  (truncated-stream → error, `[DONE]`/`finish_reason`/`message_stop` → ok, length/max_tokens → ok)
  plus rewritten budget tests in `provider_kernel_adapter.rs`. Frontend `tsc`/`vitest`/`eslint` NOT
  run. Nothing runtime-verified.
- RESUME: run `cd src-tauri && cargo test --lib api::`, then `pnpm test` + `pnpm lint` + tsc, then
  verify in `pnpm tauri:dev` that an xhigh turn completes and that a capped turn shows the inline
  amber notice instead of silence.
- FOLLOW-UP (same day, work now COMPLETE and verified): the first cut of the cap fix was wrong.
  `anthropic_max_tokens_with_thinking` clamped the total to the 64k ceiling and then applied a
  `.max(budget + 1)` floor, so a 32k answer budget on `xhigh` (96k desired thinking) produced
  `max_tokens: 96_001` — straight back over the ceiling, a flat 400. Two invariants
  (`budget < max_tokens` AND `max_tokens <= ceiling`) cannot be clamped independently. Replaced with
  ONE function, `anthropic_thinking_plan(explicit, effort, answer) -> Option<(budget, max_tokens)>`,
  which resolves both together: over-ceiling requests shrink THINKING and keep the answer share whole
  (32k answer + 96k want → 64k total / 32k budget / 32k answer intact); only when the answer budget
  alone fills the ceiling does it split the cap 50/50. `anthropic_thinking_budget` stays as the pure
  "what does this tier want" helper.
- KNOWN LIMITATION (deliberate, not a bug): the notice marker is LIVE-ONLY. `DbMessage.timeline` is a
  UI-side field Rust never persists (same as `tool_calls[].durationMs`), so reopening a thread rebuilds
  events via `eventsOf`'s synthesised path (thinking → content → tools) and the notice is gone. The
  truncated reply itself persists; the explanation of WHY does not. Making it durable needs a Rust
  session/JSONL marker like compaction has — not done, out of scope for this fix.
- VERIFIED: 863 Rust tests pass (`cargo test --lib`), 239 frontend tests pass (`pnpm test`, up from
  234 — 5 new), `npx tsc --noEmit` clean, eslint clean on all 8 touched files (repo-wide `pnpm lint`
  reports 555 pre-existing problems, none in the files touched here). NOT runtime-verified: no
  `tauri:dev` run, so the amber notice has not been seen rendering and no live xhigh turn was made.

- CORRECTION (found by reading the actual thread, `6daeb9de-…` in the sessions dir): the mechanism I
  first blamed was WRONG. The provider was `d840dd0a` "GREY" (`base_url https://api.443.hk/v1`) with
  **`provider_type: "openai"`** — so `build_anthropic_body` / `anthropic_thinking_budget` NEVER RAN and
  the "xhigh = 90% of the cap" carve-out is irrelevant to this turn. The model row
  `d840dd0a::claude-opus-5` declares `max_output_tokens: 128000`, yet the request was capped at 8192.
  WHY: `toLlmConfig` set `defaultMaxTokens: provider.defaultMaxTokens ?? provider.maxOutputTokens`, and
  every consumer reads `defaultMaxTokens ?? maxOutputTokens`. `provider.defaultMaxTokens` was null so it
  fell back to the GREY row's legacy `max_output_tokens: 8192`, which then OUTRANKED the correctly
  resolved per-model 128000. A 128k model was silently running with an 8k output cap. Fixed: the three
  `defaultMaxTokens` sites in `useSettingsStore.ts` now use `provider.defaultMaxTokens ?? undefined`
  (explicit override only) so the per-model cap wins.
- So the real chain for the reported bug was: legacy provider row capped output at 8192 → on an
  OpenAI-compat gateway reasoning bills against that same cap → xhigh burned all 8192 on thinking →
  `finish_reason: "length"` → Rust emitted its "reply is cut off" warning → the frontend's
  `case "error": break;` swallowed it → silence. The Anthropic additive-budget change and the
  truncated-stream guard are real fixes for real latent bugs, but neither was THIS bug.
- Notice persistence now DONE (the earlier "known limitation" is resolved): new
  `ContentBlock::Notice { message, created_at }` on a `MessageRole::System` message appended right
  after the assistant message, stripped from every provider view (openai/anthropic/responses/team) and
  costed at 0 tokens; `threads.rs` maps it to `role: "notice"`, and `buildTurns` folds it into the
  preceding assistant turn (orphans are dropped, never rendered as an assistant bubble).
- VERIFIED after all of the above: 864 Rust tests, 241 frontend tests, tsc clean, eslint clean on the
  9 touched files. Still NOT runtime-verified.

## 2026-07-29 — file_read contract rewrite: exact ranges, honest caps, no double-bounding (DONE, uncommitted)
- WHY: reading the real session showed a 739-line / 30 KB component (`ProfileForm.tsx`) came back with
  its middle 22 KB replaced by a spill pointer, and the model then spent FIVE more calls paging the
  spill file back in — one of which spilled AGAIN. Cause: `tool_spill.rs` `SPILL_THRESHOLD = 12 KB`
  runs at `conversation.rs:1014` BEFORE `truncate_tool_content`, so `MAX_READ_RESULT_LENGTH` (512 KB,
  written specifically to let a normal read through whole) never applied. The real ceiling for a source
  file was 12 KB ≈ 300 lines of TSX, not the 1500 lines / 500 KB the read policy advertised.
- NEW CONTRACT (`file_read.rs`): an explicit `start_line`/`end_line` is returned EXACTLY, capped at
  `MAX_SINGLE_READ_LINES` = 1000; a wider ask returns the first 1000 with `cappedAtMaxLines: true` and a
  warning naming the resume point (`start_line: 1001`) and the `force_full_content` escape hatch. New
  `force_full_content: true` bypasses every bound. Files ≤1000 lines come back whole with no window
  bookkeeping. `DEFAULT_LINE_WINDOW`/250 and `LARGE_FILE_LINE_THRESHOLD`/1500 are GONE — the old
  1500→250 cliff is replaced by one number.
- Every read payload now carries `"exactRead":true` (`EXACT_READ_MARKER`, re-exported from
  `file_workspace_search`). `tool_spill::spill_oversized` and `conversation::truncate_tool_content` both
  return early on it. Spill still applies to shell/build output, where head+tail is correct because the
  summary is at the tail and the bytes die with the process.
- NOT changed: `multi_file_read` — its nested `files[].content` was never reachable by
  `spill_json_fields` (only top-level fields spill), so the batch form was already immune by accident.
- UI: `activity.ts` now labels any read whose path is inside `<thread_id>.tool-results/` as
  "Reading tool output" with no file chip, instead of leaking `out-b6179211-content.txt` into the
  transcript as if it were a project file.
- KNOWN GAP, NOT FIXED: `file_read` on an image is broken. `read_with_policy` uses
  `fs::read_to_string`, so a PNG returns `{"success":false,"exists":false,"error":"...did not contain
  valid UTF-8"}` — verified empirically. `exists:false` is a LIE for a file that is on disk, and the doc
  comment invites callers to use that flag as a presence probe. Vision plumbing already exists
  (`<aurora_image>` + `split_aurora_images`, used by `browser_screenshot`); `file_workspace_search` has
  zero image handling.
- VERIFIED: 875 Rust tests, 245 frontend tests, tsc clean, eslint clean on touched files. NOT
  runtime-verified.

## 2026-07-31 — Plan and todo are TWO systems, not one (DONE, uncommitted, build-verified only)
- USER'S MODEL (authoritative, this is the design): **plan** = the coarse per-project artifact a
  Plan-mode conversation produces — phases the user reads and approves, rendered in the Canvas.
  **todo** = the agent's fine-grained working checklist while executing, normally the concrete steps
  of the ONE phase it is on. Rhythm: plan phase `in_progress` → `todo_write` that phase's steps →
  work them with `todo_update` → phase `done` → next phase. Exactly Claude Code's plan-mode →
  agent-mode → TodoWrite flow. Without a plan, only the checklist exists.
- WHAT WAS WRONG (the user's report: panel stuck at 0/4 while the agent marked t2/t3 completed):
  1. The agent window built its checklist by parsing `todo_write` TOOL-CALL ARGUMENTS
     (`useAgentWindowSend.captureTodos`). It watched 1 of the 4 tools that change the list, so
     `todo_update` — which the prompt explicitly told the model to prefer — moved nothing.
  2. Rust DID emit `agent_todo_write` from all four tools, but the payload was `{todos}` with **no
     thread id** (the sink is app-global), and the only listener was `agent-ide-events.ts` → the
     IDE's global `useTaskStore`, which no agent-window component renders. A dead write.
  3. `todo_store::resolve` made an active plan HIJACK the todo tools: `todo_write`/`todo_update`
     returned `success:false, usePlanInstead` and pointed at `plan_step_update`. So in a planned
     project the checklist could never move at all.
  4. Turn start `clear`ed the list; turn end `finalize(threadId,"completed")` flipped whatever was
     left open to a tick — inventing completions the agent never reported.
  5. `tool-result.ts` printed `todo_update`'s model-facing `message` verbatim ("Marked t2 as
     completed. Nothing in progress; next up is t3."), so the transcript showed internal ids.
- FIXES: (a) hijack DELETED — `TaskSource`/`resolve`/`TodoList::from_plan`/`TodoStatus::from_step`/
  `publish_plan_as_tasks` are gone; plans emit only `plan_changed` (Canvas), todos only
  `agent_todo_write` (checklist). (b) `emit_todo_write(thread_id, todos)` — thread id is now
  REQUIRED and lands in the payload as `threadId`. (c) `useAgentTaskStore` rewritten: subscribes to
  `agent_todo_write` (window-lifetime, mirroring `subscribeToPlanChanges`), keeps Rust's stable ids
  as row keys, and hydrates from the new `todo_list_for_thread` command on thread open — so
  reopening a chat restores the checklist from `<thread>.todos.json`. (d) turn-start clear and
  turn-end finalize both removed. (e) new `TodoBeatCard` for `todo_update` (verb + task TITLE +
  closed/total), mirroring `PlanStepCard`; static, not a button (the checklist is already on screen).
- TOOL EXPOSURE is now gated per turn in `agent_v2::is_tool_available_this_turn(name, mode, has_plan)`:
  `plan_write` = Plan mode ONLY (it was callable in Agent mode while the prompt said it wasn't);
  `plan_read`/`plan_step_update` = Plan mode, or Agent/Team **only when the project has a plan on
  disk** (`workspace_has_plan` → `plans::store::active`). No plan ⇒ no plan tools and no plan text in
  the prompt at all. `getAgentModePromptSection(mode, {hasActivePlan})` mirrors it, resolved in
  `composeAgentSystemPrompt` via `plan_get_active` — read from DISK, same source Rust's gate reads,
  so the two can't disagree.
- COUNT SEMANTICS unified on **closed = completed + cancelled** over total, in all four places
  (panel, composer-rail chip, beat card, Rust `progress_line`). The panel previously counted
  `completed` only while its own `allDone` treated cancelled as terminal — a list ending in a
  cancelled task rendered "Tasks complete  2/3". Rust's line now reads "2/2 closed (1 cancelled)" so
  the model never reads it as "2 done".
- NEW UI STATE — **paused**: a task left `in_progress` by a turn that ended. Own shape (pending ring
  + held centre), imperative label ("Add the route", not "Adding the route"), header reads
  "Paused — …". Liveness = `useAgentChatStore.liveTurns[threadId]`, the same rule the Canvas already
  applies to plan steps. Replaces the old lie in both directions (fake tick / eternal spinner).
- VERIFIED: 906 Rust tests, 257 frontend tests, `npx tsc --noEmit` clean, eslint clean on all 11
  touched frontend files. NOT runtime-verified — no `tauri:dev` run, so the paused glyph, the beat
  card, and the live event path have not been seen on screen.

## 2026-08-01 — Agent window "Worked Nm" footer never showed on a just-finished turn

- SYMPTOM (owner): the greyed duration at the end of an assistant reply "is not showing and
  sometimes shows". It in fact NEVER showed on a turn you just watched finish — it only appeared
  after reopening the thread, which is what made it look intermittent.
- ROOT CAUSE: `useAgentWindowSend.ts` seeds the optimistic assistant message with
  `timestamp: nowIso()` at SEND time (line ~774) and never re-stamps it. `buildTurns`
  (`components/timeline.ts`) reads the last assistant message's timestamp as the turn's `endedAt`,
  so `endedAt ≈ startedAt` → `turnWorkedMs` computed a ~0ms span → returns `null` (it guards
  `span > 0`) → `WorkedDuration` renders nothing. On reload the number was correct because the Rust
  runtime stamps the PERSISTED assistant message at end-of-stream
  (`api/provider_kernel_adapter.rs:1528`, `assistant_with_usage(.., now_unix_ms())`).
- FIX: re-stamp the optimistic assistant message in `sendTurn`'s `finally` block (same place that
  clears `isThinking`), so the live view and the reloaded view agree. Nothing new is recorded.
- STILL DEAD: `WorkedDuration`'s `streaming` branch ("Working 4m", ticking) can never render —
  `ConversationPane` sets `showActions = !streaming` for assistant turns, and the whole actions row
  is what hosts the readout. Its docstring claims live ticking. Left as-is (behaviour change, owner's
  call) but flagged.
- VERIFIED: `npx tsc --noEmit` clean, `timeline.test.ts` 12/12. NOT runtime-verified (no tauri:dev).

## 2026-08-01 — Verified two browser-tool complaints from a long agent session

- `browser_click` takes a RAW CSS selector handed to `querySelector` (`tools/browser/mod.rs:602-629`).
  `:has-text()` is a Playwright extension, not CSS, so it can never match. The intended discovery path
  is `browser_page_outline`, which already returns `{selector, text}` per element — the module
  docstring says it exists precisely to stop selector guessing. Complaint is factually correct; the
  open question is whether to add `:has-text()` sugar or make the outline path more discoverable.
- `browser_get_console_logs` already keeps a rolling 500-entry buffer WITH `window.onerror` +
  `unhandledrejection` capture (`services/browser_runtime.rs:1421-1472`). The buffer is NOT
  "consumed" by a crash — it lives in the PAGE's `window.__aurora.__logs`, so a Vite HMR full-reload
  after the error wipes it, and `sinceMs` filters against the page's own `Date.now()`. Fixing this
  means mirroring entries into Rust, not enlarging the buffer.

## 2026-08-01 — Checklist moved to the header; three todo tools became one (uncommitted, build-verified only)

- USER'S CALL (all three, authoritative): (1) todos render NOTHING in the transcript; (2) ONE `todo`
  tool with a typed `op`; (3) header indicator that hover-peeks and click-pins.
- WHY IT MOVED, third home now: as a transcript card it pushed the reading area down on every touch
  and left a trail of stale copies of one list threaded through the reply. As a composer-rail chip it
  stopped moving the transcript but sat in the WRITING zone — a readout you consult while the agent
  works, parked where you go to type. The header already holds this window's ambient truth about the
  running turn (title, activity line, context ring), so the checklist now sits beside `ContextRing`:
  the two "how is this turn going" readouts together.

### Rust
- `todo_write` / `todo_update` / `todo_read` DELETED, replaced by `tools/shell_editor_todo/todo.rs` —
  one `TodoTool`, `op: "set" | "update" | "read"`. `todo_store` is untouched. Rationale: all three
  spoke the same vocabulary (ids, statuses, cursor) and differed only in required fields, so the
  split cost the roster three slots and cost the model a choice before every call. `op` keeps it a
  discriminated union rather than a bag of optional fields whose combination decides the action —
  a missing `op` is REJECTED, never guessed.
- BUILTIN_TOOL_COUNT 31 -> 29. `shell_editor_todo::TOOL_NAMES` 9 -> 7.
- PLAN-MODE GATE CHANGED: `todo` is withheld from Plan mode ENTIRELY (both `PLAN_MUTATING_TOOLS` in
  `agent_v2.rs` and `WRITE_TOOL_NAMES` in `agent-execution-mode.ts`). `todo_read` used to be allowed
  there; with one tool, read cannot be split from set/update by name — and Plan mode authors the
  plan, it does not work a checklist. The retired names stay in the TS write-set so a stale roster
  cannot smuggle a write past the gate under an old name.
- NEW in `tool_suggest.rs`: a `RETIRED_NAMES` table (`todo_write`/`todowrite`/`todo_update`/
  `todo_read` -> `todo`) consulted BEFORE fuzzy matching. Edit distance can never bridge a rename
  (`todo_write` is 6 edits from `todo`, past any sane tolerance), and `TodoWrite` is in essentially
  every agent model's training data — without this the first turn of every conversation is a
  guaranteed unknown-tool dead end. A row only fires when its target is in the LIVE roster.

### Frontend
- NEW `components/TaskIndicator.tsx` — header trigger (glyph + `closed/total`) + portaled checklist
  card. Hover peeks, click pins; Escape and outside-pointerdown close a pin. A 140ms grace timer on
  peek-close is load-bearing: the card is portaled 8px below the trigger, so travelling to it crosses
  a gap belonging to neither element and a raw mouse-leave tore the card away mid-reach.
- SPINNER HONESTY unchanged and re-applied: the glyph becomes the shared `agw-rail-spin` ONLY when a
  task is `in_progress` AND `liveTurns[threadId]` exists. A task left open by a finished turn renders
  `data-state="paused"`, named in the imperative in the aria-label. Same rule as `AgentTaskPanel` and
  the Plan Canvas.
- NEW `checklist` icon in `AgentIcon` (ticked first row, shortened last) — deliberately NOT
  `task-list` (three empty boxes), which says "a list exists" rather than "progress through a list".
- `buildRows` (timeline.ts) now drops tool events whose name is in `SILENT_TOOLS` (= `["todo"]`).
  Dropped WITHOUT flushing the run, so a status flip between two file edits does not split them into
  two tool groups. Bar for adding a name: the tool's ENTIRE output must already be visible somewhere
  permanent, or silence is indistinguishable from a tool that failed.
- REMOVED: `TodoBeatCard` + its `.agw-task-beat*` CSS (orphaned), the composer-rail todo chip, and
  `AgentTaskPanel`'s `dock` variant (its host is gone). The panel now reuses `.agw-crail-panel` —
  the same popover body shape the background-process panel uses.
- `todo-tools.ts` still declares `todo_write` but is `nativeRustOwned: true`, so
  `AgentService.buildAvailableTools` strips it before the request — VERIFIED it can never reach a
  model as a rival tool. It survives only for the legacy IDE chat path.
- VERIFIED: 904 Rust tests, 269 frontend tests, `tsc --noEmit` clean, eslint clean on all touched
  files, `pnpm build` green with the new CSS emitted. NOT runtime-verified — no `tauri:dev` run, so
  the hover→pin interaction, the spinner, and the 13px glyph have not been seen on screen.

## 2026-08-01 (later) — WHY the header stayed empty: `ToolContext.session_id` was never the thread

- USER'S REPORT: the agent created todos and the header indicator showed nothing.
- ROOT CAUSE, pre-existing and NOT from the header move: `ToolContext.session_id` was filled from
  `Session::session_id` (`conversation.rs`), which is a **fresh UUIDv4 on every load** and whose own
  doc comment says "Distinct from `thread_id` … the `session_id` changes each time". The todo tools
  used it as the conversation identity for BOTH the sidecar path and the event payload, so:
  * the list was written to `<sessions_dir>/<uuid>.todos.json`, while `todo_list_for_thread` reads
    `<thread_id>.todos.json` — hydrate ALWAYS found nothing and the list died on every restart;
  * `agent_todo_write` announced `threadId: <uuid>`, so `useAgentTaskStore.applyTodos` filed it under
    a key no component reads. `currentThreadId` never matched ⇒ nothing rendered.
  The composer-rail chip had exactly the same defect — it was never going to work either. This dates
  to the 2026-07-31 rewrite, whose own note says the live event path was never runtime-verified.
- SAME BUG, TWO MORE PLACES: `plan_step_update` stamped a step's `run_id` with the session uuid and
  `plan_write` filtered plans by `frontmatter.thread_id == ctx.session_id`, so a plan's run claim
  could never match after a reload. And `lib.rs::resolve_background_log_path` filed background-process
  logs under `tool_results_dir_in(dir, <uuid>)` while thread deletion removes
  `tool_results_dir(thread_id)` — the logs were never cleaned up.
- FIX: `ToolContext.session_id` **renamed** to `thread_id` (compiler-checked across ~30 files) and
  filled from `session.thread_id`. Renamed rather than reassigned so it cannot be misread the same
  way twice; the field doc now spells out why. `ShellStreamRequest.session_id` renamed to match, since
  it is populated from the same value. `read_tracker` keeps its local param name — it is an in-memory
  per-conversation map and thread scope is at least as correct.
- REGRESSION TEST: `conversation::tests::tools_receive_the_thread_id_never_the_ephemeral_session_id`
  runs a real turn with a spy tool and asserts the id it sees equals the thread AND differs from
  `session.session_id`.

## 2026-08-01 (later) — Todo beat is BACK in the transcript (user's call, reversing the earlier choice)

- The earlier "render nothing" decision was wrong in practice: a checklist that moves with no trace
  reads as if nothing happened, AND it made a FAILED todo call invisible — which is part of why the
  broken event path above went unnoticed for a whole session.
- NOW: `op: "set"` → `● Planned  5 tasks  0/5`; `op: "update"` → `● Finished  Add the route  2/5`.
  `op: "read"` still renders nothing — a lookup changes nothing a reader could care about.
- The filter is a PREDICATE on the call (`isSilentToolCall`, parses `op` from the arguments), not a
  name set, and it still skips WITHOUT flushing the tool run so a read between two edits does not
  split them into two cards. A todo call whose arguments fail to parse is deliberately SHOWN.
- VERIFIED: 905 Rust tests, 270 frontend tests, `tsc -b` clean, eslint clean, `pnpm build` green.
  STILL NOT runtime-verified — the header indicator has not been seen on screen.

## 2026-08-02 — Agent Window empty state now uses the IDE's project-aware starters (uncommitted, build-verified only)

- GAP: the Agent Window home offered FOUR HARDCODED starters ("Explain this project", "Find a bug",
  "Build a feature", "Write tests") whose prompts were generic and half of them trailing fragments the
  user had to finish ("Write tests for "). The IDE chat panel had shipped project-aware starters the
  whole time (`components/chat/WorkspaceAwareEmptyState.tsx`) — named after the workspace and tuned to
  what a scan found. The agent window simply never adopted it.
- WHAT CHANGED: the branching + copy moved OUT of the IDE component into a new shared service
  `src/services/workspace-starter-prompts.ts` (`buildStarterPrompts(rootPath, summary)`), consumed by
  BOTH empty states. Copy and branch logic are byte-identical to what the IDE shipped — this was an
  extraction, not a rewrite, so the IDE's rendered strings are unchanged.
- ICONS ARE NOT SHARED, deliberately. The IDE uses lucide; the agent window uses the bespoke
  `AgentIcon` set. A prompt now declares a semantic `kind`
  (`getting-started`/`architecture`/`review`/`debug`/`plan`/`tests`/`read-first`) and each surface owns
  a `KIND_ICONS` map. Agent window mapping: architecture→`workspace-tree`, review+debug→`shield`,
  plan→`file-edit`, tests→`checklist`, getting-started→`book`, read-first→`book-open`.
- The three branches (no workspace / workspace but scan pending / scan resolved) all return exactly
  FOUR prompts with the same `kind` in each slot, so the async `scanWorkspace` landing rewrites the
  wording IN PLACE — no reflow, no row count change. Rows are keyed by `kind`, not by title: a title
  key remounts every row on refinement and drops hover/keyboard focus for what is only a wording change.
- CSS: `.agw-suggestion` labels went from two-word chips to full sentences carrying the project name, so
  they wrap in a narrow pane. New `.agw-suggestion-icon` (`flex: none`, replaces an inline style) stops
  the glyph collapsing to a sliver on the first wrap; new `.agw-suggestion-label` (`min-width: 0`,
  `overflow-wrap: anywhere`) handles long unbroken folder names.
- SCAN COST unchanged but now paid on a second surface: `scanWorkspace` walks the root plus one level of
  subdirectories with SEQUENTIAL awaits and has no cache, so it re-runs on every EmptyState mount
  (i.e. every "New chat"). ~15 IPC round trips on this repo. Not blocking (the generic branch renders
  first) and identical to the IDE's long-standing behaviour, so left alone — but a memo/TTL cache in
  `workspace-summary.ts` would serve both surfaces if it ever shows.
- NOTE for whoever tunes the copy: with the project name in the `.agw-home-root` row AND in all four
  starter titles, the workspace name appears five times in one viewport. That is exactly what the IDE
  does (its heading repeats it too), so it was kept for parity rather than unilaterally diverged.
- VERIFIED: 277 frontend tests pass (up from 270 — 7 new in `workspace-starter-prompts.test.ts`, incl. a
  branch sweep asserting 4 prompts with unique kinds everywhere), `npx tsc -b` clean, eslint clean on all
  4 touched files, `pnpm build` green with `.agw-suggestion-label` present in the emitted CSS, postcss
  parses the agent-window stylesheet. NOT runtime-verified — no `tauri:dev` run, so the wrapped rows,
  the glyphs, and the scan-refinement have not been seen on screen.

## 2026-08-02 — Startup surface preference: app icon can open the Agent window (uncommitted, build-verified only)

- FEATURE (user's ask): a preference deciding whether launching Aurora from its app icon opens the
  IDE (default) or the Agent window. Owner's two calls, both taken: scope = **app icon only**, and the
  IDE window is **hidden, not closed**, so the choice is never a one-way door.
- THE MECHANISM ALREADY EXISTED. `agw` / `aurora --agent` sets `agent_mode`, and `setup()` already
  hid `main` → read the saved size → built the agent window → closed `main` → re-showed `main` on
  failure. `main.rs:88` already had the bare-launch branch ("launched from Start menu"). The work was
  storage, precedence, scoping, and reversibility — not new window machinery.
- **STORAGE IS A FILE, NOT `app_settings`, AND THE REASON IS ORDERING.** Window size lives in SQLite
  (`app_settings.agent_window_bounds`), so "put it next to the size" was the obvious move and is
  WRONG: `agent_mode` is consumed in `run_with_args` before `tauri::Builder` is even constructed,
  because `setup()`'s FIRST statement hides the auto-created IDE window to avoid a flash.
  `db::Database::init` runs later in `setup()` (needs the `AppHandle`, runs migrations), so a SQLite
  value arrives after the moment it is needed and every agent launch would flash the IDE. New
  `src-tauri/src/launch_prefs.rs` → `<AuroraIDE>/launch.json`, `{"surface":"ide"|"agent"}`. This is a
  real category — **boot config** (readable before the state layer exists) vs **runtime state**.
- FAILS CLOSED TO THE IDE, always: missing / unreadable / corrupt / unknown variant / wrong case all
  resolve to `Ide`. A launch preference that could resolve to "no window" is unrecoverable without
  hand-editing a file. `parse`/`serialize` are pure fns so the 5 tests never touch the real app dir.
- PRECEDENCE: `bare_launch = path.is_none() && !agent && command.is_none() && diff.is_none()`. Only
  that shape consults the file. `aurora <path>`, the Explorer context menu, and file associations
  carry an explicit "open this here" intent the VIEW-ONLY agent window cannot serve, so they always
  get the IDE. `--agent` still always wins.
- **SCOPING TRAP (would have shipped broken)**: `agw` fills `?ws=` from the CWD. An icon launch's CWD
  is meaningless (Explorer hands the process System32). A null root produces a chat that persists
  correctly but renders NOWHERE — the left rail is a per-project tree keyed on it (`agent_workspace_
  root`'s own doc says this). Fixed by resolving the icon-launch root from `workspace().get_most_
  recent()` AFTER db init, inside the window-build block. The early/late split is the nice part:
  `agent_mode` is needed early (file), `?ws=` late (DB), and each is available exactly when needed.
- REVERSIBILITY: `agent_open_in_ide` already did `unminimize + show + set_focus`, so a HIDDEN `main`
  was always recoverable — but only via "Open in IDE", which REQUIRES A FILE. A fresh agent-first
  launch has none, so there was no path-free way back. Added `open_ide_window` (async — a sync
  command building a window deadlocks the Windows UI thread) + an "Open the editor" command-center
  entry. Extracted `reveal_main_window` / `build_main_window` in `editor_ops.rs` so the recreated
  window can't drift from tauri.conf.json in only some paths.
- UI: new "Startup" section at the TOP of agent Settings → Preferences (`external` icon), segmented
  Editor / Agent window. Not a store — loaded on mount, written straight through, optimistic with a
  REVERT on failure (a startup preference that shows the new value while the next launch does the old
  thing is worse than one that visibly refuses). The precedence rule is stated as inline hint text,
  not a tooltip: without it, a user who picked "Agent window" reads the Explorer menu still opening
  the editor as the setting being broken.
- VERIFIED: 910 Rust tests (up from 905 — 5 new in `launch_prefs`), 277 frontend tests, `cargo check
  --lib` clean, `npx tsc -b` clean, eslint clean on all 4 touched frontend files, `pnpm build` green.
  NOT runtime-verified — no `tauri:dev` run and, critically, **no real icon launch has been performed**,
  so the flash-free agent boot, the most-recent-workspace scoping, and the hidden-IDE handoff have not
  been observed. That verification needs an installed build, not a dev server.

## 2026-08-02 — Jump-to-latest pill: the hook had computed it all along, nothing rendered it

- USER ASK: a jump-to-bottom control in the agent window transcript.
- ROOT FINDING: `useAgentAutoScroll` has ALWAYS returned `showJump` and `jumpToBottom`, and its
  docstring promises it "surfaces a 'jump to latest' affordance (`showJump`)". **No consumer ever
  destructured either one.** All three call sites (`ConversationPane`, `TeamPanel`, `MemberPanel`)
  take only `containerRef` / `contentRef` / `bottomRef`. A comment inside the hook even documents
  gating that lives in a component that never existed: "The pill's mid-stream gating lives in the
  component (`showJump && sending`)". Dead API described as shipped behaviour — same class as the
  `read_lints` stub whose own description lies about returning real errors.
- DELIBERATELY DID NOT ADOPT that `showJump && sending` gate. Being lost in a FINISHED conversation is
  the more common case, and a control that only exists during streaming would vanish from under the
  cursor at the exact moment a turn ends. The pill shows whenever the reader is away from the bottom.
- STREAMING IS A MODIFIER, NOT THE TRIGGER: while a turn streams, the distance means something extra
  (content is arriving unseen), so the pill grows a pulsing live dot — AND the aria-label changes to
  "Jump to latest — the agent is still writing", so the state is never carried by the dot alone.
  Regression-tested.
- NEW `components/JumpToLatest.tsx` + `.agw-jumplatest` CSS. Placed absolutely inside the existing
  relative wrapper that already hosts the scroll container and `JumpRail`, CENTRED so it can never
  collide with the jump rail on the right edge. The composer sits outside that wrapper, so `bottom:
  14px` lands just above it.
- Styled as a POPOVER, not a card: it floats above the transcript, so it takes a real shadow and a
  SOLID `--agw-surface-elevated` fill — transcript text scrolling under a translucent control the
  reader is trying to read is the failure mode.
- CSS trap avoided: the pill is centred with `translateX(-50%)`, so `:active { transform: scale() }`
  would have DROPPED the centring and thrown it to the right on every press. Both the active state
  and the entry keyframes re-state `translateX(-50%)`.
- TOKEN CHECK PAID OFF: `--agw-elevated` and `--agw-fs-small` do not exist (correct names are
  `--agw-surface-elevated` and `--agw-fs-label`). Note the agent-window colour tokens are NOT defined
  in `agent-window.css` — they are injected at runtime from `theme/themes.ts` (camelCase key →
  `--agw-kebab-case`), so grepping the stylesheet for a `--agw-*:` definition finds nothing and proves
  nothing. Verify against `themes.ts`, or by counting existing `var(--agw-x)` usages. Fallbacks were
  then REMOVED — a fallback on a token that exists only hides the next typo.
- No self-dismiss code needed: `jumpToBottom` scrolls, the scroll listener calls `refreshNearBottom`,
  and `showJump` clears itself.
- TEST HARNESS NOTE: this repo has NO `@testing-library/react` and no `jest-dom` matchers. Component
  tests use raw `react-dom/client` + `act` (see `TaskIndicator.test.tsx`); `toBeEmptyDOMElement` and
  friends are unavailable — assert on `container.innerHTML` / `querySelector`.
- VERIFIED: 281 frontend tests (up from 277 — 4 new), `npx tsc -b` clean, eslint clean on 3 touched
  files, postcss parses the stylesheet, `pnpm build` green with `.agw-jumplatest` in the emitted CSS.
  NOT runtime-verified — the pill has not been seen on screen, and the 140px `bottomThreshold` that
  decides when it appears has not been felt with a real scroll wheel.

## 2026-08-02 — grep rewritten: real total cap, honest counts, streamed and bounded (uncommitted)

Three stacked defects in the `grep` / `ripgrep_search` path, found from one owner-reported empty
result. All fixed together; the first two are written up in `lesson.md`.

1. **Comma split destroyed brace globs.** `parse_glob_patterns` was `split(',')`, so `**/*.{ts,tsx}`
   became `**/*.{ts` + `tsx}`. Now depth-aware (skips `{…}`, `[…]`, `\` escapes); malformed input is
   forwarded verbatim so ripgrep names the real problem.
2. **Path-qualified globs matched nothing.** ripgrep anchors a slash-bearing glob to the WORKING
   DIRECTORY, not the path operand, so `apps/x/src/**/*.ts` against an absolute root silently found
   zero while bare `**/*.rs` worked. Now runs with `current_dir(search_dir)` + `.` operand (a single
   FILE keeps the operand form); `absolutize_rg_path` rejoins ripgrep's now-relative output so the
   absolute-path contract used by file chips / open-in-IDE / Review is unchanged. `glob.rs` had
   already solved this and its comment names it exactly — `grep` never got the same treatment.
3. **`max_results` was a lie in three directions.** It was forwarded to `--max-count`, which is
   ripgrep's PER-FILE limit — measured on this repo, `max_results: 5` collected **224** matches
   (true total 240). `files_with_matches` and `count` were never capped at all. And the reply
   reported `total_matches.min(max_results)`, i.e. the cap dressed as a measurement, erasing the one
   number that would have told the caller to narrow.

### The cap now
- `max_results` = results returned in TOTAL, measured in the unit the active `output_mode` returns
  (matches for `content`, files for `files_with_matches` / `count`).
- ripgrep's stdout is STREAMED (`BufReader::lines`) instead of buffered whole, and the read stops one
  unit past the cap, then kills the child. Reading one past is what makes `truncated` an observation
  rather than a guess — stopping exactly at the cap cannot distinguish "exactly N" from "N and more".
  This also removes a latent unbounded-memory path: the entire `--json` stream used to be buffered.
- `count` mode caps on ripgrep's `end` events, so a capped search never reports a half-counted file.
- stderr is drained on its own task — reading stdout to completion while stderr fills its pipe would
  deadlock (`wait_with_output` used to handle that for us).
- A killed process has no meaningful exit code, so the status is only trusted when the search ran to
  completion (`exit_code = if truncated { Some(0) } else { status.code() }`).
- NEW response fields: `returned` (how many items are actually in the array) and `message` (names the
  cap and the way out — "Showing the first N matches; more exist. Raise `max_results`, narrow
  `pattern`, or scope with `path` / `glob`."). An EMPTY result also gets a `message` now.
  `total_matches` / `total_files` are exact for a complete search and an explicit lower bound for a
  truncated one — never clamped. Both existing frontend consumers read `totalMatches`/`truncated`
  only, so the shape is additive.
- grep's schema now documents `glob` (braces, comma lists, `!` negation) and `max_results` (total, not
  per file). Both previously had NO description at all — an undocumented parameter invites exactly the
  input the parser mishandles.

VERIFIED: 931 Rust tests (26 in `commands::tests`, incl. 8 END-TO-END cap tests that run the real
ripgrep against temp fixtures), `cargo check --lib` clean, `tsc -b` clean, rustfmt clean on both
touched files via `--config skip_children=true` (plain rustfmt recurses into sibling modules and
would reformat unrelated pre-existing files). Reproduced the owner's original query end to end: it
returns **35 files** where Aurora returned none. NOT runtime-verified inside the app.

## 2026-08-02 — Home screen workspace row is now a project switcher (uncommitted, build-verified only)

- OWNER PICKED variant 7 from the design probe `C:\Users\Alvan\Documents\aurora-home-root-designs.html`
  (7 treatments, real tokens, rendered above a stand-in composer). Probe-first is the standing workflow
  for any non-trivial UI change here — see the 2026-07-22 lesson.
- WHY IT CHANGED: the old `.agw-home-root` was a static label whose spaced-slash path
  (`… / Users / Alvan / Documents`) read as a clickable breadcrumb and did nothing. The fix makes the
  promise TRUE rather than removing the signifier — the row is now the control for changing project,
  which is what someone looking at it wants to do. Switching previously lived only in the left rail
  and the command centre.
- NEW `lib/project-order.ts` is the SINGLE SOURCE for project identity + ordering: `orderProjects`,
  `projectActivity`, `folderName`, `compactParentPath`, `loadPinnedProjects`, `loadProjectSort`, and
  the two localStorage keys. `LeftRail` now imports all of it and its ~25-line inline sort is gone.
  Ordering is NOT simple (pins float above everything, three sort modes, two of them derived from
  per-project thread activity), so a second implementation would have drifted and shown the user two
  different orders for the same list.
- NEW `components/ProjectSwitcher.tsx`. Ghost at rest (no fill/border) so it never competes with the
  composer; chip surface + chevron on hover/focus. Portaled to `.agw-root` — required twice over: the
  `--agw-*` tokens are set there (a menu outside that subtree renders with no surface colour), and it
  must escape the home column's `overflow-y: auto`. Same rule as `TaskIndicator`.
- Menu snapshots its project list AT OPEN. Rail prefs (sort mode, pins) are localStorage the rail can
  change at any time, so reading them per-open is current by construction; it also stops the list
  reordering under the cursor if a background turn touches a thread mid-choice.
- Keyboard complete: ArrowDown/Up from the trigger opens, arrows/Home/End move, Enter/Space selects,
  Escape closes and returns focus to the trigger. Opens ON the current project so the first arrow moves
  from where you are. "Add project…" is the last ROW (not a mouse-only corner button) so it is
  keyboard-reachable, and is divider-separated because it creates rather than selects.
- LINT TRAP worth remembering: `react-hooks/set-state-in-effect` rejected both the popover positioning
  and the initial highlight when they lived in effects. Both were already known at click time, so they
  moved into one `openMenu()` event handler — `open` is now derived (`menu !== null`) rather than a
  second state. A popover whose position is state should place itself in the handler that opens it.
- Also: exporting a helper from a component file trips `react-refresh/only-export-components` — that is
  why `compactParentPath` lives in `lib/project-order.ts` rather than beside the component.
- VERIFIED: 299 frontend tests (up from 286 — 13 new covering all three sort modes, pin floating,
  activity-less tie-breaking, dedupe, and left-elision), `tsc -b` clean, eslint clean on all 5 touched
  files, postcss parses, `pnpm build` green with `.agw-projsw` / `.agw-projmenu` emitted. NOT
  runtime-verified — the hover reveal, the portal placement and the keyboard path have not been seen
  on screen.

## Per-conversation model (agent window)

The model is a property of the CONVERSATION, not of the app. `useSettingsStore.selectedModel` is now
only the DEFAULT a new chat inherits; the authority is `SessionMetadata.model` on the thread's own
sidecar (`"providerId:modelKey"`), surfaced through `ThreadSummary.model` and resolved by
`agent-window/lib/thread-model.ts` — the one place the picker and the send path both read, so they can
never disagree about what a turn will run on.

- Two writers: `thread_set_model` (the user's pick, before any turn) and the runtime's per-turn
  `set_workspace_and_model`. The latter used to be write-once, which branded a thread forever by
  whatever ran its first turn; the model is deliberately NOT sticky, unlike `workspace_root` (which
  still is — see `workspace_scope_is_sticky_and_never_moves_on_a_later_turn`).
- Everything reading the model had to follow, or it would describe a different chat: the send path
  (`getLLMConfigFor` / `getModelFor` — resolved AFTER `threadId` is known, which is why it no longer
  sits with the other settings reads), compaction, `ContextRing`'s window size, and `AgentComposer`'s
  vision gate. `ModelSelector` and `AgentComposer` take an optional `threadId` (omitted = the open
  chat) so a composer that isn't the main one can address its own thread.
- VERIFIED: 305 frontend tests, 934 Rust tests, `tsc -b` + eslint clean, `pnpm build` green. NOT
  runtime-verified.

## Chat docked in the side panel (agent window)

Right-click a chat in the rail → "Open in side panel" docks it as a `chat:<threadId>` tab
(`ChatPanel`), a FULLY live second conversation — streams, takes tool approvals, can be stopped, has a
real composer. Built for comparing two models on one prompt, which is impossible by switching chats
because you never see both answers form.

- Nothing in the pipeline was window-scoped to begin with, so concurrency was free: the Rust runtime
  locks per thread, `liveTurns`/`queuedByThread`/`activityByThread` are keyed by thread id, and
  `runningAgents` is one `AgentService` per thread. Only the VIEW was single (`currentThreadId`).
- `useAgentWindowSend(bound?)` takes a `BoundConversation { threadId, projectRoot, getSeed }`; omitted =
  the open chat. `getSeed` is a FUNCTION because the seed is read at send time — a transcript that
  finished loading after mount must still be the one the live turn opens on, or the history vanishes
  until the turn ends. `BackgroundSendTarget.interactive` now separates "a person pressed send"
  (consume staged trays, allow mid-turn queueing) from the pipeline's own post-turn resubmit.
- The staging stores had to be split per composer (`composerKey(threadId)`, `"draft"` when there is no
  thread): with two composers on screen, one global tray meant staging an image in the main pane and
  sending from the dock attached it to the wrong conversation. `useAgentSelectionStore` stays global on
  purpose — there is one inspector, so its picks belong to whichever composer sends next.
- Deliberately NOT in the docked panel: per-message action rows, the suggestion drum, and
  `onActionCommand` (that one prop gates both `/compact` and `/suggest`, and suggest chips aren't
  rendered at this width — offering it would be a dead control). Opening the chat from the left rail
  puts it in the main pane, where they all work. The panel header carries the TITLE ONLY: a promote
  button there was drawn with a panel glyph and read as the main header's dock toggle — a different
  control, whose meaning is nonsense inside the panel it opens.
- VERIFIED: 316 frontend tests, `tsc -b` + eslint clean, `pnpm build` green. NOT runtime-verified.

### Cross-conversation leaks the docked chat exposed

The window used to render exactly ONE conversation, so anything deep in the tree could read
`currentThreadId` / `projectRoot` off the store and be right. With a second chat on screen that
assumption silently describes — or acts on — the wrong chat. Fixed by prop where the chain is short
(`AgentComposer.projectRoot` → the `@` file index, `/` rules+skills and their post-turn cache
invalidation; `ComposerRail`/`BackgroundTaskDock.threadId` → the background-process chip and its kill
control; `AgentQueuedDock.threadId`), and by `lib/conversation-scope.ts` where it isn't — a tool card's
"open in Canvas" sits four levels under anything that knows which chat it is, and artifacts are stored
per thread. Absent provider = the open chat, so nothing else had to change.

The panels that still follow the WINDOW's scope do so correctly: Canvas, Files, Terminal, Team and the
command centre are window surfaces, not per-conversation ones.

## Dragging a file from the Files panel into a composer (agent window)

The Files panel is now a drag SOURCE and every composer a drop ZONE, so a file can be carried into a
prompt instead of being typed as an `@` mention. Nothing was broken before this — the wiring never
existed: the panel rows were plain click-to-open buttons and the composer only listened to Tauri's
OS-level `onDragDropEvent`.

- Pointer-driven, not HTML5 DnD, matching the IDE explorer's proven approach in this Tauri webview
  (`src/hooks/useInternalDrag.ts`). Deliberately a SEPARATE system from the IDE's `useDragStore`: that
  coordinator moves files between folders / into the IDE editor (neither exists here) and its drop
  signal is app-global, which cannot address one of several composers.
- Routing is a DOM CustomEvent dispatched ON the zone element (`lib/path-drag.ts`), because the window
  can show a main composer AND a docked chat's composer at once. `useAgentPathDrop` stamps the zone
  attribute itself so the hit-test target and the listener can never drift apart.
- Both transports converge on `AgentComposer.handlePaths`: images → attachment (vision-gated), anything
  else → the same `@` pill the picker builds. A press only becomes a drag past 5px, and a real drag
  suppresses the trailing `click` for 250ms so releasing over the source row doesn't also open the file.
- `insertPathPill` now writes a project-RELATIVE `data-rel` (abs stays in `data-path`), so a dragged
  mention serializes exactly like a picked one. What reaches the model is only that `@path` text — file
  chips are display/replay metadata; the agent still reads the file with its own tools.
- The OS transport (Windows Explorer → composer) was separately broken and is fixed in
  `useAgentExternalDrop`: it now subscribes via `listen(name, h, { target: label })` instead of
  `getCurrentWindow().onDragDropEvent`, because Tauri filters delivery on the listener's target KIND as
  well as its label. See the 2026-08-04 entry in `lesson.md` before touching that subscription.
- VERIFIED: 330 frontend tests (11 new), `tsc -b` + eslint + `pnpm build` clean. The in-window drag is
  RUNTIME-verified (Files-panel folder → composer produced the pill end to end); the OS drop fix is not.
