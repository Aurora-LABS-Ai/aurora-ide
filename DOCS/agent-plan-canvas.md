# Plan Canvas + Todo Unification

> Status: **implemented end to end** (2026-07-28). 841 Rust tests + 182 frontend
> tests green, tsc and eslint clean. **Not yet runtime-verified** — no live
> Plan-mode run has exercised it.
> Owner: agent-window / agent_runtime
> Resume point for any agent picking this up.

## What shipped

| Layer | Files |
|---|---|
| Model / parse / store | `src-tauri/src/plans/{model,document,store}.rs` |
| Tools | `src-tauri/src/tools/plan/{plan_write,plan_read,plan_step_update}.rs` |
| Todo rebuild | `src-tauri/src/tools/shell_editor_todo/{todo_store,todo_write,todo_read,todo_update}.rs` |
| Commands | `src-tauri/src/commands/plans.rs` |
| Event | `agent_plan_changed` via `IdeEventSink::emit_plan_changed` |
| Frontend state | `src/apps/agent/services/plans/agent-plans.ts`, `src/apps/agent/store/artifacts/useAgentPlanStore.ts` |
| UI | `src/apps/agent/components/canvas/PlanCanvas.tsx`, wired into `CanvasPanel.tsx` |
| Mode + prompts | `src/apps/agent/services/runtime/agent-execution-mode.ts` |

### Known gaps

- `plan_save_body` and `plan_set_status` commands exist and are covered by
  tests, but no Canvas UI edits prose yet — the panel is read-plus-status-only.
- Team mode inherits Agent mode's plan behaviour; team members have not been
  given per-member plan awareness.

## What this is

Plan mode gets a real **document surface**. The agent authors a plan file that *is*
the task list; the Canvas renders it live; the agent marks each step
`in_progress` / `done` / `failed` as it works, and the in-progress section
animates in the Canvas.

Todos — today a fire-and-forget list the agent cannot read back — are rebuilt so
the agent can actually follow them, and when a workspace has both a plan and
todos they become **one system**, never two rival lists.

## Why the plan cannot be an ordinary Canvas artifact

`src-tauri/src/commands/artifacts.rs` stores artifacts as **append-only immutable
versions** (`v1`, `v2`, …) in a `<thread>.artifacts.json` sidecar. If a status
flip rewrote the document, a 10-step plan would churn 20+ versions and fight the
Canvas version picker.

So the plan is its own record type with a hard split:

- **Prose is a document** — authored once, revised rarely.
- **Step status is structured state** — flipped constantly, cheaply.

Marking a step `in_progress` rewrites only frontmatter. The body is never touched.

## Storage

`<workspace>/.aurora/plans/<nnn>-<slug>.aurora.md` — a real file in the user's
repo, hand-editable, with the custom extension visible.

> **gitignore note:** this repo already ignores `.aurora/` (line 48) for the
> semantic index, so plans are *not* committed by default. To version plans, add
> `!.aurora/plans/` after it. `*.aurora` (line 49) does **not** match
> `foo.aurora.md` — it ends in `.md`.

### File format

YAML frontmatter (`serde_yaml`, already a dependency) + markdown body:

```markdown
---
auroraPlan: 1
id: plan_7f3a91
title: API Building
status: active            # draft | active | done | failed | abandoned
createdAt: 2026-07-28T18:30:00Z
updatedAt: 2026-07-28T19:04:12Z
threadId: thr_abc123
steps:
  - id: s1
    title: Scaffold routes
    status: done
    startedAt: 2026-07-28T18:32:00Z
    endedAt: 2026-07-28T18:41:00Z
    paths: [src/api/routes/**]
  - id: s2
    title: Wire auth middleware
    status: in_progress
    startedAt: 2026-07-28T18:41:00Z
    runId: run_9911         # liveness key — see below
  - id: s3
    title: Integration tests
    status: pending
---

## 1. Scaffold routes {#s1}

Rationale, files, acceptance criteria — free markdown.

## 2. Wire auth middleware {#s2}
...
```

Body sections bind to frontmatter steps via the `{#id}` anchor; missing anchors
fall back to document order.

## The liveness rule (a spinner must never lie)

An in-progress step carries `runId`. The Canvas spins a section **iff**:

```
step.status === "in_progress" && step.runId === <currently live run for this thread>
```

Otherwise it renders **Interrupted** with a Resume affordance. This is what makes
the "user stops" and "user returns hours later" cases correct rather than a
spinner animating forever over a dead runtime.

