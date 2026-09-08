# Idle background-process report — handoff

State on 2026-09-08. Everything below is uncommitted on branch `tools-reshape`.

## Resolution (2026-09-08, later the same day)

All three problems below are closed. The current record is the top entry of
`.knowledge/knowledge.md`; the rest of this file is kept as the investigation it was.

- **Problem 1** — the `collect_text` fix is live-verified in session `66a9bf5d` (the model
  answered "has finished with exit code 0" on both process turns). The same gap was closed on
  the Cursor wire (`cursor/history.rs::text_of`, where an empty active message was sent as a
  RESUME) and in the API view.
- **Problem 2** — the turn had no boundary. Both the live path and the reload path now emit a
  `role: "process"` row carrying the summary; `buildTurns` opens a fresh AURORA turn from it
  with the beat as its first line (the same `ProcessBeat` component and CSS as the checklist
  beats), and the reply streams beneath it. Rewind ordinals count `process` rows as the
  user-role messages they are on disk; Retry is hidden on a process-started turn.
- **Problem 3** — the merge above plus a module-level event counter that reset on every hot
  reload. The counter lives on `globalThis` now; `dedupeRowIds` stays as the guardrail.

**Not yet watched in a running app.** The next `tauri:dev` pass should run a background script,
wait for it to end while idle, and confirm the beat appears under a new AURORA label as the reply
streams, then switch threads away and back to confirm the reopened view is identical.

---

**No fix is proposed in this document.** It records what was changed, what is proven to work,
what is proven to be broken, and what was tried. Two problems are still open at the bottom.

---

## What this was supposed to do

When a background process ends while the conversation is **idle**, start a turn so the agent
finds out. Before this, that ending was dropped: the runtime's queued-message slot only drains
at a tool-result boundary, so with no turn in flight nothing drained it, and the agent's last
memory of a long run stayed "still running".

Mid-turn endings already worked and were left alone.

---

## Files touched

### The feature

| File | What changed |
|---|---|
| `src/apps/agent/hooks/useIdleProcessReport.ts` | **NEW.** The drain. Watches for idle + a parked ending and calls `send`. |
| `src/apps/agent/hooks/useIdleProcessReport.test.tsx` | **NEW.** 7 tests for the drain conditions. |
| `src/apps/agent/hooks/useBackgroundProcessWatch.ts` | Split into two paths: mid-turn → queue as before; idle → park it (`parkIdleReport`, `takeIdleReport`, `IDLE_REPORT_MAX_AGE_MS`). Removed the `!chat.liveTurns[threadId]` early return. `useProcessEndings` no longer requires a thread. |
| `src/apps/agent/components/conversation/ConversationPane.tsx` | Mounts `useIdleProcessReport` next to `useCliTask`. |
| `src/apps/agent/hooks/conversation/useAgentWindowSend.ts` | `SendOptions.origin` + `.summary`. A `"process"` send appends no user bubble and seeds the beat into the streaming assistant message's timeline. |
| `src/apps/agent/services/runtime/agent-service.ts` | Passes origin/summary through to the runtime client. |
| `src/apps/agent/services/runtime/agent-service.types.ts` | Type for the above. |
| `src/apps/agent/services/runtime/agent-prompt.ts` | `AgentPromptContext.userMessageOrigin` / `.userMessageSummary`. Does not affect the system prompt. |
| `src/apps/agent/services/runtime/agent-runtime-client.ts` | `userMessageOrigin` / `userMessageSummary` on the request and the chat input. |
| `src-tauri/src/agent_runtime/ipc.rs` | `AgentChatRequest.user_message_origin` (defaults to `User`) and `.user_message_summary`. |
| `src-tauri/src/agent_runtime/types.rs` | `ConversationMessage::user_process_event(summary, detail, ts)` — user role, single `ProcessEvent` block. |
| `src-tauri/src/commands/agent_v2/turn_driver.rs` | Builds the leading message as `ProcessEvent` when the origin is `Process`. Skips image ingestion and auto-title for it. |
| `src-tauri/src/commands/agent_v2/tests.rs` | Struct-literal fields for the two new request fields. |

