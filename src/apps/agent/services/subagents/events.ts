import { auroraListen } from "@/kernel/lib/ipc/runtime";
import type { AuroraUnlistenFn } from "@/kernel/lib/ipc/runtime";

/**
 * Wire channel for subagent lifecycle events. Mirrors
 * `SUBAGENT_EVENT_CHANNEL` in `src-tauri/src/agent_runtime/subagents/events.rs`.
 *
 * A child's own stream (text, thinking, tool cards) rides the ordinary
 * `agent_event` channel under `turnId`; this channel only carries the
 * lifecycle that stream cannot tell you.
 */
export const SUBAGENT_EVENT_CHANNEL = "agent_subagent";

/** Mirrors Rust `TaskStatus` (snake_case). */
export type SubagentStatus = "running" | "completed" | "failed" | "killed";

/** Mirrors Rust `SubagentUsage`. */
export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** Model round trips. */
  iterations: number;
  durationMs: number;
}

/** Mirrors Rust `AgentReportMeta`. */
export interface AgentReportMeta {
  agentId: string;
  name?: string;
  /** `completed`, `failed`, or `killed`. */
  status: string;
}

/** A child started running. Also sent on resume, with `resumed: true`. */
export interface SubagentStartedEvent {
  type: "started";
  agentId: string;
  parentThreadId: string;
  /** The parent turn that started it, when one did. */
  parentTurnId?: string;
  /** Follow this id on `agent_event` to watch the child live. */
  turnId: string;
  agentType: string;
  name?: string;
  description: string;
  model?: string;
  background: boolean;
  resumed: boolean;
  outputFile: string;
}

/** A child's run ended, one way or another. */
export interface SubagentFinishedEvent {
  type: "finished";
  agentId: string;
  parentThreadId: string;
  turnId: string;
  status: SubagentStatus;
  /** The final message or best partial answer; may be empty. */
  result: string;
  error?: string;
  usage: SubagentUsage;
  /** Whether the parent hears about this through its own conversation. */
  reportedToParent: boolean;
}

/** A message was queued for, or delivered to, a running child. */
export interface SubagentMessageEvent {
  type: "message";
  agentId: string;
  parentThreadId: string;
  text: string;
  delivered: boolean;
}

/**
 * A background child's report is ready and the parent conversation is idle, so
 * the window must start a turn on `parentThreadId` with
 * `userMessageOrigin: "subagent"`. Not sent when the report was queued into a
 * running parent turn.
 */
export interface SubagentReportEvent {
  type: "report";
  agentId: string;
  parentThreadId: string;
  agent: AgentReportMeta;
  /** The one-line transcript message. */
  summary: string;
  /** What the model reads. */
  detail: string;
}

export type SubagentEvent =
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentMessageEvent
  | SubagentReportEvent;

/** Subscribe to subagent lifecycle events. Resolves to the unlisten function. */
export function listenSubagentEvents(
  handler: (event: SubagentEvent) => void,
): Promise<AuroraUnlistenFn> {
  return auroraListen<SubagentEvent>(SUBAGENT_EVENT_CHANNEL, ({ payload }) =>
    handler(payload),
  );
}
