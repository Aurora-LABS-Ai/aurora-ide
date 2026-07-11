/**
 * Aurora Agent Team client (Phase 1 foundation).
 *
 * Thin frontend wrapper over the Rust team commands in
 * `src-tauri/src/commands/team.rs` and the live `team_event` broadcast
 * emitted by the TeamBus. This is the team-side sibling of
 * `agent-runtime-client.ts`: it scaffolds/reads a project's shared brain
 * (`~/.aurora/projects/<projectId>/`) and subscribes to the standup
 * stream so a store/UI can render the team live.
 *
 * Phase 1 deliberately ships no UI — this is the bridge the Phase 5
 * visible team view (ground truth §13) will consume. It carries no
 * state of its own beyond the optional live subscription.
 */
import { auroraInvoke, auroraListen, isAuroraRuntimeAvailable } from "../lib/runtime";
import type { ProviderConfigSnapshot } from "./agent-runtime-client";
import type {
  AgentSpec,
  AgentStatus,
  AgentTurn,
  ChannelEvent,
  ChannelEventKind,
  ConveneRequest,
  DispatchMember,
  GateCommands,
  GateStatus,
  ReviewVerdict,
  ScopeDecision,
  TaskStatus,
  TeamDispatchOrigin,
  TeamEventPayload,
  TeamProjectState,
  TeamRunStatus,
  TeamStreamDelta,
} from "../types/team";

/** Tauri channel the TeamBus broadcasts each persisted channel event on. */
export const TEAM_EVENT_CHANNEL = "team_event";

/** Tauri channel the TeamBus broadcasts ephemeral live token frames on. */
export const TEAM_STREAM_CHANNEL = "team_stream";

const requireRuntime = (op: string): void => {
  if (!isAuroraRuntimeAvailable()) {
    throw new Error(`Aurora Agent Team requires an Aurora runtime (${op})`);
  }
};

/**
 * Resolve the stable `projectId` for a repo path without touching disk.
 * Lets a store key its team state before the brain is initialized.
 */
export async function resolveProjectId(repoPath: string): Promise<string> {
  requireRuntime("resolveProjectId");
  return auroraInvoke<string>("team_resolve_project_id", { repoPath });
}

/**
 * Scaffold (or open) a project's shared brain and return its full state.
 * Idempotent — re-initializing an existing project preserves its
 * `project.json` (`createdAt`, `repoPath`).
 */
export async function initTeam(
  repoPath: string,
  leadModel?: string,
): Promise<TeamProjectState> {
  requireRuntime("initTeam");
  return auroraInvoke<TeamProjectState>("team_init", { repoPath, leadModel });
}

/**
 * Read a project's brain snapshot. Safe before {@link initTeam}: an
 * un-scaffolded project returns `{ initialized: false, … }` so the UI can
 * render an empty team view immediately.
 */
export async function getTeamState(
  repoPath: string,
  channelLimit?: number,
): Promise<TeamProjectState> {
  requireRuntime("getTeamState");
  return auroraInvoke<TeamProjectState>("team_get_state", {
    repoPath,
    channelLimit,
  });
}

/** Read the tail of the team channel (most-recent events, oldest-first). */
export async function getChannelTail(
  repoPath: string,
  limit?: number,
): Promise<ChannelEvent[]> {
  requireRuntime("getChannelTail");
  return auroraInvoke<ChannelEvent[]>("team_channel_tail", { repoPath, limit });
}

/**
 * The distinct chat/thread ids that have ever dispatched a team run for this
 * project (from the durable channel log). Empty for a project with no team
 * history. Powers the left-rail "this chat has team work" badge.
 */
export async function getOriginThreads(repoPath: string): Promise<string[]> {
  requireRuntime("getOriginThreads");
  return auroraInvoke<string[]>("team_origin_threads", { repoPath });
}

/** Arguments for posting one event to the team channel. */
export interface PostChannelEventInput {
  repoPath: string;
  author: string;
  kind: ChannelEventKind;
  body: string;
  meta?: unknown;
}

