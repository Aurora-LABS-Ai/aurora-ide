# Aurora Agent Team — Session Handoff (2026-07-02)

Continuation doc for the next session. Everything here was verified against source code
in this session; trust the code over any older doc. All work is **uncommitted** and needs
a **Rust rebuild** (`pnpm tauri:dev`) to be live — several complaints the user reported may
simply have been the old binary still running.

---

## 1. THE VISION (what the user is building — hold every decision to this)

The user is building an **agent-to-agent system** (their reference: https://github.com/a2aproject/a2a-rs —
the A2A protocol). The mental model:

- The **chat agent in the agent window IS the Lead/architect**. He has the full conversation
  context. Nothing else plays "lead". No fresh-context middleman may ever re-plan his work.
- He spawns a team by calling **`team_dispatch` — an ordinary tool, like file_read/file_write**.
  In that call **he defines the team himself**: each member's role, full instructions (task),
  and owned paths (scope). The instructions carry the conversation context naturally, because
  he writes them — no "context briefing" params, no prompt theatrics (user explicitly rejected
  "your memory of the conversation" style framing — keep all prompts plain).
- Members are **real peer agents**: own identity/role, own transcript, own scope. They talk in a
  **group chat** (WhatsApp-style bubbles), ask each other questions (`@mention` / `ask_owner`),
  ask the Lead for direction or scope access (`@lead` → Lead can GRANT paths).
- The **user is a viewer** of the team chat; they interact only with the Lead in the main chat.
- On completion, control shifts back to the Lead, who inspects the worker reports and talks to
  the user. **Never** auto-retrigger the work.
- A2A concept mapping (in-process today, protocol-shaped): role≈AgentCard, task≈Task,
  team chat≈Message, changed files≈Artifact, team_stream≈SSE, completion notifier≈push
  notification, member-waiting-on-@lead≈input-required (state not implemented yet — good candidate).

**User working rules:** no subagents for my work; explore source directly; docs only as reference;
keep everything SIMPLE — they get (rightly) angry at overengineering, fake/duplicated UI state,
dead tools, and any design where the Lead loses context.

## 2. ARCHITECTURE — HOW IT IS NOW (end-to-end)

Dispatch: agent window chat (Team mode = `teamEnabled` && mode != plan, `useAgentWindowSend.ts`)
→ model calls `team_dispatch {goal, members[{role,task,scope[]}], gate?}` (schema:
`src/tools/definitions/team-tools.ts`, **members REQUIRED**) → executor
`src/services/team-agent-tools.ts::runDispatch` (validates members, loop-guard: rejects identical
goal <3min after a done run, clamps to maxTeamSize-1, opens Team screen) →
`team-client.dispatchTeam` → Rust `commands/team.rs::team_dispatch` →
`dispatch.rs::TeamDispatcher::dispatch` (one-run-per-workspace guard, resets brain, spawns detached task).

Worker run (`dispatch.rs::run_team_lifecycle`):
1. **Assigned start** — `members` present → `runner.rs::run_assigned_planning`: convene exactly
   that roster, lock scopes, seed one board task per member (the full task text), and post the
   Lead's brief (goal + assignments) to the channel. There is **no separate planning model call**
   and no member standup round.
2. **Worker execution** — `build_runner.rs::run_build`: all scoped members concurrently (join_all,
   one tokio task), guarded tool loop each. Tool roster = the REAL Rust registry
   (`file_read, workspace_tree, grep, auroro_websearch` unrestricted; `file_write, file_edit,
   move_path (both ends guarded), delete_path, folder_create` scope-guarded) + lateral
   (`send_message, publish_contract, ask_owner, finish`). Aliases keep stale names working.
   `@lead` mention or `ask_owner(to="lead")` → `lead_answer` (plain coordinator prompt, sees
   board assignments + ownership map + recent chat) and can end with `GRANT: <paths>` → applied
   via `assign_scope` (non-overlap kept), directive stripped, human note appended.
3. Terminal lifecycle event `meta.terminal = done|failed` + `TeamRunStatus` registry. No automatic
   peer-review, test/build gate, or rework loop runs after the workers report back; the Lead decides
   any follow-up with the user.

Completion: `useAgentTeamNotifier.ts` (agent window) delivers ONE report prompt to the Lead —
exactly-once via Rust `TeamRunStatus.acknowledged` + `team_run_ack` command (acks at delivery;
poll skips acked). Prompts hard-forbid re-dispatch/auto-retry (this killed the retrigger loop).

Streaming/UI single-source rules (`useTeamStore.ts` + `TeamScreen.tsx`):
- `team_stream` frames → per-agent live drafts (ONLY live layer); persisted channel/transcript
  (ONLY settled layer). A message may NEVER render in both:
  - event clears its author's draft only when draft is `done` (mid-stream posts like ask_owner
    replies must not clobber a live draft);
  - `refresh()` reconciles done drafts vs snapshot ts (poll path); ghost drafts dropped >6min idle;
  - member transcript: pull-callback baseline (assistant-bubble count at draft start) →
    `clearDraft` the moment the persisted turn lands; immediate pull on draft end.
- Everything renders through the conversation's own `MessageBubble` (gained `label`/`labelColor`).
  Group chat = per-member color-tinted bubbles (`bubbleTint`, `.agw-team-bubble`), member name
  label colored; raw `@agent-id` mentions rewritten to clean names (`prettifyMentions`).
- Lead plan JSON + reviewer verdict JSON stream as THINKING frames (`TeamStreamer::text_as_thinking`)
  — machine output never streams into chat as a message.
