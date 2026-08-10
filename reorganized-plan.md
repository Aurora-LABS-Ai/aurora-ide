# Aurora IDE — Frontend Reorganization Plan

Reorganize `src/` from layer-typed folders (`components/`, `services/`, `store/`) into two
products over a thin kernel, and delete the IDE-side agent that is being retired.

The Rust side (`src-tauri/`) is already domain-modular and is **out of scope**. Nothing in this
plan touches Rust, the IPC command names, or runtime behavior.

---

## STATUS

| | |
|---|---|
| **Current phase** | **Phases 1–3 structurally complete.** Deferred: 2.4 (typed IPC), 3.5 (settings split) |
| **Next action** | Phase 3.5 — split `kernel/store/useSettingsStore.ts` (2110 lines); it is the last boundary exemption |
| **Last updated** | 2026-08-06 |
| **Branch** | `main` working tree (last commit `53d6644 reorganized`) |
| **Baseline** | 52 files / 382 tests → **now 51 / 381** (only `tool-timeline/grouping.test.ts` lost, expected) |
| **Gate** | `pnpm build` clean · `pnpm test` **51 / 381** · boundary rule **0 violations** |
| **NOT verified** | No `tauri:dev` run since the move. UI-loads was confirmed by the owner *before* Phase 3. |

**Resume protocol** — if you are picking this up cold:
1. Read *Ground Truth* below. Do not re-derive it; it was measured, not guessed.
2. Find the first unchecked `- [ ]` box in the lowest-numbered phase. That is the next step.
3. Run the verify command of the last checked box first, to confirm the tree is where the plan
   says it is. If it fails, the previous step was left half-done — finish it before continuing.
4. Update **STATUS** and tick boxes as you go. Add anything surprising to *Decisions & Traps*.

---

## Ground Truth (measured 2026-08-06)

Import graph built over 409 non-test `src/**/*.{ts,tsx}` files, rooted at
`components/layout/MainLayout.tsx` (IDE) and `agent-window/index.ts` (agent).

**Scale:** ~460 files, ~102 KLOC TypeScript.

| folder | files | KLOC |
|---|---|---|
| `agent-window` | 181 | 37.8 |
| `components` | 115 | 30.0 |
| `services` | 71 | 16.8 |
| `store` | 21 | 7.3 |
| `lib` / `hooks` / `tools` / `types` / `canvas-sdk` | 71 | 10.4 |

**One entry, two products.** `src/main.tsx` → `App.tsx`, which branches on
`window.location.pathname === "/agent-window"` to render `<AgentWindow/>` or `<MainLayout/>`.
No multi-entry Vite config is needed, now or after the move.

**The seam is small.** Everything the agent window actually borrows from the IDE side:

| borrowed | sites | disposition |
|---|---|---|
| `components/explorer/FileIcons` (`FileIcon`, `FolderIcon`) | 13 | → `kernel/ui` |
| `components/chat/useShikiTokens` | 2 | → `kernel/ui` |
| `components/ui/{ConfirmDialog,ModelSelector,ShimmerText,AgentExecutionModeToggle}` | — | → `kernel/ui` |
| `hooks/useWorkspaceSummary` (`agent-window/components/EmptyState.tsx`) | 1 | → `kernel/workspace` |
| `store/{useSettingsStore,useMcpStore,useWorkspaceStore}` | many | → `kernel` / `apps/agent` |
| **type** `AttachedFile` from `components/chat/ChatInput` | 1 | → `types/` (see trap T1) |

**Reverse edges (IDE → agent) that must be cut or narrowed:**

| edge | problem |
|---|---|
| `components/layout/TitleBar.tsx:53` → `openAgentWindow` from `"../../agent-window"` | imports the **barrel**, so the IDE chunk transitively pulls in the entire agent app (this is why `MainLayout` reaches all 265 agent files) |
| `services/aurora-tools.ts:48-50` → 3 `agent-window/store/*` | shared service reaching up into an app |
| `services/team-agent-tools.ts:28` → `agent-window/store/useAgentChatStore` | same |
| `App.tsx:25` → `AgentWindow` | legitimate — this is the router |

