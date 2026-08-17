# Aurora IDE — Working Memory

## 2026-08-17 (2nd) — A tool card resolves on its own clock, not its batch's

`execute_tool_calls` awaited the whole concurrent group under `join_all` and only then emitted
`ToolExecutionResult` for each call, so **the slowest tool in a group set every card's clock**.
Measured in session `9db4f0f0`: one message held `2x shell_execute + read_lints + 3x grep`; the
three greps finish in single-digit ms and sat spinning for the full **24.79s**. Reported as
"`file_read` feels slow now" — the reads in that same turn took **1–4 ms** (7 files in one call:
2 ms). Whole turn 867s, of which tools were 26.8s (3.1%) and the model 840.5s (96.9%).
- Each future now emits its own result event the moment it resolves. The **fold stays ordered** —
  result blocks, spill, and rich sidecars all follow the model's call order and always must; a
  card belongs to one call and nothing else reads it. Two orderings, only one of them a constraint.
- Needed a shareable counter: `emit_native_tool_event_shared(&AtomicU64)` in `util.rs`, seeded from
  the caller's `seq` and written back after the loop, since `&mut u64` cannot cross concurrent
  futures. Bind `let seq_cell = &event_seq;` outside the closure or `async move` swallows it.
- The repeat-failure escalation (`FailureLoopGuard`) is deliberately NOT on the card: it is
  addressed to the model ("do not issue this call again") and is counted per batch in call order.
- Regression test `a_finished_call_resolves_its_own_card_without_waiting_for_the_batch` gates a
  slow neighbour on the fast call's event — deadlock IS the assertion. Verified it fails (5.00s
  timeout) with the early emit disabled and passes (0.00s) with it. 1,310 Rust tests green.
- STILL OPEN: the card looks identical whether the model is still typing the call, it is queued
  behind a solo tool, or it is running. Tools do not start until the whole assistant message has
  finished streaming, so a card can shimmer for the rest of the message before anything runs.

## 2026-08-17 — Fatal crashes now write their own report; `workspace_tree` bounded by BYTES

**`crash.rs`** — a Windows exception handler registered `CALL_FIRST` catches stack overflow,
access violation and four other fatal codes and writes `logs/aurora-crash.log`: exception name,
faulting address, thread id, **module base**, and every return address with its RVA. It records and
steps aside (`CONTINUE_SEARCH`) — never alters the crash. Verified end-to-end by a test that kills a
child process with real recursion.
- It cannot use `logging::write_entry`: that allocates, opens a file and takes a `Mutex` the
  crashing thread may hold. Instead — handle opened at install, fixed 1 KB stack buffer, hand-rolled
  hex, no lock, one atomic against re-entry.
- **`SetThreadStackGuarantee(64 KiB)` on every tokio worker** (`lib.rs` builds the runtime with an
  `on_thread_start` hook) — without reserved stack there is nowhere to run the handler when the
  crash IS an exhausted stack, and the agent runs on those workers.
- **`[profile.release] strip = true` made crash reports useless**: the pdb held 6,685 public symbols
  and no line coverage, so every frame resolved to a WebView2 annotation 400 KB away. Now
  `strip = false`, `debug = "line-tables-only"` — pdb 6.7 MB → 68 MB, **exe unchanged** (MSVC keeps
  debug info in the pdb). Keep the pdb of any build whose crash logs you may need.

**`workspace_tree`** — same JSON contract (the agent-window tree card reads `children` / `elided` /
`depthLimited` / `lineCount`; do not change the shape), new engine:
- **Byte budget, measured not estimated.** `MAX_TREE_BYTES` (48 KiB) is checked against the real
  serialized tree; over it, the per-directory quota halves and the tree is re-selected, up to 8
  passes. This finishes the half-learned lesson at lesson.md 2026-08-10 — one live call on a pnpm
  monorepo produced **79,491 bytes against a 500-node budget** and now lands at 36,360.
- **Each retry restores a pristine copy of the children lists first** (`reset_selection`). Trimming
  is destructive, so a second pass over an already-trimmed tree computes every "+N more" from a
  short list and under-reports what was left out.
- `render` was the last recursive walker in the file — now iterative, matching the walk and both
  quota passes which were already explicit-stack for exactly this reason.
- Line counting uses `memchr` (lf + cr − crlf per chunk, CRLF split across reads handled); the two
  pre-existing line-counter tests pin the semantics unchanged.
- Every stage logs: start (path/depth/flags), walked (nodes, ms), stats (counted, too_big, ms),
  each byte-budget tightening, and done (nodes/discovered, elided, bytes, total ms).

**Still open:** the stack overflow is NOT diagnosed. It reproduced with journaling disabled, so that
change is cleared; a test firing the exact 7 concurrent `workspace_tree` calls at the real checkout
passes, so the tool is cleared too. It crashed on one build and not the next when only debug-info
settings differed — so it is marginal or timing-dependent and WILL return. The reporter is armed and
the build now has line tables, so the next occurrence names the function.

## 2026-08-16 — Messages reach disk as they happen, not at turn end

A turn used to live entirely in RAM until `run_turn` returned; `turn_driver` step 9 wrote the whole
session once. A 74-message, 20-minute analysis turn was therefore one kill away from nothing at all.
`Session` now owns an optional `Journal` (path + `AtomicUsize` written count) and `append_message`
streams each message to the thread's JSONL. The end-of-turn `save_to_path` is still the authority —
it rewrites the file and re-syncs the counter.
- **The journal only ever says "one more line."** Any rewrite it cannot express — Retry rewind,
  compaction replacing the head, `clear` — leaves `written != len-1`, which silences it until the
  next full save. Appending across one of those would produce a transcript that never happened.
- **`Journal` has a hand-written `Clone` that yields `None`.** A fork/duplicate inheriting the
  source's path would interleave two conversations into one file. Not remembering to clear it at
  each fork site is exactly the bug that impl makes impossible.
- **Torn-tail repair, or this change would make crashes worse.** `parse_jsonl` drops a malformed
  FINAL record when the file lacks a trailing newline (an interrupted write) and still fails loud
  on a malformed line anywhere else. `load_from_path` reads whole rather than streaming, because a
  line iterator has discarded the trailing-newline fact by the time parsing fails.
- One `write_all` per record (line + `\n` together): two calls can be interrupted between them.
  No `sync_all` per message — the target is process death, which the page cache survives; the
  end-of-turn save syncs.
- Attached in ONE place, `registry.rs::load_or_create_session`, which is the only funnel for
  sessions a turn can run on. Read-only `store.load()` and `duplicate()` get no journal by
  construction. Team member sessions (`team/member_actor.rs`) are still unjournaled.
- Multi-project safe: one journal per thread, one `Mutex<Session>` per thread, threads are
  per project — two open projects write two files and never contend.
- 1,291 Rust tests green. **NOT runtime-verified.**

## 2026-08-16 — `file_read` serves a line range across several files

`paths: [4 files] + start_line/end_line` was rejected ("a line range needs one file"). Observed
live: ten batch reads in one assistant message, all ten failed, one full iteration burned. The
request is not ambiguous — it means the same range from each file — and the rejection existed only
because the batch case was never implemented. `multi_file_read` now takes an optional `Window` and
slices per file through `file_read::slice_window`, the same function and 1000-line cap the
single-file form uses; the `largeFile` bail-out is skipped when a window is present (a window is
*how* you read part of a big file). The size budget is spent on sliced bytes, not whole files.
- The input was always SCHEMA-VALID: `path` xor `paths` cannot be expressed (a top-level `oneOf`
  makes xAI/grok 400), so the rule lived in prose only. Same reasoning already applied to
  1-element `paths` + window; this finishes the job for N.
- 1,283 Rust tests green, clippy clean on both files. **NOT runtime-verified** — needs a rebuild.

## 2026-08-15 — Tools can be loaded on demand (`tool_search`), and `agent_v2.rs` split

**`commands/agent_v2.rs` (3,238) → `commands/agent_v2/`**: mod.rs (225) · registry.rs (300) ·
turn_driver.rs (503) · tool_policy.rs (301) · tauri_layer.rs (204) · tests.rs (1,737). Same proof
as the conversation split: ranges tile the file, item names identical (108 fns / 18 types / 2
consts), tests green. Two things needed care — `mod tauri_layer` stays declared in mod.rs with its
`pub use tauri_layer::*` (the `__cmd__*` companions `generate_handler!` needs are only reachable
through the glob), and trait-impl methods must NOT take `pub(super)` (E0449).

**Deferred tools.** New `tools/tool_search/` bucket. When `defer_tools` is on, the deferrable
buckets — `mcp_*`, `browser_*`, `team_*` — are built as usual but held in a catalogue instead of
the per-turn registry, and one `tool_search` entry is registered in their place. Its DESCRIPTION
carries the names (capped at 4,000 chars, then a "+N more" note), so the model sees what exists
without paying for schemas. `select:a,b` loads exact names; keywords rank name hits over
description hits; `+term` requires the term in the name.
- **The mechanism is `ToolRegistry` being `Arc<DashMap>`**: the executor holds a CLONE of the live
  per-turn registry, and `conversation/mod.rs:436` re-reads `schemas()` INSIDE the turn loop — so a
  tool loaded on iteration N is advertised and callable on N+1. No runtime change was needed.
- The catalogue holds the real `Arc<dyn ToolExecutor>`, not a copy of the schema, so a native tool
  keeps its `install_permission_gate` wrapper and an MCP tool keeps its bridge routing.
- Defaults OFF (`None` on the wire = off, unlike `browser_tools` whose `None` = on): this one
  changes how the model REACHES a tool, so it is the user's call. Settings → Agent → Tool loading.
- The 3-line prompt section is gated on the same flag the request carries (same contract as
  chapters), so the instruction and the roster can never disagree.
- NOT saved: the IPC payload still carries every `AllowedTool` — the bridge executors must exist to
  be loadable. Only the model-facing roster shrinks, which is the part that costs money.
- Rust 1,279 tests (+15) and 572 frontend tests green; tsc + eslint clean. **NOT runtime-verified.**

## 2026-08-15 — `conversation.rs` (7,466 lines) split into a directory module

`agent_runtime/conversation/` — mod.rs (1,090: config, struct, `run_turn` loop) + compaction.rs
(988) · tool_exec.rs (611) · tool_results.rs (507) · trim.rs (184) · tokens.rs (168) ·
context_injection.rs (188) · util.rs (105) · tests.rs (3,703). Moved VERBATIM, then rustfmt.
- **Children are descendants, which is the whole trick**: they read `mod.rs`'s private imports via
  `use super::*`, and reach `ConversationRuntime`'s private fields because privacy is
  module-tree-based. Methods and struct fields that were file-wide became `pub(super)` — that is
  the *exact* reach they had before, not a widening.
- Verified three ways: the cut ranges are asserted to TILE 1..7467 with no hole or overlap (a hole
  failed the first run — line 2025); function/type/const/test-name sets are identical before and
  after (187/25/26/85); `cargo test --lib` 1,264 passed / 0 failed, before AND after rustfmt.
- Two seams exposed PRE-EXISTING doc drift, moved verbatim rather than silently fixed:
  the block describing `fixed_request_overhead_tokens` is attached to `transcript_hint`, and
  `execute_tool_calls`' doc sits on `concurrent_batch_len`. Owner's call whether to re-attach.
- `tool_results.rs` needed NO import from its parent — that seam is genuinely decoupled.
- Remaining files ≥2,500 lines: `commands/agent_v2.rs` (3,238), `commands/mod.rs` (3,234),
  `api/provider_kernel_adapter.rs` (2,956), and `conversation/tests.rs` itself (3,703).

## 2026-08-15 — `read_lints` implementation traced and verified
- Rust-owned `tools/shell_editor_todo/read_lints.rs` runs project-wide `tsc -b`, `cargo check`, Ruff/compileall, or direct `node --check`; requested paths select checker families and only filter diagnostic lines, not checker scope.
- The `agent_read_lints` frontend event is debug-only; Rust returns the real output. The legacy frontend metadata still incorrectly describes Monaco/open-file diagnostics. Focused implementation suite: 12/12 passed.

## 2026-08-15 — agent_runtime module doc de-phased (comments only)
- Removed the "Phase 2.1" header, the "Phase status" block (2.2/2.3 futures long since shipped), the
  "Phase 2.3" label on the bridge bullet, and the dead `docs/plan/rust-agent-migration.md` reference
  (glob confirms no such file exists). Intro now calls the TS loop "a thin composing façade" and points
  at its real path `src/apps/agent/services/runtime/agent-service.ts`. Comments-only; no compile check run.

## 2026-08-15 — Architecture overview written for the agent window (no code changed)
- Read-only survey of the whole repo to answer "explain the architecture". Verbatim findings,
  for the next time someone asks: Tauri 2 desktop shell, ONE React bundle (`src/App.tsx`) routed
  by pathname — `/` = IDE (`MainLayout`), `/agent-window` = agent window (`AgentWindow`); both
  share `src/kernel/` (stores, IPC runtime, shared UI) and `src/bridge/` (agent↔IDE event glue).
- Agent loop lives in RUST: `agent_runtime/` (ConversationRuntime::run_turn in conversation.rs,
  ~7.2k lines) behind the `agent_chat_v2` Tauri command; the TS `AgentService` is a documented
  thin façade composing prompt/context/tools then delegating to `AgentRuntimeClient` over 4 IPC
  channels (`agent_event`, `agent_tool_pending`, `agent_turn_complete`, `agent_turn_error`).
  Tool execution is split: 41 Rust-builtin tools in `tools/*` buckets (10 file/search + 7
  shell/todo + 16 browser + plan/design/canvas/transcript/code_intel/diagnostics) vs frontend
  bridge tools (skills, team, MCP, ask_question) resolved via `agent_post_tool_result`.
- Persistence: sessions are JSONL files (NOT the db) under `%LOCALAPPDATA%\AuroraIDE\sessions`,
  owned solely by `SessionStore` inside `AgentRegistry`; SQLite `aurora.db` holds settings,
  workspace/editor state, providers, themes, tool permissions. Backend also hosts `code_index`
  (tree-sitter structural index behind the `code` tool + repo map), `context` engine (legacy,
  IDE-seeded), `plans`, `checkpoints`, `undo_redo`, `mcp` (rmcp), `team` (TeamBus brain in
  `~/.aurora/projects/<id>`), `browser_runtime` (native child-webview BrowserManager), `shell`
  (profile discovery), `typing_assist` + `prompt_refine` (local GGUF composer helpers).

## 2026-08-15 — A failed tool card is a card like any other: quiet row, closed by default

Two reversals of the 2026-08-11 pass, both flowing from one misread of "state the reason on the
row". `ToolCallCard` puts **`Failed`** in the outcome slot instead of `parsed.summary`, and
`defaultOpen` is now plainly `false` — a live failure no longer forces itself open and then stays
open for the rest of the turn while the agent recovers around it. `success:false` messages are whole
sentences, and the slot is one line beside a filename, so the row was showing a clipped half-word.
The ✗ plus the label carry the state; the sentence and its recovery hint are one click away where
there is room for them. `tool-result.ts` still sets `summary` from the error for other consumers —
the card is what changed.