- Tool cards: a working member's LAST bubble keeps `streaming` (pending tool = spinner, not
  "Didn't complete") and `MessageBubble` memo also compares resolved-result count (a result
  landing re-renders; was the "stuck failed until next tool call" bug).
- Sidebar: member names plain text + `agw-shimmer` while that member streams; NO status
  dots/words; "Team chat" row shows pulsing unread dot (seen-count updated only in click
  handlers); gate chips gone. Auto-scroll = shared `useAgentAutoScroll` (stick-to-bottom, release
  on scroll-up). Column shift on reasoning expand fixed via `scrollbar-gutter: stable both-edges`
  + `overflow-x: hidden` on `.agw-team-main`.

Brain on disk: `~/.aurora/projects/<projectId>/` (events.jsonl, team.json, scope-map.json,
board/tasks.json, agents/<id>/session.jsonl). Author `"lead"` in team chat = either the background
engine's lifecycle/brief/answers OR the chat agent via `team_message` — both are "the Lead".

## 3. FILES EDITED THIS SESSION

Frontend:
- `src/agent-window/components/team/TeamScreen.tsx` — largely rewritten (all of §2 UI).
- `src/agent-window/components/team/team-ui.ts` — +`prettifyMentions`; removed statusColor/authorInitials/GATE_TONE.
- `src/agent-window/components/MessageBubble.tsx` — +`label`/`labelColor`; memo compares resolved tool results.
- `src/store/useTeamStore.ts` — draft `startedAt`, done-only clear on events, `reconcileDrafts`,
  ghost cleanup, `clearDraft` action, poll 500→2000ms.
- `src/agent-window/hooks/useAgentTeamNotifier.ts` — durable ack, rewritten prompts, runId on Notice.
- `src/services/team-agent-tools.ts` — `requireMembers` validation, members pass-through,
  same-goal re-dispatch guard, integer members removed.
- `src/services/team-client.ts` — `ackRunStatus`, `dispatchTeam(+members)`.
- `src/types/team.ts` — `TeamRunStatus.acknowledged`, `DispatchMember`.
- `src/tools/definitions/team-tools.ts` — team_dispatch schema v2 (members array REQUIRED, plain wording).
- `src/agent-window/theme/agent-window.css` — team styles pruned/rebuilt (bubble, unread, shimmer
  names, both-edges gutter); dead msg/caret/think/gate CSS deleted.

Rust (`src-tauri/src/`):
- `agent_runtime/team/dispatch.rs` — `acknowledged` + `ack()`, `members` param, planning branch, tests.
- `agent_runtime/team/runner.rs` — `run_assigned_planning` (NEW); lead plan streams as thinking.
- `agent_runtime/team/build_runner.rs` — IC tool roster fixed (8/14 names were dead → real registry),
  `execute_move_path` dual guard, stale-name aliases, ~340 lines dead legacy tool methods deleted,
  `lead_answer` + `apply_lead_grants` (NEW), lead sees board assignments, prompt/tool-schema updates,
  tests updated + `lead_mention_answers_and_grants_scope_access` (NEW).
- `agent_runtime/team/bus.rs` — `TeamStreamer::text_as_thinking()`.
- `agent_runtime/team/integration_runner.rs` — reviewer streams as thinking.
- `agent_runtime/team/types.rs` — `DispatchMember` (NEW).
- `agent_runtime/team/mod.rs` — export `DispatchMember`.
- `commands/team.rs` — `team_run_ack` (NEW), `team_dispatch(+members)`.
- `lib.rs` — register `team_run_ack`.
- Pre-existing test-compile breakage fixed (not team-related): `allow_outside_workspace` /
  compaction fields added to test initializers in `commands/agent_v2.rs`, `agent_runtime/ipc.rs`,
  `tools/file_workspace_search/*`, `tools/shell_editor_todo/*`, `tools/permissions/permission_guard.rs`.

Also: `.knowledge/knowledge.md` — detailed per-fix log of this session (worth reading).

## 4. VERIFICATION STATE

- `cargo check --lib` clean; `cargo test --lib agent_runtime::team --no-run` compiles.
- **Test executables cannot LAUNCH on this machine** — exit 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND
  (DLL/onnxruntime-class env issue; copying build/debug DLLs into deps/ did not fix). Logic is
  compile-verified + code-reviewed only.
- `pnpm exec tsc -b` clean; eslint clean on all touched files (repo has 2 pre-existing
  set-state-in-effect errors in AgentComposer.tsx, not ours).
- Nothing runtime-tested by me. User must rebuild + run a real team.

## 5. OPEN ITEMS / NEXT CANDIDATES

1. **Delete the auto-planner fallback?** `run_planning` (fresh-context lead) violates the vision;
   only reachable if `members` is absent (executor makes it required). Removing it simplifies a lot.
   `desiredIcs` is now redundant too.
2. **`input-required` state** — a member waiting on `@lead` could surface in the roster (A2A concept).
3. **Unresolved user report: "the twist tool is not working."** Never identified (best guesses:
   @lead grant before rebuild, file_edit, move_path). Ask for the exact tool name shown in UI.
4. Watch: `file_edit`'s read-before-edit guard (read_tracker keyed by agent session) can reject an
   edit of a file the member wrote but never read — model recovers via error text, but verify in a
   real run.
5. Board task "titles" now carry full member instructions (long) — fine for count UI, revisit if a
   board view ships.
6. External A2A agents as team members (adapter where a roster entry's turn = a2a-client task call)
   — the long-term direction the user pointed at; do NOT put A2A inside the in-process engine.
