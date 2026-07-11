# Agent Window — Codex-parity implementation status

> Target spec: `CODEX-UI-REFERENCE.md` (the live-captured Codex UI, now including
> §12 Review panel / Files tab / Search / account menu / Settings).
> Vision: the **agent window is the agent**; the **IDE is the editor**. Diff/file
> surfaces in the agent window are **VIEW-ONLY** — to edit, hand off to the IDE.
> Theme: ONE source of truth — `agent-window/theme/tokens.ts` → `--agw-*`
> (auto-derived), applied by `AgentThemeProvider`. No `--aurora-*`, no hardcoded
> colors anywhere in the agent window.

## Done this session

### Motion / smoothness (all CSS-scoped, respects `prefers-reduced-motion`)
- Tool cards/groups glide in (`agw-row-in`); tool-card body + reasoning block
  expand/collapse animate height via framer `AnimatePresence`.
- `<MotionConfig reducedMotion="user">` wraps the window (AgentWindow.tsx) so
  framer animations honor reduced motion too.
- Newest transcript turn fades in (`agw-turn-enter`), gated to the last turn so
  opening a thread is not a bulk "wave".
- Removed the floating "Latest" jump pill (kept the smooth auto-scroll core).

### Real diffs (backend emits true before/after)
- Rust modify tools now include `oldContent`/`newContent` (LF-normalized, capped
  at 128 KiB/side = `MAX_DIFF_CONTENT`, aligned to the UI's per-field cap):
  - `tools/file_workspace_search/search_replace.rs` `render_response` (covers
    search_replace, multi_search_replace, file_patch) — `diff_side()` helper.
  - `file_write.rs` (captures pre-write original in the same blocking task).
  - `file_create.rs` (old = "").
- Parser `tool-views/tool-result.ts` extracts `diff { oldText, newText, path,
  fullPath }`.
- `tool-views/diff.ts` — LCS line diff with prefix/suffix trim + size guard +
  context folding (`N unchanged lines`); `toSplitRows()` for side-by-side.
- `tool-views/DiffView.tsx` — unified + split layouts; dual line-number gutters;
  removed=red / added=green; view-only.
- Inline "Edited a file" card body now renders the real red/green diff
  (`ToolResultView.tsx`, unified mode).

### Review panel (right dock)
- `components/ReviewPanel.tsx` (mounted in `RightDock.tsx` for the `review` tab):
  stats-first "Edited N files · +x/−y", per-file collapsible diffs, summary
  toolbar with **Collapse/Expand all** + **split⇄unified** segmented toggle.
- `components/review.ts` `collectFileChanges()` aggregates per-file net change
  across the thread (earliest original → latest content).
- Diff layout persisted in `useAgentWorkspaceStore.diffMode` (default **split**,
  Codex-style).
- Clicking a file chip on a tool card opens Review focused on that file
  (`useAgentReviewStore.selectedPath` → expand + scroll).

### "Open in IDE" (view-only → edit hand-off)
- `adapters/open-in-ide.ts` emits global `agent_open_in_ide` { path } (absolute
  `fullPath` preferred — agent window may be scoped to a different project).
- `services/agent-ide-events.ts` handles it **only in the main window** (gated by
  pathname): opens the file in Monaco (`handleEditorOpen`) + unminimizes/focuses
  the IDE window.
- Per-file "Open in IDE" button in the Review panel (`external` icon).
- New bespoke icons in `shared/AgentIcon.tsx`: `external`, `columns`, `rows`.

## Verified
- `cargo check --lib` clean; `npx tsc -b` exit 0.
- NOTE: Rust changes need a `pnpm tauri:dev` restart (no hot reload). Edits made
  before the restart won't carry `oldContent`/`newContent`, so they won't show a
  diff in Review — only new edits will.

## Session 2b — streaming feel, model selector, @-mentions

- **Smooth streaming reveal** (`hooks/useSmoothReveal.ts`, used by `AgentMarkdown`):
  decouples the visual reveal from bursty token arrival — eases `shown` toward the
  full text a few chars/frame (fast when behind, gentle at the tail), snaps on
  stream end, honours reduced motion. Streamdown's own per-token fade is OFF
  (`isAnimating={false}`) so this owns the motion. Fixes the "lightweight cartoon"
  feel → steady/weighty.
- **ModelSelector rebuilt** (`ModelSelector.tsx`) to a real picker layout (trigger
  avatar + label + chevron → header w/ count · search · grouped rich rows w/
  avatar+name+provider+spring check · footer). Spring open/close. **No focus halo**
  on the search (user: focus glow = slop) — only the cursor/fill is the affordance.
- **`@`-file mentions** in the composer: `adapters/file-index.ts` builds a cached,
  bounded, recursive file list (the agent window has no IDE explorer). Typing `@`
  opens a spring dropdown (`rankFiles`); picking drops a **pill** into an
  attachments row (spring add/remove) and strips the `@token`; on send the paths
  are folded into the message. Additive — normal typing/sending untouched. Index
  invalidated after each turn. `/` (skills) still TODO.
- **Tactile press** on the send button (`:active { scale(0.9) }`) — deliberately
  NOT a hover-lift.

## Session 2c — `/` slash-command picker (skills · rules · MCP)
- **`/` directive picker** in the composer, sibling of the `@`-file picker but for
  **directives, never files**:
  - `adapters/prompt-commands.ts` — catalog of skills (ALL discoverable, via
    `loadAllSkillCandidates` — slash pulls a skill in on demand regardless of the
    per-workspace toggle), project rules (`loadProjectRules`), and **connected**
    MCP servers (`useMcpStore`). Cached per root, dropped after each turn (same
    lifecycle as the `@`-index).
  - `store/useAgentCommandStore.ts` — staged directives as chips; `buildCommandSelection()`
    splits them into `explicitSkillKeys` / `ruleFilenames` / `mcpServerNames`.
  - `AgentComposer.tsx` — `SLASH_RE` trigger (line-start or post-whitespace,
    word/dash query), spring dropdown reusing `.agw-menu`/`.agw-mention`, arrow/
    enter/tab/esc nav, backspace-pops-last-chip, `/query` stripped on pick. The
    directive rides as a CHIP (not inline text). Placeholder updated.
  - `useAgentWindowSend.ts` — threads `explicitSkillKeys` into the prompt context
    (resolved authoritatively in `composeAgentSystemPrompt`); injects selected
    rule content as a `<project_rules>` block and a `<preferred_mcp_servers>`
    nudge into `ideContext`; clears the store at turn start.
  - CSS: `.agw-cmd-row/.agw-cmd-chip/.agw-cmd-source` (kind-tinted chips).
- Verified: `npx tsc -b` exit 0.

## Session 2d — chat archive (15-day retention)
- **Archive a chat** with auto-purge after 15 days. Full stack:
  - Rust: `SessionMetadata.archived_at` + `SessionSummary.archived_at` (RFC3339,
    `None` = active). `SessionStore::set_archived()` stamps/clears it;
    `list_summaries_filtered()` purges any archive older than
    `ARCHIVE_RETENTION_DAYS = 15` on every listing (GC needs no scheduler —
    listing is the trigger). Command `thread_set_archived` (registered in lib.rs).
  - TS: `ThreadSummary.archivedAt` + `threadService.setArchived()`;
    `useAgentChatStore.toggleArchive()` (optimistic, reverts on failure, drops to
    empty state if the open chat is archived).
  - UI (`LeftRail.tsx`): active tree excludes archived chats; each row gets an
    **archive** action on hover (next to pin). **Archived** is an inline
    collapsible section at the bottom of the tree that expands/collapses exactly
    like a project (chevron + count badge) — NOT a separate panel. Each archived
    row shows a "deletes in Nd" countdown + **restore** + **permanent-delete**.
  - **Confirmation policy**: archiving/restoring is silent (reversible within the
    15-day window); permanent-delete routes through `AgentConfirm.tsx` (a portaled
    `--agw-*`-themed yes/no modal, Esc/Enter, destructive-red confirm).
  - New `AgentIcon` glyphs: `archive`, `trash`. CSS: `.agw-rail-del`,
    `.agw-rail-archive-count`, `.agw-confirm-*`.
- Verified: `cargo check --lib` + `npx tsc -b` exit 0; eslint clean.
- NOTE: archiving is an agent-window surface only — the IDE's own thread-history
  modal still lists archived chats (separate store/UI; out of scope here).

## Session 2e — fix: in-flight chat unreachable after navigating away
- **Root cause** (end-to-end traced): the runtime flushes the FULL session JSONL
  only ONCE, at turn END (`commands/agent_v2.rs` `TurnDriver::run_turn`, the
  post-turn `save_to_path`). A chat started from a fresh draft therefore has an
  empty `.jsonl` (`messageCount 0`) for the whole turn, and the rail's
  `messageCount > 0` filter (`useAgentChatStore.refreshThreads`) hides it. Navigate
  to another project mid-turn and the in-flight turn lives on only in `liveTurns`
  memory with no rail row → unreachable. (The thread's metadata sidecar DOES exist
  from draft-send via `createThread`→`ensure_thread`; only the message log is late.)
- **Backend fix (durability / disk-accurate from msg #1)**: `TurnDriver::run_turn`
  now persists the user message to the JSONL *up front* for fresh threads
  (`is_fresh` = empty log) via `Session::append_to_path`, before the agent loop.
  The post-turn full `save_to_path` (truncate+rename) overwrites it, so there is
  no duplicate on success; on a mid-turn crash/reload the user's message survives.
- **Frontend fix (instant, reactive visibility)**: `LeftRail` now folds live turns
  into the rail via `allWithLive` — synthesizes a `ThreadSummary` for each
  `liveTurns` entry not yet in `allThreads`, keyed by the SAME thread id the
  runtime persists under (title via the shared `deriveThreadTitle`, project via
  `liveProjects`). So an in-flight chat is a first-class, clickable row the instant
  it starts and across project navigation; `selectThread` already re-attaches to
  the live transcript on click.
- **Seamless hand-off**: `useAgentWindowSend` finally now `refreshThreads()` BEFORE
  `endTurn()` — the persisted row enters `allThreads` (deduping the live extra by
  id) before the live turn is dropped, so the row never blinks out.
- Verified: `cargo check --lib` + `npx tsc -b` exit 0; eslint clean. NOTE: Rust
  unit tests compile but the test binary can't launch in this env
  (`STATUS_ENTRYPOINT_NOT_FOUND` — missing native DLL on PATH); run
  `cargo test --lib agent_v2` locally to exercise the no-duplication happy path.

## Session 2f — parallel-chat: streaming re-attach + workspace_tree error surface
- **Streaming "dumps all at once / janky catch-up" on re-open** of a background
  turn: `useSmoothReveal` initialised `shown=""` whenever `active`, so re-opening
  a chat whose turn ran in the background re-revealed the whole backlog from zero.
  Fix: seed `shown` with the CURRENT target (and `shownLenRef` with its length) —
  the backlog shows instantly, only tokens arriving *after* re-attach are eased.
  Fresh foreground streams are unaffected (they mount empty → ease as they grow).
- **`workspace_tree` raw `os error 2`** ("The system cannot find the file
  specified"): the tool used the STRICT `resolve_path`, which canonicalizes and
  hard-fails when the model probes a subdir that doesn't exist (routine during
  exploration). Switched to the tolerant `resolve_path_for_read` + an explicit
  `is_dir()` check that returns actionable guidance ("No directory 'X' … call
  workspace_tree with no path to list the root"). NOT a parallel-chat bug — the
  native tool roots per-turn correctly off `session.workspace_root`; the parallel
  timing was coincidental (both models were probing paths).
- Verified: `cargo check --lib` + `npx tsc -b` exit 0.
- **Known follow-ups (diagnosed, not yet fixed):**
  1. Frontend-BRIDGED tools (`aurora_skill_*`, MCP) resolve workspace via the
     GLOBAL `useWorkspaceStore.rootPath`, which `bindRuntimeWorkspace` flips on
     navigation — a background turn's bridged tools can read the foreground
     project. Native tools are unaffected. Fix = thread per-turn `workspace_root`
     through the bridge payload to `executeAuroraFrontendTool`/`executeMcpTool`.
  2. `LeftRail` subscribes to the whole `liveTurns` object → re-renders on EVERY
     streamed token of every turn (the synthesized rows only depend on the live
     SET + first user message, which are token-stable). Likely contributes to
     "not smooth while two turns run." Fix = subscribe to a stable signature
     (ids|root|title) and read `liveTurns` via `getState()` in the memo.

## Not done / next (no Codex re-dump needed — see CODEX-UI-REFERENCE §6.1, §12)
- Wire the composer mic → Qwen3-ASR; access/approval pill; reasoning-effort tier.
- **Scope selector** ("Last turn" vs "All changes") in the Review toolbar.
- **Jump to file** dropdown; **Hide files**; in-panel **Commit/Push/Create PR**.
- **Files tab** (§6.2/§12.2): read-only workspace tree + fuzzy filter + read-only
  file viewer, with "Open in IDE" to edit. Still a placeholder in `RightDock`.
- **Search** as a command palette (§12.3) for the agent window's rail.
- Composer gaps (separate from Review): wire mic → Qwen3-ASR; access/approval
  selector pill; reasoning-effort tier in the model menu.
- Settings page parity (§7/§12.6) — grouped nav + Appearance controls.

## Key files
```
src-tauri/src/tools/file_workspace_search/{search_replace,file_write,file_create}.rs
src/agent-window/components/tool-views/{diff.ts,DiffView.tsx,tool-result.ts,ToolResultView.tsx}
src/agent-window/components/{ReviewPanel.tsx,review.ts,ToolCallCard.tsx,RightDock.tsx}
src/agent-window/store/{useAgentWorkspaceStore.ts,useAgentReviewStore.ts}
src/agent-window/adapters/open-in-ide.ts
src/agent-window/shared/AgentIcon.tsx
src/agent-window/theme/agent-window.css
src/services/agent-ide-events.ts   (main-window listener for agent_open_in_ide)
```
