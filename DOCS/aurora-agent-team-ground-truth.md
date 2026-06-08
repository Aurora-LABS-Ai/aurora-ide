# Aurora Agent Team — Ground Truth

> **Status:** Vision locked, pre-implementation. This is the north-star document.
> **Read this first** before touching anything related to the multi-agent team feature.
> No code here on purpose — this defines *what* we are building, *why* it is different,
> *where* we touch the codebase, and *how* it is structured. Implementation plans
> (per phase) reference back to this file.

---

## 1. One-line vision

Aurora runs a **virtual engineering team** of AI agents that plan together, divide
ownership of the codebase by scope, build in parallel, coordinate at the boundaries,
review each other, and integrate — exactly like a real software team. The user talks to
**one lead AI**; behind it, a team of peer agents does the work and the user can watch them
collaborate live.

This is **not** sub-agents. See §3.

---

## 2. Why this makes Aurora different from every other AI IDE / CLI

Every agentic IDE and CLI today (Cursor, Windsurf, Claude Code, Copilot Workspace, Devin,
etc.) ships some flavor of the **same** pattern: a single agent loop, optionally spawning
**isolated sub-agents** that run blind, never talk to each other, and report back to a
parent that merges their output. It is always a **hierarchy of command**.

Aurora Agent Team is a **horizontal team of communicating peers** with a **shared,
persistent brain on disk**. The agents:

- **negotiate** who owns which part of the codebase (not assigned top-down),
- **talk to each other** while working (lateral coordination, not parent-mediated),
- **publish contracts** other agents depend on,
- **review each other's** work before integration,
- and do all of this around a **shared project workspace that persists** across sessions.

That combination — peer negotiation + lateral comms + on-disk shared brain + scope
ownership of one real repo + a visible team view — does not exist anywhere else. This is
the differentiator. The whole design must protect that, not water it down into "fancy
sub-agents."

---

## 3. Sub-agents vs. Aurora Agent Team (the line we must not cross)

| Sub-agents (everyone else) | Aurora Agent Team (us) |
|---|---|
| Parent **spawns** isolated workers | Lead **convenes** a team of peers |
| Workers **never talk to each other** | Agents **communicate laterally** through the team channel |
| Parent hands each a fixed task | Team **negotiates** scope ownership |
| Each runs blind, reports back, parent merges | They **coordinate while working**, like a standup |
| Ephemeral, stateless between runs | **Persistent shared brain** under `~/.aurora/projects/<projectId>/` |
| Hierarchy / command | **Collaboration** / colleagues |

**Litmus test for any design decision:** "Would this still be true if the agents could
not see or talk to each other?" If yes, we have drifted back into sub-agents. Stop.

---

## 4. Glossary (shared vocabulary)

- **Lead (a.k.a. Architect / PM agent):** the single AI the user chats with. Convenes the
  team, ratifies the scope split, resolves conflicts, runs the integration gate, and is the
  only agent that speaks to the user.
- **IC agent:** a peer "engineer" agent. Owns a scope, builds, coordinates with peers.
- **Team:** the Lead + N IC agents working one project.
- **Scope:** a set of folders/globs in the user's repo that exactly one agent owns
  (e.g. `app/`, `lib/`, `components/`). Ownership is non-overlapping by construction.
- **Shared brain / project workspace:** the on-disk directory
  `~/.aurora/projects/<projectId>/` holding the team's entire working context.
- **Team channel:** the append-only discussion log (the "standup") inside the workspace.
- **Blackboard / board:** the shared state — scope map, tasks, decisions, contracts.
- **Contract:** a shared interface (types, API shape, function signature) that an owner
  publishes so other agents can depend on it without guessing.
- **TeamBus:** the runtime mechanism that persists channel events and broadcasts them live
  to peers and to the UI.

---

## 5. Decisions locked (do not re-litigate without the user)

| Decision | Choice | Notes |
|---|---|---|
| Communication model | **Shared team channel + blackboard on disk** | Not direct DMs. Coherent, observable, resumable, auditable. The lateral arrows = posting/reading the shared space. |
| Filesystem strategy | **Scope ownership in one repo** | Each agent edits only its owned folders. Conflicts rare by construction. Not worktrees, not live file-locking. |
| Engine location | **Rust `agent_runtime`** | Native, fast, matches the in-progress TS→Rust migration. |
| Visibility | **Visible team view** | User watches the team channel, ownership map, and live status. This is a headline feature, not a debug panel. |
| Persistent home | **`~/.aurora/projects/<projectId>/`** | Mirrors the `.claude` memory-dir idea, but holds the team's whole brain, not just memories. |
| Agent count | **From user Settings; max 16, recommended 5; no fixed default** | The Lead picks the actual count per task, clamped to the user's max. |

---

## 6. The shared brain — `~/.aurora/projects/<projectId>/`

The single most important structural idea. A real team coordinates around **shared
artifacts** (board, channel, contracts, decision records), not by whispering. So the team's
truth lives on disk, project-scoped, and **every agent reads from and writes to it.**

