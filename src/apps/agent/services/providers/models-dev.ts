/**
 * models.dev catalog — model metadata auto-fill.
 *
 * Fetches the public models.dev database (`api.json`, CORS-open) once, normalizes
 * each model to Aurora's shape, and caches a slim index in localStorage (24h TTL,
 * falls back to stale on network failure). Powers the "add a model and it
 * auto-fills" flow in Provider settings — context window, output limit, vision /
 * tool-calling / reasoning capability, pricing, and the reasoning levels that
 * drive the composer's reasoning picker. Every field stays user-overridable.
 */

import type { ModelReasoning } from "@/kernel/types/database";

const API_URL = "https://models.dev/api.json";
// v2: the cache stores ALREADY-NORMALIZED entries, so a fix to normalization
// does not reach anyone holding a v1 copy until its 24h TTL runs out. Bumped
// when zero-cost placeholders stopped being read as a price of zero.
const CACHE_KEY = "aurora-modelsdev-cache-v2";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** A models.dev model normalized to the fields Aurora stores. */
export interface ModelsDevEntry {
  /** API model identifier (what you send as `model`). */
  modelKey: string;
  /** Human label. */
  name: string;
  /** models.dev provider id (e.g. "anthropic", "openai"). */
  providerId: string;
  /** models.dev provider display name. */
  providerName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsToolStream: boolean;
  priceCacheHitPerMtok?: number;
  priceCacheMissPerMtok?: number;
  priceOutputPerMtok?: number;
  /** USD per 1M cache-CREATION tokens. Published for ~1,200 models
   *  (every Anthropic one); absent elsewhere, where the cost math falls
   *  back to the fresh-input rate. */
  priceCacheWritePerMtok?: number;
  reasoning?: ModelReasoning;
}

/**
 * A published rate, or `undefined` when the catalogue has no real answer.
 *
 * **Zero is not a price.** models.dev carries a `kenari` provider whose 38
 * models are ALL listed as `{input: 0, output: 0}` — kenari bills in Rupiah and
 * this schema is USD, so those entries hold a placeholder rather than a rate.
 * Copying it through is how a paid model ends up showing "$0 / $0" and every
 * conversation on it reports as free.
 *
 * Unknown is the better answer, and the UI already handles it properly: the
 * price chip shows a dash and the cost card says "no price set — add one in
 * Settings › Providers", which is something a person can act on. `$0.0000`
 * looks measured and is silently wrong, which is the class of bug the cost work
 * exists to remove.
 *
 * A genuinely free model loses nothing worth having: it gets that same note
 * instead of a zero.
 */
const rate = (value: number | undefined): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined;

// ── Raw API shapes (only the fields we read) ─────────────────────────────────

interface RawReasoningOption {
  type: string; // "effort" | "toggle" | "budget_tokens"
  values?: string[];
  min?: number;
  max?: number;
}
interface RawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: RawReasoningOption[];
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  /** `cache_write` is a real, separately-billed rate — Anthropic charges
   *  1.25x input for it. Dropping it priced cache creation at zero and
   *  understated every cached conversation. */
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}
interface RawProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModel>;
}
type RawCatalog = Record<string, RawProvider>;

// ── Normalization ────────────────────────────────────────────────────────────

