/**
 * The Tauri commands the window uses to read and steer sub-agents.
 *
 * Spawning is never a command: the parent AGENT starts children through its
 * `spawn_agent` tool. The window only lists them, reads their transcripts and
 * stops them.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { DbThread } from "@/apps/agent/services/threads/thread-service";

import type { AgentReportMeta, SubagentStatus, SubagentUsage } from "./events";

/** Mirrors Rust `TaskSnapshot` (camelCase on the wire). */
export interface SubagentSnapshot {
  agentId: string;
  parentThreadId: string;
  agentType: string;
  /** The name the parent gave it, when it gave one. */
  name?: string;
  description: string;
  status: SubagentStatus;
  background: boolean;
  startedAtMs: number;
  endedAtMs?: number;
  /** The child's final message, once there is one. */
  result?: string;
  error?: string;
  usage: SubagentUsage;
  notified: boolean;
  /** How many runs so far: 1, plus one per resume. */
  runs: number;
  /** `providerId:modelKey` it runs on. */
  model?: string;
  /** Prompt size of its latest model call: how full its context is. */
  contextTokens?: number;
}

/** Every sub-agent a conversation has started, oldest first. */
export function listSubagents(parentThreadId: string): Promise<SubagentSnapshot[]> {
  return auroraInvoke<SubagentSnapshot[]>("agent_subagent_list", { parentThreadId });
}

/** A child's transcript in the chat panel's shape, or `null` when unknown. */
export function loadSubagentThread(
  parentThreadId: string,
  agentId: string,
): Promise<DbThread | null> {
  return auroraInvoke<DbThread | null>("subagent_thread_load", { parentThreadId, agentId });
}

/** Stop a running sub-agent. Resolves to whether it was running. */
export function killSubagent(agentId: string): Promise<boolean> {
  return auroraInvoke<boolean>("agent_subagent_kill", { agentId });
}

/**
 * Mirrors Rust `RailState`: which of a conversation's agent cards are pinned
 * beside the icon rail (in pin order) and which are grown with "Show more".
 * Saved with the conversation, in its `subagent-rail.json`.
 */
export interface SubagentRailState {
  pinned: string[];
  expanded: string[];
}

/** A conversation's saved rail state. Empty when it has none. */
export function getSubagentRail(parentThreadId: string): Promise<SubagentRailState> {
  return auroraInvoke<SubagentRailState>("agent_subagent_rail_get", { parentThreadId });
}

/** Save a conversation's rail state; resolves to what Rust stored. */
export function setSubagentRail(
  parentThreadId: string,
  state: SubagentRailState,
): Promise<SubagentRailState> {
  return auroraInvoke<SubagentRailState>("agent_subagent_rail_set", {
    parentThreadId,
    pinned: state.pinned,
    expanded: state.expanded,
  });
}

/**
 * Mirrors Rust `PendingWake`: a report addressed to an idle parent that no
 * turn has carried yet. Rust keeps it until the window claims it.
 */
export interface PendingWake {
  /** Unique for the life of the process, increasing in delivery order. */
  id: number;
  parentThreadId: string;
  agent: AgentReportMeta;
  /** The one-line transcript message. */
  summary: string;
  /** What the model reads. */
  detail: string;
  queuedAtMs: number;
}

/** Reports waiting to wake this conversation, oldest first. */
export function pendingSubagentWakes(parentThreadId: string): Promise<PendingWake[]> {
  return auroraInvoke<PendingWake[]>("agent_subagent_pending", { parentThreadId });
}

/**
 * Tell Rust a turn carrying wake `wakeId` has opened. Resolves to `false`
 * when it was already claimed: the report is on its way and must not be
 * sent again.
 */
export function claimSubagentWake(parentThreadId: string, wakeId: number): Promise<boolean> {
  return auroraInvoke<boolean>("agent_subagent_claim", { parentThreadId, wakeId });
}

/**
 * Whether a conversation id is a sub-agent's. Rust mints them as
 * `agent_<uuid>` (`subagents::new_agent_id`); nothing else uses the prefix.
 */
export function isSubagentId(threadId: string): boolean {
  return threadId.startsWith("agent_");
}

/** The handle the parent gave an agent, else its id. */
export function subagentLabel(agent: Pick<SubagentSnapshot, "name" | "agentId">): string {
  return agent.name?.trim() || agent.agentId;
}
