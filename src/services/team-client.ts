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
  AgentTurn,
  ChannelEvent,
  ChannelEventKind,
  DispatchMember,
  LeadQuestion,
  ScopeDecision,
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

// ─── Lead control surface ─────────────────────────────────────────────

/** Remove/dismiss a member; its scope is released and its tasks unassigned. */
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

/** Stop the whole team run (graceful cancel → Disbanded; brain stays on disk). */
export async function disbandTeam(repoPath: string): Promise<TeamProjectState> {
  requireRuntime("disbandTeam");
  return auroraInvoke<TeamProjectState>("team_disband", { repoPath });
}

/**
 * Ask the scope write-guard whether `agentId` may write `path` (read-only —
 * the Team view uses it to explain a refused edit).
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
 * The Lead grants a member write access to additional paths — structured,
 * no magic text directives. The partition stays non-overlapping and the
 * grant is posted to the team chat.
 */
export async function grantScope(
  repoPath: string,
  agentId: string,
  paths: string[],
): Promise<TeamProjectState> {
  requireRuntime("grantScope");
  return auroraInvoke<TeamProjectState>("team_grant_scope", {
    repoPath,
    agentId,
    paths,
  });
}

/**
 * Post a Lead message to the team chat AND deliver it into the live
 * members' conversations (all, or one via `to`). Returns the member ids
 * actually reached.
 */
export async function leadMessage(
  repoPath: string,
  text: string,
  to?: string,
): Promise<{ delivered: string[] }> {
  requireRuntime("leadMessage");
  return auroraInvoke<{ delivered: string[] }>("team_lead_message", {
    repoPath,
    text,
    to: to ?? null,
  });
}

/**
 * Questions members routed to the real Lead and are waiting on
 * (input-required). The notifier polls this and injects each question into
 * the Lead's conversation exactly once.
 */
export async function leadInbox(repoPath: string): Promise<LeadQuestion[]> {
  requireRuntime("leadInbox");
  return auroraInvoke<LeadQuestion[]>("team_lead_inbox", { repoPath });
}

/**
 * The Lead answers a member's parked question. The waiting member resumes
 * immediately; the answer is also posted to the team chat. Resolves false
 * when the member already stopped waiting (the chat post still lands).
 */
export async function leadReply(
  repoPath: string,
  questionId: string,
  text: string,
): Promise<boolean> {
  requireRuntime("leadReply");
  return auroraInvoke<boolean>("team_lead_reply", {
    repoPath,
    questionId,
    text,
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
 * Dispatch the Lead-defined team in the background. Resolves to the current
 * (just-reset) brain snapshot WITHOUT waiting for the run — each member runs
 * as a real agent on its own task while the Lead keeps chatting. Progress
 * streams live via {@link subscribeTeamEvents}; the outcome (per-member
 * reports included) is read from {@link getRunStatus}. Rejected (throws) if
 * a run is already in progress for this workspace.
 */
export async function dispatchTeam(
  repoPath: string,
  goal: string,
  members: DispatchMember[],
  leadProviderConfig: ProviderConfigSnapshot,
  teamProviderConfig: ProviderConfigSnapshot,
  maxSize: number,
  origin?: TeamDispatchOrigin,
): Promise<TeamProjectState> {
  requireRuntime("dispatchTeam");
  return auroraInvoke<TeamProjectState>("team_dispatch", {
    repoPath,
    goal,
    members,
    leadProviderConfig,
    teamProviderConfig,
    maxSize,
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