/**
 * Post one event to the team channel. The Rust side persists it to
 * `events.jsonl` and broadcasts it on {@link TEAM_EVENT_CHANNEL} in one
 * path (§7). The runtime stamps `id` + `ts`; returns the stored event.
 */
export async function postChannelEvent(
  input: PostChannelEventInput,
): Promise<ChannelEvent> {
  requireRuntime("postChannelEvent");
  return auroraInvoke<ChannelEvent>("team_post_channel_event", {
    repoPath: input.repoPath,
    author: input.author,
    kind: input.kind,
    body: input.body,
    meta: input.meta,
  });
}

// ─── Lead team-control surface (Phase 2a) ─────────────────────────────
//
// These wrap the Rust `TeamSession` commands. Each returns a fresh
// `TeamProjectState` snapshot so a store can replace its state in one
// shot; lifecycle changes also arrive live via {@link subscribeTeamEvents}.

/**
 * Convene the team: seed the roster (Lead + clamped ICs) and enter the
 * Planning phase. `maxSize` is the user's configured ceiling (from
 * settings); the runtime clamps it again to the hard ceiling of 16.
 */
export async function convene(
  repoPath: string,
  request: ConveneRequest,
  maxSize: number,
): Promise<TeamProjectState> {
  requireRuntime("convene");
  return auroraInvoke<TeamProjectState>("team_convene", {
    repoPath,
    request,
    maxSize,
  });
}

/** Add one IC to the running team (rejected if it would exceed `maxSize`). */
export async function addAgent(
  repoPath: string,
  agent: AgentSpec,
  maxSize: number,
): Promise<TeamProjectState> {
  requireRuntime("addAgent");
  return auroraInvoke<TeamProjectState>("team_add_agent", {
    repoPath,
    agent,
    maxSize,
  });
}

/** Remove/dismiss an IC; its scope is released and its tasks unassigned. */
export async function removeAgent(
  repoPath: string,
  agentId: string,
): Promise<TeamProjectState> {
  requireRuntime("removeAgent");
  return auroraInvoke<TeamProjectState>("team_remove_agent", {
    repoPath,
    agentId,
  });
}

/** Stop the whole team run (soft stop → Disbanded; brain stays on disk). */
export async function disbandTeam(repoPath: string): Promise<TeamProjectState> {
  requireRuntime("disbandTeam");
  return auroraInvoke<TeamProjectState>("team_disband", { repoPath });
}

/** Update one agent's live status (reflected on the next state read). */
export async function setAgentStatus(
  repoPath: string,
  agentId: string,
  status: AgentStatus,
): Promise<TeamProjectState> {
  requireRuntime("setAgentStatus");
  return auroraInvoke<TeamProjectState>("team_set_agent_status", {
    repoPath,
    agentId,
    status,
  });
}

/**
 * Authoritatively (re)assign folder ownership to an agent, keeping the
 * partition non-overlapping (§8).
 */
export async function assignScope(
  repoPath: string,
  agentId: string,
  ownedPaths: string[],
  ownedContracts?: string[],
): Promise<TeamProjectState> {
  requireRuntime("assignScope");
  return auroraInvoke<TeamProjectState>("team_assign_scope", {
    repoPath,
    agentId,
    ownedPaths,
    ownedContracts,
  });
}

/** Push a ticket onto the board for an owner (or unassigned). */
export async function assignTask(
  repoPath: string,
  title: string,
  owner?: string,
  dependsOn?: string[],
): Promise<TeamProjectState> {
  requireRuntime("assignTask");
  return auroraInvoke<TeamProjectState>("team_assign_task", {
    repoPath,
    title,
    owner,
    dependsOn,
  });
}

/** Update a task's status. */
export async function setTaskStatus(
  repoPath: string,
  taskId: string,
  status: TaskStatus,
): Promise<TeamProjectState> {
  requireRuntime("setTaskStatus");
  return auroraInvoke<TeamProjectState>("team_set_task_status", {
    repoPath,
    taskId,
    status,
  });
}