```
~/.aurora/
└── projects/
    └── <projectId>/                 # one folder per opened user project
        ├── project.json             # repo path, detected stack, created-at, lead model
        ├── team.json                # roster: agent ids, roles, models, live status
        ├── scope-map.json           # OWNERSHIP: agent → owned folders/globs + owned contracts
        ├── channel/
        │   └── events.jsonl         # the team "standup": every message/decision, append-only
        ├── board/
        │   ├── tasks.json           # tickets: title, owner, status, depends-on
        │   ├── decisions.md         # ADRs the team agreed on (architecture choices)
        │   └── contracts/           # published shared interfaces other agents depend on
        ├── agents/
        │   └── <agentId>/
        │       ├── session.jsonl    # that agent's own turn loop (reuses session.rs format)
        │       └── notes.md         # private scratchpad
        └── integration/
            ├── reviews/             # peer-review threads (A reviews B's diff)
            └── status.json          # build / lint / test gate result before "done"
```

Properties this buys us:

- **Coherence** — one source of truth for who owns what and what was decided.
- **Observability** — the visible UI is just a renderer over `channel/` + `board/` + `scope-map.json`.
- **Resumability** — close Aurora, reopen, the team resumes from the workspace.
- **Auditability** — full replay of who said/decided/changed what.

