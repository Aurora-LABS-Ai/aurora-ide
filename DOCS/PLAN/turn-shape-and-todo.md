# The request shape, and the `todo` round trip

**Hand this file to the next session and start here.**

This is the core-correctness work: what Aurora sends the model on every
request, and what it costs when that shape is wrong. It is separate from the
feature plan in [`implementation-progress.md`](./implementation-progress.md).
**Aurora Chat is the main body of work and is paused**, four phases done and
Phase 5 part-built. Come back to it after this.

Last updated: 2026-09-04, evening. Green at that point: **2,237 Rust tests,
962 agent-window frontend tests**, `tsc --noEmit` clean, ESLint clean on every
touched file. **Not yet run live** — see "How to verify" at the end.

---

## What shipped on 2026-09-04 (evening)

The request shape now follows the rule all three vendored references agree on
(Claude Code, OpenCode, pi): **write a fact into the request once, at the
place whose cost matches how often it changes, and never rebuild it per
request.**

| what | where | changes |
|---|---|---|
| behaviour, `<env>`, `<machine_tools>`, project rules, skill catalogue, mode | system prompt | per turn at most |
| `<repo_map>` (Build) / `<memory>` (Chat) | head of the first user message | never in a conversation |
| open files, selection, slash-attached rule, MCP directive, `<checklist>` at send time | `aurora_context` field on the user's own message, folded after the words for the API | never, once written |
| "your checklist has gone untouched" | inside one tool result, after 10 assistant messages of silence | never, once written |

**There is no state block any more.** `<aurora_runtime_state>`, the standalone
tail message, the freeze into tool results, the unchanged guard, the dedup
guard (`newest_message_answers_todo`), the live reminder and its complete-list
variant (`task_reminder_block`), `RuntimeConfig::ide_context`, and
`ApiRequest::volatile_tail_messages` are all gone. A request never ends on a
message that is not already in the transcript exactly as sent, so the
Anthropic breakpoint sits on the last message.

### Why the old shape had to go, not be patched

Alvan ran `scripts/aurora_dual_api_stream_simulator.py` and read
`aurora_sim_logs/conversation.md`: request 1 carried **two user messages**,
the real one and a state-only one. And the state was not "open files plus
checklist" — the frontend's `ide_context` held the whole `<project_rules>`
block (up to 10,000 characters), and the skill catalogue, and
the whole thing was re-frozen into a tool result every time the checklist
toggled in or out of it. In a four-request loop the project rules appeared
three times.

### Where each piece lives in code

- `agent_runtime/types.rs` — `ConversationMessage::aurora_context`, saved with
  the message, `serde(default)` so old JSONL loads.
- `commands/agent_v2/turn_driver.rs` — copies the request's `ideContext` onto
  the user message. The IPC field keeps its name; its meaning is now "what
  belongs to this message".
- `agent_runtime/conversation/context_injection.rs` — the whole story, in its
  module doc. `request_system_prompt` (prompt + `<machine_tools>`),
  `user_message_context` (frontend part + `<checklist>`), `fold_message_context`
  (the API view), `checklist_block`, `stale_checklist_reminder` +
  `checklist_silence` (Claude Code's 10/10 cadence, stops at a compaction
  marker).
- `agent_runtime/conversation/mod.rs` — attaches the context before appending
  the user message; folds it after `compacted_view`; builds the system prompt
  once per iteration.
- `agent_runtime/conversation/tool_exec.rs` — writes the stale reminder into
  the last result of a batch when it is due, only where `todo` is registered.
- `agent_runtime/conversation/compaction.rs` — folds the head view the same way
  and uses the same system prompt, so the cache-sharing summary keeps the prefix.
- `src/apps/agent/services/runtime/agent-prompt.ts` — `projectRules` on
  `AgentPromptContext`; the skill catalogue and
  `required_skills` are composed here from the resolved skills; "Context Aurora
  Injects" describes `<aurora_context>` and the rare reminder.
