/**
 * Aurora Agent Team — shared types (Phase 1 foundation).
 *
 * These mirror the Rust serde shapes in
 * `src-tauri/src/agent_runtime/team/types.rs` 1:1 (camelCase on the wire).
 * They are the typed projection of the on-disk shared brain documents
 * under `~/.aurora/projects/<projectId>/` — see
 * `DOCS/aurora-agent-team-ground-truth.md` §6.
 *
 * Phase 1 only ships the foundation (the brain + the TeamBus pipe); the
 * roster/scope/board are read but not yet populated by a running team.
 * The visible team view (§13) is a pure renderer over `TeamProjectState`
 * plus the live `team_event` stream.
 */

/** Live status of one agent in the visible team view (§13). */
export type AgentStatus =
  | "idle"
  | "planning"
  | "building"
  | "reviewing"
  | "blocked"
  | "done";

/** Kind of a team-channel event — these are the lateral arrows (§7). */
export type ChannelEventKind =
  | "message"
  | "scope_claim"
  | "boundary_question"
  | "contract_published"
  | "review_verdict"
  | "system";

/** Status of one ticket on the board. */
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

/**
 * Team-level run state, distinct from a single agent's {@link AgentStatus}.
 */
export type TeamPhase =
  | "forming"
  | "planning"
  | "building"
  | "integrating"
  | "done"
  | "disbanded";

/** Legacy result of one manual integration gate (build / lint / test). */
export type GateStatus = "unknown" | "pending" | "passed" | "failed";

/** `project.json` — identity of one project's team brain. */
export interface ProjectMeta {
  projectId: string;
  repoPath: string;
  stack?: string;
  createdAt: string;
  leadModel?: string;
  schemaVersion: number;
}

/** One roster entry in `team.json`. */
export interface AgentRecord {
  id: string;
  role: string;
  model?: string;
  status: AgentStatus;
}

/** `team.json` — the roster (Lead + IC agents). */
export interface TeamManifest {
  projectId: string;
  /** Where the whole team is in its lifecycle (§9). */
  phase: TeamPhase;
  agents: AgentRecord[];
  updatedAt: string;
  schemaVersion: number;
}

/** One agent's ownership claim in `scope-map.json`. */
export interface ScopeAssignment {
  agentId: string;
  ownedPaths: string[];
  ownedContracts: string[];
}

/** `scope-map.json` — the non-overlapping ownership partition (§8). */
export interface ScopeMap {
  assignments: ScopeAssignment[];
  updatedAt: string;
}

/** Where a team run was dispatched from. */
export type TeamOriginSurface = string;

/** Optional origin metadata captured when `team_dispatch` starts a run. */
export interface TeamDispatchOrigin {
  originThreadId?: string;
  originSurface?: TeamOriginSurface;
}

/**
 * Terminal lifecycle metadata attached to run lifecycle channel events.
 *
 * `terminal` is the outcome marker the Rust dispatcher stamps on the run's
 * final event. It emits the canonical `"done"` / `"failed"`, but the notifiers
 * also tolerate `"success"`/`"failure"`/`"complete(d)"`/`true` so the seam can
 * never silently regress to relying on emoji-prefix body parsing again.
 */
export interface TeamLifecycleMeta extends TeamDispatchOrigin {
  terminal?:
    | boolean
    | "done"
    | "failed"
    | "complete"
    | "completed"
    | "success"
    | "failure";
  runId?: string;
}

export type TeamEventMeta = TeamLifecycleMeta & Record<string, unknown>;

/** One line of `channel/events.jsonl` — the append-only standup. */
export interface ChannelEvent {
  id: string;
  ts: string;
  author: string;
  kind: ChannelEventKind;
  body: string;
  meta?: TeamEventMeta | null;
}

/** One ticket on the board. */
export interface TaskRecord {
  id: string;
  title: string;
  owner?: string;
  status: TaskStatus;
  dependsOn: string[];
}

/** `board/tasks.json` — the team's ticket board. */
export interface BoardTasks {
  tasks: TaskRecord[];
  updatedAt: string;
}

/** `integration/status.json` — legacy manual gate snapshot. */
export interface IntegrationStatus {
  build: GateStatus;
  lint: GateStatus;
  test: GateStatus;
  updatedAt: string;
}

/** One read of the entire brain, returned by `team_init` / `team_get_state`. */
export interface TeamProjectState {
  projectId: string;
  initialized: boolean;
  project?: ProjectMeta;
  team: TeamManifest;
  scopeMap: ScopeMap;
  tasks: BoardTasks;
  integration: IntegrationStatus;
  /** Tail of the channel (most-recent events, oldest-first). */
  channel: ChannelEvent[];
}

/** Payload of the live `team_event` broadcast (one persisted channel event). */
export interface TeamEventPayload extends TeamLifecycleMeta {
  projectId: string;
  event: ChannelEvent;
}

