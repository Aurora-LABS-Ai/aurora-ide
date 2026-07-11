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

import type { ModelReasoning } from "../types/database";

const API_URL = "https://models.dev/api.json";
const CACHE_KEY = "aurora-modelsdev-cache-v1";
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
  reasoning?: ModelReasoning;
}

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
  cost?: { input?: number; output?: number; cache_read?: number };
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
  if (effort?.values?.length) {
    const levels = effort.values;
    const def = levels.includes("medium") ? "medium" : levels[levels.length - 1];
    return { type: "effort", levels, default: def };
  }

  const budget = opts.find((o) => o.type === "budget_tokens");
  if (budget) {
    const max = typeof budget.max === "number" ? budget.max : undefined;
    const min = typeof budget.min === "number" ? budget.min : undefined;
    const def = max ? Math.min(16000, max) : (min ?? 8192);
    return { type: "budget", min, max, default: def };
  }

  // Bare `reasoning: true` or a plain toggle → on/off.
  return { type: "toggle", default: true };
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
        priceCacheMissPerMtok: m.cost?.input,
        priceCacheHitPerMtok: m.cost?.cache_read,
        priceOutputPerMtok: m.cost?.output,
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

/** Case-insensitive lookup by exact model key. `providerHint` is preferred when several providers expose the same id. */
export async function lookupModel(
  modelKey: string,
  providerHint?: string,
): Promise<ModelsDevEntry | null> {
  const key = modelKey.trim().toLowerCase();
  if (!key) return null;
  const all = await ensureModelsCatalog();
  const matches = all.filter((e) => e.modelKey.toLowerCase() === key);
  if (matches.length === 0) return null;
  if (providerHint) {
    const hint = providerHint.toLowerCase();
    const preferred = matches.find((e) => e.providerId.toLowerCase().includes(hint));
    if (preferred) return preferred;
  }
  return matches[0];
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