**Deletion set (IDE agent), ~17 KLOC:** `components/chat/**` (8.4k), agent settings tabs (~5.0k),
agent stores (~2.7k), `hooks/useAgentSend` + `useRustChatSync` (~1.1k).

**True shared kernel after deletion:** ~4 KLOC — `lib/tauri`, `lib/runtime`,
`lib/error-classifier`, `lib/clipboard`, `store/useSettingsStore` (needs splitting),
`store/useWorkspaceStore`, `services/database`, `services/types`, `components/ui/*`.

---

## Target Tree

```
src/
  apps/
    ide/                    # editor product — zero agent code
      app/                  # MainLayout, TitleBar, StatusBar, ActivityBar, MenuBarMenu
      features/
        editor/  explorer/  git/  search/  terminal/  theme/  icons/  browser/
        settings/           # editor-scoped prefs only
    agent/                  # today's src/agent-window
      app/                  # AgentWindow, AgentShell, AgentTitlebar, LeftRail, RightDock
      features/
        runtime/  composer/  conversation/  tools/  providers/  mcp/
        skills/  team/  artifacts/  canvas/  files/  review/  plans/  terminal/
  kernel/                   # ~4 KLOC — the ONLY thing both apps may import
    ipc/                    # lib/tauri, lib/runtime, lib/error-classifier, typed command map
    settings/               # split useSettingsStore
    workspace/              # useWorkspaceStore, services/database, useWorkspaceSummary
    ui/                     # components/ui/*, FileIcons, useShikiTokens
    lib/                    # cn, clipboard, file-utils
    types/
  canvas-sdk/               # STAYS PUT — see trap T2
  themes/                   # STAYS PUT — see trap T3
```

**Dependency rule:** `apps/* → kernel`. Never `kernel → apps`. Never `apps/ide ↔ apps/agent`
(except `App.tsx`, the router). Each feature exposes exactly one `index.ts` — its `mod.rs`
equivalent — and nothing may import a feature's internals.

---

## PHASE 1 — Remove the IDE agent

Deletion first: it removes ~17 KLOC that Phases 2 and 3 would otherwise pay to alias and move.
**Untangle before deleting** — 1.1 and 1.2 make 1.3–1.6 mechanical.

### 1.0 Clear the runway
- [ ] **SKIPPED — owner's call.** The ~50 in-flight files were never committed or stashed, so the Phase 1 diff is mixed in with that work. Committing someone else's in-flight changes is not mine to do. Do this before review.
- [x] Green baseline recorded: **52 test files / 382 tests**, `pnpm build` clean.
- [ ] Working branch not created (same reason as above) — work is on `main`'s working tree.

### 1.1 Cut the agent window's reach into IDE code — **DONE**
- [x] **T1:** `AttachedFile` moved to `src/types/attachments.ts`; `services/context-builder.ts` repointed. `ChatInput` kept a local import + re-export until it was deleted in 1.4.
- [x] `components/explorer/FileIcons.tsx` → `components/ui/FileIcons.tsx` (16 agent-window files + 10 IDE sites rewritten).
- [x] `components/chat/useShikiTokens.ts` → `components/ui/useShikiTokens.ts`.
- [ ] `hooks/useWorkspaceSummary.ts` — **deferred to Phase 3 on purpose.** It is imported by `agent-window/components/EmptyState.tsx` but lives in `hooks/`, which is not part of the deletion set, so it never blocked 1.4. Phase 3 places it with its owner.
- [x] Verified: `rg "components/(chat|explorer)/" src/agent-window` → **0 hits**; `pnpm build` clean.