### Touched while chasing the breakage

| File | What changed |
|---|---|
| `src/apps/agent/components/conversation/timeline.ts` | `dedupeRowIds` at the end of `buildRows`: duplicate render keys get a suffix instead of dropping rows, and dev logs the duplicated id + row type. |
| `src/apps/agent/components/conversation/timeline.test.ts` | 3 tests for the above. |
| `src-tauri/src/api/provider_kernel_adapter.rs` | `collect_text` now returns the `ProcessEvent` detail; test asserts both wires carry it. |

### Unrelated fixes sitting in the same working tree

`src-tauri/src/commands/mod.rs` and `src/kernel/lib/ipc/tauri.ts` carry the failed-stop change
(`CommandStopOutcome`). The MCP server lane, the mermaid canvas fix and the background-dock row
fix are also uncommitted in this tree and are independent of everything above.

---

## What is proven to work

Read from the session JSONL under
`%LOCALAPPDATA%\AuroraIDE\sessions\`, not from the UI.

**The turn starts and persists correctly.** Session `6c258ed6-447e-4637-b8b8-5a90a03c36f0`:

```
5  assistant ['text']            09:42:47   "It's running…"
6  user      ['process_event']   09:43:15   "Finished Count seconds 1 to 30 · exit 0"
7  assistant ['thinking','text'] 09:43:19
```

Session `ed32184f-effd-472d-8c9b-5bb9ab499a35` went further — line 8 `process_event`, line 9
assistant with two `tool_use` blocks, line 10 tool results.

So: the ending is detected, a turn is started with nothing running, the message is written to
disk in the right shape (user role, single `process_event` block, checklist context attached),
and the model replies.

---

## Problem 1 — the model was never told (root cause found)

The model's own thinking on line 7 of `6c258ed6`:

> "No user content — just an empty message. The background process likely finished by now."

It was not told the process ended. It guessed, and happened to guess right.

`collect_text` in `src-tauri/src/api/provider_kernel_adapter.rs` is the block flattener every
OpenAI-compatible provider goes through. It ended:

```rust
ContentBlock::Text { text } => Some(text.clone()),
ContentBlock::Image { .. } => b.image_as_text(),
_ => None,                       // ProcessEvent fell in here
```

Grep of `ProcessEvent` handling per adapter at the time:

```
openai_compat.rs            0
anthropic.rs                0
deepseek.rs                 0
provider_kernel_adapter.rs  1   (Anthropic body only)
responses.rs                2
```

The message therefore went on the wire with empty content. The model used was
`modal:canyaman6879--ep-glm-5-3-server.us-west.modal.direct`, which uses the OpenAI path.

**This predates the feature.** Mid-turn process beats — including "the user stopped this
process" — have been invisible to the model on these providers for as long as the block has
existed. The feature only made it total, because the ending became the entire message rather
than one block among several.

Changed in `collect_text`; Rust test
`a_process_ending_reaches_the_openai_wire_too` passes.

---

## Problem 2 — the turn does not render live (cause found)

**Symptom:** the turn runs and is on disk, but nothing appears in the transcript while it
happens. Switching to another thread and back renders it correctly, as its own AURORA turn.

### The measurement that settled it

Run "create 3 task then tell me created", then "now run the script in background again and mark
task 1 complete then reply me only done". Result:

- `Created 3 tasks` and `Finished Task 1` **rendered live**. Checklist beats are fine.
- The process turn that followed did not appear until the thread was switched away and back.

So the live-view update path is not at fault and this is not older than the feature. The
difference is structural, and it is the one thing a process turn does that no other turn does.

### The cause

`buildTurns` (`timeline.ts`) merges **consecutive assistant messages** into one turn.

- **Live:** the feature appends no user-role row (`useAgentWindowSend.ts`, the
  `options?.origin !== "process"` branch). The process turn's assistant seed is therefore
  consecutive with the previous turn's last assistant message, the two merge, and the new rows
  are folded into a bubble that is already settled and scrolled past. Nothing appears as a new
  turn.
- **On reload:** `threads.rs:175` (`MessageRole::User`) emits a `role: "user"` row for the
  process message — `content` empty, `timeline: None`, because `collect_text_blocks` reads text
  blocks only and the message holds a single `process_event`. That empty user row breaks the
  assistant merge run, so the reply becomes its own turn.

The live view and the reloaded view therefore disagree by construction: one has a boundary
between the previous turn and the process turn, the other does not.

### Also unverified

Whether that empty user row is itself visible on reload as a blank user bubble.

---

## Problem 3 — duplicate React keys (contained, cause not found)

Console, repeating every ~2s during a broken turn:

```
Encountered two children with the same key, `ev9`
Encountered two children with the same key, `ev10`
    at AssistantTurn (MessageBubble.tsx:903)
