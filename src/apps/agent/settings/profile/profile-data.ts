/**
 * Profile page data: the `usage_stats_get` shape and the pure projections the
 * page draws from it. Kept apart from the view so the grouping rules (one row
 * per model, removed providers folded together, projects by folder) are
 * unit-tested on their own.
 *
 * Streak, month and series math happens here, not in Rust, because "today"
 * belongs to the renderer's timezone at the moment of viewing.
 */

import { prettyModel } from "@/apps/agent/lib/thread/model-label";

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
  /** Input (incl. cache writes) + output. */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  pricedRequests: number;
}

export interface ProjectUsage {
  root: string | null;
  surface: string;
  requests: number;
  tokens: number;
  cacheReadTokens: number;
  threads: number;
}

export interface ToolUsage {
  name: string;
  count: number;
}

export interface CostSummary {
  usd: number;
  pricedRequests: number;
  reportedRequests: number;
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
  /** Every tool called from a visible message, descending. */
  topTools: ToolUsage[];
  /** Requests by local weekday (Monday first) and hour: 7 rows of 24. */
  hourOfWeek: number[][];
  projects: ProjectUsage[];
  cost: CostSummary;
}

export type ChartRange = "days" | "weeks" | "year";
export type ChartMetric = "tokens" | "cache" | "requests";

export interface ChartBar {
  /** `YYYY-MM-DD` of the day, or of the Monday that starts the week. */
  key: string;
  inputTokens: number;
  outputTokens: number;
  /** Input + output, the billed figure. */
  tokens: number;
  cacheReadTokens: number;
  requests: number;
}

/**
 * Request counts, grouped with separators. Deliberately not the `1.2K` token
 * formatter: a request count is something a person reconciles against a
 * provider dashboard, and rounding 1,247 to "1.2K" makes that impossible.
 */
export function fmtCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
}

/** `$1,608` for a total, `$0.42` under ten dollars, `<$0.01` above zero. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 10 ? 2 : 0,
  });
}

/** Share of input that was read from the prompt cache, 0–100. */
export function cacheHitRate(cacheRead: number, input: number): number {
  const total = cacheRead + input;
  return total > 0 ? Math.round((cacheRead / total) * 100) : 0;
}

export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const dayTokens = (d: DayUsage) => d.inputTokens + d.outputTokens;

export const metricValue = (bar: ChartBar, metric: ChartMetric): number =>
  metric === "requests" ? bar.requests : metric === "cache" ? bar.cacheReadTokens : bar.tokens;

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

function emptyBar(key: string): ChartBar {
  return { key, inputTokens: 0, outputTokens: 0, tokens: 0, cacheReadTokens: 0, requests: 0 };
}

function addDay(bar: ChartBar, usage: DayUsage | undefined): void {
  if (!usage) return;
  bar.inputTokens += usage.inputTokens;
  bar.outputTokens += usage.outputTokens;
  bar.tokens += dayTokens(usage);
  bar.cacheReadTokens += usage.cacheReadTokens;
  bar.requests += usage.turns;
}

/**
 * The last 30 days, 26 weeks, or 364 days (the year view, one square each),
 * with quiet periods present as zero bars.
 *
 * The ledger only lists active days. Drawing those back to back put Sep 2 next
 * to Sep 9 whenever a week was skipped, so the gap the chart exists to show
 * disappeared; every slot is emitted here, filled or not.
 */
export function buildBars(days: DayUsage[], range: ChartRange, now: Date = new Date()): ChartBar[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);

  if (range === "days" || range === "year") {
    const out: ChartBar[] = [];
    for (let back = range === "days" ? 29 : 363; back >= 0; back--) {
      const day = new Date(today);
      day.setDate(today.getDate() - back);
      const bar = emptyBar(localDateKey(day));
      addDay(bar, byDate.get(bar.key));
      out.push(bar);
    }
    return out;
  }

  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const out: ChartBar[] = [];
  for (let back = 25; back >= 0; back--) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - back * 7);
    const bar = emptyBar(localDateKey(start));
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      addDay(bar, byDate.get(localDateKey(day)));
    }
    out.push(bar);
  }
  return out;
}