### 1.2 Fix the backwards dependencies
- [ ] `services/aurora-tools.ts` + `services/team-agent-tools.ts` still import agent-window stores. Agent-owned → `apps/agent/features/tools/` in Phase 3. **Ownership header not yet added.**
- [x] **T4 fixed:** `TitleBar.tsx` now imports `openAgentWindow` from `../../agent-window/adapters/window`, not the barrel. That adapter pulls only `lib/runtime`, `lib/tauri`, `services/database`.
- [ ] Re-run the import graph to confirm the reachability drop (not yet re-measured).

### 1.2b Unhooked from the IDE shell (part of 1.3, recorded here) — **DONE**
- [x] `MainLayout`: `ChatPanel`, `ToolApprovalModal`, `AuditTimeline`, `useRustChatSync`, `useWorkspaceSessionReset`, `isChatOpen`/`showChatPanel`, the chat `<Panel>` + resize handle, and the `centerPanelDefaultSize` calculation all removed. The editor column is now always 100.
- [x] `TitleBar`: chat toggle button, Audit Timeline button + menu item, and their now-unused icons removed. `ActivityBar` had no chat entry.

### 1.3 Unhook the chat panel from the IDE shell
- [ ] `components/layout/MainLayout.tsx:32` — remove `ChatPanel` import, its `<Panel>`, and the resize handle.
- [ ] `components/layout/ActivityBar.tsx` — remove the chat/agent entry from `SidebarPanel`.
- [ ] `components/layout/MainLayout.tsx:39-40` — remove `useRustChatSync`, and `useWorkspaceSessionReset` **only if** it is chat-only (check: it may reset editor state too).
- [ ] `App.tsx` — remove `initializeSystemInfo` from `services/context-builder` if the IDE no longer needs it; keep `installAgentIdeListeners` / `handleOpenInIde` (that is agent → IDE file opening, still wanted).
- [ ] Verify: `pnpm build && pnpm tauri:dev` — IDE window opens, no chat panel, no console errors.

### 1.4 Delete the IDE chat surface — **DONE**
- [x] `src/components/chat/` removed — 38 files, ~8.4 KLOC.
- [x] `hooks/useAgentSend.ts`, `useRustChatSync.ts`, `useWorkspaceSessionReset.ts`, `useSmoothAutoScroll.ts`, `usePromptAssetCatalog.ts` removed — all four verified chat-only first (the agent window has its own `useAgentAutoScroll`, whose docstring says it is deliberately self-contained).
- [x] **Rescued:** `DeleteConfirmDialog.tsx` was inside `chat/` but is a generic dialog the explorer's `TreeNode` uses. Restored from git into `components/ui/` rather than lost.
- [x] Verify: `pnpm build` clean.