**`projectId` resolution:** stable per opened workspace path (hash of the canonical repo
path, or reuse Aurora's existing workspace identity). One opened project → one workspace dir.

---

## 7. Communication model — the lateral arrows

Built in the Rust runtime as a **TeamBus**: `channel/events.jsonl` for persistence + an
in-memory broadcast so peers and the UI receive events live.

Agents coordinate through a small set of **team-level tools** (these tools *are* the arrows
in the diagram — they are how peers reach each other):

- **post to the team** — say something to the whole team (standup talk).
- **claim scope** — "I'll take `app/`" → updates `scope-map.json`.
- **ask a peer** — raise a boundary question to a specific owner and await the answer.
- **publish a contract** — pin a shared interface others may depend on.
- **review a peer** — record a verdict on another agent's work before integration.

Everything an agent does to the shared brain flows through the TeamBus so it is persisted
**and** streamed to the UI in one path. No side channels.

---

## 8. Scope ownership model

- The user's repo is edited **in place** (one repo), but **partitioned**: each agent owns a
  set of folders/globs, recorded in `scope-map.json`. **No two agents own the same path.**
- Ownership is **negotiated** in the planning standup, then **ratified by the Lead**. The
  Lead is the tiebreaker for overlaps.
- **Boundary handling:** when an agent needs something outside its scope (e.g. a type that
  lives in another agent's `lib/`), it must **not** reach in and edit it. It either reads a
  **published contract** or **asks the owner**. The owner makes the change in its own scope.
- **Contract changes** are broadcast to dependents so downstream agents adapt.
- This is what keeps a "one repo, parallel edits" model safe **without** file locking or
  worktrees: the partition prevents most collisions, and a write-guard enforces that an
  agent's file writes land only inside its owned scope.

---

## 9. Team lifecycle (the engineer-team flow)

1. **Convene** — the Lead reads the project + the user's request and decides team
   composition: how many IC agents (clamped to the user's max) and what roles
   (e.g. app-owner, lib/core-owner, components-owner).
2. **Planning standup** — agents discuss in the team channel and **negotiate scope
   ownership** → produce `scope-map.json` + `tasks.json`. The Lead ratifies; overlaps resolved.
3. **Parallel build** — each agent works **only inside its owned scope**. Writes outside
   scope are rejected.
4. **Continuous coordination** — boundary questions, contract publishing, and contract-change
   broadcasts happen through the channel while work proceeds.
5. **Integration & peer review** — agents review each other's diffs; the Lead runs the
   build/lint/test gate (`integration/status.json`) before anything is "done."
6. **Report** — the Lead summarizes up to the user. Throughout, the user sees the whole team
   working in the visible team view.

---

## 10. Roles & team composition

- **Lead / Architect** = the "AI" the user talks to. The only agent with the user's ear.
- **IC agents** = peers, **dynamically specialized per project** based on the repo's shape
  (a Next.js fullstack app → frontend/`app`, core/`lib`, UI/`components`; a different repo →
  different split). Roles are not hard-coded; the Lead proposes them at Convene time.
- **Count:** chosen by the Lead per task, **clamped to the user's configured maximum.**

---

## 11. Agent count & Settings

- New setting on the **Settings page**: **maximum team size**.
  - Hard ceiling: **16**.
  - Recommended value shown to the user: **5**.
  - **No fixed default team size** — the Lead decides the actual count per task, never
    exceeding the user's max.
- Lives with the other agent/approval preferences (the settings store + the settings DB
  table). The runtime reads this ceiling at Convene time.

---

## 12. Where we touch the codebase (impact map)

> This is a *map*, not a task list. Exact modules are confirmed per phase via impact analysis.

**Rust backend (`src-tauri/src/`)**
- `agent_runtime/` — **the core of the work.** New team-orchestration layer alongside the
  existing single-agent loop:
  - team session/lifecycle (convene, standup, integration) — sits above `conversation.rs`.
  - **TeamBus** — channel persistence + live broadcast (new module).
  - **project workspace store** — read/write `~/.aurora/projects/<projectId>/` (new module).
  - **scope guard** — enforce that an agent's file writes stay inside its owned scope.
  - `events.rs` — new event variants for team channel / roster / scope / review, streamed to UI.
  - `session.rs` — reused per-agent for each IC's own turn log.
- `commands/` — new Tauri commands: start/stop a team, fetch team state, subscribe to the
  team channel, settings for max team size. (Sibling to `agent_v2.rs`.)
- `db/` — settings persistence for max team size; optionally an index of known project
  workspaces. The team's working brain lives in the `~/.aurora` files, **not** SQLite.
- `agent_safety/` — extend path validation to honor scope ownership.

**Frontend (`src/`)**
- `services/` — a team client that subscribes to the Rust team events (sibling to
  `agent-runtime-client.ts`); maps roster/channel/scope/status into stores.
- `store/` — a new team store (roster, channel, scope map, tasks, integration status); a new
  field in the settings store for max team size.
- `components/` — the **visible team view** (team channel, ownership map, per-agent live
  status, peer-review threads); a Settings control for max team size.
- `types/` — shared types for team/roster/scope/channel/contract events.

**Docs**
- This file is the ground truth. Per-phase implementation plans live beside it.

---

## 13. Visible team view (UI goals)

- Show the **roster**: each agent, its role, its model, live status (planning / building /
  reviewing / blocked / done).
- Show the **ownership map**: which folders each agent owns (the `app/ lib/ components/` split).
- Show the **team channel** live: the standup discussion, scope claims, boundary questions,
  contract publishes, review verdicts — streamed as it happens.
- Show **integration status**: the build/lint/test gate.
- The user still chats with the **Lead**; the team view is the window into the team behind it.
- All user-facing strings in this view go through the `surface` standard (clear, specific,
  next-step-oriented; no builder/debug/AI-referencing text).

---

## 14. Concurrency, safety & conflict handling

- **Primary defense = the scope partition.** Non-overlapping ownership means agents rarely
  touch the same file.
- **Secondary defense = the scope write-guard.** A write outside an agent's owned scope is
  rejected; the agent must go through a contract or a peer ask.
- **Cross-boundary changes** are mediated by contracts + asks, never by reaching into another
  scope.
- **Integration gate** (build/lint/test) is the final correctness check before "done."
- **Resource sanity:** even at the 16 ceiling, the runtime must bound concurrent model calls
  and tool execution so the team does not overwhelm the machine or the provider.

---

## 15. Persistence & resumability

- A project's team brain persists in `~/.aurora/projects/<projectId>/` across sessions.
- Reopening a project rehydrates roster, scope map, channel, board, and integration status
  from disk — the team continues rather than starting over.
- The channel and per-agent sessions are append-only logs, so state is reconstructable by
  replay (same philosophy as the existing JSONL session persistence).

---

## 16. Phased roadmap

- **Phase 1 — Foundation (shared brain + TeamBus).** The `~/.aurora/projects/<projectId>/`
  store and the TeamBus (channel persistence + live broadcast) in Rust. No agents yet — just
  the brain and the pipes, plus the settings ceiling.
- **Phase 2 — Team loop & scope negotiation.** Convene → planning standup → negotiated
  `scope-map.json`. One real multi-agent planning round, no code-writing yet.
- **Phase 3 — Parallel build with scope enforcement.** Agents edit within owned scopes;
  boundary asks + published contracts; the scope write-guard.
- **Phase 4 — Integration & peer review gate.** Cross-agent review + build/lint/test gate.
- **Phase 5 — Visible team UI.** The team channel, ownership map, live per-agent status, and
  review threads.

Each phase is independently demoable and ends in a working state.

---

## 17. Open questions (resolve as we reach them)

- **Lead = a distinct agent, or a mode of the existing chat agent?** (Leaning: a role on top
  of the existing loop so the current chat UX stays intact.)
- **How fine-grained is scope?** Folder-level to start; file/glob-level later if needed.
- **What happens when the user edits a file an agent owns mid-run?** (Likely: the agent
  re-reads before writing; treat the human as the ultimate owner.)
- **Checkpoint/undo semantics for a team run** — one checkpoint per team turn vs. per agent.
- **How much of the channel goes into each agent's model context** vs. stays on the board
  (token budget management for the team).

---

## 18. Non-goals (for now)

- Not git-worktree isolation, not live file-locking (we chose scope ownership).
- Not direct agent-to-agent private DMs (we chose the shared channel).
- Not a fixed org chart of hard-coded roles (the Lead composes the team per project).
- Not running the team brain in SQLite (it lives in the `~/.aurora` files).

---

## 19. Done looks like

A user opens a Next.js fullstack project, asks Aurora to build a feature, and watches a team
of (say) 5 agents hold a standup, split `app/` / `lib/` / `components/` between themselves,
build their parts in parallel while asking each other boundary questions, review each other's
diffs, pass the build gate, and report back through the Lead — with the entire collaboration
visible and persisted under `~/.aurora/projects/<projectId>/`. No other AI IDE or CLI in the
world does this.
