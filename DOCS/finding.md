# Aurora Chat / Aurora Build boundary findings

**Opened:** 2026-09-27  
**Scope:** prompts, conversation ownership, composer context, tool rosters, and nearby UI.  
**Status:** Code fixes complete. Automated checks passed; live Tauri/provider switch scenarios remain to be checked.

Aurora Chat is a conversation surface with its own conversation store and no project or native file/shell tools. Aurora Build owns project conversations, project rules, file and browser context, and Agent/Plan modes. A rule or turn that belongs to one surface must not silently run on the other.

## Progress ledger

| ID | Finding | Priority | Status | Verification required |
| --- | --- | --- | --- | --- |
| F-01 | Build global instructions enter Chat | Critical | Fixed in code | Composed Chat prompt excludes an active Build profile; Build still includes it. |
| F-02 | Docked conversation uses the window's surface instead of its owner's | Critical | Fixed in code | Both switch directions retain the correct prompt, tools, store, and project scope; mismatched runtime requests are rejected. |
| F-03 | Queued Chat message can inject Build project rules and skills | High | Fixed in code | Queued Chat directives cannot resolve against a Build project. |
| F-04 | Chat receives Build open-file paths | High | Fixed in code | A Chat send after Build file tabs are opened has no `<open_files>` block. |
| F-05 | Chat receives a stale Build browser selection | High | Fixed in code | Browser picks are neither shown nor sent by a Chat composer. |
| F-06 | Chat slash picker offers project directives that ordinary sends drop | Medium | Fixed in code | Chat lists only actionable directives and preserves the intended explicit global-skill path. |
| F-07 | Chat skill reference names a loader unavailable in Chat | Medium | Fixed in code | A Chat-attached global skill can be fully loaded, or no loader is promised. |
| F-08 | Chapters instruction can reach Chat without a chapter tool | Medium | Fixed in code | Chat prompt and registry agree with the preference. |
| F-09 | Chat inherits Build-oriented optional-tool prose | Medium | Fixed in code | Chat prompt describes only its callable core and optional tools. |
| F-10 | TypeScript and Rust disagree on `generate_image` being Chat-only | Low | Fixed in code | Both policy lists and a parity test agree. |
| F-11 | Chat command center exposes project and Build-mode controls | Low | Fixed in code | Chat offers only relevant navigation/actions; Build retains project controls. |
| F-12 | Late thread-list requests can repopulate the other surface | High | Fixed in code | A delayed Chat response or failure cannot replace Build's list after a switch. |
| F-13 | Chat file picker creates unusable project-path attachments | High | Fixed in code | Chat accepts image attachments and rejects other paths; stale Build file pills do not send. |
| P-01 | All connected MCP tools are shared with Chat | Policy | Pending decision | Confirm the desired per-surface MCP policy before changing it. |

**Status meaning:** **Fixed in code** means the implementation passed the automated checks below. It does not claim a live Tauri/provider reproduction. **Pending decision** means no code policy change was made.

## Findings and evidence

### F-01. Global instructions enter Chat