// ─── Live planning round (Phase 2b) ───────────────────────────────────

/**
 * Run the live planning round: the Lead proposes a team + non-overlapping
 * scope partition + seeded board via real model calls, then each IC runs a
 * one-shot standup turn. Lifecycle events stream live via
 * {@link subscribeTeamEvents} as the round progresses; the resolved
 * `TeamProjectState` is the settled brain once planning completes.
 *
 * The Lead and the IC team can ride **different** configured providers:
 *
 *   - `leadProviderConfig` drives the Lead's planning call.
 *   - `teamProviderConfig` drives every IC standup.
 *
 * Build them from the user's Team settings with
 * `AgentRuntimeClient.buildProviderConfigSnapshot(getTeamLeadConfig())` and
 * `…(getTeamMemberConfig())`. When the user hasn't overridden either, both
 * resolve to the active chat model, so the team rides the chat provider by
 * default.
 */
export async function runPlanning(
  repoPath: string,
  goal: string,
  leadProviderConfig: ProviderConfigSnapshot,
  teamProviderConfig: ProviderConfigSnapshot,
  maxSize: number,
  desiredIcs?: number,
): Promise<TeamProjectState> {
  requireRuntime("runPlanning");
  return auroraInvoke<TeamProjectState>("team_run_planning", {
    repoPath,
    goal,
    leadProviderConfig,
    teamProviderConfig,
    maxSize,
    desiredIcs: desiredIcs ?? null,
  });
}

// ─── Parallel build + scope enforcement (Phase 3) ─────────────────────
//
// These drive the build phase (§9 step 3) and enforce the scope partition
// (§8). The mutations return a fresh snapshot; `checkScope` is read-only and
// returns only its decision.

/**
 * Start the parallel build: move the team into the Building phase and flip
 * every scoped IC to `building` (§9). Rejected on a disbanded team.
 */
export async function beginBuild(repoPath: string): Promise<TeamProjectState> {
  requireRuntime("beginBuild");
  return auroraInvoke<TeamProjectState>("team_begin_build", { repoPath });
}

/**
 * Run the full parallel build round: flip the team to Building, then drive
 * each scoped IC through a guarded tool-calling loop that edits **only** its
 * owned files in the real repo (§8/§9). Per-IC summaries + lifecycle events
 * arrive live via {@link subscribeTeamEvents}; the resolved snapshot is the
 * settled brain (Integrating once every IC finishes).
 *
 * `teamProviderConfig` is the provider every IC runs on — build it from the
 * user's Team settings with
 * `AgentRuntimeClient.buildProviderConfigSnapshot(getTeamMemberConfig())`
 * (defaults to the active chat model when not overridden).
 */
export async function runBuild(
  repoPath: string,
  goal: string,
  teamProviderConfig: ProviderConfigSnapshot,
): Promise<TeamProjectState> {
  requireRuntime("runBuild");
  return auroraInvoke<TeamProjectState>("team_run_build", {
    repoPath,
    goal,
    teamProviderConfig,
  });
}

/**
 * Ask the scope write-guard whether `agentId` may write `path` against the
 * current ownership partition (§8). Read-only — no brain mutation. The build
 * runner runs this before letting an IC's write land; the team view uses it
 * to explain a refused edit.
 */
export async function checkScope(
  repoPath: string,
  agentId: string,
  path: string,
): Promise<ScopeDecision> {
  requireRuntime("checkScope");
  return auroraInvoke<ScopeDecision>("team_check_scope", {
    repoPath,
    agentId,
    path,
  });
}

/**
 * Raise a boundary question from one agent to a scope owner (§8). Persisted
 * + broadcast on the team channel as a `boundary_question`.
 */
export async function askBoundary(
  repoPath: string,
  fromAgent: string,
  toOwner: string,
  question: string,
): Promise<TeamProjectState> {
  requireRuntime("askBoundary");
  return auroraInvoke<TeamProjectState>("team_ask_boundary", {
    repoPath,
    fromAgent,
    toOwner,
    question,
  });
}