/**
 * Requests this month so far against the same days of last month, so the
 * comparison is fair on the 3rd as much as on the 30th.
 */
export function monthPace(days: DayUsage[], now: Date = new Date()) {
  const key = localDateKey(now);
  const month = key.slice(0, 7);
  const dayOfMonth = Number(key.slice(8, 10));
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = localDateKey(prev).slice(0, 7);
  let tokens = 0;
  let requests = 0;
  let prevRequests = 0;
  for (const d of days) {
    if (d.date.startsWith(month)) {
      tokens += dayTokens(d);
      requests += d.turns;
    } else if (d.date.startsWith(prevMonth) && Number(d.date.slice(8, 10)) <= dayOfMonth) {
      prevRequests += d.turns;
    }
  }
  return {
    tokens,
    requests,
    prevRequests,
    dayOfMonth,
    /** Whole percent change, or null when last month had nothing to compare. */
    change: prevRequests > 0 ? Math.round(((requests - prevRequests) / prevRequests) * 100) : null,
    monthName: now.toLocaleDateString(undefined, { month: "long" }),
    prevName: prev.toLocaleDateString(undefined, { month: "long" }),
  };
}

/** Busiest weekday and hour, weekend and night shares, from `hourOfWeek`. */
export function rhythmFacts(grid: number[][]) {
  const byDay = grid.map((row) => row.reduce((a, b) => a + b, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((a, row) => a + (row[h] ?? 0), 0));
  const total = byDay.reduce((a, b) => a + b, 0);
  const share = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const topDay = byDay.indexOf(Math.max(...byDay));
  const topHour = byHour.indexOf(Math.max(...byHour));
  return {
    total,
    topDay,
    topDayShare: share(byDay[topDay] ?? 0),
    topHour,
    weekendShare: share((byDay[5] ?? 0) + (byDay[6] ?? 0)),
    nightShare: share(byHour.slice(0, 6).reduce((a, b) => a + b, 0)),
  };
}

const titleCase = (key: string) =>
  key
    .split(/[-_/]/)
    .filter(Boolean)
    .map((p) => (p.length <= 3 && /^[a-z]+$/i.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2");

/**
 * A Modal endpoint key (`owner--ep-glm-5-3-server.us-west.modal.direct`) as
 * the model it serves plus the workspace that owns it. Every other key: null.
 */
export function modalEndpoint(key: string): { label: string; owner: string } | null {
  const match = /^([a-z0-9]+)--ep-(.+?)-server/i.exec(key);
  return match ? { label: titleCase(match[2]), owner: match[1] } : null;
}

type Catalog = Parameters<typeof prettyModel>[1];

/** The label a person reads for a model key. */
export function modelLabel(key: string, catalog: Catalog): string {
  const known = catalog.find((m) => m.modelKey === key)?.label;
  if (known) return known;
  // A key with no catalog label spells versions with dashes (`gpt-5-6-luna`);
  // "GPT 5 6 Luna" reads as three numbers, "GPT 5.6 Luna" as one version.
  return modalEndpoint(key)?.label ?? prettyModel(key, catalog).replace(/(\d) (?=\d)/g, "$1.");
}

export interface LedgerModel {
  label: string;
  keys: string[];
  /** Display names of providers still configured. */
  providers: string[];
  /** Providers that served it but have since been removed. */
  removedProviders: number;
  modalEndpoints: number;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  pricedRequests: number;
}

/**
 * One row per model AS A PERSON READS IT.
 *
 * Rust already merges a model across providers. Two keys can still be one
 * model to the reader when the catalog gives them the same label (or two
 * Modal endpoints serve the same model), so rows are merged again by label
 * here; providers are unioned rather than summed, so a gateway that served
 * both keys is counted once.
 */
export function modelRows(
  models: ModelTotal[],
  catalog: Catalog,
  known: ReadonlyArray<{ id: string; name?: string }>,
): LedgerModel[] {
  const names = new Map(known.map((p) => [p.id, p.name?.trim() || p.id]));
  const merged = new Map<string, LedgerModel & { ids: Set<string> }>();
  for (const m of models) {
    const label = modelLabel(m.model, catalog);
    const row = merged.get(label) ?? {
      label, keys: [], providers: [], removedProviders: 0, modalEndpoints: 0, requests: 0, tokens: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, pricedRequests: 0, ids: new Set<string>(),
    };
    row.keys.push(m.model);
    if (modalEndpoint(m.model)) row.modalEndpoints += 1;
    for (const id of m.providers) row.ids.add(id);
    row.requests += m.requests;
    row.tokens += m.tokens;
    row.inputTokens += m.inputTokens ?? 0;
    row.outputTokens += m.outputTokens ?? 0;
    row.cacheReadTokens += m.cacheReadTokens ?? 0;
    row.costUsd += m.costUsd ?? 0;
    row.pricedRequests += m.pricedRequests ?? 0;
    merged.set(label, row);
  }
  return Array.from(merged.values(), ({ ids, ...row }) => {
    const providers = [...ids].map((id) => names.get(id)).filter((n): n is string => Boolean(n));
    return { ...row, providers: providers.sort(), removedProviders: ids.size - providers.length };
  }).sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}

export interface LedgerProvider {
  id: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  cacheReadTokens: number;
  threads: number;
  models: Array<{ label: string; requests: number; tokens: number; cacheReadTokens: number }>;
}

export interface ProviderGroups {
  active: LedgerProvider[];
  /** Providers deleted since: their names are gone, their requests are not. */
  removed: { count: number; requests: number; tokens: number; cacheReadTokens: number };
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
  catalog: Catalog = [],
): ProviderGroups {
  const names = new Map(known.map((p) => [p.id, p.name?.trim() || p.id]));
  const active: LedgerProvider[] = [];
  const removed = { count: 0, requests: 0, tokens: 0, cacheReadTokens: 0 };
  for (const p of usage) {
    if (!p.providerId) continue;
    const tokens = p.inputTokens + p.outputTokens;
    const name = names.get(p.providerId);
    if (!name) {
      removed.count += 1;
      removed.requests += p.requests;
      removed.tokens += tokens;
      removed.cacheReadTokens += p.cacheReadTokens;
      continue;
    }
    active.push({
      id: p.providerId,
      label: name,
      requests: p.requests,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      tokens,
      cacheReadTokens: p.cacheReadTokens,
      threads: p.threads,
      models: p.models.map((m) => ({
        label: modelLabel(m.model, catalog),
        requests: m.requests,
        tokens: m.inputTokens + m.outputTokens,
        cacheReadTokens: m.cacheReadTokens,
      })),
    });
  }
  active.sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));
  return { active, removed };
}

export interface LedgerProject {
  id: string;
  label: string;
  /** Full folder, for the tooltip; null for Aurora Chat. */
  root: string | null;
  requests: number;
  tokens: number;
  cacheReadTokens: number;
  threads: number;
}

/** A folder's last segment; Aurora Chat by name; folderless threads stated. */
export function projectRows(projects: ProjectUsage[]): LedgerProject[] {
  return projects.map((p) => {
    const folder = p.root?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    const label = p.surface === "chat" ? "Aurora Chat" : folder || "No folder recorded";
    return {
      id: p.surface === "chat" ? "chat" : (p.root ?? "").toLowerCase(),
      label,
      root: p.surface === "chat" ? null : p.root,
      requests: p.requests,
      tokens: p.tokens,
      cacheReadTokens: p.cacheReadTokens,
      threads: p.threads,
    };
  });
}
