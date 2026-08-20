/**
 * Agent Window — conversation cost accounting [leaf, pure].
 *
 * Turns token counts into money. Nothing here touches a store, the clock, or
 * the network: given the same tokens and prices it returns the same answer,
 * which is the only way a figure people check repeatedly can be trusted.
 *
 * Three rules this module exists to enforce, each of which was violated by the
 * ad-hoc arithmetic it replaces:
 *
 * 1. **Sum money, never tokens.** A conversation can move between models
 *    mid-task and their prices differ by orders of magnitude. Adding all the
 *    tokens up and multiplying once by whichever model is selected *now*
 *    misprices every request that ran under a different one. Each
 *    {@link ModelUsageGroup} is priced with its own model and only the
 *    resulting dollars are added.
 *
 * 2. **A missing price is not a zero price.** If a model carries no pricing,
 *    its tokens are reported as *unpriced* and excluded from the total, and
 *    the caller renders that fact. Folding them in as $0 would understate a
 *    real bill while looking precise.
 *
 * 3. **An estimate is never presented as a measurement.** Providers that
 *    report no usage get a local tiktoken estimate; any total containing one
 *    is marked approximate all the way to the label.
 *
 * Cache tokens are billed by every provider that offers prompt caching, and
 * both rates fall back to the fresh-input rate rather than to zero — see
 * {@link resolveRates}.
 */

/** Per-model token totals, as aggregated from the session transcript by Rust. */
export interface ModelUsageGroup {
  /** `"{providerId}:{modelKey}"`, or absent for calls recorded before the
   *  model was persisted per message. */
  model?: string;
  /** Fresh (uncached) input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** API requests represented by this group. */
  requests: number;
  /** How many of those carry a local estimate rather than reported usage. */
  estimatedRequests: number;
  /**
   * Total USD the PROVIDER reported for these requests.
   *
   * When present it is used VERBATIM and the tokens are not priced — see
   * {@link priceUsage}. Groups are split upstream on whether cost was
   * reported, so this is never a partial sum next to tokens that still need
   * pricing: a group is entirely reported or entirely computed.
   */
  reportedCostUsd?: number;
}

/** A thread's cost basis, straight from `thread_usage_breakdown`. */
export interface ThreadUsageBreakdown {
  threadId: string;
  byModel: ModelUsageGroup[];
  lastTurn: ModelUsageGroup[];
  turns: number;
  requests: number;
}

/** The four rates a model needs to be fully priceable, in USD per 1M tokens. */
export interface ModelPrices {
  /** Fresh input. Required — without it nothing can be priced. */
  cacheMissPerMtok?: number;
  /** Output, including reasoning tokens (providers bill those as output). */
  outputPerMtok?: number;
  /** Cached input read. Falls back to the fresh-input rate. */
  cacheHitPerMtok?: number;
  /** Cache creation. Falls back to the fresh-input rate. */
  cacheWritePerMtok?: number;
}

/** Resolves `"providerId:modelKey"` to that model's prices, or `null`. */
export type PriceLookup = (model: string | undefined) => ModelPrices | null;

