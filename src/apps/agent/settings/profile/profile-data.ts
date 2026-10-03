/**
 * Profile page data: the `usage_stats_get` shape and the pure projections the
 * page draws from it. Kept apart from the view so the grouping rules (one row
 * per model, removed providers folded together) are unit-tested on their own.
 *
 * Streak math happens here, not in Rust, because "today" belongs to the
 * renderer's timezone at the moment of viewing.
 */

import { formatTokens, prettyModel } from "@/apps/agent/lib/thread/model-label";

export interface DayUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Requests that reported usage this day. */
  turns: number;
}

export interface ModelRequestUsage {
  model: string;
  requests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface ProviderRequestUsage {
  /** Provider ROW id — a UUID for user-added providers, so never rendered raw. */
  providerId: string;
  requests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  threads: number;
  models: ModelRequestUsage[];
}

/** One model across every provider it was reached through. */
export interface ModelTotal {
  model: string;
  providers: string[];
  requests: number;
  tokens: number;
}

export interface UsageStats {
  totalThreads: number;
  totalMessages: number;
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeCacheReadTokens: number;
  userName: string;
  days: DayUsage[];
  models: ModelTotal[];
  unattributed: { requests: number; tokens: number };
  requestsByProvider: ProviderRequestUsage[];
  totalRequests: number;
}

export type ChartRange = "days" | "weeks";

export interface ChartBar {
  /** `YYYY-MM-DD` of the day, or of the Monday that starts the week. */
  key: string;
  tokens: number;
  requests: number;
}

export interface RankRow {
  id: string;
  label: string;
  /** The number the row is ranked by. */
  value: number;
  /** A quieter second number (tokens beside requests, share beside tokens). */
  aside: string;
  detail?: string;
}

/**
 * Request counts, grouped with separators. Deliberately not the `1.2K` token
 * formatter: a request count is something a person reconciles against a
 * provider dashboard, and rounding 1,247 to "1.2K" makes that impossible.
 */
export function fmtCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
}

export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const dayTokens = (d: DayUsage) => d.inputTokens + d.outputTokens;

/**
 * Current streak counts back from today (a quiet today doesn't break it until
 * tomorrow); longest is the longest run of consecutive active days anywhere.
 */
export function computeStreaks(
  days: DayUsage[],
  now: Date = new Date(),
): { current: number; longest: number } {
  if (days.length === 0) return { current: 0, longest: 0 };
  const active = new Set(days.map((d) => d.date));

  let current = 0;
  const cursor = new Date(now);
  if (!active.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(localDateKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of days) {
    const date = new Date(`${d.date}T12:00:00`);
    run = prev && Math.round((date.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = date;
  }
  return { current, longest };
}

/**
 * The last 30 days or 26 weeks, with quiet periods present as zero bars.
 *
 * The ledger only lists active days. Drawing those back to back put Sep 2 next
 * to Sep 9 whenever a week was skipped, so the gap the chart exists to show
 * disappeared; every slot is emitted here, filled or not.
 */
export function buildBars(days: DayUsage[], range: ChartRange, now: Date = new Date()): ChartBar[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);

  if (range === "days") {
    const out: ChartBar[] = [];
    for (let back = 29; back >= 0; back--) {
      const day = new Date(today);
      day.setDate(today.getDate() - back);
      const key = localDateKey(day);
      const usage = byDate.get(key);
      out.push({ key, tokens: usage ? dayTokens(usage) : 0, requests: usage?.turns ?? 0 });
    }
    return out;
  }

  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const out: ChartBar[] = [];
  for (let back = 25; back >= 0; back--) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - back * 7);
    let tokens = 0;
    let requests = 0;
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const usage = byDate.get(localDateKey(day));
      if (usage) {
        tokens += dayTokens(usage);
        requests += usage.turns;
      }
    }
    out.push({ key: localDateKey(start), tokens, requests });
  }
  return out;
}

/** Tokens and requests in the calendar month containing `now`. */
export function monthTotals(days: DayUsage[], now: Date = new Date()) {
  const prefix = localDateKey(now).slice(0, 7);
  let tokens = 0;
  let requests = 0;
  for (const d of days) {
    if (!d.date.startsWith(prefix)) continue;
    tokens += dayTokens(d);
    requests += d.turns;
  }
  return { tokens, requests };
}

export function peakDay(days: DayUsage[]): DayUsage | null {
  let best: DayUsage | null = null;
  for (const d of days) if (!best || dayTokens(d) > dayTokens(best)) best = d;
  return best;
}

/**
 * One row per model AS A PERSON READS IT.
 *
 * Rust already merges a model across providers. Two keys can still be one
 * model to the reader when the catalog gives them the same label, so rows are
 * merged again by label here; providers are unioned rather than summed, so a
 * gateway that served both keys is counted once.
 */
export function modelRows(
  models: ModelTotal[],
  catalog: Parameters<typeof prettyModel>[1],
): RankRow[] {
  const merged = new Map<string, { tokens: number; requests: number; providers: Set<string> }>();
  for (const m of models) {
    const label = prettyModel(m.model, catalog);
    const row = merged.get(label) ?? { tokens: 0, requests: 0, providers: new Set<string>() };
    row.tokens += m.tokens;
    row.requests += m.requests;
    for (const p of m.providers) row.providers.add(p);
    merged.set(label, row);
  }
  const attributed = Math.max(1, models.reduce((sum, m) => sum + m.tokens, 0));
  return Array.from(merged, ([label, row]) => ({
    id: label,
    label,
    value: row.tokens,
    aside: `${Math.round((row.tokens / attributed) * 100)}%`,
    detail: row.providers.size > 1 ? `via ${row.providers.size} providers` : undefined,
  })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export interface ProviderGroups {
  active: RankRow[];
  /** Providers deleted since: their names are gone, their requests are not. */
  removed: { count: number; requests: number; tokens: number };
}

/**
 * Providers the user still has, ranked by requests, with deleted ones folded
 * into a single total. A deleted provider's id is a UUID with no name left to
 * show, so listing each as "Removed provider (d840dd0a…)" was rows of noise;
 * dropping them would make the total disagree with the rows. Usage with no
 * provider at all is reported by the page's footnote, not here.
 */
export function providerGroups(
  usage: ProviderRequestUsage[],
  known: ReadonlyArray<{ id: string; name?: string }>,
): ProviderGroups {
  const names = new Map(known.map((p) => [p.id, p.name?.trim() || p.id]));
  const active: RankRow[] = [];
  const removed = { count: 0, requests: 0, tokens: 0 };
  for (const p of usage) {
    if (!p.providerId) continue;
    const tokens = p.inputTokens + p.outputTokens;
    const name = names.get(p.providerId);
    if (!name) {
      removed.count += 1;
      removed.requests += p.requests;
      removed.tokens += tokens;
      continue;
    }
    active.push({
      id: p.providerId,
      label: name,
      value: p.requests,
      aside: formatTokens(tokens),
      detail: `${p.models.length} ${p.models.length === 1 ? "model" : "models"}`,
    });
  }
  active.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return { active, removed };
}
