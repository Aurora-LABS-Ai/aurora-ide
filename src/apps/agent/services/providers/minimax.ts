/**
 * MiniMax — one key, an Anthropic wire, and a subscription Aurora can read.
 *
 * MiniMax needs no adapter of its own: it serves a genuine Anthropic Messages
 * API at `https://api.minimax.io/anthropic/v1`, and Aurora's stock Anthropic
 * client reaches it unchanged. What lives here is the part that is MiniMax's
 * own — the Token Plan quota.
 *
 * ## Measured, not read off a page (2026-09-09)
 *
 * - **Prompt caching works**, and Aurora had it switched off. One
 *   `cache_control` breakpoint on a 1,582-token system prompt wrote the cache
 *   and then read all 1,582 back, with `input_tokens: 0` both times. Their
 *   cache reads are priced at $0.06/M against $0.30/M for fresh input, so the
 *   exclusion cost 20x on the cached half of every turn.
 * - **One key does both.** The `sk-cp-` subscription key authenticated the chat
 *   endpoint and the quota endpoint. There is no browser sign-in to capture,
 *   unlike kenari, and no CLI credential file, unlike Command Code.
 * - **Thinking arrives unasked.** Their Messages reference says `thinking`
 *   defaults to disabled; a request sending no `thinking` field came back with
 *   a `thinking` block carrying a signature.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import type { LLMProvider } from "@/apps/agent/store/settings/useAgentSettingsStore";

export const MINIMAX_PROVIDER_ID = "minimax";

/** The Anthropic-compatible wire. Every client appends its own path. */
export const MINIMAX_BASE_URL = "https://api.minimax.io/anthropic/v1";

/** Where a person gets a key, and where the usage bar lives. */
export const MINIMAX_CONSOLE_URL = "https://platform.minimax.io";

/**
 * One metered bucket over both of the plan's windows.
 *
 * `remainingPercent` is what is LEFT, which is how MiniMax reports it — not
 * what is spent. Passing it through as "used" draws a full bar over an
 * untouched plan.
 */
export interface MinimaxQuota {
  /** MiniMax's own name: `general` is text, `video` is video. */
  modelName: string;
  intervalRemainingPercent: number;
  /** Milliseconds until the rolling 5-hour window resets. */
  intervalResetsInMs: number | null;
  weeklyRemainingPercent: number;
  weeklyResetsInMs: number | null;
  /**
   * Countable allowance, where the bucket is counted at all.
   *
   * On a live Max plan the `general` row reports zeroes here while `video`
   * reports real numbers (3 per window, 21 weekly). Text quota is metered as a
   * share, so these are NOT drawn for it — "0 of 0" would report an untouched
   * plan as spent.
   */
  intervalTotalCount: number | null;
  intervalUsageCount: number | null;
  weeklyTotalCount: number | null;
  weeklyUsageCount: number | null;
}

export interface MinimaxUsageSnapshot {
  quotas: MinimaxQuota[];
  fetchedAtMs: number;
}

/** Whether this provider row is MiniMax. */
export function isMinimaxProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  return (
    provider.id === MINIMAX_PROVIDER_ID ||
    (provider.providerType ?? "").toLowerCase() === MINIMAX_PROVIDER_ID
  );
}

/**
 * How much of the Token Plan is left.
 *
 * Throws with a sentence a person can act on. The endpoint is undocumented —
 * MiniMax's own pages say only that usage "is shown as a usage bar in the
 * console" — so a shape drift degrades the plan section rather than breaking
 * the provider.
 */
export function fetchMinimaxUsage(apiKey: string): Promise<MinimaxUsageSnapshot> {
  return invoke<MinimaxUsageSnapshot>("minimax_usage_get", { apiKey });
}

/** The text bucket, which is the only one a coding agent spends. */
export function minimaxGeneralQuota(
  snapshot: MinimaxUsageSnapshot | null,
): MinimaxQuota | null {
  if (!snapshot) return null;
  return (
    snapshot.quotas.find((q) => q.modelName.toLowerCase() === "general") ?? null
  );
}

/**
 * A window's rollover, as a sentence.
 *
 * MiniMax sends a DURATION in milliseconds where Codex sends seconds and Cursor
 * sends an instant, so this cannot reuse either of theirs. It shares
 * `fmtDuration` with them, which is the part that has to match: a plan that
 * resets "in 4h 18m" here and "4h" elsewhere reads as two different numbers.
 */
export function minimaxResetLabel(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms <= 0) return "resets now";
  return `resets in ${fmtDuration(Math.round(ms / 1000))}`;
}