/** Money attributable to one line of the breakdown. */
export interface CostLines {
  freshInput: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface CostTotal {
  /** Dollars for every group that could be priced. */
  total: number;
  lines: CostLines;
  /** Requests included in {@link CostTotal.total}. */
  pricedRequests: number;
  /**
   * Requests whose model carries no pricing. Their tokens are NOT in the
   * total — the caller must say so rather than implying the total is whole.
   */
  unpricedRequests: number;
  /** Distinct models among the unpriced groups, for the disclosure line. */
  unpricedModels: string[];
  /** True when any priced request used estimated token counts. */
  estimated: boolean;
  /** Distinct priced models, so the UI can say a switch happened. */
  pricedModels: string[];
  /**
   * Dollars in {@link CostTotal.total} that came from the provider's own
   * reported cost rather than from catalog rates. The card distinguishes the
   * two because they carry different authority: one is the bill, the other is
   * a list price that a gateway may not charge.
   */
  reportedTotal: number;
  /** Requests priced from a provider-reported figure. */
  reportedRequests: number;
}

const EMPTY_LINES: CostLines = { freshInput: 0, cachedInput: 0, cacheWrite: 0, output: 0 };

/** A model with no usable pricing at all. */
function isPriceable(prices: ModelPrices | null): prices is ModelPrices {
  return (
    prices != null &&
    Number.isFinite(prices.cacheMissPerMtok) &&
    Number.isFinite(prices.outputPerMtok)
  );
}

/**
 * Fill in the two optional rates.
 *
 * Both cache rates default to the FRESH-INPUT rate, never to zero. Zero was
 * the previous behaviour by omission and it silently made every cached
 * conversation look cheaper than it was — cache reads are discounted, not
 * free, and cache writes usually cost at least the base rate.
 *
 * A provider that genuinely does not charge for one of these is expressed by
 * setting that price to `0` explicitly, which this preserves.
 */
function resolveRates(prices: ModelPrices) {
  const base = prices.cacheMissPerMtok ?? 0;
  return {
    fresh: base,
    output: prices.outputPerMtok ?? 0,
    cachedIn: prices.cacheHitPerMtok ?? base,
    cacheWrite: prices.cacheWritePerMtok ?? base,
  };
}

/** Tokens x USD-per-million. Guards non-finite inputs so one bad row cannot
 *  turn a whole total into `NaN` on screen. */
function money(tokens: number, perMtok: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(perMtok)) return 0;
  if (tokens <= 0 || perMtok <= 0) return 0;
  return (tokens * perMtok) / 1_000_000;
}

/**
 * Price a set of per-model groups and sum the money.
 *
 * Groups whose model has no pricing are counted in `unpricedRequests` and
 * left out of the total — deliberately, so a partially-priced conversation
 * reports "$4.20 + 3 requests not priced" instead of a confident $4.20 that
 * is quietly missing a model.
 */
export function priceUsage(groups: ModelUsageGroup[], lookup: PriceLookup): CostTotal {
  const lines: CostLines = { ...EMPTY_LINES };
  let pricedRequests = 0;
  let unpricedRequests = 0;
  let estimated = false;
  let reportedTotal = 0;
  let reportedRequests = 0;
  const pricedModels: string[] = [];
  const unpricedModels: string[] = [];

  for (const group of groups) {
    // The provider's own figure OUTRANKS every rate we hold. A catalog price
    // is what the model list says; this is what the account was charged, and
    // it already carries gateway markup, BYOK rates, promos and discounts
    // that no published rate can know about. Taken verbatim — the tokens in
    // this group are deliberately NOT priced, or the request would be counted
    // twice.
    if (typeof group.reportedCostUsd === "number" && Number.isFinite(group.reportedCostUsd)) {
      reportedTotal += Math.max(0, group.reportedCostUsd);
      reportedRequests += group.requests;
      pricedRequests += group.requests;
      if (group.estimatedRequests > 0) estimated = true;
      if (group.model && !pricedModels.includes(group.model)) {
        pricedModels.push(group.model);
      }
      continue;
    }
    const prices = lookup(group.model);
    if (!isPriceable(prices)) {
      unpricedRequests += group.requests;
      // An unattributed group has no model name to show; it is disclosed by
      // count alone rather than as a fake "unknown" entry in a model list.
      if (group.model && !unpricedModels.includes(group.model)) {
        unpricedModels.push(group.model);
      }
      continue;
    }
    const rate = resolveRates(prices);
    lines.freshInput += money(group.inputTokens, rate.fresh);
    lines.cachedInput += money(group.cacheReadTokens, rate.cachedIn);
    lines.cacheWrite += money(group.cacheWriteTokens, rate.cacheWrite);
    lines.output += money(group.outputTokens, rate.output);
    pricedRequests += group.requests;
    if (group.estimatedRequests > 0) estimated = true;
    if (group.model && !pricedModels.includes(group.model)) {
      pricedModels.push(group.model);
    }
  }

  return {
    // Reported dollars and computed dollars are disjoint by construction —
    // groups are split on which source priced them — so adding them cannot
    // double-count.
    total:
      reportedTotal + lines.freshInput + lines.cachedInput + lines.cacheWrite + lines.output,
    lines,
    pricedRequests,
    unpricedRequests,
    unpricedModels,
    estimated,
    pricedModels,
    reportedTotal,
    reportedRequests,
  };
}