The active set is selected and inserted after the Chat base prompt is chosen. The insertion is not gated by `chatMode`: [prompt composer](../src/apps/agent/services/runtime/agent-prompt.ts#L539), [instruction selection and insertion](../src/apps/agent/services/runtime/agent-prompt.ts#L606), [wrapper claiming every workspace and task](../src/apps/agent/services/runtime/agent-prompt.ts#L393). [AgentService](../src/apps/agent/services/runtime/agent-service.ts#L290) forwards the composed prompt. The [settings UI](../src/apps/agent/settings/AgentGeneralSettings.tsx#L164) says the profile is sent with every chat. The [prompt test mock](../src/apps/agent/services/runtime/agent-prompt.test.ts#L25) always returns an empty active profile, so existing Chat prompt tests do not exercise this boundary.

**Impact:** Aurora Chat can follow or disclose Aurora Build standing instructions. **Target:** the existing global-instruction profiles apply to Build (including its IDE agent path), with no implicit Chat profile.

### F-02. Docked conversations can cross surfaces

[Surface switching](../src/apps/agent/store/conversation/useAgentChatStore.ts#L520) swaps the main conversation list but leaves dock tabs. The [dock filter](../src/apps/agent/components/shell/RightDock.tsx#L391) admits every `chat` tab in either surface. [Dock-tab creation](../src/apps/agent/store/workspace/useAgentWorkspaceStore.ts#L204) stores the thread ID and project root, but no owning surface. The [docked panel](../src/apps/agent/components/shell/RightDock.tsx#L349) remains sendable. The [send pipeline](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1128) derives mode from the window's current surface, then [uses a nullable target root with a window-project fallback](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1166). Rust [routes an existing ID to its existing store](../src-tauri/src/commands/agent_v2/registry.rs#L257) without comparing that store's surface to the requested mode; the [turn driver](../src-tauri/src/commands/agent_v2/turn_driver.rs#L261) proceeds with that mode and session.

**Impact:** A Build thread can receive Chat prompting/tools, and a Chat thread can receive Build prompting/tools and a Build project root. This is a code-confirmed conditional path, not a live reproduction. **Target:** a conversation's owning surface is authoritative at both the UI and Rust runtime boundaries. Older persisted dock tabs need safe handling.

### F-03. Queued Chat directives use the remembered Build project

For a mid-turn queued message, the [steering root](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1019) comes from `target?.projectRoot ?? chat.projectRoot`, without Chat scoping. The path then [loads project rules](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1025) and [resolves skills](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1034) into the queued model text. Ordinary sends instead use [effectiveProjectRoot](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1166).

**Impact:** A Chat `/rule` or project skill can enter `<steering_context>` even where an ordinary Chat send would exclude it. **Target:** queued and ordinary sends use the same conversation-owned surface and project scope.

### F-04. Build file-tab paths enter Chat context

The [dock hides Build file tabs](../src/apps/agent/components/shell/RightDock.tsx#L391) rather than removing them from the shared store. The [send pipeline reads that store](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1592), builds [an `<open_files>` block](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L463), and includes it in [the message context](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1608). Rust's [Chat request scoping](../src-tauri/src/agent_runtime/ipc.rs#L102) clears the workspace path, not the already-built `ide_context`.

**Impact:** After a Build-to-Chat switch in the same window session, Chat can receive Build file paths. **Target:** project-file context is formed only for Build turns.

### F-05. Browser selections cross into Chat

The [selection store](../src/apps/agent/store/composer/useAgentSelectionStore.ts#L24) is window-wide. [Surface switching](../src/apps/agent/store/conversation/useAgentChatStore.ts#L520) does not clear it. The [composer mirrors picks into pills](../src/apps/agent/components/composer/AgentComposer.tsx#L476), and the [send pipeline](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1090) consumes them without a surface check, including [queued sends](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L982). [Selection serialization](../src/apps/agent/store/composer/useAgentSelectionStore.ts#L64) includes visible text and clipped outer HTML.

**Impact:** A pick made in Build's browser can ride into a later Chat message. **Target:** a Chat composer does not display or attach Build inspector picks; returning to Build should have deliberate selection behavior.

### F-06. Chat shows project directives that it cannot apply normally

The main [composer project root](../src/apps/agent/components/composer/AgentComposer.tsx#L383) still refers to the remembered Build project in Chat. Its [slash catalog](../src/apps/agent/components/composer/AgentComposer.tsx#L681) loads [project rules and skills](../src/apps/agent/adapters/prompt-commands.ts#L181). An ordinary Chat turn has [no effective project root](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L1166), and [rule loading returns nothing without one](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts#L378). [Skill resolution](../src/apps/agent/services/skills/skills.ts#L622) likewise sees no workspace skill, although the directive chip can still appear in the transcript.

**Impact:** The picker promises an action, then silently omits it; F-03 makes queued behavior inconsistent. **Target:** Chat's picker lists only directives that Chat can use.

### F-07. Explicit Chat skills cannot fetch their full body

The [prompt formatter](../src/apps/agent/services/runtime/agent-prompt.ts#L367) advertises `aurora_skill_load` for an explicit skill, and [Chat includes explicit skill references](../src/apps/agent/services/runtime/agent-prompt.ts#L631). `aurora_skill_load` is absent from the [Chat frontend roster](../src/apps/agent/services/runtime/agent-execution-mode.ts#L136) and [Rust roster](../src-tauri/src/commands/agent_v2/tool_policy.rs#L272).

**Impact:** An explicitly attached global skill is represented by a short preview while the model is told to call a tool it lacks. **Target:** preserve explicit global skills only with a working full-body path and no project-skill crossover.

### F-08. Chapters prompt/tool mismatch

The [prompt composer](../src/apps/agent/services/runtime/agent-prompt.ts#L599) adds chapter instructions whenever the preference is on. Rust [answers Chat availability before the chapter preference arm](../src-tauri/src/commands/agent_v2/tool_policy.rs#L223), and `chapter` is absent from [Chat's allow-list](../src-tauri/src/commands/agent_v2/tool_policy.rs#L272). The [existing Rust chapter test](../src-tauri/src/commands/agent_v2/tests.rs#L777) covers Agent/Plan, not Chat.

**Impact:** Chat can be asked to call a tool it has not been given. **Target:** one preference controls both the Chat prompt and roster, or the instruction is omitted in Chat.

### F-09. Optional-tool prose describes Build abilities in Chat

The [Build-oriented optional-tool text](../src/apps/agent/services/runtime/agent-prompt.ts#L257) names files, shell, tasks, skills and browser tools. It is [inserted unconditionally](../src/apps/agent/services/runtime/agent-prompt.ts#L604) after Chat's separate base prompt, despite [Chat's narrow tool roster](../src/apps/agent/services/runtime/agent-execution-mode.ts#L136).

**Impact:** The full Chat prompt contradicts its own capability boundary. **Target:** surface-specific tool guidance, tested on the composed prompt rather than the base constant alone.

### F-10. Tool-policy copies have drifted

The [TypeScript `CHAT_ONLY_TOOLS`](../src/apps/agent/services/runtime/agent-execution-mode.ts#L173) omits `generate_image`; [Rust's corresponding list](../src-tauri/src/commands/agent_v2/tool_policy.rs#L324) includes it. Rust blocks this native tool in Build today. The TypeScript helper can still answer incorrectly for a Build-mode check. The earlier regression is recorded in [.knowledge/lesson.md](../.knowledge/lesson.md#L1739).

**Impact:** The two policy representations disagree and future call paths can reintroduce the Build tool mismatch. **Target:** align both copies and test the shared invariant.

### F-11. Chat command center exposes Build project controls

The [command center](../src/apps/agent/components/modals/AgentCommandCenter.tsx#L130) uses the remembered project name on “New chat” and offers [Open project folder](../src/apps/agent/components/modals/AgentCommandCenter.tsx#L142), [Build's mode toggle](../src/apps/agent/components/modals/AgentCommandCenter.tsx#L246), and [project rows](../src/apps/agent/components/modals/AgentCommandCenter.tsx#L264) without gating them on `chatSurface`. The [project setter](../src/apps/agent/store/conversation/useAgentChatStore.ts#L448) changes the remembered project while leaving Chat as the active surface.

**Impact:** Chat presents project controls that do not match its projectless conversation model. **Target:** hide or clearly route these controls to Build, while keeping Build's navigation intact.

### F-12. Late thread-list requests can replace the current surface's list

[Surface switching](../src/apps/agent/store/conversation/useAgentChatStore.ts#L524) clears the rail and awaits `refreshThreads`. The original [thread-list request](../src/apps/agent/store/conversation/useAgentChatStore.ts#L485) assigned its result or error after the await without checking whether the user had switched again. A slow Chat request could therefore write Chat rows into a Build rail, or show an irrelevant error after Build had loaded. The [dock-open action](../src/apps/agent/components/shell/LeftRail.tsx#L706) uses rows from that rail.

**Impact:** Rapid switches can expose a conversation row under the wrong surface. **Target:** discard results and errors when their captured surface or project is no longer current, and avoid resuming the stale surface's thread.

### F-13. Chat's file action attaches paths it cannot use

The [Chat plus-menu file action](../src/apps/agent/components/composer/AgentComposer.tsx) offered “Files & images”. For non-image picks or drops, [the path handler](../src/apps/agent/components/composer/AgentComposer.tsx) created an `@path` pill. [Serialization](../src/apps/agent/lib/composer/serialize-editor.ts) and [submit](../src/apps/agent/components/composer/AgentComposer.tsx) sent that path and a file chip, although [Chat's tool allow-list](../src/apps/agent/services/runtime/agent-execution-mode.ts) has no file reader. Existing Build pills could also survive a surface switch.

**Impact:** Chat promises a file attachment it cannot read and can disclose a Build path. **Target:** allow image attachments in Chat, explain rejected document/folder paths, and omit old Build path/terminal references from Chat messages and chips.

## Implementation record

| Finding | Changed files and outcome |
| --- | --- |
| F-01 | [Prompt composition](../src/apps/agent/services/runtime/agent-prompt.ts) gates active instruction profiles on Build. [Settings copy](../src/apps/agent/settings/AgentGeneralSettings.tsx) names Build and the IDE agent. [Prompt test](../src/apps/agent/services/runtime/agent-prompt.test.ts) uses a nonempty active profile. |
| F-02 | [Dock tab type](../src/apps/agent/types.ts), [workspace store](../src/apps/agent/store/workspace/useAgentWorkspaceStore.ts), [rail opener](../src/apps/agent/components/shell/LeftRail.tsx), and [dock filter](../src/apps/agent/components/shell/RightDock.tsx) preserve and enforce the owner; legacy untagged chat tabs require reopening. [Rust registry](../src-tauri/src/commands/agent_v2/registry.rs) rejects wrong-surface turns. [Turn driver](../src-tauri/src/commands/agent_v2/turn_driver.rs) and [session store](../src-tauri/src/agent_runtime/session_store.rs) clear a stale Chat workspace path in memory and metadata. [Store tests](../src/apps/agent/store/workspace/useAgentWorkspaceStore.test.ts) and [Rust tests](../src-tauri/src/commands/agent_v2/tests.rs) cover ownership and contaminated metadata. |
| F-03 | [Send pipeline](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts) uses the live turn's mode/root for queued directives; [command policy](../src/apps/agent/adapters/prompt-commands.ts) removes stale project directives in Chat. [Policy tests](../src/apps/agent/adapters/prompt-commands.test.ts) cover both allowed and rejected origins. |
| F-04 | [Send pipeline](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts) forms the open-file block only for Build. Existing [open-file tests](../src/apps/agent/hooks/conversation/open-files-context.test.ts) still pass. |
| F-05 | [Composer](../src/apps/agent/components/composer/AgentComposer.tsx) hides Build browser picks in Chat; [send pipeline](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts) omits them on ordinary and queued Chat sends. Picks remain in the Build selection store and reappear on return to Build. |
| F-06 | [Composer](../src/apps/agent/components/composer/AgentComposer.tsx) loads Chat commands without a Build project and filters stale project rules/skills. [Command policy](../src/apps/agent/adapters/prompt-commands.ts) uses skill provenance, with [tests](../src/apps/agent/adapters/prompt-commands.test.ts). |
| F-07 | [Frontend roster](../src/apps/agent/services/runtime/agent-execution-mode.ts) and [Rust roster](../src-tauri/src/commands/agent_v2/tool_policy.rs) allow skill search/load in Chat. The [skill executor](../src/apps/agent/services/tools/aurora-tools.ts) receives a null Chat workspace. [Tool-policy tests](../src/apps/agent/services/runtime/agent-execution-mode.test.ts) and [Rust tests](../src-tauri/src/commands/agent_v2/tests.rs) cover the roster. |
| F-08 | [Rust policy](../src-tauri/src/commands/agent_v2/tool_policy.rs) admits `chapter` in Chat only when enabled, matching [prompt composition](../src/apps/agent/services/runtime/agent-prompt.ts). [Rust chapter test](../src-tauri/src/commands/agent_v2/tests.rs) now includes Chat. |
| F-09 | [Prompt composition](../src/apps/agent/services/runtime/agent-prompt.ts) has Chat-specific optional-tool guidance; [prompt test](../src/apps/agent/services/runtime/agent-prompt.test.ts) checks for the absence of Build-only prose. |
| F-10 | [TypeScript tool policy](../src/apps/agent/services/runtime/agent-execution-mode.ts) now matches [Rust](../src-tauri/src/commands/agent_v2/tool_policy.rs) on `generate_image`; [TypeScript test](../src/apps/agent/services/runtime/agent-execution-mode.test.ts) checks Build exclusion. |
| F-11 | [Command center](../src/apps/agent/components/modals/AgentCommandCenter.tsx) removes project/mode actions and project rows in Chat and adjusts the remaining labels. |
| F-12 | [Thread store](../src/apps/agent/store/conversation/useAgentChatStore.ts) discards late results/errors after a surface or project switch. [Tests](../src/apps/agent/store/conversation/useAgentChatStore.test.ts) cover both late success and failure. |
| F-13 | [Composer](../src/apps/agent/components/composer/AgentComposer.tsx) offers Chat image picks, rejects non-image paths and removes old Build pills. [Serializer](../src/apps/agent/lib/composer/serialize-editor.ts) and [send pipeline](../src/apps/agent/hooks/conversation/useAgentWindowSend.ts) omit stale path/terminal references even before effects run. [Serializer test](../src/apps/agent/lib/composer/serialize-editor.test.ts) covers Build versus Chat output. |

### Verification on 2026-09-27

- `pnpm exec vitest run` on the prompt, mode, command, workspace, thread, open-file, skill and composer-serializer tests: **8 files, 118 tests passed**. Tests that import the Tauri-backed send service logged failed IPC calls in the browser-like test environment; those calls were outside the assertions.
- `cargo test --lib commands::agent_v2::tests`: 70 passed, 1 existing manual benchmark ignored. This includes wrong-surface rejection, contaminated Chat metadata cleanup, and the Chat chapter gate.
- `pnpm build`: passed. `pnpm exec tsc --noEmit -p tsconfig.app.json`: passed after the last TypeScript edits. Targeted ESLint: 0 errors, with one pre-existing `RightDock.tsx:196` hook-dependency warning.
- `cargo fmt --check` was attempted but fails on thousands of pre-existing formatting differences across unrelated Rust files. No broad reformat was applied.
- Live Tauri/provider Chat → Build → Chat turns, docked sends, file-drop interaction and visual checks were not run in this code-only session. Those acceptance scenarios remain the release QA step; their absence is not evidence of a live failure.

### P-01. MCP access is an explicit product-policy decision

[Connected enabled servers](../src/apps/agent/services/tools/mcp-tools.ts#L106) feed the tool list, [AgentService](../src/apps/agent/services/runtime/agent-service.ts#L593) passes them through mode filtering, and both [TypeScript](../src/apps/agent/services/runtime/agent-execution-mode.ts#L158) and [Rust](../src-tauri/src/commands/agent_v2/tool_policy.rs#L303) admit the `mcp_` prefix in Chat. The [Chat base prompt](../src/apps/agent/services/runtime/agent-execution-mode.ts#L417) states connected tools are an exception to the no-machine-access rule.

**Impact:** A connected server may expose file or write operations to Chat. This is intentional in the current code; it is not classified as a code defect without a product decision. **Decision:** keep all connected servers shared, make connectivity surface-specific, or require an explicit Chat grant.

## Existing boundaries and baseline

- The normal send path uses [effectiveProjectRoot](../src/apps/agent/services/runtime/agent-execution-mode.ts#L113), and Rust [clears a Chat request's workspace path](../src-tauri/src/agent_runtime/ipc.rs#L102). These guards do not sanitize the system prompt, message context, queued message, or an existing docked conversation's owner.
- Rust [filters native Chat tools by allow-list](../src-tauri/src/commands/agent_v2/tool_policy.rs#L223), so this report does not claim ordinary Chat has native file or shell tools.
- On 2026-09-27, `pnpm exec vitest run src/apps/agent/services/runtime/agent-prompt.test.ts src/apps/agent/services/runtime/agent-execution-mode.test.ts src/apps/agent/hooks/conversation/open-files-context.test.ts src/apps/agent/store/conversation/useAgentChatStore.test.ts` passed: **4 files, 82 tests**. The browser-like test environment logged unavailable Tauri IPC calls. No live Tauri/provider reproduction was performed during the initial audit.

## Repair sequence

1. Make the conversation owner authoritative at the dock, frontend send, and Rust runtime boundaries (F-02). This prevents later fixes from relying only on UI visibility.
2. Scope prompt instructions and tool guidance by surface (F-01, F-07 through F-09).
3. Scope ordinary and queued composer context by conversation surface (F-03 through F-06).
4. Align the command center and tool-policy copies (F-10, F-11).
5. Add focused regression checks, run frontend and Rust checks, and perform live Chat/Build switch scenarios where available. Update this ledger with results before calling an item fixed.

The MCP policy (P-01) stays open until the owner chooses it; no implementation should silently narrow or widen that access as part of these fixes.
