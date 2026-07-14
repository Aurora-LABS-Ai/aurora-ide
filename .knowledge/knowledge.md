# Aurora IDE — Working Memory

Thin progress + working-memory layer. Append 2-4 lines per meaningful change.

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