```

A consecutive pair, which is the signature of one two-event message reaching the render list
twice. `buildTurns` merges consecutive assistant messages and concatenates their event lists,
so an id that is unique inside its own message need not be unique inside the turn.

`dedupeRowIds` now suffixes duplicates instead of letting React drop rows, and logs the id and
row type in dev. **The duplication itself was never traced.** It is still unknown which path
produces the same event twice.

Confound worth knowing: `nextEventId()` is a plain module counter (`let seq = 0`) with no HMR
guard. Any hot reload that re-evaluates `timeline.ts` resets it to zero while the open
conversation still holds `ev1…evN`, which manufactures duplicate keys on its own. Source files
were being edited while the app was running, so the observed collisions cannot be attributed to
the feature with confidence.

---

## What was tried, and what it produced

1. **Beat as its own assistant message.** Broke the transcript with duplicate keys. The
   optimistic beat message and the streaming assistant seed are consecutive, so `buildTurns`
   merged them; the beat's id came from `genId()` (random) while streamed events use
   `nextEventId()`.
2. **Beat seeded into the streaming assistant message's timeline** using `nextEventId()`.
   Duplicate keys still reported afterwards.
3. **`sendRef` instead of `send` in the drain's effect deps.** The send pipeline is rebuilt
   every render, so the watch had been tearing down and resubscribing on every streaming token.
   Fixed; not related to either open problem.
4. **`dedupeRowIds` in `buildRows`.** Contains problem 3; does not explain it.
5. **`collect_text`.** Fixed problem 1.
6. **Session JSONL + `aurora.log` read directly.** This is what produced the evidence above.
   The runtime does not log normal turns at INFO in this build, so the log contained only
   `ui.console` React warnings for the window in question.
7. **A checklist turn run as a control.** This is what identified problem 2's cause. Checklist
   beats render live; the process turn does not. The variable is the missing user-role row.

---

## Verification status

- Frontend: 1204 tests / 119 files passing. TypeScript and ESLint clean.
- Rust: `cargo check --lib` clean; `agent_v2` suite 70 passing;
  `a_process_ending_reaches_the_openai_wire_too` passing.
- Production frontend build succeeds.
- **None of this has been observed working in a running app.** Problem 1's fix in particular has
  not been seen on a live turn — it was found by reading a model's thinking after the fact.

### Where the evidence is

- Sessions: `%LOCALAPPDATA%\AuroraIDE\sessions\<thread_id>.jsonl` (+ `.meta.json`).
  The two runs referenced here are `6c258ed6-447e-4637-b8b8-5a90a03c36f0` and
  `ed32184f-effd-472d-8c9b-5bb9ab499a35`.
- Log: `%LOCALAPPDATA%\AuroraIDE\logs\aurora.log`.
- Test rig: `E:\VOID-EDITOR\aurora-testing\.aurora\00-harness.md`. Its previous contents were
  deleted and are backed up at
  `%LOCALAPPDATA%\Temp\claude\E--VOID-EDITOR-Aurora-Agent-IDE\6c09ede3-57ff-41d6-9675-b91fc6d538f0\scratchpad\aurora-testing-backup\`.