### 1.5 Move speech, then delete the agent settings tabs — **DONE**
**Speech moved, not deleted** (owner's call). The agent window already had the *capture*
(`useAgentSpeech` → composer mic, `AgentMicPermissionModal`) and one *preference*
("Polish voice dictation", in Composer assists) — but **no engine/model/device/language
configuration at all**. Deleting the IDE tab outright would have left a working feature
with no way to set it up.
- [x] New `agent-window/settings/SpeechSettings.tsx`, rebuilt on `--agw-*` primitives (the IDE tab was Tailwind + `--aurora-*` and would have read as a foreign panel). Rendered **inside Preferences**, right after "Typing assistance" — owner asked for it there, alongside the dictation toggle, not as its own nav section.
- [x] Reuses the existing `agw-set-field-row` / `agw-set-inline-row` classes and the "Prompt refine" progressive-disclosure shape. **No new CSS was added.**
- [x] Extracted the portal dropdown out of `TeamSettings` into `primitives.tsx` as `AgwSelect` (+ `SelectOption`) — Speech needed the same control, and two hand-rolled dropdowns in one settings surface drift apart. `TeamSettings` now consumes it; code moved verbatim.
- [x] Dead controls removed rather than disabled: GPU is not offered when validation reports no usable GPU (the hint carries the reason), and CPU-threads is only shown for the CrispASR engine that actually uses it.
- [x] Deleted from `components/modals/`: `AgentSettingsTab`, `ProvidersHubTab`, `McpSettingsTab`, `FireworksSettingsTab`, `SkillsSettingsTab`, `ToolSettingsTab`, `ToolApprovalModal`, `AuditTimeline`, `ModelEditorDialog`, `ProviderEditorDialog`, `SpeechSettingsTab` — plus `services/fireworks.ts`.
- [x] **Fireworks erased** (owner's call). Only the account/usage dashboard + its tab were removed; the provider *plumbing* (`provider-defaults`, `providers/types`, `provider-display`, `useSettingsStore`) was left alone because ripping it out would change agent-window behavior.
- [x] `SettingsPanel` rewritten: 8 tabs → 3 (Appearance, General, About), one "System" group. Agent-tab deep-links now land on General instead of a blank pane.
- [x] "Default agent mode" removed from `GeneralSettingsTab` — the agent window's Settings › Agent already owns execution mode.
- [x] Verify: `pnpm build` clean, `pnpm test` 51/381.
- [ ] **Runtime check still owed:** open the agent window → Settings › Preferences › Voice input, and confirm the engine/model/device/language controls drive the composer mic.

### 1.6 Delete the IDE-only agent stores — **DONE, but the plan's estimate was wrong**
I had budgeted ~2.7 KLOC of store deletions. **Actual: 308 lines.** Almost every store I
expected to delete turned out to be live for the *agent window*, not the IDE:

| store | verdict | why |
|---|---|---|
| `usePendingChangesStore` (241) | **deleted** | zero importers |
| `useAuditStore` (67) | **deleted** | zero importers (only its own `window.auditStore` debug hook) |
| `useChatStore` | **keep → agent** | `services/agent-service.ts` uses it, and `useAgentWindowSend` instantiates `AgentService`. There is a deliberate lazy-import cycle between them. Deleting it breaks the agent window. |
| `useThreadStore` | **keep → agent** | `services/team-agent-tools.ts` + `hooks/useWindowClose.ts` |
| `useContextStore` | **keep → agent** | imported by `useThreadStore` as a **sibling** (`./useContextStore`) — my first scan searched for `store/useContextStore` and reported 0 importers. Sibling imports are invisible to that pattern. |
| `useTaskStore` | **keep → agent** | `agent-window/store/useAgentTaskStore.ts` |
| `useTeamStore` | **keep → agent** | 6 agent-window importers |
| `useCheckpointStore` | **keep → IDE** | `GeneralSettingsTab` — this answers the open decision below |

- [x] Verified: `pnpm build` clean.

### 1.7 Triage the orphans — **DONE**
- [x] Deleted 11 verified-dead files: `components/{git,icons,search}/index.ts`, `layout/ThemeDropdown`, `ui/SettingsSelect` (superseded by `IdeSelect`), `ui/StreamingText`, `lib/cn` (only `StreamingText` used it), `lib/native-editor-ops`, `services/syntax-validator`, `store/useBrowserHistoryStore`, `tools/utils/excluded-paths`.
- [x] **`lib/monaco-setup.ts` rescued from the orphan list.** It is imported as a bare side-effect (`import '../../lib/monaco-setup';`) by `CodeEditor` and `GitDiffModal`. My orphan script's regex only matched `from '…'` and `import('…')`, so every side-effect import looked like dead code. See T9.
- [x] Confirmed keep: `main.tsx`, `lib/disable-native-tooltips`, `services/agent-file-sync`, `canvas-sdk`, `themes/*`.

### 1.7 Triage the orphans
20 files are reachable from neither root. Some are **false positives** — confirm before deleting.
- [ ] Known-good (do NOT delete): `main.tsx` (entry), `lib/disable-native-tooltips` + `services/agent-file-sync` (imported by `main.tsx`), `canvas-sdk/index.tsx` (loaded as text by the Vite plugin), `themes/*.json` + `themes/index.ts` (dynamic).
- [ ] Genuinely dead — verify then `git rm`: `components/chat/FileChangeCard`, `components/chat/ToolApprovalBanner` (both die with 1.4 anyway), `components/git/index.ts`, `components/icons/index.ts`, `components/layout/ThemeDropdown`, `components/search/index.ts`, `components/ui/SettingsSelect`, `components/ui/StreamingText`, `store/useBrowserHistoryStore`, `services/syntax-validator`, `tools/utils/excluded-paths`, `lib/monaco-setup`, `lib/native-editor-ops`, `lib/cn`.
- [ ] `lib/cn.ts` unreferenced is suspicious for a Tailwind app — confirm it is not used via some untracked path before removing.

### 1.8 Phase 1 verification gate
- [ ] `pnpm build` clean
- [ ] `pnpm test` — count vs baseline: `____` (drop is expected; note which suites were deleted)
- [ ] `pnpm lint` clean on touched files
- [ ] `pnpm tauri:dev` — **runtime check**: IDE opens (editor, explorer, git, search, terminal, theme all work); TitleBar still opens the agent window; the agent window is fully functional; agent → "Open in IDE" still opens files in the IDE.
- [ ] `cargo check` in `src-tauri/` — should be untouched, this is a canary.
- [ ] Commit: `refactor: remove the IDE-side agent surface`
- [ ] Update **STATUS** above.

---

## PHASE 2 — Enforced boundaries

No file moves here. This phase installs the rails so Phase 3 cannot rot afterwards.
There are currently **zero path aliases** and **301 relative cross-boundary imports** across
109 agent-window files.

### 2.1 Aliases — **DONE**
- [x] **One alias, not four.** `@/*` → `src/*` in `tsconfig.app.json` (`baseUrl` + `paths`), `vite.config.ts` and `vitest.config.ts`. The planned `@ide/ @agent/ @kernel/` set was dropped: those folders do not exist yet, so the aliases would have been fictions pointing at today's layout. `@/` is unambiguous now and makes Phase 3 a pure prefix rewrite. **The boundary rule does not depend on alias names** — it matches specifier globs — so nothing was lost.
- [x] All three configs carry a comment saying the other two must agree; a mismatch resolves in the editor and fails at runtime.

### 2.2 Codemod relative → alias — **DONE**
- [x] **303 imports across 139 files** rewritten from `../../…` to `@/…`.
- [x] Only `../../`-and-deeper were rewritten. `./x` and `../x` stay relative on purpose — they mean "my neighbour", which stays true when a whole folder moves in Phase 3.
- [x] Specifiers resolving **outside** `src` are skipped — caught exactly one (`lib/app-version.ts` → `../../package.json`), which would have become a broken `@/` path.
- [x] Verified `pnpm build` + `pnpm test` 51/381. Codemod script: `scratchpad/alias-codemod.ps1` (idempotent, has a dry-run mode).

### 2.3 Boundary lint rule — **DONE, 0 violations**
- [x] **No new dependency.** Used ESLint's built-in `no-restricted-imports` instead of `eslint-plugin-boundaries` — after 2.2 every boundary-crossing import is an `@/…` specifier, which the built-in rule matches directly.
- [x] Two rule blocks: IDE/shared code may not import `**/agent-window/**`; the agent window may not import IDE component folders or `@/hooks/**`.
- [x] Exemptions are explicit and annotated in the config: `App.tsx` (the router), `TitleBar.tsx` (window launcher), and `services/{aurora-tools,team-agent-tools}.ts` carrying a `TODO(reorg Phase 3.4)` — they are agent-owned services still parked in `src/services`.
- [x] The rule immediately caught the one edge deferred in 1.1: `agent-window/components/EmptyState.tsx` → `@/hooks/useWorkspaceSummary`. **Fixed by moving the hook to `agent-window/hooks/`** — the agent window was its only remaining consumer once the IDE chat died.
- [x] Ships at `error`, not `warn` — there was nothing left to grandfather.
- [x] Verified: **0 `no-restricted-imports` violations.**
- [x] Two rule bugs found and fixed while writing it (see T10): `**/hooks/**` matched the agent's *own* hooks, and `!` negation inside a `group` did not exclude `@/components/ui/**`. IDE folders are now listed explicitly rather than negated.

### 2.4 Typed IPC seam — **DEFERRED to Phase 3, deliberately**
Measured first: **248 `invoke` call sites, 227 distinct commands, across 38 files.**
Hand-writing a typed map means reading 227 Rust signatures for arg and return types;
rushed or guessed types are worse than none, because they read as verified.
The commands are already funnelled through domain wrappers (`lib/tauri.ts` 37,
`services/database.ts` 25, `thread-service.ts` 21, `git.ts` 17, `team-client.ts` 17),
so a partial seam already exists. Do this properly in Phase 3 when `kernel/ipc/` is real.
- [ ] Build `kernel/ipc/commands.ts` from the Rust `#[tauri::command]` list.
- [ ] Verify: grep for `invoke(` outside `kernel/ipc/` → expect 0.

### 2.5 Phase 2 gate — **DONE**
- [x] `pnpm build` clean
- [x] `pnpm test` 51 files / 381 tests
- [x] `pnpm lint` — **0 boundary violations**. Note: the repo reports ~823 pre-existing errors (`@typescript-eslint/no-explicit-any`, `react-hooks/*`) from the `recommended` configs it already extended. Untouched by this work and out of scope — but `pnpm lint` therefore still exits 1.
- [ ] Commit (owner's).

---

## PHASE 3 — Restructure into `apps/` + `kernel/`

Pure moves. **No behavior changes in this phase** — if a diff line is not a path or an import,
it does not belong in Phase 3 (exception: 3.5, which is called out explicitly).

Use `git mv` so history follows the files.

### 3.0 Prep (not in the original plan, but it made 3.2–3.4 safe) — **DONE**
- [x] Rewrote 226 remaining single-level `../` imports to `@/…`, **except** agent-window→agent-window ones (245 kept), since that tree moved atomically. After this, every cross-directory import was absolute and a folder move became a string rewrite.
- [x] Re-ran the ownership graph (`scratchpad/classify.ps1`), now handling **bare side-effect imports** (the T9 fix).

### 3.1 Skeleton — **DONE (shape differs from the original sketch — deliberately)**
- [x] Final tree: `src/apps/{ide,agent}`, `src/kernel`, plus **`src/bridge`** — a layer the original plan did not anticipate. See "the bridge" below.
- [x] `kernel/` subdivided as `{ui,lib,store,services,types}` rather than the sketched `{ipc,settings,workspace,…}`: `kernel/ipc` was invented for the typed-IPC seam, which is deferred (2.4). `kernel/lib/{tauri,runtime}` is the honest placement until that lands.

### 3.2–3.4 The move — **DONE**
128 path moves + ~500 import rewrites. Final shape:

```
src/
  apps/agent/    adapters components hooks lib services settings shared store theme tools
  apps/ide/      app features hooks lib services store ui
  kernel/        ui lib store services types
  bridge/        agent↔IDE glue (see below)
  canvas-sdk/ themes/ assets/   (unmoved — see T2)
```

- [x] `agent-window/**` → `apps/agent/**` as one unit, so its 245 internal relative imports stayed correct.
- [x] `components/{editor,explorer,git,search,terminal,theme,icons}` → `apps/ide/features/<name>/`; `components/layout` → `apps/ide/app/`; `components/modals` → `apps/ide/features/settings/`; `components/settings` (local-provider UI, still used by `OnboardingModal`) → `apps/ide/features/settings/local-providers/`.
- [x] `components/ui` → `kernel/ui`; `types` → `kernel/types`; `hooks` → `apps/ide/hooks`; `tools` → `apps/agent/tools`.
- [x] `store/`, `services/`, `lib/` split per-file by the measured ownership.

**The classification was wrong about 8 services, and the lint rule is what caught it.**
`skills`, `agent-execution-mode`, `mcp-tools`, `provider-catalog`, `checkpoint`, `codex`,
`atlascloud`, `agentrouter` all classified as KERNEL — because the *shared* `useSettingsStore`
imports them, so both product roots reached them transitively. Only `git` and `database` are
genuinely shared. They were re-homed to `apps/agent/services`.

**`src/bridge/` — a layer the plan missed.** Some code legitimately spans both products:
agent events → Monaco (`agent-ide-events`), agent file writes → editor (`agent-file-sync`,
`live-file-preview*`), and close → save both (`useWindowClose`). Forcing these into one app
would only have pushed the same coupling somewhere less honest, so they get a named home that
is explicitly exempt from the direction rule. **Keep it small**: anything there serving only
one product belongs in that product.

### 3.4b Services grouped by concern (owner's request) — **DONE**
`apps/agent/services` was 48 flat files — relocated bloat, not fixed bloat. Now:

| group | files | | group | files |
|---|---|---|---|---|
| providers | 13 | | artifacts | 6 |
| runtime | 12 | | tools | 6 |
| workspace | 6 | | skills | 4 |
| team | 3 | | threads / plans / browser / speech | 1 each |

Root keeps only `index.ts` (the barrel).
- [ ] **Not done:** full feature slicing (`features/<name>/{ui,model,api}` co-locating components + store + service). Services and stores are grouped; the 59 agent components are not yet sliced.

### 3.5 Split `useSettingsStore` (2110 lines) — the only non-mechanical step
Both apps import it; leaving it whole re-creates the coupling the whole plan removes.
- [ ] Inventory its slices and label each: **agent** (providers, models, tools, approvals, skills, MCP), **ide** (editor prefs, appearance), **kernel** (app-level, onboarding, profile).
- [ ] Split into three stores in their owning locations, preserving the SQLite `app_settings` persistence keys **exactly** — key drift silently resets user settings.
- [ ] Verify: `pnpm test`, then `pnpm tauri:dev` with an **existing** DB — confirm providers, theme, approvals and onboarding state all survive a restart. This is the one step that can lose user data; do not skip the runtime check.

### 3.6 Feature public APIs
- [ ] Give every feature an `index.ts` exporting only its public surface.
- [ ] Flip the Phase 2.3 boundary rule to `error` including the feature-internals clause.
- [ ] Verify: `pnpm lint` clean.

### 3.7 Phase 3 gate
- [ ] `pnpm build && pnpm test && pnpm lint` clean
- [ ] `pnpm tauri:dev` — full runtime sweep of both windows
- [ ] `cargo check` canary
- [ ] Update `CLAUDE.md` — the *File Structure* and *State Stores* sections describe the old tree and will be wrong.
- [ ] Update `.knowledge/knowledge.md` with the new layout + the dependency rule (2–4 lines).
- [ ] Commit + set **STATUS** to complete.

---

## Decisions & Traps

Append here as you go. These already cost investigation once — do not rediscover them.

- **T1 — the type-only edge.** `services/context-builder.ts:16` does `import type { AttachedFile } from "../components/chat/ChatInput"`. Type-only imports are erased at build, but they make the entire IDE chat subtree *look* load-bearing for the agent window. Cut this first or Phase 1.4 will seem impossible.
- **T2 — `canvas-sdk/` must not move.** `vite-canvas-plugin.ts:47` hardcodes `./src/canvas-sdk/` and `vitest.config.ts` shares the plugin. Moving it breaks live canvases in both build and test. Leave it at `src/canvas-sdk/` unless you update both.
- **T3 — `themes/*.json`** are imported by `store/useThemeStore.ts:9-11` and also resolved dynamically; `themes/index.ts` looks orphaned but is not.
- **T4 — the barrel-import bundle leak.** `TitleBar.tsx` importing from the `agent-window` barrel is why the IDE currently bundles the whole agent app. Worth fixing in 1.2 regardless of the rest of the plan.
- **T5 — settings persistence keys.** Phase 3.5 must not rename `app_settings` keys. Verify against a real DB at `%LOCALAPPDATA%/AuroraIDE/data/aurora.db`.
- **T6 — `manualChunks` in `vite.config.ts`** only matches `node_modules` paths (monaco/xterm/mermaid), so src moves do not affect it. The comment there warns that hand-splitting app chunks caused TDZ crashes in release builds — do not "improve" it during this work.
- **T7 — PowerShell `-replace` is case-insensitive.** A `ModelOption → SelectOption` rename also renamed the `modelOptions` variable. Use `-creplace` for identifier renames. Also: multi-line `-replace` patterns are regex, so `import {` silently matches nothing — use the Edit tool for those.
- **T8 — the agent window has no speech config of its own.** It reads engine/model/device/language straight from the shared `useSettingsStore`; `useAgentSpeech`'s docstring even said "anything configured in the IDE's Speech settings just works here too". Any future IDE deletion must check for this shape: feature in one window, its only configuration UI in the other.
- **DECIDED — speech:** agent-window only. Moved into Settings › Preferences › Voice input (see 1.5).
- **DECIDED — Fireworks:** erased. Dashboard + tab + `services/fireworks.ts` gone; provider plumbing kept.
- **T9 — side-effect imports are invisible to naive dependency scans.** `import 'x'` has no `from`. My orphan script matched only `from '…'` / `import('…')`, so `lib/monaco-setup.ts` looked dead while two editor components depend on it for Monaco registration. Any "is this file dead?" check must include bare `import '…'`. Related: ripgrep patterns ending in `$` silently fail on this repo's CRLF files — use `\s*$`.
- **T11 — three things a codemod cannot see.** All three broke silently, and only tests caught them:
  1. `vi.mock("…")` paths are string arguments, not imports. A stale mock does not error — it just **stops applying**, so the real module runs and the test fails somewhere unrelated. 9 mocks broke across the two moves. Fixed by making them `@/…` absolute so they stop being position-dependent.
  2. Hardcoded **filesystem paths**: `appearance-token-coverage.test.ts` does `readFileSync(\`${cwd}/src/agent-window/theme/agent-window.css\`)`.
  3. Doc comments naming paths (23 files pointed at `src/types/theme.ts`).
- **T12 — `git mv` fails with "Permission denied" when the destination directory already exists.** My mover pre-created parents, which made `git mv agent-window apps/agent` fail *while the import rewrite still ran* — leaving imports pointing at paths nothing had moved to. Worse, `Move-Item <dir> <existing-dir>` then **nests** (`apps/agent/store/store`). Always check the exit status of a move before rewriting anything that depends on it.
- **T13 — replacement order corrupts paths when a filename equals a group name.** Grouping `skills.ts` under `services/skills/` meant the prefix `@/apps/agent/services/skills` matched *inside* the already-correct `@/apps/agent/services/skills/prompt-assets`, producing `skills/skills/prompt-assets`. Use one single-pass regex with a lookup callback, never sequential `.Replace()` over overlapping keys.
- **T14 — I deleted a live test file.** `Remove-Item services -Recurse -Force` to clean up an "empty" folder took `theme-system-integration.test.ts` with it. Recovered via `git checkout`. Check `Get-ChildItem -Recurse -File` before any recursive delete, however empty a folder looks.
- **T10 — `no-restricted-imports` gotchas.** A `**/hooks/**` glob matches a module's *own* sibling `../hooks/…`, not just the foreign one — scope bans to the alias form (`@/hooks/**`). And `!negation` inside a `group` array did not exclude the intended path; list allowed/denied folders explicitly instead.
- **DECIDED — checkpoints:** stay in the IDE. `useCheckpointStore` is used by `GeneralSettingsTab`, and the toggle is workspace-scoped, which is an IDE concern. The Rust service stays shared.
- **DECIDED — `useThreadStore`:** does **not** die. It is live for the agent window (`team-agent-tools`, `useWindowClose`) and moves to `apps/agent` in Phase 3, along with `useChatStore`, `useContextStore`, `useTaskStore`, `useTeamStore`.