/**
 * Format a dollar amount for display.
 *
 * Four decimals under $1 because per-turn costs genuinely live there and
 * rounding them to cents would show `$0.00` for a real charge. Anything that
 * would round to zero but is not zero reads `<$0.0001`, never `$0`.
 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  if (value < 1) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * How many decimals {@link formatCost} would use for a figure of this size.
 *
 * Exposed so a total and its component lines can be shown at ONE precision.
 * Formatted independently they drift into different bands — a $0.0002 line
 * under a $1.20 total — and a column at mixed precision can never be made to
 * add up.
 */
export function costPrecision(total: number): number {
  if (!Number.isFinite(total) || total < 1) return 4;
  if (total < 100) return 3;
  return 2;
}

/** Format at an explicit precision, for a column that must tally. */
export function formatCostAt(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return `$${value.toFixed(decimals)}`;
}

/**
 * Round line values so that, at display precision, they SUM TO THE TOTAL.
 *
 * Rounding each line on its own is what made a card read
 * `$0.0665 + $0.0028 + $0.0006` under a headline of `$0.0700` — arithmetic
 * that is correct to the last unrounded cent and visibly wrong to a person
 * adding up three numbers. Whoever is checking a cost card is, by definition,
 * checking; a column that does not tally is read as a bug in the figure, not
 * as a rounding artifact.
 *
 * The residual goes on the largest line: it is the one where a unit in the
 * last place is proportionally smallest, and it is never zero when there is a
 * residual to place. The TOTAL is never adjusted — it is the number that
 * matters and it stays exactly what was computed.
 */
export function alignLinesToTotal(values: number[], total: number): number[] {
  const scale = 10 ** costPrecision(total);
  const round = (n: number) =>
    Math.round((Number.isFinite(n) && n > 0 ? n : 0) * scale);

  const rounded = values.map(round);
  if (rounded.length === 0) return rounded;

  const residual = round(total) - rounded.reduce((sum, n) => sum + n, 0);
  if (residual !== 0) {
    let largest = 0;
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i] > rounded[largest]) largest = i;
    }
    // Never push a line negative. A residual big enough to do that means the
    // total and the lines disagree about more than rounding — leave both
    // alone and let the discrepancy be visible rather than hide it in a line.
    if (rounded[largest] + residual >= 0) rounded[largest] += residual;
  }
  return rounded.map((n) => n / scale);
}

/**
 * The human-readable half of a `"{providerId}:{modelKey}"` selection.
 *
 * A built-in provider's id is a readable slug, but a user-added one is a
 * generated UUID — so the raw selection reads
 * `6fa1043d-2c79-4867-8956-9645decd35e4:agnes-2.5-flash`, which tells a person
 * nothing and is long enough to stretch whatever it is rendered in. Only the
 * model key means anything at a glance.
 */
export function modelLabel(selection: string | undefined): string | null {
  if (!selection) return null;
  // First colon only — a provider id never contains one, a model key can.
  const split = selection.indexOf(":");
  const key = split > 0 ? selection.slice(split + 1) : selection;
  return key.trim() || null;
}

/** `"14 turns · 41 requests"`, pluralized, for the total's subline. */
export function formatRequestCount(turns: number, requests: number): string {
  const t = `${turns} ${turns === 1 ? "turn" : "turns"}`;
  const r = `${requests} ${requests === 1 ? "request" : "requests"}`;
  return `${t} · ${r}`;
}

/** Is there anything worth rendering? Keeps the card from showing a `$0` row
 *  for a conversation that simply has no pricing configured. */
export function hasCost(total: CostTotal): boolean {
  return total.total > 0 || total.unpricedRequests > 0;
}