- `src/apps/agent/hooks/conversation/useAgentWindowSend.ts` — `ideContext` is
  open files + selection + slash rule + MCP directive, nothing else; rules go
  every turn (they are in the cached prompt now, not first-message-only).
- `src/apps/agent/services/runtime/agent-service.ts` — no
  `<execution_mode_context>` block; the mode section in the system prompt is
  the one home and says so ("Aurora sets this mode from the window's actual
  state"). `formatAgentExecutionModeRuntimeContext` is deleted.

### The prompt opening

`BASE_AGENT_SYSTEM_PROMPT` names Aurora Agent once, describes the dock in the
same sentence, and no longer says what does not exist. The "Core Identity"
heading is gone. Pinned by `states who it is once, and says what the window
has` in `agent-prompt.test.ts`.

---

## The `todo` round trip: measured, and the runtime rule was NOT built

The earlier version of this file proposed: *if an assistant message's only
tool calls are `todo`, run them and end the turn.* Before building it I replayed
every todo-only assistant message on disk, simulating the list from the call
arguments:

| shape of the todo-only message | count | what the model did next |
|---|---|---|
| list still open, no text | 471 | real tools, 447 times |
| list still open, with text | 270 | real tools, 252 times |
| closes the last task, no text | 98 | a long answer, 78 times |
| closes the last task, with text | 26 | a long answer, 18 times |

The rule as written would have cut off 270 turns mid-work (the model narrating
before its next step). Even the narrow version — only when the list is complete
— loses the answer in 18 of 26 cases, because the text beside the close is
usually "All four tasks are done." and the real answer follows. None of the
three references ends a turn on a tool call. **Not built**, by agreement.

What was built instead, for the 741 checklist-only messages followed by real
tools: one prompt sentence, *"A checklist update never travels alone. Put it in
the same message as the tool calls for the next step."* It competes with no
other rule. The end-of-work shape (close, then answer in its own message) is
unchanged and still costs one round trip, as it does in Claude Code.

The measurement script is in the session scratchpad as `todo_shapes.py`; it
walks `%LOCALAPPDATA%\AuroraIDE\sessions\*.jsonl`.

### What NOT to try — already failed

- **"Close the last task in the same message as your final tool call."** Collides
  with `todo`'s "never mark something completed that is not". The prompt test
  bans the sentence.
- **Round-trip economics in the prompt.** Same test, same ban.
- **Ending the turn on a todo-only message.** See the table above.
- **A per-request state block, under any name.** It has to live somewhere, and
  every somewhere was worse than not building it.

---

## How to verify

Run `scripts/aurora_dual_api_stream_simulator.py` and read
`aurora_sim_logs/conversation.md`. Expected, per request:

- **One** user message per human message. No `[2] user` after `[1] user`.
- `<machine_tools>` at the END of the system prompt, after `<env>`.
- `<project_rules>` and `<agent_skills>` in the system prompt, not in any message.
- The user message ends with `<aurora_context>` holding `<open_files>` and a
  `<checklist>` once a list exists — identical bytes on every later request.
- Tool results carry the tool's output and nothing else, until the tenth
  assistant message without a `todo` call, which carries one
  `<aurora_task_reminder>`.
- Cache hit rate on a six-round turn should be at or above the 99.6% measured
  on 2026-09-04 morning, with fewer tokens in the window because nothing is
  copied.

Then read a session's reasoning in
`%LOCALAPPDATA%\AuroraIDE\sessions\<id>.jsonl`: the model should open on the
task, never on what a message is.

---

## Where everything else is

- [`implementation-progress.md`](./implementation-progress.md) — **the main
  work.** Aurora Chat: Phases 0–4 done, Phase 5 part-built. Paused for this.
- [`chat-mode-design.md`](./chat-mode-design.md) — the decisions behind it.
- `.knowledge/knowledge.md` and `.knowledge/lesson.md` — the full account of
  2026-09-04, morning and evening.