/**
 * Publish a shared interface other agents can depend on (§8). Recorded under
 * the author's `ownedContracts` and posted as a `contract_published`.
 */
export async function publishContract(
  repoPath: string,
  agentId: string,
  name: string,
  body: string,
): Promise<TeamProjectState> {
  requireRuntime("publishContract");
  return auroraInvoke<TeamProjectState>("team_publish_contract", {
    repoPath,
    agentId,
    name,
    body,
  });
}

/**
 * Mark an IC finished. When every IC is done, the team closes and the Lead
 * receives the worker reports.
 */
export async function markAgentDone(
  repoPath: string,
  agentId: string,
): Promise<TeamProjectState> {
  requireRuntime("markAgentDone");
  return auroraInvoke<TeamProjectState>("team_mark_agent_done", {
    repoPath,
    agentId,
  });
}

// ─── Phase 4: integration & peer review ───────────────────────────────
//
// The review/gate mutations return a fresh snapshot; `runIntegration` drives
// the whole gate (review round + build/lint/test) and streams as it goes (§9
// step 5, §14).

/**
 * Record one agent's peer-review verdict on another's work (§9 step 5).
 * Persists a thread under `integration/reviews/` and posts a `review_verdict`.
 */
export async function recordReview(
  repoPath: string,
  reviewer: string,
  target: string,
  verdict: ReviewVerdict,
  comments: string,
): Promise<TeamProjectState> {
  requireRuntime("recordReview");
  return auroraInvoke<TeamProjectState>("team_record_review", {
    repoPath,
    reviewer,
    target,
    verdict,
    comments,
  });
}

/**
 * Record the integration gate result to `integration/status.json` and post a
 * Lead summary (§9 step 5, §14).
 */
export async function setGateStatus(
  repoPath: string,
  build: GateStatus,
  lint: GateStatus,
  test: GateStatus,
): Promise<TeamProjectState> {
  requireRuntime("setGateStatus");
  return auroraInvoke<TeamProjectState>("team_set_gate_status", {
    repoPath,
    build,
    lint,
    test,
  });
}

/**
 * Close the integration phase: move the team to `done` when no gate failed,
 * else keep it integrating (§14).
 */
export async function finishIntegration(
  repoPath: string,
): Promise<TeamProjectState> {
  requireRuntime("finishIntegration");
  return auroraInvoke<TeamProjectState>("team_finish_integration", {
    repoPath,
  });
}

/**
 * Run the full integration & peer-review gate (§9 step 5, §14): a round-robin
 * review pass plus the build/lint/test gate, then the Lead's finish. Verdicts,
 * gate results, and the wrap-up stream live on `team_event`; resolves to the
 * settled brain (`done` when the gate passes).
 *
 * `teamProviderConfig` drives the review calls; `gate` carries the opt-in
 * shell commands (an omitted command leaves that gate `unknown`).
 */
export async function runIntegration(
  repoPath: string,
  teamProviderConfig: ProviderConfigSnapshot,
  gate?: GateCommands,
): Promise<TeamProjectState> {
  requireRuntime("runIntegration");
  return auroraInvoke<TeamProjectState>("team_run_integration", {
    repoPath,
    teamProviderConfig,
    gate: gate ?? null,
  });
}

// ─── Background dispatch (the team is its own engine, §17) ─────────────
//
// `dispatchTeam` is the Lead's single non-blocking entry point: it hands the
// assigned worker run to the Rust dispatcher, which runs it on a detached task
// and returns the current snapshot immediately. The Lead stays free to chat;
// `getRunStatus` reports where the team stands and is injected into the Lead's
// context every message.