function normalizeReasoning(m: RawModel): ModelReasoning | undefined {
  if (!m.reasoning) return undefined;
  const opts = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];

  const effort = opts.find((o) => o.type === "effort");
  const budget = opts.find((o) => o.type === "budget_tokens");
  const toggle = opts.find((o) => o.type === "toggle");

  // EVERY control this model declares — not just the one Aurora picks as the
  // default. The settings form renders the reasoning-type choices from this,
  // so a model is never offered a control it doesn't have: `budget` on a
  // Claude 4.7+ model would be silently dropped on the wire, and the user
  // would have no way to know the number they typed did nothing.
  const supported: ModelReasoning["supported"] = [];
  if (effort?.values?.length) supported.push("effort");
  if (budget) supported.push("budget");
  if (toggle) supported.push("toggle");

  // Reasoning can be switched off only if models.dev says so. A model that
  // declares effort but no toggle always reasons — there is nothing to switch.
  const toggleable = supported.includes("toggle");

  if (effort?.values?.length) {
    const levels = effort.values;
    const def = levels.includes("medium") ? "medium" : levels[levels.length - 1];
    return { type: "effort", levels, default: def, supported, toggleable };
  }

  if (budget) {
    const max = typeof budget.max === "number" ? budget.max : undefined;
    const min = typeof budget.min === "number" ? budget.min : undefined;
    const def = max ? Math.min(16000, max) : (min ?? 8192);
    return { type: "budget", min, max, default: def, supported, toggleable };
  }

  // Bare `reasoning: true` or a plain toggle → on/off.
  return {
    type: "toggle",
    default: true,
    supported: supported.length > 0 ? supported : ["toggle"],
    toggleable: true,
  };
}

function normalize(catalog: RawCatalog): ModelsDevEntry[] {
  const out: ModelsDevEntry[] = [];
  for (const provider of Object.values(catalog)) {
    const providerId = provider.id ?? "";
    const providerName = provider.name ?? providerId;
    for (const m of Object.values(provider.models ?? {})) {
      const modelKey = m.id;
      if (!modelKey) continue;
      const input = m.modalities?.input ?? [];
      out.push({
        modelKey,
        name: m.name ?? modelKey,
        providerId,
        providerName,
        contextWindow: m.limit?.context,
        maxOutputTokens: m.limit?.output,
        supportsVision: input.includes("image"),
        supportsThinking: !!m.reasoning,
        supportsToolStream: !!m.tool_call,
        priceCacheMissPerMtok: rate(m.cost?.input),
        priceCacheHitPerMtok: rate(m.cost?.cache_read),
        priceOutputPerMtok: rate(m.cost?.output),
        priceCacheWritePerMtok: rate(m.cost?.cache_write),
        reasoning: normalizeReasoning(m),
      });
    }
  }
  return out;
}

// ── Cache + fetch ────────────────────────────────────────────────────────────

interface CacheShape {
  fetchedAt: number;
  entries: ModelsDevEntry[];
}

let memo: ModelsDevEntry[] | null = null;
let inflight: Promise<ModelsDevEntry[]> | null = null;

function readCache(): CacheShape | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(entries: ModelsDevEntry[]): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), entries } satisfies CacheShape),
    );
  } catch {
    /* quota — fine, we keep the in-memory copy */
  }
}

/**
 * Load the catalog: in-memory → fresh localStorage → network. On a network
 * failure we serve stale cache if we have any, so the picker still works offline.
 */
