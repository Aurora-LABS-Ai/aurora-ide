/** The sizes `LimitChips` offers under the token-limit fields, and their labels. */

/** Common context windows, smallest first. */
export const CONTEXT_WINDOW_CHIPS = [128_000, 200_000, 262_000, 400_000, 1_000_000, 5_000_000] as const;

/** Common output caps, smallest first. */
export const MAX_OUTPUT_CHIPS = [16_000, 32_000, 64_000, 128_000] as const;

/** `262000` → `262K`, `1000000` → `1M`, `1500000` → `1.5M`. */
export function formatTokenChip(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}