/**
 * Dispatch the assigned worker run in the background. Resolves to the current
 * (just-scaffolded) brain snapshot WITHOUT waiting for the run — the team works
 * on its own engine while the Lead keeps chatting. Progress streams live via
 * {@link subscribeTeamEvents}; the outcome is read from {@link getRunStatus}.
 *
 * `desiredIcs` is kept for IPC compatibility; assigned `members` define the
 * actual workers. Rejected (throws) if a run is already in progress for this
 * workspace.
 */
export async function dispatchTeam(
  repoPath: string,
  goal: string,
  leadProviderConfig: ProviderConfigSnapshot,
  teamProviderConfig: ProviderConfigSnapshot,
  maxSize: number,
  desiredIcs?: number,
  gate?: GateCommands,
  origin?: TeamDispatchOrigin,
  members?: DispatchMember[],
): Promise<TeamProjectState> {
  requireRuntime("dispatchTeam");
  return auroraInvoke<TeamProjectState>("team_dispatch", {
    repoPath,
    goal,
    members: members ?? null,
    leadProviderConfig,
    teamProviderConfig,
    maxSize,
    desiredIcs: desiredIcs ?? null,
    gate: gate ?? null,
    originThreadId: origin?.originThreadId ?? null,
    originSurface: origin?.originSurface ?? null,
  });
}

/**
 * Read the live background-run status for a workspace (`idle` / `running` +
 * phase / `done` / `failed`). The Lead's context injection calls this every
 * message so the Lead always knows where the team stands.
 */
export async function getRunStatus(repoPath: string): Promise<TeamRunStatus> {
  requireRuntime("getRunStatus");
  return auroraInvoke<TeamRunStatus>("team_run_status", { repoPath });
}

/**
 * Mark a terminal run's completion report as delivered to the Lead. The Rust
 * dispatcher owns the flag, so the completion notifier delivers exactly once
 * across window reloads. Pass the run id when known so a stale ack can't hit a
 * newer run. Returns the fresh status.
 */
export async function ackRunStatus(
  repoPath: string,
  runId?: string,
): Promise<TeamRunStatus> {
  requireRuntime("ackRunStatus");
  return auroraInvoke<TeamRunStatus>("team_run_ack", {
    repoPath,
    runId: runId ?? null,
  });
}

/**
 * Read one agent's transcript — what it called and what it got back —
 * from `agents/<id>/session.jsonl`. Empty until the agent starts building.
 * The team window polls this for the selected agent's individual view.
 */
export async function getAgentTranscript(
  repoPath: string,
  agentId: string,
): Promise<AgentTurn[]> {
  requireRuntime("getAgentTranscript");
  return auroraInvoke<AgentTurn[]>("team_get_agent_transcript", {
    repoPath,
    agentId,
  });
}

/**
 * Subscribe to the live team-channel stream. The handler fires for every
 * event the TeamBus broadcasts; pass `projectId` to ignore broadcasts
 * for other projects. Returns an unlisten function.
 */
export async function subscribeTeamEvents(
  handler: (payload: TeamEventPayload) => void,
  projectId?: string,
): Promise<() => void> {
  requireRuntime("subscribeTeamEvents");
  return auroraListen<TeamEventPayload>(TEAM_EVENT_CHANNEL, ({ payload }) => {
    if (projectId && payload.projectId !== projectId) {
      return;
    }
    handler(payload);
  });
}

/**
 * Subscribe to the live ephemeral token stream ({@link TEAM_STREAM_CHANNEL}).
 * The handler fires for every token frame an agent's in-flight model call emits
 * (start / delta / end); pass `projectId` to ignore other projects. These are
 * NOT persisted — they exist only to render the Team view streaming in real
 * time. Returns an unlisten function.
 */
export async function subscribeTeamStream(
  handler: (payload: TeamStreamDelta) => void,
  projectId?: string,
): Promise<() => void> {
  requireRuntime("subscribeTeamStream");
  return auroraListen<TeamStreamDelta>(TEAM_STREAM_CHANNEL, ({ payload }) => {
    if (projectId && payload.projectId !== projectId) {
      return;
    }
    handler(payload);
  });
}