export async function ensureModelsCatalog(force = false): Promise<ModelsDevEntry[]> {
  if (memo && !force) return memo;

  const cached = readCache();
  if (cached && !force && Date.now() - cached.fetchedAt < TTL_MS) {
    memo = cached.entries;
    return memo;
  }

  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(API_URL, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      const entries = normalize((await res.json()) as RawCatalog);
      memo = entries;
      writeCache(entries);
      return entries;
    } catch (err) {
      // Network/parse failure → fall back to any cache (even if stale).
      if (cached?.entries.length) {
        memo = cached.entries;
        return memo;
      }
      console.warn("[models.dev] catalog fetch failed:", err);
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Whether an entry's published limits can both be true.
 *
 * Output tokens are drawn from the context window — the reply and the prompt
 * share it — so a model cannot emit as many tokens as its whole window holds.
 * An entry saying otherwise has copied the context number into the output slot,
 * and its limits carry no information.
 *
 * Real: models.dev lists `glm-5.2` under 30 providers. `neuralwatt` publishes
 * `context 1,048,560 / output 1,048,560`, and it happens to sort first.
 */
function limitsAreCoherent(e: ModelsDevEntry): boolean {
  const ctx = e.contextWindow;
  const out = e.maxOutputTokens;
  if (typeof ctx !== "number" || typeof out !== "number") return true;
  return out > 0 && ctx > 0 && out < ctx;
}

/**
 * The value the most providers agree on, ties broken by taking the smallest.
 *
 * Smallest on a tie because the two errors are not symmetric: an output cap
 * larger than the endpoint serves is a hard 400 that kills the turn, while one
 * smaller than it had to be costs a slightly shorter reply. The same asymmetry
 * governs `context_limits.rs`'s SAFETY_MARGIN on the Rust side.
 */
function consensus(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const tally = new Map<number, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of tally) {
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Token limits for a model id, agreed across every provider that serves it.
 *
 * **Limits belong to the model, prices belong to the reseller.** Which provider
 * entry we return still decides pricing and capabilities — those genuinely
 * differ per host. The context and output ceilings do not: they are properties
 * of the weights, and one provider's broken row should not become Aurora's
 * answer just because it sorted first.
 *
 * Measured on the live catalogue: of the 30 providers publishing `glm-5.2`,
 * 20 say output = 131,072. Aurora used to take `matches[0]` — 1,048,560, from
 * the one provider whose row is self-contradictory — and then sent it as
 * `max_tokens`, which no endpoint serving that model accepts. Every turn on
 * that model died on a 400 before a token was generated.
 */
function agreedLimits(matches: ModelsDevEntry[]): {
  contextWindow?: number;
  maxOutputTokens?: number;
} {
  const usable = matches.filter(limitsAreCoherent);
  // Nothing coherent to vote on — say nothing rather than pass on a number we
  // have just decided is meaningless. The fields stay empty and overridable.
  if (usable.length === 0) return {};
  return {
    contextWindow: consensus(
      usable.map((e) => e.contextWindow).filter((v): v is number => typeof v === "number"),
    ),
    maxOutputTokens: consensus(
      usable.map((e) => e.maxOutputTokens).filter((v): v is number => typeof v === "number"),
    ),
  };
}

/**
 * Case-insensitive lookup by exact model key. `providerHint` is preferred when
 * several providers expose the same id.
 *
 * The chosen entry supplies pricing, capabilities and reasoning — all of which
 * are the host's own. Its token limits are replaced by what the field agrees
 * on; see [`agreedLimits`] for why those two halves are resolved differently.
 */
export async function lookupModel(
  modelKey: string,
  providerHint?: string,
): Promise<ModelsDevEntry | null> {
  const key = modelKey.trim().toLowerCase();
  if (!key) return null;
  const all = await ensureModelsCatalog();
  const matches = all.filter((e) => e.modelKey.toLowerCase() === key);
  if (matches.length === 0) return null;
  const hint = providerHint?.toLowerCase();
  const chosen =
    (hint ? matches.find((e) => e.providerId.toLowerCase().includes(hint)) : undefined) ??
    matches[0];
  return { ...chosen, ...agreedLimits(matches) };
}

/** Typeahead: rank by prefix then substring over id + name. De-dupes by model key. */
export async function searchModels(query: string, limit = 24): Promise<ModelsDevEntry[]> {
  const q = query.trim().toLowerCase();
  const all = await ensureModelsCatalog();
  const seen = new Set<string>();
  const dedup = all.filter((e) => {
    if (seen.has(e.modelKey)) return false;
    seen.add(e.modelKey);
    return true;
  });
  if (!q) return dedup.slice(0, limit);
  const scored = dedup
    .map((e) => {
      const key = e.modelKey.toLowerCase();
      const name = e.name.toLowerCase();
      let score = -1;
      if (key === q) score = 0;
      else if (key.startsWith(q)) score = 1;
      else if (name.startsWith(q)) score = 2;
      else if (key.includes(q)) score = 3;
      else if (name.includes(q)) score = 4;
      return { e, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.e.modelKey.localeCompare(b.e.modelKey));
  return scored.slice(0, limit).map((x) => x.e);
}

/** Internals exposed for tests only — not part of this module's public surface. */
export const __testing = { rate, agreedLimits, consensus, limitsAreCoherent };