/** Which live stream a {@link TeamStreamDelta} frame belongs to. */
export type TeamStreamKind = "text" | "thinking";

/** Frame type of a {@link TeamStreamDelta}. */
export type TeamStreamEvent = "start" | "delta" | "end";

/**
 * One live token frame from the `team_stream` broadcast.
 *
 * **Ephemeral — never persisted.** Mirrors Rust `TeamStreamDelta`. These carry
 * an agent's tokens as the model emits them so the Team view streams in real
 * time (parity with the normal chat composer). The authoritative content still
 * lands afterward as a posted {@link ChannelEvent} (planning / standup / review)
 * or the agent's transcript (build); the UI drops the live draft once it does.
 */
export interface TeamStreamDelta {
  projectId: string;
  /** The agent producing the tokens: an IC id or `"lead"`. */
  agentId: string;
  /** Team stream bucket, usually `"building"` for worker tool loops. */
  phase: string;
  kind: TeamStreamKind;
  event: TeamStreamEvent;
  /** The token chunk (empty for `start`/`end` boundary frames). */
  delta: string;
  runId?: string;
  seq: number;
}

/** Lifecycle of the background dispatch run. Mirrors Rust `RunLifecycle`. */
export type RunLifecycle = "idle" | "running" | "done" | "failed";

/**
 * Live status of the background team run (the team is its own engine, §17).
 * Mirrors Rust `TeamRunStatus`. The Lead is dispatched once via `team_dispatch`
 * and stays free; this status is injected into the Lead's context every
 * message so it always knows whether the team is still working, finished, or
 * failed — the "pull" re-engage model.
 */
export interface TeamRunStatus {
  state: RunLifecycle;
  /** While `running`: "starting" | "working". */
  phase?: string;
  /** The goal the run was dispatched with. */
  goal?: string;
  /** Set when `state === "failed"`. */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  originThreadId?: string;
  originSurface?: TeamOriginSurface;
  /**
   * True once the completion notifier delivered this run's terminal report to
   * the Lead. Owned by the Rust dispatcher (`team_run_ack`) so delivery is
   * exactly-once across window reloads — the notifier never re-reports (and so
   * never re-triggers) a run that was already acknowledged.
   */
  acknowledged?: boolean;
}

// ─── Lead control inputs (Phase 2a) ───────────────────────────────────

/** One IC the Lead wants to field. Mirrors Rust `AgentSpec`. */
export interface AgentSpec {
  role: string;
  model?: string;
}

/**
 * One member as the dispatching agent defines it in `team_dispatch`:
 * role, instructions, owned paths. Mirrors Rust `DispatchMember`.
 */
export interface DispatchMember {
  role: string;
  /** Full instructions for this member — what to build and how. */
  task: string;
  /** Folders/files/globs this member owns (its writable scope). */
  scope: string[];
}

/** What the Lead decides at Convene time. Mirrors Rust `ConveneRequest`. */
export interface ConveneRequest {
  leadModel?: string;
  stack?: string;
  agents: AgentSpec[];
}

// ─── Scope write-guard (Phase 3) ──────────────────────────────────────

/**
 * Outcome of a guarded write check. Mirrors Rust `ScopeDecision`
 * (`scope_guard.rs`). The build runner consults this before letting an IC's
 * file write land; the team view renders the reason for a refused edit (§8).
 */
export interface ScopeDecision {
  /** Whether the write is permitted. */
  allowed: boolean;
  /** Normalized repo-relative path the decision was made on. */
  path: string;
  /** Why — set for both allow and deny. */
  reason: string;
  /** When denied because a peer owns the path, the owning agent id. */
  blockingOwner?: string;
}

// ─── Legacy manual integration helpers ────────────────────────────────

/**
 * A peer-review verdict on another agent's work before integration
 * (§7 "review a peer", §9 step 5). Mirrors Rust `ReviewVerdict`.
 */
export type ReviewVerdict = "approve" | "changes_requested";

/**
 * Legacy build/lint/test gate commands. Each is
 * optional — an omitted command leaves that gate `unknown` (skipped).
 * Mirrors Rust `GateCommands`.
 */
export interface GateCommands {
  build?: string;
  lint?: string;
  test?: string;
}

// ─── Per-agent transcript (the team window's individual agent view) ────

/** One tool call an agent made — what it's "calling". Mirrors Rust `AgentToolCall`. */
export interface AgentToolCall {
  name: string;
  /** JSON-stringified arguments (clamped). */
  input: string;
}

/** One tool result an agent received — what it "got back". Mirrors `AgentToolResult`. */
export interface AgentToolResult {
  content: string;
  isError: boolean;
}

/**
 * One turn in an agent's transcript: what it said/thought, what it called, and
 * what it got back. Rendered in the team window when you select an agent.
 * Mirrors Rust `AgentTurn`.
 */
export interface AgentTurn {
  /** "assistant" | "user" | "tool" | "system". */
  role: string;
  text: string;
  thinking: string;
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
}