Reconciliation on load does **not** rewrite the file — a stale `in_progress` is
still legitimately resumable, so it stays `in_progress` on disk and is only
*presented* as interrupted.

## Tools

Authoring and status marking are deliberately split by mode.

| Tool | Mode | Purpose |
|---|---|---|
| `plan_write` | **Plan only** | Create/revise the plan document. Reconciles steps by id, preserving status of survivors. |
| `plan_read` | all | Full plan + `cursor` (active step, next step, done/total). |
| `plan_step_update` | **Agent / Team** | Flip one step's status. Stamps `runId`. Returns the full step list. |

`plan_write` is the one permitted write in Plan mode — the mode is otherwise
strictly read-only (`WRITE_TOOL_NAMES` in `src/apps/agent/services/runtime/agent-execution-mode.ts`
blocks even `todo_write`). Status marking must work during *execution*, so
`plan_step_update` is Agent/Team only. Authoring ≠ marking.

## Todo rebuild

Today's `todo_write` (now the single `todo` tool in `src-tauri/src/tools/shell_editor_todo/todo.rs`) is
structurally unable to be followed:

1. **No read-back.** There is no `todo_read`; the result is `{success, count, inProgressCount}`.
2. **No durable state.** The tool emits a Tauri event and forgets. `useAgentTaskStore` is "memory-only and live". After a stop or reload the list is gone from the agent's side.
3. **Full replace every call.** Marking step 3 done requires resending all 10 todos verbatim; after compaction the agent re-invents them.
4. **No stable ids.** Todos are positional, so a re-send can re-map statuses onto the wrong task.

The fix:

- **Durable** per-thread sidecar (`<thread>.todos.json`, mirroring the artifacts pattern).
- **Stable ids**, assigned on write and returned to the agent.
- **`todo_read`** — the list plus an explicit cursor: what's active, what's next, counts.
- **`todo_update`** — incremental `{id, status}`; no full resend to flip one item.
- **Every result echoes the materialized list**, so the agent never depends on context surviving compaction.

## Unification: one system, one cursor

When a plan is active for the thread's workspace:

- `todo_read` returns the **plan steps** projected as todos — exactly one answer to "where am I".
- `todo_write` does **not** create a rival list. It reconciles onto plan steps and the result directs the agent to `plan_step_update`, echoing the current steps.
- Plan step ids **are** the todo ids. One id space.
- The Task panel and composer-rail chip render plan steps.

With no plan present, todos work standalone — with all the durability and
read-back above.

## Edge cases and how each is handled

| Case | Handling |
|---|---|
| User stops mid-run | `runId` goes stale → section renders Interrupted + Resume, not a spinner. |
| Returns hours later / app restart | File on disk is source of truth; nothing is memory-only. |
| User switches workspace | Plan store keyed by workspace root; Canvas shows the current workspace's plan. Switching back re-reads from disk. |
| User hand-edits the plan file | `notify` fs watcher → reload → Canvas updates. Parse failure shows a clear error rather than crashing. |
| Agent and user write at once | Process-wide lock + atomic replace, same pattern as `ARTIFACT_LOCK` / `replace_file` in `artifacts.rs`. |
| Agent marks two steps in_progress | Soft-clamp to one (first wins, rest demoted), with a warning in the result — same contract as today's `todo_write`. |
| Plan revised mid-execution | `plan_write` reconciles by step id; surviving steps keep their status, new steps start `pending`. |
| Step never marked done | Surfaced as drift in the UI; enforcement is **soft** (prompt + visible drift), not a hard gate. |

## Enforcement: soft

The system prompt requires marking a step `in_progress` before working it and
`done`/`failed` after. The UI surfaces drift (writes with no active step, skipped
steps). No hard scope or ordering gate — a mis-scoped step must never hard-block
real work.

## Build order

1. Rust `plans/` module — model, parse/serialize, store, fs watch.
2. Rust tools — `plan_write`, `plan_read`, `plan_step_update`; registry wiring.
3. Todo rebuild — durable store, ids, `todo_read`, `todo_update`, echo results.
4. Unification layer — plan-active projection.
5. Tauri commands + events for the frontend.
6. `useAgentPlanStore` + liveness wiring.
7. Canvas plan renderer — sections, status chips, spinner, interrupted state, write-enabled source mode.
8. Plan-mode tool carve-out + prompt sections in `agent-execution-mode.ts`.
9. CSS, tests, verification.
