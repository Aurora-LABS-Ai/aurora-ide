/**
 * Agent Window — model usage ranking (frecency).
 *
 * Which models surface in the picker's "Frequent" strip, and in what order.
 *
 * The strip used to rank on a bare last-used timestamp, which meant a model
 * tried once yesterday outranked one picked fifty times last week: the order
 * churned every time you glanced at something new, and the models actually
 * being worked with kept falling off the bottom. Frequency alone fails the
 * other way — a model you hammered on one project would sit at the top of the
 * list forever after you moved on.
 *
 * Frecency is the standard answer to that pair (browser address bars, editor
 * file pickers): every pick adds 1, and the running total decays continuously.
 * Repeated use accumulates faster than decay removes it, so habits rise; an
 * abandoned model fades on its own without anything having to expire it.
 *
 * Pure module — no React, no storage side effects beyond the two explicit
 * read/write helpers, so the ranking is testable on its own.
 */

/** localStorage key. Named for the old timestamp map it grew out of. */
export const MODEL_USAGE_KEY = "agw:model-recent";

/**
 * Half-life of a use: a model's weight halves every two weeks of NOT being
 * picked. Long enough to survive a holiday, short enough that changing projects
 * re-sorts the strip within days.
 */
export const USE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** One model's usage history, keyed elsewhere by `"providerId:modelKey"`. */
export interface ModelUsage {
  /** Use count decayed to the instant recorded in `last`. */
  score: number;
  /** ms epoch of the most recent pick. */
  last: number;
  /** Lifetime picks, never decayed — a stable tie-break. */
  uses: number;
}

/** `score` re-based from `last` forward to `now`. Pure exponential decay. */
export const decayUsage = (score: number, last: number, now: number): number =>
  score <= 0 ? 0 : score * Math.pow(0.5, Math.max(0, now - last) / USE_HALF_LIFE_MS);

/** How strongly a model should surface at `now`: frequency and recency in one number. */
export const frecency = (usage: ModelUsage | undefined, now: number): number =>
  usage ? decayUsage(usage.score, usage.last, now) : 0;

/** Record one pick — decay what was there, then fold the new use in. */
export function bumpUsage(
  prev: Record<string, ModelUsage>,
  key: string,
  now: number,
): Record<string, ModelUsage> {
  const before = prev[key];
  return {
    ...prev,
    [key]: {
      score: decayUsage(before?.score ?? 0, before?.last ?? now, now) + 1,
      last: now,
      uses: (before?.uses ?? 0) + 1,
    },
  };
}

/**
 * Rank `keys` by frecency, strongest first, capped at `limit`.
 *
 * Ties break on most-recently-used so the order can never depend on the
 * insertion order of the underlying object.
 */
export function rankByUsage(
  keys: string[],
  usage: Record<string, ModelUsage>,
  now: number,
  limit: number,
): string[] {
  return keys
    .filter((key) => frecency(usage[key], now) > 0)
    .sort((a, b) => {
      const diff = frecency(usage[b], now) - frecency(usage[a], now);
      return diff !== 0 ? diff : (usage[b]?.last ?? 0) - (usage[a]?.last ?? 0);
    })
    .slice(0, limit);
}

/**
 * Read the stored history, tolerating both shapes.
 *
 * This key used to hold a bare `"key": timestamp` map. Those entries are read
 * as a single use at that moment rather than discarded, so the strip stays
 * populated across the upgrade instead of resetting to empty. Anything
 * unparseable is dropped rather than allowed to poison the ranking.
 */
export function readModelUsage(): Record<string, ModelUsage> {
  try {
    const raw = localStorage.getItem(MODEL_USAGE_KEY);
    if (!raw) return {};
    return parseModelUsage(JSON.parse(raw) as unknown);
  } catch {
    /* malformed or unavailable — start clean rather than throw in a render */
    return {};
  }
}

/** The pure half of {@link readModelUsage}, split out so it can be tested. */
export function parseModelUsage(parsed: unknown): Record<string, ModelUsage> {
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, ModelUsage> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Legacy shape: a bare last-used timestamp.
    if (typeof value === "number") {
      if (Number.isFinite(value) && value > 0) out[key] = { score: 1, last: value, uses: 1 };
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const { score, last, uses } = value as Partial<ModelUsage>;
    if (Number.isFinite(score) && Number.isFinite(last) && (score as number) > 0) {
      out[key] = {
        score: score as number,
        last: last as number,
        uses: Number.isFinite(uses) ? (uses as number) : 1,
      };
    }
  }
  return out;
}

/** Persist the history. Best-effort: a full or blocked quota must not break a pick. */
export function writeModelUsage(usage: Record<string, ModelUsage>): void {
  try {
    localStorage.setItem(MODEL_USAGE_KEY, JSON.stringify(usage));
  } catch {
    /* best-effort persistence */
  }
}