## 2026-08-15 — Compaction budgets are absolute token counts, never window fractions

`COMPACT_TAIL_MAX_TOKENS = 40_000` (`conversation.rs`) is the verbatim tail a compaction keeps,
floored by `COMPACT_TAIL_WINDOW_DIVISOR` (`window / 4`) so a small model scales down and a large
one never scales up. It replaces `COMPACT_TAIL_PCT = 30`, which authorised a 330k tail on the 1.1M
model. Sized against `openclaude`, where every budget is a number (40k preserved segment, 50k file
restore, 25k skills, 30k autocompact buffer) and standard `/compact` keeps no tail at all.

The ring now separates **measured** from **projected**: `useAgentContextStore.projectedByThread`
holds Aurora's post-compaction estimate and is cleared by the next real `setUsage`. It used to be
written into `byThread` as `estimated: true`, which is the flag for "the provider reported
nothing" — a different claim, and a false one. Cache-hit telemetry is suppressed while projecting
(those hits belong to a context that no longer exists). Manual `/compact` now invalidates the cost
breakdown in its `finally`, the way `sendTurn` always did.

Still open, same area: `compaction_cut` can only cut at a **user message**, so a chat with 3 long
user turns has 3 possible cut points. Cutting at a tool-result boundary inside a turn is the next
step (`repair_tool_pairing` already keeps such a cut valid).

## 2026-08-14 — A running tool animates its OWN mark; the spinner is gone from the row
- **Two halves, deliberately split.** The SCAN is universal (`33-tool-glyph-motion.css`, new
  partial): a masked full-strength copy of the glyph sits over the base and a soft band passes
  DOWN it, so every mark — including MCP tools nobody drew for — reads as live from one rule. The
  PART is per glyph: `AgentIcon` tags the one element that does the work with `data-part`, and the
  stylesheet owns the timing. Geometry and motion never learn each other's details. Vocabulary is
  fixed at 9 (`nib line lens caret pulse flow travel travel-y turn`, + `turn-b` counter-phase);
  83 elements tagged, all 37 marks `toolIcon()` can return covered except `files` (one indivisible
  path — it rides the scan alone, same as an un-tagged MCP mark).
- **No accent.** The mark rests at `--agw-text-muted` and rises to `--agw-text` — the two colours
  `.agw-shimmer` already uses on the label beside it. Owner's call; a tint scheme was probed
  (part-only / by-consequence / by-family) and is still OPEN, not rejected.
- Beat is **1.67s** (the 2.5s shimmer at the 1.5× the owner picked), one var, one pass of the scan
  = one stroke of work, so the halves cannot drift. `line`/`tick` parts carry `pathLength={1}` so a
  single dash rule writes a 3-unit text line and a 19-unit divider at the same speed.
- **The status column is EMPTY while running** (the ✓/✕ box keeps its 16px, so nothing shifts). A
  spinner 8px from an animated glyph is two things saying one thing. Canvas-launch cards keep theirs.
- Reduce-motion comes from **Aurora's own switch only**, never `@media (prefers-reduced-motion)` —
  the OS reports reduce on the owner's machine, and honouring it here switched the whole feature
  off while the shimmer 8px away kept running (see lesson.md). It freezes the mark BRIGHT and drops
  the scan copy; never a blanket `animation: none` under `.agw-root`.
- Probe: `C:\Users\Alvan\Documents\aurora-tool-running-state-designs.html` (11 motion variants +
  7 tint schemes). VERIFIED: tsc 0, eslint clean, 568 tests / 64 files, `pnpm build`.
  **NOT runtime-verified — needs eyes in `tauri:dev`.**

## 2026-08-13 (6th) — Composer `+` opens a menu; Providers V2 layout built then PULLED
- **`+` is no longer a shortcut to the OS file picker.** New `ComposerPlusMenu.tsx`: Files & images
  (the old behaviour, now one row) · Mention · Actions · Browser. Chrome is the PROJECT SWITCHER's,
  class for class (`.agw-projmenu` + rows + portal-into-`.agw-root`) — owner's explicit ask, two
  menus on one screen must be the same object. Dropped its filter box (4 fixed rows). Opens UPWARD,
  placed by `bottom` from the trigger's top edge, so it never needs measuring first.
- **Mention/Actions rows TYPE `@` / `/` into the editor; they never call `setMention`/`setSlash`.**
  Both pickers key off `MENTION_RE`/`SLASH_RE` matching the text before the caret, so inserting the
  character brings detection, ranking, pill splicing and the delete-it-again escape hatch along
  unchanged. Driving the state directly opens a menu with no trigger behind it. Reuses
  `insertTranscript`, whose leading-space rule is exactly what both regexes need.
- New icons `at` / `slash` (the trigger characters as themselves — the row teaches the shortcut it
  replaces) and `eye` / `eye-off`. **The globe was the reveal icon on FOUR password fields**
  (`? "inspect" : "browser"`) — providers key, backup keys, MCP env, title-model key. All now eye +
  `aria-pressed`; a test fails if that pair comes back.
- **Providers V2 (pinned header + Connection/Models tabs) was built, shipped and REVERTED the same
  session.** It fixed the fold and the 880px dead gutters, but the owner's actual complaint was the
  DOUBLED SIDEBAR (settings nav 232px + provider rail 248px = 480px of chrome doing one job), and
  the probe never listed that as a fault so none of its four variants addressed it. Two real bugs
  found while it was live, worth knowing if it is ever rebuilt: `.agw-prov-conn` is a GRID, so as a
  `flex: 1` tab body `align-content` defaulted to `stretch` and poured ~90px into every field gap;
  and moving Delete inside that grid made it a grid ITEM whose divider stopped mid-row
  (`grid-column: 1 / -1`). A test now asserts NO `data-ui` in the providers CSS or `uiVersion` in
  its TSX, so half of it cannot creep back.
- Candidate when it is revisited (owner has not chosen): drop the provider rail entirely and make
  the provider name a filterable dropdown in the header — the same `.agw-projmenu` component — which
  is the only option that actually removes the second rail. Probe:
  `C:\Users\Alvan\Documents\aurora-providers-layout-designs.html`.
- VERIFIED: tsc 0, eslint clean, 562 tests / 63 files, `vite build`. NOT runtime-verified.

## 2026-08-13 (5th) — Appearance → Interface (Classic / V2); segmented pill now travels
> Renamed the same day: shipped as "Surface depth — Flat / Raised", then became **Interface —
> Classic / V2** when the owner wanted layout bound to it. A control named for depth that also
> restructures a page is lying, so the NAME moved up a level rather than the scope creeping under
> the old one. `classic` is FROZEN: it keeps today's rendering and stops receiving design work, so
> future changes never need verifying twice.
- **V2 is a SWITCH OVER the themes, never a theme.** `uiVersion` pref → `data-ui="v2"`
  on `.agw-root` → re-points five paint aliases declared in `01-root.css`
  (`--agw-card-paint/-line/-lift/-lift-hover`, `--agw-control-lift`, `--agw-grain`). Flat resolves
  them to the exact pre-existing tokens, so off is a byte-equivalent no-op. Raised TRADES fill
  contrast for elevation — the card fill color-mixes 55% back toward the user's own `--agw-canvas`
  and the border drops to 62% alpha, then a three-part shadow separates (1px top light-catch,
  tight contact, wide ambient at -10px spread so it pools under rather than haloing). Light
  appearance gets its own inverted light-catch. A test pins both halves: flat must equal the raw
  tokens, and the raised block may set NOTHING but those six aliases.
- Settings cards ride the pre-existing `--agw-set-shadow` / `-soft` hooks on `.agw-settings`
  (one bridge rule), so no per-card shadow edits. Cards converted to the aliases: set-panel,
  set-tile, set-group, mcp-card, appr-card, skill-card/-hero, prov-detail, atlas, proj-stats,
  tasks, queued, canvas-launch, composer-surface.
- **Deliberately NOT lifted:** tool cards (08-transcript-flow.css documents them as un-boxed
  timeline entries on purpose), and `.agw-tasks`/`.agw-queued` — those are ATTACHED to the
  composer (no bottom border, tuck 12px behind it), so a shadow would draw a seam through one
  object. Attached surfaces stay flat; free-standing ones lift.
- Grain is on the two GROUNDS only (`.agw-root`, `.agw-settings`), as a `background-image` data
  URI, never a `mix-blend-mode` overlay — that would pull the whole window into one blended
  stacking context. Reference for the whole look: QuantumHub client's Agent Studio
  (`apps/quantumhub-client/src/renderer`), whose `--shadow-premium` is the same three-part recipe.
- **`AgwSegmented` selection is now ONE travelling pill** (`.agw-seg-thumb`), measured from
  bounding rects minus `clientLeft` (an absolutely positioned child sits against the padding box,
  and `offsetLeft`'s reference edge differs by engine). Animates transform AND width — the options
  are words, so the pill genuinely resizes. `data-ready` is set one frame after the first measure
  or every control flies in from the left on mount; ResizeObserver covers label ellipsis and
  Interface-text-size changes. Active buttons lost their own fill/shadow (both moved to the pill)
  and hover/press are now scoped `:not([data-active])` — the buttons sit above the pill, so an
  active-button fill would paint over it.
- VERIFIED: tsc 0, eslint clean on touched files, 560 frontend tests / 63 files, `vite build`.
  **NOT runtime-verified** — needs eyes in `tauri:dev`; there is no browser bridge in this session.

## 2026-08-13 (4th) — Temperature is per-model now; the "..." rows were the provider
- **Temperature moved to the model row** (schema **v22**, `provider_models.temperature`, NULL =
  inherit). Chain is model → provider `defaultTemperature` → `DEFAULT_TEMPERATURE` **0.8**, resolved
  once in `model-request-config.ts::resolveTemperature` (a function, not `??`, so an explicit `0`
  survives). It was previously a hidden `app_settings.temperature` no UI could edit, hard-coded to
  1.0 at the send site, while Settings → Agent claimed it was a model setting. Field lives in the
  model's expanded panel in Providers; Claude 5+ reject sampling so Rust strips it there regardless.
- **The stray `...` rows between tool cards are the PROVIDER, not us.** Reproduced with
  `scripts/probe-provider.mjs` (new): it drives Aurora's loop shape at any endpoint with no system
  prompt and no Aurora in the path — a6api/claude-opus-5 emitted `text("...")` before the tool call
  on 3 of 8 turns; real Anthropic on the same build never does. `timeline.ts::isSilentContent` now
  drops dot/dash-only text without splitting the tool run.

## 2026-08-13 (3rd) — Composer picker depth, screenshots at 1024/JPEG, `report_aurora_issue`
- **The `@` / `/` picker** is one component now (`ComposerMenu.tsx`) and opens from BEHIND the
  composer: `z-index: -1` on `.agw-mention` + an 18px rise (larger than the 6px gap, so the box
  occludes the start), the panel's shadow casts UP only, and the input casts DOWN onto it via
  `:has()`. It shook because `.agw-menu`'s `agw-pop-in` keyframe and a Framer spring animated the
  same element — a running CSS animation outranks inline styles, then hands back mid-flight. One
  owner now; height is measured and eased so re-filtering never leaps.
- **Screenshots: longest edge 1024, JPEG q85, both axes** (`SCREENSHOT_MAX_EDGE`,
  `encode_screenshot`). Measured on the user's own provider: a 1400px capture and a 1024px one cost
  the SAME tokens (charged per tile, not per pixel), and JPEG q85 costs the same as PNG at a fifth
  of the bytes — 1151 KB → 109 KB per capture, re-sent on every turn. Pasted/dropped/annotated
  images go through the same bound in `image-utils.ts::toModelImage`. Old `.png` threads still
  rehydrate: the marker carries its own `media_type`.
- **`report_aurora_issue`** (new `tools/diagnostics/` bucket, roster 40 → 41): append-only, one
  `report` string, stamped by Aurora with time + thread id, written to
  `<root>/reports/aurora-issues.md`. Rendered as expandable entries in Settings → Diagnostics
  ("Reported by the agent"). It replaces a paragraph of standing instructions that asked the model
  to remember faults and mention them "at the end of the task" — a moment the model cannot detect,
  across a span compaction is free to erase.

## 2026-08-13 — Attached images moved INSIDE the user card
- The image row was a SIBLING above `.agw-bubble-user`, carrying its own `max-width: 82%` and
  right-hug to imitate the card beside it. Under the sticky-user preference the card pins, widens to
  full column and caps at 34vh — the row got none of it: a right-hugging thumbnail over a full-width
  band, no height cap (a few 220px tiles = a pinned header eating the viewport), and on an
  image-only message no card rendered at all, so the copy chip landed on the picture. Now a child of
  the card, above `CollapsibleBubbleBody` (which clamps by LINE-height and would cut an image).
  Matches the reference: `DOCS/visual-studies/antigravity/13-user-bubble-image.png`.
- The thumbnail is a **fixed 76px tile** (`object-fit: cover`, cropped from the top because these are
  nearly always screenshots), not a `max-width` ceiling. A ceiling gave every attachment a different
  size and let a wide screenshot render as a full-width letterbox strip. It is a marker; the click
  opens `AgentImageModal` for actually reading it. Do NOT use a percentage inside `min()` for the
  cap — it does not resolve against a shrink-to-fit box and silently removes the constraint.
- **Tool-group header: the failure mark is a red ×, not a pill.** `1 FAILED` was bordered, tinted
  and uppercase — the brightest object in the quietest row. Now the same glyph the failed row wears,
  with the count only from 2 upwards.
- tsc 0, eslint clean, 552 tests. NOT runtime-verified in `tauri:dev` yet.

## 2026-08-13 (2nd) — Header task card: one width, and a calmer self-reveal
- `.agw-taskpop` had `min-width: 260px` + `max-width: 28rem` — a range, not a measure, so the card
  was as wide as its longest task title and re-measured every time the agent wrote one. Now
  `width: min(320px, 100vw - 24px)`; rows clamp to 2 lines, the heading ellipses, both keep the full
  text on `title`.
- The card now animates its own resize (framer `layout`) instead of jumping when a row lands, and
  the AGENT-DRIVEN reveal gets its own slower curve (260ms ease-out) while hover/click keep the
  house tween — it is the one popover here that opens with nobody touching it, and at menu speed
  that reads as a flicker. `place()` also stops handing back a new position for scrolls that never
  moved the header (it is on a capturing `scroll` listener, so that was every transcript frame).
- tsc 0, eslint clean, 552 tests. NOT runtime-verified in `tauri:dev` yet.

## 2026-08-12 (8th) — Terminal: real shells, and the agent can read them
- **The agent can now read the USER's terminals.** Two frontend tools (`terminal_list`,
  `terminal_read`, both auto-approved read-only) over the xterm buffers, which are in the window,
  not in Rust. Session registry moved out of `TerminalPanel.tsx` into
  `services/terminal/terminal-sessions.ts` — a tools module importing a React component to reach a
  Map is the wrong shape. `scope: "last_command"` works with NO shell integration: Aurora owns the
  PTY, so the Enter keystroke in `term.onData` marks the buffer line where that command's output
  starts. Head+tail (40/40) because a compiler puts the real error at the top and the summary at the
  bottom; the elision is stated inline as `… N lines hidden …`. Read-only by design — no
  `terminal_write`; typing into a live shell is a different trust level and `shell_execute` exists.
