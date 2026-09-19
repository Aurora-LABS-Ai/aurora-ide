/**
 * Agent Window — one conversation's own numbers [service].
 *
 * The sibling of `agent-project-stats`, one level down: that one aggregates a
 * whole workspace folder, this one reads a single thread's JSONL. Backed by
 * `commands/conversation_stats.rs`, which derives everything from data the
 * runtime already writes — nothing here is separately persisted.
 *
 * The figure the Rust side computes that nothing else in Aurora does is the
 * tool OUTCOME: `ToolUse` blocks paired to their `ToolResult` by
 * `tool_use_id`, so a call is known to have succeeded, failed, or never come
 * back at all. `calls === succeeded + failed + unresolved` always holds.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

/** One bar in the turn timeline. */
export interface TurnStat {
  /** 1-based within this conversation. */
  index: number;
  startedAt: number;
  durationMs: number;
  /** The prompt, truncated — the bar's tooltip heading. */
  prompt: string;
  toolCalls: number;
  failedCalls: number;
  thinkingMs: number;
  compacted: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  /**
   * The largest prompt the model was handed during this turn
   * (`input + cacheRead + cacheWrite` of its biggest request).
   *
   * A MAX, never a sum: every request in a turn re-sends the whole prefix, so
   * adding them would multiply the conversation by its own length. This is what
   * lets the timeline show context climbing and dropping at a compaction.
   */
  contextTokens: number;
  costUsd: number | null;
  /** These counts are Aurora's own estimate, not provider-reported usage. */
  estimated: boolean;
  model: string | null;
}

export interface ToolOutcome {
  name: string;
  calls: number;
  succeeded: number;
  failed: number;
  /** The result never arrived — cancelled turn, dead process, dropped stream. */
  unresolved: number;
}

export interface ConversationModelUse {
  name: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface ConversationStats {
  threadId: string;
  title: string;
  workspaceRoot: string | null;
  createdAt: number | null;
  updatedAt: number | null;

  messages: number;
  turns: number;
  /** Summed turn durations — time the agent was working, not wall clock. */
  activeMs: number;
  /** First to last message, idle time included. */
  spanMs: number;
  longestTurnMs: number;
  thinkingMs: number;
  compactions: number;

  toolCalls: number;
  toolSucceeded: number;
  toolFailed: number;
  toolUnresolved: number;
  /** Busiest first. */
  tools: ToolOutcome[];

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `input + output`, cache excluded — the same definition used everywhere. */
  totalTokens: number;
  requests: number;
  estimatedRequests: number;
  /** Null when NO request reported a cost, so the UI stays silent rather than
   *  rendering a confident `$0.00` for a provider that never reports money. */
  costUsd: number | null;
  costReportedRequests: number;
  models: ConversationModelUse[];

  peakContextTokens: number;
  contextWindow: number;
  lastContextTokens: number;
  lastContextPercent: number;

  /** Oldest first — the timeline reads left to right. */
  turnStats: TurnStat[];
}

export const getConversationStats = (threadId: string): Promise<ConversationStats> =>
  auroraInvoke<ConversationStats>("conversation_stats_get", { threadId });

/**
 * Duration for this panel. Finer than the project panel's, which rounds to
 * minutes because its totals run to hours — a single turn is routinely seconds,
 * and "0m" for a four-second turn is a wrong number rather than a coarse one.
 */
export function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/** Compact token count — `128k`, `12.4k`, `840`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  if (k < 10) return `${k.toFixed(1)}k`;
  if (k < 1000) return `${Math.round(k)}k`;
  return `${(k / 1000).toFixed(1)}M`;
}

/** Cost, at the precision the number deserves. Sub-cent totals still say
 *  something rather than rounding to `$0.00`. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}