- **The terminal was never running the user's shell.** It asked for kind `powershell`, which
  resolves to Windows PowerShell 5.1 once the scan registers it (the Rust comment even says the
  argument historically meant pwsh 7). It also overwrote the user's `prompt` function and ran bash
  with `--noprofile --norc`. All removed: `pwsh` is the default, the PowerShell prompt is installed
  only when the profile left the stock one, POSIX shells get `-i` and their own rc. `cmd` was
  launched with PowerShell's `-Command` (it fails the `isPosix` test) and died instantly.
- Nerd Font families are appended after the user's code font so prompt themes (oh-my-posh) render
  their glyphs; browsers fall back per glyph, so the user's font still draws the text.
- **32 commands were answered on the MAIN thread while waiting on the database** — the freeze where
  X stops working. Found by a new test (`commands/command_thread_safety.rs`) that reads the real
  source and fails on the shape; it also proves itself against the known-bad snippet.
  `shell_profiles_get` additionally now reads the in-memory registry, so it never queues at all.

## 2026-08-12 (7th) — Skills can be deleted from disk; `todo` costs one round trip per item
- **Delete on every skill card** (Settings → Skills). Deleting a FOLDER skill removes the whole
  folder, not just `skill.md` — `references/`, scripts and assets live beside it, so removing the
  markdown alone would clear the card and leave the skill on disk. New `SkillDefinition.sourceDir`
  records the folder form; `resolveSkillDeleteTarget` re-derives the target from the skill roots and
  refuses anything not strictly inside `<project>/.aurora/skills`, `<project>/.agents/skills` or the
  global path (also refuses `..`, and the root itself). It is `remove_dir_all` with no recycle bin,
  so the confirm names the exact path. `removeSkillToggle` purges the toggle from EVERY workspace —
  a global skill can be equipped in several, and a stale `true` would keep eating the 10-cap with no
  card left to unequip. The card became a `<div>` + stretched equip button (a button can't nest one).
- **`todo` now matches Claude Code's, in all three places it differed** (owner's ask). The measured
  problem: session `3d410c6f…` had 35 todo calls, each its own assistant message with ONE `tool_use`
  block and its own ~255k-token input pass, because `op:"update"` took a single `id`+`status` and the
  description prescribed exactly that. Never a batching limit — msg#206 of that same session carries
  3 tool_use blocks.
  1. `update` takes `updates: [{id,status}]`, applied atomically (one bad id changes nothing); the
     single `id`+`status` form still works, and an empty `updates` beside a valid `id` is read as a
     placeholder, not a no-op. Closing one task and starting the next is now ONE call.
  2. **`<aurora_task_reminder>`** — `task_reminder_block`/`inject_task_reminder` in conversation.rs
     re-read the store on EVERY request and append the live checklist to the LATEST user message.
     Deliberately the opposite placement from `inject_repo_map`, for the opposite reason: the map is
     static so it rides at the head inside the cached prefix, while this list changes every few calls
     and at the head would rewrite that prefix and re-bill the conversation. The model no longer
     needs `op:"read"` to know where it stands, and survives compaction.
  3. **The header TaskIndicator FLASHES OPEN for 3.5s whenever the agent changes the list**, then
     collapses. Driven by a `useAgentTaskStore.subscribe` callback, not an effect watching `tasks` —
     a render-time comparison cannot tell a real change from a mount, a thread switch or reopening
     an old thread. Escape/click-away dismiss it; a hover or pin outlives the timer (`open` is an
     OR). The transcript card names only what CHANGED (one line per entry in `updates`, "Updating
     tasks" while in flight).
- **DO NOT draw the checklist in the transcript.** I did, and it was wrong: the header dropdown is
  the list's ONE home (it is live; a card is a record of a moment), so an inline copy says the same
  thing twice and ages badly. Reverted the same session. This is the fourth time the checklist has
  tried to move into the transcript — the module doc on TaskIndicator.tsx records the first three.
- `ide_context` is NOT IDE-only despite the name: in the agent window it carries base context, auto
  rules, selection, `/` rule blocks, the MCP summary, the skill catalog/references and team policy.
  It is load-bearing; the name is legacy.

## 2026-08-12 (6th) — right-click menu overflow fixed; split audited clean
- The CSS split/prune was AUDITED and is sound: 1098 → 1028 classes, all 70 removed classes verified
  unreferenced across ts/tsx/rs/html, manifest ↔ partials agree, `pnpm build` green. The reported bug
  was NOT a split regression — see lesson.md (3rd) for the fixed-width-popover cause and fix.
- **OPEN, owner's call: `.agw-tree-row` / `-caret` / `-name` are defined TWICE** — `09-tool-cards.css`
  (transcript trees: workspace_tree, MultiFile, FileList) and `14-dock-files.css` (the Files panel).
  14 loads later, so the Files-panel rules win for BOTH: tool-card tree rows render at 26px/`fs-ui`
  instead of the intended auto-height/`fs-label`. Pre-existing (the split preserved order byte for
  byte), not a regression. Fixing it means scoping one set, which visibly re-densifies transcript
  tool cards — a design change, so it needs a probe first, not a silent edit.

## 2026-08-12 (5th) — freeze fix + font pass runtime-verified on the real store
- User confirmed the boot freeze is gone. His log (example.txt) shows the new WARNs firing:
  `thread_list_summaries` streams 569 threads in ~455ms off the main thread; usage-stats full
  scan ~1.1s in the background. Both healthy — but the log exposed the frontend calling the
  thread listing 4× and usage stats 2× simultaneously at boot (dedupe candidate), and the
  300ms warn threshold is slightly tight for a 569-thread store.
- Fonts: PrintWindow capture of the live agent window, zoomed 3× — headings (fw 700) and strong
  (600) render with clean uniform stems, no synthetic-bold smearing. `font-synthesis-weight:
  none` confirmed working. Caveat: compositor capture can strip ClearType fringing, so
  subpixel-vs-grayscale can't be proven from pixels; canvas sandbox + IDE window text still
  need a human glance (same properties applied, surfaces weren't open).

## 2026-08-12 (4th) — boot "(Not Responding)" fixed: sync commands full-parsed 193MB of sessions on the main thread
User's app froze ~5s at boot (window "Not Responding", then normal). Cause chain, verified on disk:
- `thread_list_summaries` (chat rail, called at boot) is/was a SYNC `#[tauri::command]` — Tauri v2
  runs sync commands ON THE MAIN THREAD, so its cost blocks the message pump of every window.
- `SessionStore::summarize_thread` full-deserialized every message block of every thread via
  `Session::load_from_path` just to get a count + 120-char preview — its own comment said streaming
  was the plan, then didn't. This machine: 569 JSONL / 193 MB → seconds of parse per listing.
- Fix (three files): `summarize_thread` now line-scans (count = non-empty lines; preview = last
  line starting `{"role":"user"` — sound because `role` is ConversationMessage's first field and
  serde_json keeps declaration order — typed-verified before use). `thread_list_summaries`,
  `usage_stats_get`, `project_stats_get` are now async + `spawn_blocking` (the stats pair
  legitimately full-loads every session; it just must never do it on the main thread).
- Slow-path WARNs added (threads.list >300ms, usage/project stats >1s) so a regression names
  itself in the log instead of reappearing as a mystery freeze.
- VERIFIED: cargo check + 1220 lib tests green (incl. `message_count_and_preview_come_from_jsonl`
  covering the new scan). Not yet runtime-verified against the real 193MB store.

## 2026-08-12 (3rd) — dead-class prune: 72 orphaned agw- classes deleted (−683 lines)
Phase 3 of the `split-css` branch, after the split + font pass below. 1,097 → 1,025 classes.
- **Verification was the work.** The naive "class not in TSX" scan lies twice: comments write
  `--agw-*`/"agw-" (marks everything alive via prefix match), and `--agw-fs-md` var refs contain
  `agw-fs-md` (drowns the token set). Clean pass = strip `--agw-` refs + comment lines, keep
  template prefixes (`agw-foo-${x}` → prefix `agw-foo-`), then per-candidate repo-wide rg with
  `(?![A-Za-z0-9_-])` boundary across ts/tsx/rust/html. Classes are never built dynamically in
  this codebase (only VAR names are — tokens.ts); that's what makes static analysis sound here.
- Families removed: old model/mode picker (menu items, avatars), reasoning picker
  (pill/menu/items — replaced UI), profile chart/rows/collapse, provider add-menu +
  prov-layout/list, set-card grid (per-tool settings cards), cmd-chips, br-inspect toolbar,
  attach pills, bare `.agw-pill` (only `-inline/-ico/-sel` variants live), resize-handle,
  team-bubble, think-pulse, tree-icon, proj-chips, settings-stack/nav-foot, bgtask-cmd.
- Prune script v1 sheared comments (comma inside a comment split the selector list mid-comment
  → unbalanced `/*`). v2 tokenizes comments as standalone nodes so preludes can't contain them,
  recurses @media/@supports/@container, and passed a byte-identical no-op roundtrip before the
  real run. Orphaned family comments + 3 stale cross-references cleaned by hand afterwards.
  No orphan keyframes (agw-pulse was never defined; the one flagged, agw-drop-beam, is used on
  a continuation line single-line greps miss).
- VERIFIED: full `pnpm build` + 535 tests / 61 files (`--pool=vmThreads`). Still NOT
  runtime-verified — same caveat as phase 2; needs eyes on both windows in `tauri:dev`.

## 2026-08-12 (2nd) — agent-window.css split into 32 partials; font-rendering pass
Branch `split-css`. Two phases, deliberately separate so phase 1 stays provable:
- **Phase 1 — the god file is gone, bytes unchanged.** `agent-window.css` (14,310 lines) is now an
  @import MANIFEST over `theme/agent-window/01-root.css … 32-project-stats.css`, cut at verified
  top-level boundaries by a throwaway comment/string-aware script (not by hand, not by codemod).
  ORDER IS LOAD-BEARING — numeric prefixes = cascade order; the manifest header says so. Proof:
  the split partials re-concatenate byte-identical to the original, AND a full `pnpm build` from
  both states emitted the same content-hashed `index-*.css`. `appearance-token-coverage.test.ts`
  now reads the partials dir (sorted = cascade order) and gained a test pinning manifest ↔
  directory agreement — a partial on disk that the manifest skips would otherwise pass every rule
  check while never loading in the app.
- **Phase 2 — font rendering unified (deliberate pixel changes, NOT byte-identical).** Audit found
  exactly two sites contradicting the documented `.agw-root` rationale ("antialiased on Windows =
  grayscale AA, thinner washed-out stems"): the IDE `body` (index.css) and the canvas sandbox body
  (canvas-react.ts). Both now `-webkit-font-smoothing: auto` — the canvas one mattered most, it
  renders INSIDE the agent window and its text rasterized visibly thinner than the transcript
  beside it. All three roots (agw-root / IDE body / canvas body) also gained
  `font-synthesis-weight: none`: `--agw-fw-display` is 700 and of the bundled UI faces only Inter
  Variable has a real 700 — IBM Plex Sans stops at 600, so picking it produced smeared fake-bold.
  Italic synthesis deliberately stays ON (no bundled face ships italics; an upright `em` would
  erase emphasis). Weight audit was otherwise clean: 177/178 agent font-weight declarations ride
  tokens; markdown `strong` is fw-strong(600), a real weight everywhere.
- Decision reaffirmed for the record: NO Tailwind migration of the agent window, and no 10k-LOC
  CSS cut exists — only 82/1097 agw- classes are even candidates for dead code. 03-composer.css
  line ~150 documents the doctrine in-file ("Composer rows own their layout HERE, not via
  Tailwind utilities in the JSX").
- VERIFIED: 535 frontend tests / 61 files, `tsc -b`, `pnpm build`, lints clean, canvas +
  token-coverage suites re-run after the phase-2 edits. **NOT runtime-verified** — the smoothing
  and synthesis changes need eyes on both windows in `tauri:dev`. Tests ran with
  `--pool=vmThreads`; the default pool is broken on this machine (see lesson.md 2026-08-12).

## 2026-08-11 — file_edit read-gate narrowed; failed tool cards stopped showing green
Three fixes from one reported transcript (the in-window agent editing Aurora itself).
- **The read-before-edit gate was refusing correct work.** It required every target of a
  `file_edit` to have been opened with `file_read` this session. Observed: the model located the
  exact line with `grep`, batched edits across 3 files, and the WHOLE batch was declined because
  one file was never `file_read` — though the matched text came back in the search result it was
  reading. `read_tracker` records only `file_read`/`file_write`, and it can never observe the other
  legitimate routes (search hits, `code` output, an earlier diff, the user pasting text), so as a
  precondition it will always refuse some correct edits. **What keeps a blind edit safe is the
  engine, not the tracker**: `old_string` must match exactly and be unique, and the batch is atomic,
  so a guess writes nothing. The gate now (a) stays a PRECONDITION only for `replace_all`, which
  waives uniqueness and so can rewrite occurrences nobody has seen, and (b) becomes the DIAGNOSIS
  for a `NotFound` on an unread file, where "you never read this" is the actionable cause. Tool
  description updated to match. 5 new tests, incl. the reported batch shape.
- **Every structured failure rendered as a green check.** `toolStatus` classified only by a leading
  `[error]`/`[rejected]` sentinel, so any `{"success": false}` body — the refusal above, a failed
  exact-text match, a non-zero shell exit — showed a ✓, counted as "done" in the group header, and
  fell through `parseToolResult` to its last-resort branch, which dumped the raw JSON into the card.
  New `resultReportsFailure()` (TOP-LEVEL `success` only — a per-file flag inside a multi-read is a
  partial result, not a failed call) drives the status; `parseToolResult` now summarises with the
  tool's own error + hint. Failures also state their reason on the collapsed row (they were
  dropdown-only, so a failed card showed a bare name).
  **SUPERSEDED 2026-08-15** — the row shows `Failed`, not the reason; the reason is dropdown-only
  again, and a failed card no longer defaults open. See the 2026-08-15 entry.
- **Tool groups auto-collapse once they stop being the live edge** (`isLastRow` from MessageBubble).
  An explicit click still wins in both directions until the turn ends.
- `design_guidelines`/`canvas_guidelines` had no `toolIcon` mapping and fell through to `diff` — the
  file family's folded-corner page on tools that touch no file. New bespoke `design-guidelines`
  glyph: an artboard with two off-centre guides running past its edges.
- **TYPOGRAPHY QUESTION IS CLOSED — the agent window does NOT re-typeset itself.** Measured live in
  `tauri:dev` over two runs (30s and 45s, byte-identical): message text, composer and window shell
  held 16px / 28px / 400 / Inter Variable / 260.59px rendered width from the moment they mounted to
  the end of the recording. **Zero changes.** The only movement in the whole log was `body` — width
  216.63 → 231.68px at **+9ms**, i.e. a face swap on the host document BEFORE React mounted and
  before anything painted, so nothing visible. (The `Face` rows lag it: the face probe polls at
  500ms, which is why the same swap timestamps as +512ms — do not read that as "half a second after
  paint".) Message text is 16px rather than the 15px default because the owner set it in Settings;
  `text scale` is 1 and `size step (md)` is `calc(15px * 1)`, both correct. The enforced-defaults
  work from 2026-08-10 (4th) is therefore confirmed working — no stale override survived.
- **4 fonts baked in** (all OFL-1.1, all STATIC packages so the family carries its plain name —
  `@fontsource-variable/*` registers as "X Variable", the mismatch that made Geist render as a
  fallback, 2026-08-08): IBM Plex Sans 400/500/600 (UI), Cascadia Code + Fira Code + Geist Mono
  400/600 (code). Cascadia was ALREADY named in `CODE_FONT_STACK` but never shipped, so that
  fallback only resolved on machines that happened to have it. Bundle 1.2 → **2.0 MB** (+800 KB, not
  the ~400 KB estimated — Cascadia is 336 KB and IBM Plex 292 KB across their unicode subsets).
  Do NOT trim those subsets: they are why non-Latin text in a reply still renders in the same face
  instead of falling back mid-paragraph, and `unicode-range` means they are never fetched at runtime.
  `BUNDLED_UI_FONTS`/`BUNDLED_CODE_FONTS` in AppearanceSettings.tsx must stay in step with
  `bundled.ts` or the picker offers a face that silently renders as a fallback.
- **`preloadBundledFonts` now follows the USER's chosen faces**, not just the shipped defaults
  (`boot.ts::chosenFamilies`): the IDE's from the root CSS vars, the agent window's from its
  persisted theme snapshot. Preloading a fixed default list meant that picking any other face
  reintroduced the startup swap this module exists to prevent — and bundling more faces made that
  far more likely. The other bundled faces are deliberately NOT preloaded (options in a picker).
- **User bubble: an inline `padding` was silently beating the sticky-user rule.** `MessageBubble`
  set `padding: "9px 13px"` inline, so `agent-window.css`'s
  `[data-transcript-sticky-user] … .agw-bubble-user { padding-bottom: 28px }` never applied — and
  that reserve is what keeps a question's last line out from under the absolutely-positioned copy
  chip. Text rendered underneath the button. Padding moved to `.agw-bubble-user`, exactly as the
  `background` was moved earlier for the same cascade reason; the fill's comment had recorded the
  trap and padding was left behind anyway. **Inline styles outrank every selector — if a CSS state
  variant needs to override a property, that property cannot live inline.**
- **Settings search now returns CONTROLS, in the page** (the redesign the in-window agent started and
  never landed). The nav is no longer filtered — it is the map, and rearranging it as you type
  removes it exactly when you are lost. A query (≥2 chars) replaces the CONTENT area with the
  matching rows, rendered from their own components so they still work: search `chapter` → the
  Chapters row + its live switch, under a PREFERENCES heading that is a button back to the page.
  Two levels: registry match (`searchTerms`) picks which sections MOUNT — settings pages open
  connections and draw charts on mount, so rendering all of them per keystroke is not free — then
  `SettingsRow`/`SettingsBlock` filter themselves via `SettingsQueryContext`/`SectionSearchContext`.
  Rows report their own verdict from an effect even when returning null (a null return is still
  mounted), which is how a section learns it is empty and sets `data-hidden`; a `:has()` rule then
  drops the result heading so a page never announces a match it isn't showing.
  **Only 5 of 11 settings pages use the shared primitives** — Agent/Team/Preferences/Appearance are
  tagged `inlineResults: true`; Providers/Tools/MCP/Profile/Skills render as a destination instead,
  because pasting a whole unfilterable page under a "results" heading is a worse answer than a link.
  Converting a page to the primitives is all it takes to promote it.
- Header layout hardening from the same work: `.agw-settings-head-title` now carries USER TEXT (the
  query), so it is `nowrap` + ellipsis, `.agw-settings-back` is `flex: none` (a long query wrapped it
  onto two lines and grew the bar), the search box is `flex: none` (it collapsed to a sliver), and
  the no-results echo is line-clamped to 2. Owner's call: **no focus ring on the settings search** —
  scoped to `.agw-settings-search` so the browser address bar keeps its own; focus still brightens
  the border, since the control is Tab-reachable and needs some state.
- **TEMPORARY, delete when done:** `kernel/lib/fonts/typography-debug.ts` + its one call in
  `main.tsx`. Bottom-right panel that records text size/leading/weight/face/rendered-width from
  BEFORE first paint (synchronous first sample, then rAF for 4s, then 300ms), logs every change with
  a timestamp, and has a copy button. Exists because a current-value readout cannot answer "did it
  change during startup". Reuses `font-probe.ts::readFontState()` for face resolution rather than
  reimplementing it; pins its own font/colors so it cannot re-typeset alongside what it measures.
- **Chapter headings now show their own wall-clock**, like the reasoning row's "Thought — 14s".
  A chapter's duration is NOT a property of its own call (which returns instantly) — it is the span
  until the next chapter, closed for the last one by the turn's end. Needed no backend change and no
  new persisted field: `TimelineEvent`'s tool variant gained `at`, stamped from the clock live and
  from the OWNING MESSAGE's timestamp on reload (each tool round is its own message, so consecutive
  chapters never share one). `buildSections(rows, turnEndedAt?)` computes the spans; `turnEndedAt`
  is derived in MessageBubble from `startedAt + workedMs`, and is deliberately withheld while
  streaming so the live chapter shows no growing clock. Unmeasurable spans render nothing, never 0s.
  `upsertToolEvent` keeps the FIRST `at` — it re-runs on every argument delta, and re-stamping would
  shorten every span.
- VERIFIED: 490 frontend tests (+7), 16 Rust file_edit tests, `tsc -b`, eslint clean on touched
  files, CSS parses. **NOT runtime-verified — the Rust change needs a `tauri:dev` restart.**
- NOT DONE, still open: the in-window agent was mid-way through making Settings search render
  matching controls IN the page (with their real toggles) instead of narrowing the sidebar. That
  batch is the one that got declined; `settings-search.ts` is still the filter-only version.

## 2026-08-10 — Agent settings search repaired
- Replaced the registry-only filter with a small `settings-search` helper and section-owned search terms. Queries now find settings controls rendered within a section, rather than only tab title/description text — `chapter` resolves Preferences because it indexes Transcript → Chapters.
- Search results still narrow the navigation to owning sections; the current settings panel stays visible as an orientation point. Escape clears the query, and the input now has an accessible name plus a visible focus boundary.
- Added 3 focused tests for section/control matching, case-insensitive metadata, and blank-query reset. Verified `tsc -b`, focused Vitest, and focused ESLint. Root `pnpm lint` remains blocked by pre-existing generated `build/` parse errors and unrelated lint findings.


## 2026-08-10 (4th) — Typography single source of truth + installed-font pickers
Owner's complaint "text changes size/face in real time" had two mechanisms, both fixed:
- **IDE window re-typeset itself after open**: `applyUiPreferences` (font + `--aurora-ui-text-scale`,
  which multiplies `body`'s 14px) only ran after the async SQLite settings load. It now mirrors its
  RESOLVED values to localStorage (`aurora-ui-prefs`) and `main.tsx` applies the mirror synchronously
  before first paint (`kernel/lib/fonts/boot.ts`). SQLite stays the authority.
- **Webfont swap at startup**: every bundled face registers `font-display: swap`, so first paint used
  Segoe UI and swapped when the woff2 landed. `main.tsx` now `document.fonts.load()`s the bundled
  faces and waits (capped 350ms — they are local assets) before mounting React.
- **`kernel/lib/fonts/` is now the single source**: `stacks.ts` (AGENT_UI_FONT_STACK /
  CODE_FONT_STACK / stackWithPrimary), `bundled.ts` (ALL @fontsource imports + Geist, imported once
  from main.tsx — AgentThemeProvider no longer imports fonts; geist-font.ts moved to
  `kernel/lib/fonts/geist.ts`), `boot.ts` (pre-paint apply + preload). Agent tokens fontUi/fontCode
  seed from stacks.ts; hardcoded stacks removed from GitDiffModal, CodeEditor (Monaco), Terminal,
  MarkdownPreview, index.css (now `--aurora-code-font-family`, set at boot from CODE_FONT_STACK).
  Agent TerminalPanel now uses the fontCode TOKEN — the Code font setting finally reaches the
  terminal. `--agw-font-mono` was referenced by 5 rules and DEFINED NOWHERE (fell back to the UI
  font); all now `--agw-font-code`.
- **Appearance → Typography pickers**: `FontStackPicker` (editable combobox — custom stacks still
  typable) lists bundled faces + installed fonts from new Rust `system_font_families` command
  (`commands/fonts.rs`): DirectWrite enumeration (NOT GDI — Chromium matches DirectWrite names, see
  lesson 2026-08-08), scanned ONCE, cached in `app_settings` key `system_font_families`; menu footer
  = Rescan. Picking a family writes `"Family", <canonical fallbacks>` via `stackWithPrimary`.
  Cargo gained windows feature `Win32_Graphics_DirectWrite`.
- **Professional defaults are ENFORCED, not just shipped** (owner: "feels like a mess, could be my
  misconfiguration"). The defaults were always right (Inter Variable / JetBrains Mono / 15px·1.75 —
  verified across all 103 commits of themes.ts); the mess was STALE PERSISTED OVERRIDES beating
  them. Three-part fix: `TYPOGRAPHY_TOKEN_KEYS`/`TYPOGRAPHY_DEFAULTS` exported from themes.ts;
  `resetTypography()` store action + a "Reset to defaults" button on the Typography section
  (rendered only when typography overrides exist — no dead control); persist **version 1 migration**
  on `aurora-agent-window-theme` that prunes overrides equal to the RETIRED pre-variable Inter
  default or to the CURRENT default (render no-ops that would pin users to today's values).
  Deliberate custom values are never touched.
- VERIFIED: tsc -b, eslint (all remaining findings pre-exist), 480 frontend tests (11 new), cargo
  check, fonts tests incl. a real DirectWrite scan (Segoe UI/Arial found), `pnpm build`.
  **NOT runtime-verified — needs `tauri:dev` restart (new Rust command) + visual check.**

## 2026-08-10 (3rd) — Outline phantom-member finding fixed
- `enclosing_container` now stops at TypeScript/TSX `statement_block`, Rust `block`, and anonymous
  TypeScript `object_type` nodes; interface `object_type` bodies remain valid containers.
- `outline` filters `variable` and container-less `field` rows only at presentation time, preserving
  extraction for `definition`/`usages`. The standalone probe mirrors both changes.
- VERIFIED: 57 production code-index tests passed (3 ignored) and all 25 probe tests passed;
  full live app verification intentionally not run because the installed Aurora runtime was not
  restarted.
- The unrelated index-invalidation change from the previous turn remains fully reverted.

## 2026-08-10 (2nd) — Code index v4: monorepo fixes. **NEEDS `tauri:dev` RESTART.**
Testing the index against a whole monorepo (not one app) found two real bugs. Both fixed.
- **`packages/` was excluded as a .NET/NuGet name** and it is where a pnpm/yarn workspace keeps
  every first-class library. Measured: **282 source files across 4 workspace members indexed as
  ZERO**, while the exclusion saved nothing (a NuGet folder holds .dll/.nupkg, none of which is a
  language this indexer reads). `bin` removed for the same reason (Node keeps its CLI entry there).
  `obj` stays — it is output everywhere. After the fix: 1262 → **1544 files**, +6,178 symbols.
  This is exactly what `WalkStats::skipped_dirs` reporting exists for — it surfaced the mistake.
- **Workspace libraries imported BY PACKAGE NAME resolved to nothing.** `import { X } from
  '@scope/core'` looked like an npm dependency, so every cross-package edge vanished and the
  whole-repo module graph came back with **0 edges**. `walk::workspace_packages` now reads
  `package.json` `name` fields (depth ≤ 4) into a name → directory map, persisted on the index;
  `resolve_module` checks it before declaring a bare specifier external. Handles the subpath form.
- `persist::FORMAT_VERSION` **3 → 4**. Old caches lack the package map.
- **PRIVACY: never put real project/package names in Aurora's source.** Owner called this out
  angrily and was right — Aurora is shipped, source-available product code. All test fixtures and
  comments now use neutral names (`@acme/core`, "a real 594-file Electron app"). Measurements are
  kept, identities are not. One pre-existing leak remains and is the owner's call:
  `apps/agent/components/theme/StreamingDotMatrix.tsx:10` credits a private project by name.
- **Settings → Agent → Code index is LIVE-CONFIRMED** by the owner (screenshot: 25 files, 1,044
  symbols, 8,381 refs, 225 ms, "Cache 227 KB"), matching the on-disk cache exactly.
- Perf at monorepo scale: 1,544 files / 46,625 symbols / 246,674 refs in **~1.1 s warm**
  (a 5.8 s first run was a cold file cache, not a regression). Churn's `git log` is only ~107 ms.
- **Tool CARD for `code` was broken and is fixed.** Every row read "Done" and expanding one showed
  only its arguments, because the JSON fell through to the generic handler in `tool-result.ts`.
  One tool answering five questions must say WHICH answer came back: `parseToolResult` now has a
  `code` branch per op — definition → `file:line`, usages → "9 uses · 3 files" + the coupling
  breakdown + callers, ambiguous → "N candidates — ambiguous" with per-candidate caller counts,
  outline → "N symbols" + the symbol list, modules → "N groups · N cycles" + the cycles. 5 tests.
- **Bespoke icon `code-index`** (AgentIcon): a filled anchor node with three lines arriving.
  Deliberately NOT angle brackets — `<>` says "source code", which every other tool here also is;
  what this tool uniquely knows is the EDGES. `toolIcon()` maps `code` → it (it was falling back
  to the generic `diff` glyph).
- VERIFIED: 1171 Rust + 460 frontend tests, `tsc -b`, eslint, `pnpm build`. **The walk + workspace-
  package changes are NOT in the running app — Rust needs a `tauri:dev` restart.** The card fix and
  icon are frontend, so they hot-reload.

## 2026-08-10 — Code index v3: coupling by kind, module graph, churn, Settings panel
Three ideas taken from evaluating `symgraph` (see lesson.md — do NOT adopt it as a dependency,
it produced a false dependency edge on a real case). All wired end to end.
- **Coupling by kind.** New `@ref.write` captures (assignment targets, compound assignment,
  `++`/`--`) in all four grammars, ranked above the bare-identifier catch-all. `usages` now
  returns a `coupling` breakdown ordered by how much a reader should care — **writes first**,
  because "12 modules assign to your field" is a different problem from "12 modules call you",
  and one undifferentiated count cannot tell them apart.
- **`code { op: "modules" }`** (`code_index/module_graph.rs`) — the first view ABOVE a single
  symbol. Fan-in/fan-out per group at `area` | `dir` | `file`, plus cycles via iterative Tarjan
  (iterative on purpose: a file-granularity graph could blow the stack inside a tool call).
  **Cycles are capped at `MAX_REPORTED_CYCLE = 6` and summarised past that** — symgraph reported
  ONE cycle spanning ~70 directories on quantumhub-client, which names no edge anyone can break.
  Aurora reports 10 cycles of 2-3 dirs there, each actionable. Edges are DISTINCT file pairs, so
  a barrel importing 5 names is 1 dependency, not 5.
  Run on Aurora itself it found `src/apps -> src/kernel` — the one documented boundary violation,
  caused solely by `kernel/store/useSettingsStore.ts`. It found the known debt unprompted.
- **Churn** (`walk::churn`) — one bounded `git log --max-count=1500 --since=1.year --name-only`
  at build time, stored per `FileEntry`. Folded into the repo-map score as a gentle MULTIPLIER
  (`1 + 0.15*ln(1+commits)`), never additive: churn should reorder files of similar importance,
  not let a busy config file outrank an architectural class. No git ⇒ empty map ⇒ factor 1.0 and
  ranking falls back to structure. Verified the `ai-orchestrator.ts` ground truth still holds.
- **Settings → Agent → Code index** (`settings/CodeIndexCard.tsx` + `commands/code_index.rs`):
  status + Rebuild, **no on/off toggle** (owner's decision — it is sub-second, a toggle could only
  make the agent worse). `code_index_status` never builds, so opening Settings costs nothing.
  `rebuild` is `async` because a sync `#[tauri::command] pub fn` runs on the UI thread.
- `persist::FORMAT_VERSION` **2 → 3** — old caches predate the write captures, so their coupling
  breakdowns would be wrong. Discarded and rebuilt, never migrated.
- VERIFIED: 1169 Rust + 455 frontend tests, `tsc -b`, eslint, `pnpm build`, `cargo check --bins`,
  rustfmt. **NOT runtime-verified — owner asked for no visual testing while away.**

## 2026-08-09 (7th) — Code index v2: repo-map ranking fixed + IMPORT-AWARE resolution
- **Repo-map ranking rebuilt** (`repo_map.rs`). The two failed attempts are documented in the code
  and must not be retried: export COUNT loses the file exporting one central class; inbound
  REFERENCE count puts `cn()` and shared `types.ts` on top. What works, verified on the real
  quantumhub-client index (`ai-orchestrator.ts` **rank 219 → 10**, and it now makes the map):
  exported METHODS count toward the score (behaviour is architecture), kinds are weighted
  (class 4 / trait 3 / interface·enum·function 2 / type 1), fan-in is **distinct files** and
  log-damped, and per-file aggregation is **concave** (1/n decay) so a bag of twenty types cannot
  out-sum one class. Selection is two-pass with `DIR_CAP = 2` — breadth first (60 dirs vs 49
  uncapped), then a refill pass so a small flat repo is not starved by a rule built for large ones.
- `FOOTER_RESERVE = 128`: the block used to overshoot its own budget by its closing tag + omission
  notice (measured 20,068 chars against 20,000). A test now pins `map.len() <= budget` at 4 sizes.
- **IMPORT-AWARE RESOLUTION is the big one.** Queries now capture the module specifier in the SAME
  match as the imported name (`@import.module` / `@import.local`) — captures group by match and by
  nothing else, so the pairing has to happen there. `store::resolve(name, from_file)` runs the
  cascade **Import → SameFile → SameDir → Ambiguous** and `references_to(&Symbol)` gives usages of
  ONE definition. `usages` therefore stopped being a refusal: `code` gained `in_file`, ambiguous
  results now list each candidate WITH its own caller count, and imports are counted separately
  from calls (an import is wiring, not a use — counting it inflated every TS count by one per file).
- Idea ported from `greysquirr3l/coraline` (cloned to `E:\VOID-EDITOR\_research\coraline`, NOT a
  dependency — 597 downloads, one maintainer, and it drags in SQLite + ONNX embeddings this project
  deliberately dropped at migration v12). `github/stack-graphs` was the other candidate: **archived
  Sept 2025**, do not build on it.
- MEASURED on quantumhub-client (728 files, 655 ms): 5,691 imports → 3,358 resolved to files,
  2,243 correctly external, 90 unresolved (all `.png`/`.webp`/`package.json`). Of 79,256
  ambiguous-name references, 65% now resolve. Ground truths from the handoff §4.4 reproduced exactly:
  `AIOrchestrator` → `ai-orchestrator.ts:326`, `qgProbe` → `probe-daemon.ts:401`, `handle` → 23 defs.
- `persist::FORMAT_VERSION` **1 → 2** (imports table). Old caches are discarded, never migrated.
- `AUTO_INDEX_MAX_FILES` is now ENFORCED, on the automatic path only (`service::auto_rebuild`);
  an explicit `rebuild` from Settings still ignores it. The refusal names Settings as the way out.
- Two `#[ignore]`d measurement harnesses are the tuning loop, keep them:
  `AURORA_INDEX_ROOT=<repo> [AURORA_INDEX_SYMBOL=X] cargo test --lib
  resolution_over_a_real_workspace -- --ignored --nocapture` and `repo_map_over_a_real_workspace`.
  Both BUILD from source rather than loading a cache, so a format bump cannot feed them stale data.
- **LIVE-VERIFIED** in tauri:dev against quantumhub-client (thread `528bfb6f…`, gpt-5.6-luna): the
  model used `code` 8× unprompted, `definition` was line-exact, `outline` replaced reading a large
  file, and the repo map reached it (its own critique — "presents itself as a landmark map and says
  many files are omitted" — matches the rendered header + omission notice). One BUG found and fixed
  in the same pass: `in_file` was wired into `usages` only, so `definition` ignored it and the model
  reported a filter that never ran. See lesson.md 2026-08-10.
- VERIFIED: 1156 Rust tests green, `cargo check --bins` clean. Docs corrected (README + DOCS/
  01-ARCHITECTURE.md no longer advertise `aurora-semantic`).

## 2026-08-09 (6th) — Code index BAKED IN: `src-tauri/src/code_index/` + the `code` tool
- Probe graduated. Modules: `lang` (grammar+query registry — adding a language is one arm),
  `extract` (source → facts), `walk` (what counts), `store` (in-memory + queries), `persist`
  (interned cache), `repo_map`, `service` (one index per workspace). The probe crate at
  `src-tauri/probes/code-index/` stays as the CLI harness.
- **`code` tool** (`tools/code_intel/`), ops `definition | usages | outline | refresh`. ONE tool with
  a typed op, not four names — every schema is re-sent each request. `BUILTIN_TOOL_COUNT` 36 → **37**
  (bump the derived sum in `tools/mod.rs::count_without_browser` too, or 3 tests fail).
- **The index checks itself.** `walk::signature` = (file count, newest mtime), stored in
  `BuildStats.signature` and re-walked before every answer. Hooking the 5 file-mutating tools would
  have missed the user's other editor and `git checkout`. mtime is 1-second resolution, which is the
  ONLY reason `op: "refresh"` exists.
- `agent-prompt.ts` line "search for the symbol with grep" was REPLACED, not supplemented — leaving it
  would have kept pointing the model at grep for symbols (the 2026-07-30 lesson).
- Cache: `%LOCALAPPDATA%\AuroraIDE\code-index\<sha256-16>.json`, write-then-rename, version-gated
  (`persist::FORMAT_VERSION`) — an unknown layout is rebuilt, never migrated. Uses sha2, NOT
  `DefaultHasher` like `checkpoints` (std's hasher is not stable across Rust releases).
- SETTINGS DECISION (owner): no on/off toggle — it is ~0.5s, unlike the old semantic indexer. A
  status + **Rebuild** panel goes under **Settings → Agent** (owner's call), beside Compaction model.
- VERIFIED: 1137 Rust tests (+37), `tsc -b`, eslint clean. **NOT runtime-verified in tauri:dev.**
- **`<repo_map>` IS WIRED** (`conversation.rs::inject_repo_map`, mirrors `inject_ide_context`).
  Two decisions that must not be undone: it goes on the **FIRST** user message, not the latest —
  at the head it lives inside the provider's cached prefix and is billed once, whereas attaching it
  to the newest message would re-send ~5k tokens every turn and cost more than the file reads it
  replaces. And it is **memoized** per runtime (`repo_map: OnceLock`): if the text changed between
  turns it would invalidate that same cached prefix. A slightly stale map is free; `code` is the
  live source. Budget is in TOKENS — `DEFAULT_BUDGET_TOKENS = 5_000`, hard cap `MAX_BUDGET_TOKENS
  = 10_000` (owner's range). Persisted JSONL stays verbatim; only the request body carries it.

## 2026-08-14 — Aurora improvement audit in progress
- Plan: map the current frontend/backend ownership and product surfaces; inspect tests, CI, runtime
  verification gaps, stale documentation, and known open defects; then rank improvements by user
  impact, confidence gain, and implementation risk.
- Initial signal: the source has moved to `src/apps/{agent,ide}` + `src/kernel`, while README and
  architecture docs still advertise retired paths/tools. Treat documentation drift as evidence of
  release-process weakness, not as the architecture itself.
- Audit result: frontend tests are strong (568/568), but CI runs only the frontend build; full ESLint
  is 1,427 findings and runtime verification is repeatedly deferred. Highest-leverage next work is
  a reproducible Windows quality gate, then splitting `useSettingsStore` and shrinking runtime seams.
- Product gaps worth prioritising after trust: disk-truth Review + rollback/forking, transcript search,
  and desktop-app inspection. Do not start another visual polish pass before these reliability loops.
- **RESUME FROM `DOCS/code-index-handoff.md`** — full wiring, the qg-probe verification recipe, and
  the open items. Read its §5 first.
- LIVE-VERIFIED in tauri:dev against quantumhub-client: `definition` line-exact, `usages` ambiguity
  refusal correct, cache correct on disk, repo map reaching the model (it named 4 real service areas
  with zero tool calls).
- **OPEN, TOP ITEM: repo-map ranking is wrong.** Only 111 of 594 files fit 5k tokens, and
  `ai-orchestrator.ts` — the heart of that app — ranks 218th. Ranking by export COUNT failed (it
  exports one class); ranking by inbound REFERENCES also fails (puts the Tailwind `cn` helper and
  shared `types.ts` on top, and a singleton scores 10). Neither "defines the most" nor "is called the
  most" means "worth knowing about" — try breadth-per-directory + kind weighting instead.
- Also open: Settings → Agent panel + its Tauri commands (`IndexStatus` is ready), usages-warning
  before edits, and `AUTO_INDEX_MAX_FILES` is defined but unenforced.

## 2026-08-09 (5th) — Structural code index PROBE (tree-sitter) — proven, not yet baked in
- `src-tauri/probes/code-index/` is a STANDALONE crate (not a workspace member — `src-tauri` is a
  single package, so cargo never compiles it with the app). Modules `lang/extract/index/walk` are
  written to move to `src-tauri/src/code_index/` as-is; `main.rs` (CLI) is throwaway.
- Languages: Rust, TypeScript, TSX/JSX, Python (adding one = a grammar dep + a `.scm` + an arm in
  `Lang::from_path`; Python took ~15 min end to end).
- MEASURED, 3 codebases: Aurora 634 files/6.9 MB → **759 ms**; QuantumHub Electron client
  728 files/6.7 MB → **530 ms**; qg-native (Python) 13 files → 73 ms. All whole-repo, from cold.
- BLIND-VALIDATED against `qg-native` (indexed before reading any source, predictions recorded, then
  checked): 6/6 definition sites line-exact, `_ctl` 24 callers = grep's 24 `_cmd_*` exactly,
  `dump_tree` 2 real call sites where **grep returned 20+** (docstrings, comment prose,
  `"action": "dump_tree"` literals). Dead-code claims hand-verified as true positives.
- **Semantic/embedding search is NOT coming back** (dropped at migration v12 — CLAUDE.md, README and
  `DOCS/01-ARCHITECTURE.md` still advertise `aurora-semantic` and are WRONG). This index is structural:
  where is X defined / who calls X / what is unreferenced. Type truth stays the LSP layer's job.
- Resolution is NAME-BASED by design and self-reports ambiguity (22% unique / 46% ambiguous / 32%
  external with ident reads on). Bare-identifier capture is what makes "unused" meaningful (dead
  candidates 3538 → 914 exported) but it triples storage and pushes ambiguity 29% → 46%.
- A 1.9 MB esbuild `index.js` in the Electron client was **88% of that build** (4620 ms → 530 ms once
  skipped) and contributed 14,685 mangled symbols — 34% of the whole index. Size caps cannot catch it
  (it is under 2 MB); `walk::looks_generated` uses LINE SHAPE (avg > 200 B/line, or any line > 50 KB).
  Dependency/build dirs are excluded by name across ~10 ecosystems and the hits are REPORTED.
- OPEN before bake-in: JSON is ~20 MB (294% of source); interning names + a binary format estimates
  **~27% of that** — do that, do not ship the JSON. Also undecided: incremental re-index on file
  write, and whether ident-refs ship on by default.

## 2026-08-09 (4th) — Chapters under-fire fixed; transcript verdict from a 3-app probe
- `CHAPTER_INSTRUCTIONS` (agent-prompt.ts) went 2 lines → 7. Observed live: pref ON + no user
  instruction = **zero chapters** on a multi-step turn; the same turn chaptered when asked by hand.
  Added lines give a countable trigger (>1 area or >~3 tool calls), "default not optional",
  call-BEFORE-the-first-tool-call, no duplicate markdown heading (the model emitted
  "Chapter 1: Electron GUI Shell" under a row already reading ANALYZING ELECTRON GUI SHELL), and an
  explicit opt-out. VERIFIED: tsc 0, 455 tests, eslint clean. NOT re-verified in a live turn yet.
- **Chapters are the answer to transcript density, not aggregation.** A 40s/5-chapter deep analysis
  collapses to 8 lines, each the model's own words — beats Antigravity's `Worked for 13s` because you
  still see WHAT the phases were. Owner rejected collapsing the scaffold into one aggregate row: that
  would silence the model's narration between tool batches, which is what `timeline`/`msg.blocks`
  exists to preserve. Never propose that again.
- BLOCKERS on chapters: ships OFF by default, and **Settings search is broken** — typing "chapter"
  renders "No settings match" WHILE the Transcript section with a row labelled `Chapters` renders
  below it (empty-state + unfiltered content on screen together). Also `Planned 5 tasks 0/5` inline
  disagrees with the header's `5/5` on a finished turn.
- NEXT, agreed with owner: (a) **task/plan system to be redesigned from the ground up** — strip it back
  and rebuild for correctness, deliberately deferred, not started; (b) take **Antigravity's sticky user
  bubble** (user message pins to the top of the scroller, response scrolls beneath, swaps per turn) —
  `.agw-row[data-row]` is the existing hook. Full probe write-ups: `VISUAL-STUDY-01..03-*.md` in root.

## 2026-08-09 (3rd) — Composer typing-assist lifecycle rework (useComposerTyping)
- Contract now enforced: the ghost is a rendering artifact — keydown drops it BEFORE any native
  edit/caret move (pure modifiers + bare → + Ctrl/Cmd+C exempt), insertion is split-free
  (`Text.after`) with the caret re-pinned before the span, `selectionchange` kills a stale ghost
  after mouse moves, empty-text-node residue is cleaned on removal. Fixes: typing appending
  after the ghost, Backspace eating the ghost-as-a-unit and "doing nothing".
- Autocorrect is atomic: one backwards text-node walk → one range `insertText` (one input
  event, one undo entry, no visible backspacing); ABORTS if the span crosses a pill/br (a
  boundary space can BE a pill — the old N×execCommand delete could eat it). Programmatic edits
  flagged via `isProgrammaticEdit()`; onInput skips its own mutations (no double-learn), the
  composer skips `refine.onUserEdit()` for them. Undo window survives Shift/arrows (only
  input-producing keys consume it); Ctrl/Cmd+Z on a fresh correction teaches `undoCorrect` so
  re-correction can't fight native undo. IME composition suspends everything. `caretAtEnd` no
  longer false-positives above trailing empty lines (>1 following <br> ≠ end).
- `serializeFragment` (engine's text-before-caret) now maps ALL pill kinds to a space — `/` and
  inspector pills used to leak their LABEL text into predictions.
- VERIFIED: 455 frontend tests (7 new on splitTail/serializeFragment), tsc, eslint. Interactive
  typing behavior needs runtime verify in tauri:dev.

## 2026-08-09 (2nd) — Steering v2: framing preamble, mid-turn images, positional command chips
- `QueuedUserMessage.mid_turn` (IPC true / team mailbox false): the runtime prepends
  `MID_TURN_PREAMBLE` ("[The user sent this while your tool calls were running…]", session.rs)
  to composer injections so the model knows a "don't run pnpm" arriving after the lint output
  predates it. `threads.rs::strip_mid_turn_preamble` removes it for display; team messages keep
  their own `[Message from …]` framing untouched.
- Mid-turn IMAGES ride the injection as `<aurora_image>` markers — the browser_screenshot wire
  path. Fixed both non-Anthropic adapters, which pasted injected text RAW (markers would ship
  as base64 prose): `responses.rs` routes it through `responses_user_content`,
  `provider_kernel_adapter::openai_messages` through `openai_user_content`, both vision-gated
  and merged with pending screenshot parts. Frontend drains the attachment tray mid-turn; the
  display copy keeps markers so `InjectionNote` (MessageBubble) renders thumbnails live AND on
  reload; queued pill shows an image-count chip. Store copies: text (typed) / displayText
  (+markers) / modelText (+steering block); Rust adds the preamble, never the frontend.
- COMMAND PILLS ARE NOW POSITIONAL: `serializeEditor(el, forSend)` emits `/title` for `/`
  pills on send (draft/emptiness/refine reads stay pill-less, command-only still unsendable) —
  previously the pill vanished from the wire text, leaving the model a sentence with a hole
  ("no MX record for ; …"). `renderUserText` inlines BOTH `@rel` file pills and `/title`
  command pills in text order; the bubble top row is now only the fallback for chips without a
  token (pre-positional messages). Contract: `dataset.cmdTitle` on the pill must equal the
  chip title on the message.
- MESSAGE TYPOGRAPHY IS NOW TOKENS: `msgFontSize/msgLineHeight/msgFontWeight` (assistant
  prose, defaults 15px/1.75/400) + `msgUserFontSize/msgUserLineHeight` (user bubble 14px/1.55;
  injection note follows user size) in `SHARED_TYPE` → `--agw-msg-*` vars, editable under
  Settings → Appearance → Typography (sliders + weight segmented). CSS keeps design defaults
  as `var(…, fallback)`; `tokensToCssVars` skips undefined so pre-existing custom themes don't
  emit "undefined"; the user-bubble collapse clamp now tracks the line-height token.
- VERIFIED: 1100 Rust + 448 frontend tests, `tsc -b`, eslint (also removed 2 stale
  eslint-disable directives in AgentComposer). NOT runtime-verified; owner has more small UI
  bugs to report after this lands.

## 2026-08-09 — Production error log + rich steering messages
- **`logging.rs`**: one file at `%LOCALAPPDATA%\AuroraIDE\logs\aurora.log` (5MB rotate → `.1`,
  8KB/entry clamp, panic hook, init first in `run_with_args`). Chokepoints: every failed model
  call (`conversation.rs` stream_result Err, with thread/model/iteration; Cancelled excluded),
  `map_status_error` (full HTTP body — 401/429 used to discard it), raw SSE error payloads in
  all three adapters. The "provider returned an error: stream error" incident is now impossible
  to lose: `responses.rs` `stream_error_message` tries `message` → `error.message` → bare
  `error` string → `code` → raw event, replacing `unwrap_or("stream error")`.
- **Mid-turn steering** now carries what a fresh turn carries. `useAgentWindowSend` mid-turn
  branch consumes staged `/` directives and resolves rules/skills/MCP into a
  `<steering_context>` block appended to the MODEL copy; `@` mentions were already in the text.
  Wire: `agent_enqueue_message(text, displayText, chips)` → `QueuedUserMessage` →  injection
  sets `attached_prompt_chips` on the tool message (persisted) and `QueuedMessageInjected`
  echoes display text + chips. Reload: `threads.rs::strip_steering_context` cuts the block out
  of the injected row, chips ride the `user_injection` timeline event. Post-turn auto-flush
  resubmits the model copy + chips, so directives survive a turn with no tool boundary.
- VERIFIED: 1097 Rust + 448 frontend tests, `tsc -b`, eslint, `cargo check` all green.
  NOT runtime-verified in tauri:dev.

## 2026-08-08 — Geist bundled; the dev-vs-exe "cheap fonts" mechanism
- Agent-window font tokens (`fontUi`/`fontCode`) persist via zustand in **localStorage, which is
  per-origin**: dev (`localhost:5173`) and the exe (`tauri.localhost`) each hold their OWN
  customization snapshot. Old snapshots carry the old Geist-first / Commit-Mono stacks; what renders
  depends on which fallback each snapshot reaches. "Geist" was never bundled or installed anywhere.
- Fix: `theme/geist-font.ts` registers the @fontsource-variable geist woff2s (latin + latin-ext)
  under the plain family name **"Geist"** via the FontFace API — the @fontsource CSS registers
  "Geist Variable", which persisted stacks don't ask for. `?url` imports, no relative node_modules
  paths. Bare side-effect import in AgentThemeProvider.
- Diagnosis method worth reusing: launch the packaged exe with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=NNNN` **plus a fresh
  `WEBVIEW2_USER_DATA_FOLDER`** (WebView2 reuses a running browser process per data folder and then
  ignores the args), then CDP `Runtime.evaluate` computed styles + `document.fonts`. qg-probe/UIA
  cannot see font-load state; CDP can.

## 2026-08-08 — Five tool fixes from the in-window agent's feedback (all tested, 1049 Rust green)
- `grep` patterns now ride behind `-e` (commands/mod.rs) so `--color-…` CSS-var searches stop dying
  as "unrecognized flag". `tool_spill` exempts valid `<aurora_image>` markers — the spill was
  shredding every screenshot before leanify/vision adapters could run (see lesson.md same date).
- `browser_page_outline` falls back to a verified-unique `:nth-of-type` chain anchored at the
  nearest addressable ancestor (or `body`) — radios/tabs/rows with no stable hooks no longer
  report `selector: null`. Verified against the reported failing DOM shape in jsdom.
- Modify-family results (`rich_persisted_tool` set) strip `oldContent`/`newContent` from MODEL
  history (`strip_edit_content_echo`, conversation.rs); UI copy + `.rich.jsonl` sidecar unchanged.
- `read_lints` singles out diagnostic lines referencing the caller's `paths`
  (`requestedPathDiagnostics`) and says when failures are all elsewhere — checkers stay project-wide.
- NOT runtime-verified in tauri:dev; GitNexus impact analysis unavailable this session (MCP absent).

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

## 2026-08-04 — Agent-window surface audit (read-only; no code changed)

Read the whole `src/agent-window` surface to propose new features. Confirmed gaps, each verified in
source rather than inferred:

- **No rollback anywhere in the agent window.** `services/checkpoint.ts` and the Rust `checkpoint_*`
  commands exist but are wired ONLY into the IDE (`hooks/useAgentSend.ts`, `components/chat/*`). The
  agent window writes files with no undo path; `ReviewPanel` is read-only + "Open in IDE".
- **`ReviewPanel` diffs the TRANSCRIPT, not disk.** `review.ts::collectFileChanges` walks reported
  tool results, so the panel shows what the agent *claimed*; a size-capped edit is skipped entirely
  and later manual edits are invisible. No per-file revert.
- **No transcript search.** `LeftRail`'s box filters `title` + the 120-char `preview` only. Nothing
  searches message bodies, thinking, tool args, paths or commands, in one chat or across chats.
- **No fork-at-turn.** `thread_duplicate` copies the FULL transcript; "Retry" re-sends the last user
  message into the same thread. Branching an approach means the docked `ChatPanel` + retyping.
- **Per-turn cost is computed then discarded.** `ContextRing` derives it from
  `priceCacheMissPerMtok`/`priceCacheHitPerMtok`/`priceOutputPerMtok`, renders it on hover, and
  returns `null` entirely once `usedTokens === 0`. Nothing accumulates it; Profile has tokens, no money.
- **No turn-level digest.** `buildRows` + `parseToolResult` + `turnWorkedMs` already know every file,
  command, diff stat, failure and the duration of a turn — nothing summarises them, so reading back a
  long turn means scanning collapsed rows one by one.

Five proposals were put to the owner from these findings (rewind/checkpoints, turn digest, find-in-
conversation, disk-truth Review with revert, cost ledger). Awaiting a pick — nothing implemented.

## 2026-08-04 — Transcript spine + chapters (both opt-in, both shipped)

The owner rejected all five feature proposals above and asked instead for VISUAL treatments of what the
transcript already emits, off by default, under Settings → Preferences → Transcript. Two independent
toggles (either, both, neither).

- **Assistant `timeline` is now PERSISTED** (`commands/threads.rs::session_to_db_messages`). It was
  always `None`, so a reload synthesised the order (all text, then all tools) and anything positional
  died on restart. It is rebuilt from `msg.blocks`, which already carry the true interleaving, with
  adjacent text/thinking coalesced the way live streaming does. The frontend re-joins it in
  `timeline.ts::hydrateToolEvents`: a persisted `tool` event carries only an id, the payload stays in
  `tool_calls`, so there is one copy of a tool call on disk. This landed FIRST because chapters are
  worthless without it. `ChatMessage.tsx` (IDE chat) grew a shape guard — its `TimelineEvent` is
  `type`-keyed, the agent window's is `kind`-keyed, and it must ignore the other shape.
- **Spine** (`useAgentThemeStore.transcriptSpine`, appearance-only, resets with customisations): a
  hairline down the turn with a marker per step, drawn entirely from `[data-transcript-spine]` +
  `.agw-row[data-row]` — the row wrapper exists on every turn regardless, so the toggle re-styles a
  live transcript without remounting anything. Markers hang on `.agw-tool-step` (one per CALL), NOT on
  the tools row; the row keeps a single marker only for a grouped run (≥6), whose cards live in a
  clipping scroller. Live marker = the running call, or the last row for text/reasoning, shimmering on
  the same `agw-shimmer` keyframes as the turn label (reduced-motion holds it solid).
- **Chapters** (`useSettingsStore.transcriptChapters`, persisted end-to-end through
  `AppSettings.transcript_chapters`) come from the MODEL, not from parsing its prose: a real Rust tool
  (`tools/transcript/mod.rs`, validate-and-echo, no state) advertised only when the pref is on
  (`agent_v2::is_tool_available_this_turn`) and paired with a two-line instruction injected by the same
  pref (`agent-prompt.ts::CHAPTER_INSTRUCTIONS`). `buildRows` turns an accepted call into a `chapter`
  row at its emission point; a rejected one falls back to a normal tool card. Typed as an uppercase
  label + `agw-timeline-rule`, NOT as bigger bold text — see `lesson.md`.
- VERIFIED: 51 tests in `timeline.test.ts` + `activity.test.ts`, lints clean on the touched files, and
  the owner runtime-confirmed chapters and the spine in the app. `tsc`/`cargo` were NOT re-run after
  the final CSS/TSX pass.

## 2026-08-04 (later) — Review of the spine/chapters work: two fixes applied
- Claude Code audited the uncommitted Cursor changes. Verified green: `pnpm build`, all 342 frontend
  tests, `cargo check`, 73 Rust tests across threads/transcript/agent_v2/tools.
- Fixed: `composeAgentSystemPrompt` now takes `transcriptChapters` from the caller
  (`AgentService.config`) instead of the settings store — the IDE chat was getting the chapter
  instruction with the tool withheld. `compactThread` deliberately passes nothing (zero-tool call).
- Fixed: the spine's running-call shimmer selector targeted a content-less pseudo-element
  (`.agw-tool-card::after`); now `.agw-tool-step:has(.agw-tool-card[data-status="running"])::after`.
  Note `data-status` exists only on the STANDARD card root — the four special card shapes (canvas,
  plan launch, plan step, checklist) still have no running shimmer. See lesson.md same date.

## 2026-08-05 — Canvas fixes: render-validated mermaid, artifact visibility, readable zoom
- `validateMermaidSource` (services/mermaid-artifacts.ts) now parse+RENDERs with the shared
  `buildMermaidConfig`; both present_artifact paths (content + patch preview) reject layout-broken
  diagrams with the renderer's message. Tool description updated to promise it.
- `useAgentArtifactStore.canvasSource` ("plan"|"artifact") replaces CanvasPanel's local state;
  `present`/`select`/launch-card claim "artifact" so a new diagram is never hidden behind a plan.
- Diagrams open at `initialDiagramViewport` (fit floored at READABLE_MIN_SCALE 0.65, top-anchored);
  Fit button/double-click keep the full fit; the % readout is now a click-to-100% button.
- VERIFIED: full frontend suite 348 tests + `pnpm build` clean. Runtime check still wanted:
  present a cycle-broken mermaid source and confirm the tool result carries the renderer error.

## Provider API type + per-model connection test (2026-08-05)
- `ProviderConfigSnapshot` now carries `provider_type` (the user's "API type" pick) SEPARATELY from
  `provider_id` (row id / UUID). `effective_provider_type()` is the only input to wire-shape dispatch
  and to prompt-caching / `stream_options` / reasoning-field decisions. `provider_id` stays the key
  for `unprefix_model` only. Frontend must forward `providerType` in `buildProviderConfigSnapshot`.
- Per-model test button (`ModelTestButton` + `provider_test_model` command) fires one real 64-token
  turn through `build_api_client` — the same factory a turn uses — and reports the resolved wire
  shape, endpoint, reply snippet, latency and usage. It deliberately shares reasoning/extraBody
  resolution with the send path via `services/model-request-config.ts`; if those ever diverge the
  test stops meaning anything.

## 2026-08-06 — Live canvases (`kind: "react"`) + `aurora/canvas` SDK
- New artifact kind `react`: ONE component file, compiled and RUN in a sandboxed frame in the
  right rail. Reuses the whole existing artifact contract (thread sidecar, immutable v1..vN,
  exact-text patches, `read_artifact`), so persistence/versioning came free.
- Gate: `compileCanvasSource` (services/canvas-react.ts, TypeScript `transpileModule`) runs BEFORE
  the write, same position as `validateMermaidSource`. Catches syntax, disallowed imports, missing
  default export, and unknown `aurora/canvas` names. It does **NOT** typecheck — asserted by a test
  so the tool description stays honest. Semantic checking needs `ts.createProgram` + lib d.ts.
- Rust now REFUSES `mermaid`/`react` without `validated: true` (`ArtifactKind::requires_validation`).
  Closes the old hole where any direct `thread_artifact_upsert` caller persisted broken Mermaid.
  `validate_upsert(_, enforce_gate)` — false for patch preview, which is what produces the text.
- Sandbox: `default-src 'none'` CSP is what actually blocks `fetch` (sandbox attr alone does not).
  React/ReactDOM UMD + the SDK are inlined as text via `vite-canvas-plugin.ts` (shared by
  vite.config + vitest.config so tests use the real generated module). `react-dom` does not export
  `./umd/*`, so it is resolved from `./package.json`'s dirname, not imported.
- SDK (`src/canvas-sdk/`) is shaped by refusal: **no `Card`** (the agent's hand-built canvas was 12
  identical bordered cards), no `style`/`className` props, required labels, empty renders `null`.
  Guidance lives in the `canvas_guidelines` Rust tool (sibling of `design_guidelines`, NOT a skill);
  system prompt carries only 2 lines. Rust + TS tests pin the guide and the export list to each other.
- An iframe inherits NO window CSS: the canvas document must restate scrollbar tokens or it draws
  the platform's default bars. Same trap will apply to any future frame.

## 2026-08-06 — Frontend restructured: two apps over a kernel (`src/apps`, `src/kernel`, `src/bridge`)
- `src/` is no longer layer-typed (`components/ services/ store/ hooks/ lib/`). It is now
  `apps/ide`, `apps/agent`, `kernel` (shared floor), and `bridge`. Direction: **apps → kernel,
  never back; ide ↮ agent**. Enforced at `error` by `no-restricted-imports` in `eslint.config.js`
  — not by convention. `@/*` → `src/*` is the only path alias (tsconfig.app + vite + vitest must
  agree). Cross-directory imports are `@/…`; `./sibling` stays relative.
- **`src/bridge/` is deliberate, not leftovers.** Code that genuinely spans both windows lives
  there and is exempt from the direction rule: `agent-ide-events` (agent → Monaco),
  `agent-file-sync` + `live-file-preview*` (agent writes → editor), `useWindowClose`. Keep it
  small; anything serving one product belongs in that product.
- The **IDE agent surface was deleted** (~17 KLOC: `components/chat/**`, 11 settings tabs, chat
  hooks/stores). The agent window is the only agent. Speech config had NO home in the agent
  window, so it was rebuilt on `--agw-*` primitives as `agent/settings/SpeechSettings.tsx` and
  rendered **inside Preferences**. Fireworks erased (dashboard + `services/fireworks.ts`);
  provider *plumbing* kept, because removing it would change agent-window behaviour.
- Within each app, `services/ store/ components/ hooks/ lib/` are grouped **by concern**
  (`runtime/ providers/ tools/ artifacts/ conversation/ composer/ shell/ …`), not left flat.
- `AgentService` (`apps/agent/services/runtime/`) is **live** — `useAgentWindowSend` instantiates
  it, and it has a deliberate lazy-import cycle with `useChatStore`. It is not legacy dead code.
- OPEN: `kernel/store/useSettingsStore.ts` (2110 lines) is the **only** boundary exemption — it
  mixes agent config with editor prefs, so kernel imports agent services. Splitting it is the
  next task. Also open: typed IPC seam (227 commands). Full plan + status: `reorganized-plan.md`.
- NOT runtime-verified: no `pnpm tauri:dev` since the move. `pnpm build` + 51 files/381 tests +
  0 boundary violations are green.

## 2026-08-08 — Tool-card transcript verdicts (shell badge + write stats)

- `shell_execute`/`shell_spawn` cards now badge the shell (`.agw-shell-badge`, family-tinted dot:
  POSIX green / PowerShell blue / cmd amber). Resolved `shell` from the RESULT wins over the
  requested arg (substitutions show what actually ran); `shell-meta.ts` (tool-views leaf) maps
  ids → name/prompt/family, and both shell views use the shell's own prompt glyph ($ % > PS>).
- `file_write` (Rust) now emits `linesAdded`/`linesRemoved` (similar crate, line split matched to
  the frontend `computeDiff` — trailing newline is not a line). New file ⇒ green `+N` only.
  Parser falls back to computing the stat from oldContent/newContent for pre-count history.
- The "missing file chip while writing" is NOT a UI bug: the model often emits `content` before
  `path` (verified in session JSONL), so the filename isn't on the wire until the end. The card
  now shows "Writing… N lines" live until the path arrives; chip pops the moment it does.

## 2026-08-08 — Context accounting: a thinking block costs what the PROVIDER replays

`ReasoningReplay` (`src-tauri/src/api/client.rs`) is now the single answer to "what does a stored
`ContentBlock::Thinking` cost the next request", derived from provider type via
`reasoning_replay_for` so it can never disagree with `openai_messages`/`reasoning_field_for`:
`Dropped` (OpenAI chat-completions, Fireworks, MiniMax, Ollama, custom — the block is never sent),
`Text` (deepseek/glm/openrouter/lmstudio/Anthropic), `Opaque` (Responses/Codex replay the encrypted
item from `signature`). `estimate_message_tokens` takes it; `RuntimeConfig.reasoning_replay` carries
it. A signature is NEVER counted as text under any policy — under `Opaque` it is priced at
`sig.len() / ENCRYPTED_REASONING_CHARS_PER_TOKEN` (=5), because the base64 ciphertext is ~2.6× the
reasoning it stands for.

Compaction's before/after now also count the tool schemas: `fixed_request_overhead_tokens()` +
`projected_request_tokens()` are the one definition of "how full is the context", shared by the
auto trigger and `/compact` so the threshold and the card can't be computed differently.

Settings → Agent → **Compaction model** pins the summarizer to its own provider
(`compactionModel` → `getCompactionConfig()` → `compactionProviderConfig` →
`ConversationRuntime::with_compaction_client`). The marker records the SUMMARIZER's model so the
cost card prices it at that model's rates. Empty = the conversation's own model (unchanged default).

## 2026-08-08 — OpenClaude 443 provider + 1M context for this repo
- Added `.openclaude/settings.json` (shared: model `claude-opus-5`, effort high, modelLimits 1M/128k out).
- Added `.openclaude/settings.local.json` (gitignored) with API-443 Anthropic proxy env + auth from user profile.
- Also patched `~/.openclaude/settings.json` with `modelLimits` for `claude-opus-5` — the active custom-anthropic provider profile does not apply CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS, so runtime fell back to 128k despite the legacy profile file saying 1M.

## 2026-08-08 (later) — Context size is MEASURED, not re-derived

Reworked after reviewing `E:\VOID-EDITOR\openclaude` (`src/utils/tokens.ts`
`tokenCountWithEstimation`). Aurora re-derived the whole context from disk every time, so every
provider quirk it did not model compounded into the answer. Now
`ConversationRuntime::projected_request_tokens` **anchors on the last request the provider
measured** and estimates only the messages appended since. Error can no longer accumulate across a
conversation — it is bounded by the last few messages. The from-scratch path (with
`fixed_request_overhead_tokens`, now memoized in a `OnceLock`) survives only as the fallback for
"nothing measured yet": fresh session, no-usage provider, or the turn right after a compaction
dropped the anchor out of the view. Aurora's own synthetic usage (`estimated: Some(true)`) is never
an anchor.

`measured_context_tokens` = input + **cache_creation** + cache_read + **output**. Both additions
were real bugs: cache-write is most of the prompt on a cache-writing turn, and the completion is
re-sent as input on the very next request. `ContextRing` now sums the same four (its cache-hit
denominator stays input-only).

**Compaction circuit breaker** (`MAX_CONSECUTIVE_COMPACTION_FAILURES = 3`,
`COMPACTION_FAILURE_COOLDOWN_MS = 5min`, state on `Session`, process-local). A failed compaction
does not fix the overrun that called it, so the next turn re-qualified and paid for the same doomed
full-history request forever. `CompactionOutcome` distinguishes `SummaryFailed` (spent money,
counts) from `NothingToDo` (transcript too short, free, doesn't count). Manual `/compact` bypasses
the breaker — the user asked and is watching.

## 2026-08-08 (3rd) — Compaction is a handoff note, not a summary

Reworked `COMPACTION_SYSTEM_PROMPT` after `openclaude/src/services/compact/prompt.ts`. It is now
written in the **second person** — the model is told it is about to lose its memory and is writing
the note it will find. Third-person "summarize this transcript" produced detached recaps; this
produces resumable specifics. Structure: an `<analysis>` chronological scratchpad (stripped by
`format_compact_summary`, so it buys quality without costing context — and gives the call
chain-of-thought while extended thinking stays off), then a `<summary>` under 10 fixed headings.
Section 6 (**every user message, verbatim**) and section 10 (**next step with quoted text**) are the
two that most affect resumption; both were absent before.

`compaction_preamble` now carries behaviour, not just content: "pick up exactly where you left off,
the user saw no interruption, do not mention the summary." Continuity is the deliverable — an
assistant that opens with "based on the summary…" has leaked an implementation detail.

`transcript_hint` makes compaction lossy-but-**recoverable**: the full JSONL still exists, so the
note names its path and tells the model to `file_read`/`grep` it instead of guessing. Gated on
`allow_outside_workspace` (the session store is outside the project — pointing at an unreadable
path is worse than silence).

Summary budget default 8192 → **16000** (range 4000–24000): it now covers the drafting pass AND the
note, and starving it truncates the LAST sections — exactly "current work" and "next step".

`format_compact_summary` degrades rather than fails: unclosed `<analysis>`, unclosed `<summary>`, or
no tags at all still yield a usable note. A formatting slip must not become a failed compaction.

## 2026-08-08 (4th) — Compaction shares the conversation's prompt cache

The dominant cost factor in compaction is NOT which model runs it — it is whether the request
reuses a prefix the provider already cached. The cache key is model + system prompt + tools +
message prefix + thinking config. The head IS a prefix of the conversation, so keeping the other
four identical bills ~200k tokens at the cache rate (~1/10 of fresh); the instruction rides past
the cached region for almost nothing.

Aurora was throwing that away: the summarization request used `COMPACTION_SYSTEM_PROMPT`,
`tools: &[]` and thinking off, diverging the prefix at token zero. Same model, same history,
billed in full. `summarize_with(share_cache)` now has two shapes:

- **share_cache** (no pinned model): the conversation's own system prompt, full tool catalogue,
  its thinking config, reasoning left in place. Whole instruction moves to the trailing user
  message, led by `COMPACTION_NO_TOOLS_PREAMBLE` — keeping the tools is what preserves the key,
  and a model holding tools sometimes calls one instead of answering. An empty result retries once
  in the standalone shape, so that accident re-bills rather than failing the compaction.
- **standalone** (pinned model): no cache to share, so send the least possible — dedicated prompt,
  no tools, thinking off, reasoning stripped.

Mirrors `openclaude`'s `promptCacheSharingEnabled = !modelChangesForCompaction && …` and its
`CacheSafeParams` doc ("inherits the parent's full tool set — required for cache-key match").

**Guidance for the Compaction model setting:** default (unset) is usually cheapest. A pinned model
pays fresh input for the entire head, so it only wins if its rate beats the chat model's CACHE
rate — about a tenth of list price, not merely cheaper.

## Agent window type scale — measured against the reference (2026-08-10)

The reference's chat prose is **15px / 1.75**, read from its chat renderer
(`pages/agent/components/chat-message.tsx` `text-[15px] leading-7`, and `.ft-stream` in
`globals.css`). Do **not** size Aurora from a `getComputedStyle(document.body)` probe of either
app: `body` is 16/24 there and 14px here (`src/index.css`), and neither styles anything the chat
actually renders — Aurora's agent text lives inside `.agw-root`. An earlier pass set prose to
16/1.5 from exactly that mistaken body reading.

Aurora now carries: chrome `--agw-fs-micro…title` = 12/13/14/15/16/17, each multiplied by
`--agw-ui-text-scale` (new theme token, Appearance → Typography → Interface text size, 90–115%).
The multiplier is smooth, not rounded per step — rounding collapses `md` and `body` onto 14px at
90%. The prose tier (`--agw-fs-h1…h4`, `--agw-fs-code`, `--agw-fs-code-block`) is **`em` ratios**
(1.5/1.25/1/0.875/0.8/0.8), so headings and code follow the Appearance message-size slider; with
the old fixed px, setting messages to 18px left h3 (17px) smaller than its own body text.

**Settings runs one step below app chrome** — `.agw-settings` re-declares all six chrome tokens at
11/12/13/14/15/16. It is a dense configuration surface, not a reading one, and those are the sizes
it was authored at before the scale moved. Re-declared, not derived via a `--agw-density`
multiplier: a `var()` inside a custom property is substituted where that property is **declared**,
so a variable set on a descendant can never reach tokens declared on `.agw-root`. Consequence to
remember: anything that portals out of settings must target `.agw-settings` before `.agw-root`
(`settings/primitives.tsx`), or it renders a step larger than the row that opened it.

One deliberate exception to the em rule: **fenced code blocks are absolute**
(`--agw-msg-code-font-size`, default 13px, its own Appearance slider). A block is a surface, not
a phrase. The reference splits it identically — `0.8em` on inline code, a hard `12px` on
`pre code`. 12px mono read cramped beside 15px sans in Aurora, hence 13.

Lesson that generalises: when the CSS scale moves, hardcoded `fontSize:` numbers in TSX do not.
36 of them across 14 files were stranded at the previous 11/12/13 and would have rendered a step
below their neighbours. Sizes belong on a token; the only legitimate numeric survivor is xterm's
`fontSize` option (`TerminalPanel.tsx`), which requires a number.

## Settings search has one catalog and two front doors (2026-08-11)

`settings/settings-catalog.ts` (`SETTINGS_CATALOG`, leaf, no JSX) is the only list of what settings
exist and what controls they contain. `SettingsPage` pairs each entry with a component via
`SECTION_VIEWS` to build `SECTION_REGISTRY`; the command center reads the same catalog through
`lib/command/settings-commands.ts`. They were separate lists before and drifted — "chapter" found
the Chapters switch in Settings and nothing in the command center.

The query lives in `useAgentUiStore.settingsQuery` (never persisted) so `openSettings(section, query)`
lands on the control, not the page. `setSection` clears it — otherwise the nav looks dead mid-search.

Only the ONE term that matched (`matchedSearchTerm`) reaches a command item, as its subtitle.
Feeding all of a section's `searchTerms` into the item's searchable text destroys ranking:
`fuzzyCommandScore` falls back to subsequence matching, and against a haystack that long almost any
typing matches almost every section.

## Settings → Diagnostics: the log finally has a door (2026-08-11)

`aurora.log` (`%LOCALAPPDATA%\AuroraIDE\logs\`) had existed since the panic hook with **no UI at
all** — you had to know the path. `settings/DiagnosticsSettings.tsx` is now its home: recent
problems newest-first, expandable detail, Copy all, **Send to agent** (fills the composer draft and
closes to the chat — the person still presses Enter), Show in folder, Clear.

The prerequisite mattered more than the page: 197 `console.error` sites went to a console a packaged
build does not have, so the log recorded the Rust half of every failure and none of the web half.
`kernel/lib/diagnostics/error-reporter.ts` routes `console.error` + `window.onerror` +
unhandled rejections into the same file. **`console.warn` is deliberately NOT captured** — 113 chatty
sites would bury the lines that matter. Guards: re-entry flag, 2s dedupe, 60/min cap that writes one
line explaining itself before going quiet, and it skips rejections already `defaultPrevented`
(App.tsx marks expected stream cancellations first — listener order is load-bearing).

Rust: `logging.rs` gained `recent()` (tail-reads 512 KB, never the whole 5 MB), a line parser that
keeps unparsable lines as `RAW` because a torn line is crash evidence, `log_from_ui` (forces the
`ui.` namespace so the renderer cannot forge backend components), and `clear()`.
Commands: `logs_recent` / `logs_report` / `logs_clear`.

Settings search now matches on WORD BOUNDARIES (`textMatches`), not plain substring: searching `log`
reached Skills before Diagnostics on the strength of "cata(log)". A prefix of a word still counts.

## The only metric that has moved: the owner's confidence (2026-08-11)

Alvan builds Aurora **with** Aurora, and rates his own confidence in using it inside a big,
important project: **~1/100 on 2026-08-08** ("terrible"), **~60/100 on 2026-08-11**.

Worth writing down because nothing else in this repo measures it. Tests, `tsc`, and the build were
green through the whole period he calls terrible — green tooling never once disagreed with a 1%
experience. Treat the missing 40 points as the roadmap, and prefer work a person would hit during a
long, high-stakes turn on a large repo over polish on surfaces that already work.

The three days in between held: the context-accounting fixes (reasoning signatures counted as prompt
text — 92k phantom; measured rather than re-derived totals; compaction as a handoff note sharing the
prompt cache), Aurora dropping non-empty provider replies, the Anthropic adapter still written for
pre-4.7 Claude, the tree-sitter code index + `code` tool, and the tool fixes the in-window agent
reported about itself. Correlation, not a verified cause.

## Desktop control — designed in full, deliberately not built (2026-08-11)

Giving the agent eyes and hands on a running Windows app — **the app you are building** — by porting
QuantumHub's `qg-probe` daemon (`E:\QuantumHUB-Infrustructure\agent-studio\qg-probe`). The whole
design conversation is written up in **`DOCS/desktop-control-plan.md`**; do not re-litigate it,
resume there.

The decisions worth knowing without opening the doc:

- **Port the C# perception engine, don't rewrite it in Rust.** `windows-rs` could do IUIAutomation,
  but UiaDump/WinInput are thousands of lines of invisible-until-it-breaks behaviour. The JSON-lines
  daemon contract is the seam if we ever swap it.
- **Drop WPF** — no QuantumFinder, and the halo becomes an Aurora overlay window. Takes the exe from
  ~62 MB to an estimated 15–20 MB.
- **31 daemon commands → 3 tools** (`computer_see`, `computer_do`, `computer_clipboard`). No app
  launching: `shell_execute` + `pnpm dev` already starts the app.
- **The setting is the consent** — no per-action approval. Rust takes/releases control automatically
  around the turn, so those four commands never reach the model.
- **Hard-gated on `supportsVision`.** Without vision the toolset is pointless: a UIA tree can't tell
  you the padding is wrong or the chart didn't render, which is the only reason to look. The
  settings row must say WHICH gate is closed — a toggle reading ON while nothing works is the
  green-checkmark lie again.
- **Screenshot is primary perception here**, inverting the source skill's "screenshots are NOT
  perception". That also disposes of OCR entirely.
- **Context discipline is the make-or-break**: a 1500-node dump is ~38k tokens. Newest two trees
  whole, older stubbed (their `n` indices are stale anyway), per-tree cap pointing at `find` — in
  the Rust result path, not the prompt.

## The Browser panel's page cannot be drawn on

The Browser panel hosts a **native child webview**, and a child webview paints above every pixel of
React DOM below it. Anything you try to overlay on the page area — a halo ring, a highlight, a
"loading" scrim — is simply invisible. Insetting the webview to make room for a border is not the
workaround: it resizes the page viewport, which changes what `browser_view` and screenshots report
mid-action. The **toolbar's bottom edge is the only border of the page area Aurora can draw on**,
which is why the agent-is-driving cue is a lit seam + a chip inside the address pill rather than a
ring. This is also why `hideAgentBrowser()` exists for every dropdown that opens over the panel.

The cue itself is Rust-owned: `tools/browser/halo.rs` wraps every browser tool and emits
`aurora:agent-browser-activity` from a **drop guard**, so an errored or cancelled tool still turns
it off. A status indicator that can get stuck on is worse than none.

**Viewport emulation resizes the webview, not just the page.** `Emulation.setDeviceMetricsOverride`
alone left the page in a narrow column with a large blank band beside and below it — painted by the
browser INSIDE the webview, unreachable by Aurora CSS, and photographed by the native screenshot as
if it were part of the site. `browser_set_viewport` now also emits `aurora:agent-browser-frame`, and
`BrowserPanel.measure()` sizes the webview to the emulated device (capped to the panel, centred).
`BrowserManager::navigate` clears the CDP overrides, Aurora's `state::EMULATION` record, AND the
frame together — before, a navigation left `browser_status` reporting an override that was gone.

**The agent has a drawn cursor** (`tools/browser/pointer.rs`): click/fill/hover glide a pointer onto
the target and ripple. It is appended to `document.documentElement` (the readers scan from `body`),
is `aria-hidden`, and is removed before every screenshot — so it appears in no tool result.

## A dropped stream now retries itself (2026-08-12)

`aurora.log` said the most common real failure was the connection dying mid-reply — three of eight
real incidents, across three different models, so it is the gateway and not one provider. There was
no retry: `ApiError::is_recoverable` only ever *labelled* the error so the UI could offer a Retry
button, and `conversation.rs` returned straight after emitting it. The user restarted every one of
those turns by hand.

`conversation.rs` now wraps the model call in a retry loop — `MAX_STREAM_ATTEMPTS` = 3, backoff
`STREAM_RETRY_BASE_DELAY_MS << (attempt-1)` (1s, 2s), Stop interrupts the wait. What retries is
`ApiError::is_retryable()`, kept **deliberately separate** from `is_recoverable()`: same set today,
different questions ("tell the user a retry may help" vs "spend their money retrying now"), and
folding them would let a presentation change silently alter runtime behaviour.

The load-bearing detail: retry scope is **one model call, never the turn**. Tool calls that already
ran and replies that already completed are in history and untouched — the assistant message is only
appended after a clean stream, so a failed attempt was never persisted. The half-reply exists ONLY
on screen, which is why the fix needs `AssistantEvent::PartialReplyDiscarded`: the session is
already correct, the screen is not.

The UI half is `timeline.ts` `beginReconnect()` / `clearReconnect()` plus `ReconnectCard`. The
truncation rule is "walk back over the trailing `thinking` / `content` / unfinished-`tool` events
and stop at the first thing that survived" — a completed tool, a mid-turn user note, a compaction
marker. Two traps it exists to avoid: a half-streamed tool card would strand next to its
replacement (the retry gets a NEW call id from the provider), and the flat `content`/`thinking`
strings must be re-derived via `textOf()` because a string cannot be un-appended — skip that and the
dropped fragment is gone from the transcript but still in Copy and the reload fallback. The marker
is transient and never persisted; a recovered hiccup is meant to leave no trace at all.
**Not visually verified** — reproducing it needs a real mid-stream drop.

## 2026-08-15 — Shell discovery and persistence traced (read-only)
- Machine scanning is owned by `src-tauri/src/shell/discovery.rs`; it imports Windows Terminal profiles, PATH, registry, and well-known locations, then verifies each candidate by execution.
- The registry is persisted as JSON under SQLite `app_settings` key `shell_profiles`; `commands/shell_profiles.rs` also installs the same snapshot in process memory for tool and PTY resolution.
- Agent tools resolve through `src-tauri/src/shell/mod.rs`; the Agent Window PTY goes through `shell_interactive_config`, so executable paths are not guessed in the frontend.

## 2026-08-15 — Code-index false `scan` usages investigation
- Plan: reproduce the reported `in_file` query with a minimal same-name fixture, trace reference extraction/import resolution through `store::resolve` and `references_to`, then fix the narrowest owning layer.
- Add a regression that prevents unrelated same-name calls from being attributed to the selected definition, then run focused Rust checks before broader validation.
- Root cause confirmed: Rust `let` bindings were only `ref.ident` facts, so a local `scan` fell through the unique-definition shortcut and was attributed to `shell::discovery::scan`.
- Fix landed: index simple Rust `let` bindings as variables, exclude value bindings that cannot be inferred safely by directory alone from the same-directory fallback, and bump the code-index cache format from 4 to 5 so stale indexes rebuild.
- Verified: 16 code-tool tests, 61 code-index tests (58 passed / 3 ignored), `cargo check`, and focused diff checks pass.

## 2026-08-15 — Code-index adversarial correctness audit
- Plan: probe import aliases, renamed calls, and lexical-shadowing cases against extraction, resolution, and the end-user `usages` result.
- Confirm defects with minimal multi-definition fixtures before changing production semantics; add regression coverage at the owning extraction/store/tool layers, then bump persisted semantics only if facts on disk change.
- Confirmed: aliased TypeScript imports (for example `formatTokens as fmtTokens`) recorded the import but lost every aliased call; side-effect imports and re-exports were absent from module-graph edges.
- Fixed: retain local + exported import names, exclude alias declarations from reads, retain module-only imports, resolve alias references to their exported definition, and bump the persisted cache to v6.
- Multi-file `file_edit` cards now say `Editing Multiple Files` while running and settle to `Edit Files`; one-file edits remain `Edit File`.
- Verified: 61/64 code-index tests (3 measurement harnesses ignored), 17/17 code-tool tests, 43 focused frontend tests, TypeScript build, Rust check, and focused diff check all pass. The final dynamic-title correction adds 20/20 focused card tests and a clean TypeScript build.

## 2026-08-15 — Context-overflow compaction + cost-card accuracy
- The provider is the only reliable source for the real context window: `gpt-5.6-sol` is configured at 1,050,000 but the endpoint rejected ~355K with `context_too_large`, so the 85%-of-window threshold never fires. `ApiError::is_context_overflow()` now pulls that error out of the retry bucket (it was re-sent 3x, byte-identical) and `run_turn` force-compacts and re-issues, capped at `MAX_OVERFLOW_COMPACTIONS`.
- Anthropic emitted `AssistantEvent::Usage` twice per request (message_start + message_delta) while the frontend ACCUMULATES every usage event, so live turn cost double-counted input/cache and requests. Only `message_delta` emits now; all providers behave alike.
- Compaction can bill two full-history requests (the cache-sharing attempt falls back to a no-tools one when the model answers with a tool call instead of the note). The discarded attempt's usage is now summed into the marker, and the fallback logs to `aurora.log` instead of stderr.
- Preset seeding hardcoded `supportsVision: false` for every model; models.dev already publishes vision/tool/reasoning support and the settings backfill was discarding it. Presets can now declare `supportsVision`, and the one-time backfill ORs models.dev capabilities in.
- Follow-up: the size guess is now measurement-anchored ONLY on requests issued after the newest compaction marker (`last_compaction_timestamp`) — the kept tail carries usage measured while the dropped head was still on the wire, so the old anchor reported the pre-shrink size. Compaction card `after` is now derived by scaling the estimator's reading of the new view by measured/estimated on the old one, so after < before is structural.
- New: `agent_runtime/context_limits.rs` + `paths::limits_dir()` — learns each endpoint's REAL ceiling into `<root>/limits/context-limits.json` (largest accepted / smallest rejected, 0.9 safety margin). `maybe_compact` and `compact_inner` budget against `effective_window(model, configured)`, so a model configured at 1.05M but served at ~355K now compacts on time instead of never.

## kenari provider (2026-08-17)

One gateway account (`kn-` key, `https://kenari.id/v1`) reaching 54 chat models over **three
wires**, selected by `providerType`: `kenari` (chat completions, the default), `kenari-messages`
(Anthropic shape), `kenari-responses` (Codex shape). Measured live on `deepseek-v4-pro`, not read
off the docs:

- **All three return the model's raw reasoning trace, not a summary.** The Responses wire ships it
  through events named `response.reasoning_summary_text.*` — that name is inherited from OpenAI's
  schema and says nothing about the content.
- **Reasoning replay is pointless here.** A second turn returns `prompt_tokens: 7661` whether the
  assistant message carries `reasoning_content`, `reasoning`, or neither — the gateway strips it.
  Hence `reasoning_field_for("kenari*") == None`.
- Only `kenari-messages` streams a thinking `signature`; `kenari-responses` has no
  `encrypted_content`, so nothing can be replayed there.
- `x-api-key` authenticates on `/messages`, so Aurora's Anthropic client works unchanged.
- The preset seeds **zero models on purpose** (`model: ""`) — the catalogue is live at
  `GET /v1/models` (public, no key) and carries context, vision, `tool_call`, `reasoning_options`
  and Rupiah pricing. Prices are **IDR per 1M tokens** (`micro_idr / 1e6`); Aurora's cost UI is
  still USD-only, so kenari model rows carry no price yet.
