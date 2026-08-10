/**
 * Atlas Cloud — coding-plan usage service.
 *
 * Atlas Cloud meters the Coding Plan in *credits*, not tokens. That's opaque for
 * anyone who thinks in tokens, so this module fetches the plan + the real
 * per-request cost history and converts credits back into an honest token
 * estimate, using the user's OWN recent input/output/cache mix where possible.
 *
 * All calls go directly from the WebView with the provider API key as a Bearer
 * token. Atlas reflects the request Origin in `Access-Control-Allow-Origin` and
 * whitelists `Authorization`, so `fetch()` works from both the Vite dev origin
 * and the packaged `tauri.localhost` origin — no Rust proxy required.
 *
 * Endpoints (all authenticate with the plain provider API key):
 *   POST {origin}/api/v1/codeplan/get       → plan: daily/weekly/monthly quota + balance
 *   GET  {origin}/api/v1/codeplan/costs      → paginated per-request credit + token history
 *   GET  {origin}/public/v1/balance          → pay-as-you-go balance (fallback, no plan)
 *   GET  {origin}/api/v1/models?sort=new     → model catalog (pricing → credit multipliers)
 *
 * Credit rule (verified against real history):
 *   credits = input·mIn + output·mOut + cache·mCache
 *   where mX ≈ price_per_1M_tokensX × {@link CREDIT_PER_PRICE_UNIT}
 *   (Kimi K2.7 Code: in $0.95→1.72, out $4→7.26 — matches the console table.)
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

// ── Constants ────────────────────────────────────────────────────────────────

export const ATLAS_API_ORIGIN = "https://api.atlascloud.ai";
export const ATLAS_API_BASE = `${ATLAS_API_ORIGIN}/v1`;
export const ATLAS_CONSOLE_URL = "https://console.atlascloud.ai";
export const ATLAS_PROVIDER_ID = "atlascloud";

/**
 * Credits per (USD-per-1M-token) unit. Derived from the authoritative console
 * multiplier table: Kimi K2.7 Code lists input $0.95/1M → 1.72 credits/token and
 * output $4/1M → 7.26 credits/token, i.e. multiplier = price_per_1M × 1.815.
 */
export const CREDIT_PER_PRICE_UNIT = 1.815;

const REQUEST_TIMEOUT_MS = 20_000;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

// ── Raw wire types (Atlas returns numbers as strings) ────────────────────────

type Num = string | number | null | undefined;

interface RawCodePlan {
  SubscriptionID?: Num;
  AccountID?: Num;
  PlanID?: Num;
  AutoRenewal?: boolean;
  CreatedAt?: Num;
  StartedAt?: Num;
  ExpiredAt?: Num;
  PlanName?: string;
  plan_uuid?: string;
  PlanType?: string;
  Price?: Num;
  DailyQuota?: Num;
  total_quota?: Num;
  PackageQuota?: Num;
  balance?: Num;
  used_quota?: Num;
  weekly_quota?: Num;
  Status?: string;
  weekly_cap?: Num;
  weekly_used?: Num;
  weekly_remaining?: Num;
}

interface RawCostUsage {
  input?: Num;
  output?: Num;
  cache?: Num;
}

interface RawCostItem {
  finishTime?: Num;
  chatId?: string;
  model?: string;
  modelCost?: Num;
  amount?: Num;
  remain?: Num;
  usage?: RawCostUsage;
  apikeyName?: string;
}

interface RawModel {
  model?: string;
  type?: string;
  displayName?: string;
  organization?: string;
  avatar?: string;
  contextLength?: Num;
  maxCompletionTokens?: Num;
  tags?: string[];
  price?: { actual?: { input_price?: Num; output_price?: Num; cache_price?: Num } };
}

// ── Normalized types ─────────────────────────────────────────────────────────

export interface AtlasCodePlan {
  planName: string;
  planType: string;
  status: string;
  accountId: number;
  priceUsd: number;
  /** Remaining monthly credits. */
  balance: number;
  /** Total monthly credit allowance. */
  totalQuota: number;
  usedQuota: number;
  dailyQuota: number;
  weeklyCap: number;
  weeklyUsed: number;
  weeklyRemaining: number;
  startedAt: number;
  expiredAt: number;
}

export interface AtlasCostItem {
  finishTime: number;
  chatId: string;
  model: string;
  credits: number;
  input: number;
  output: number;
  cache: number;
  apiKeyName: string;
}

export interface AtlasBalance {
  accountId: string;
  accountName: string;
  accountType: string;
  availableUsd: number;
  subscriptionBonusUsd: number;
}

export interface AtlasModel {
  id: string;
  displayName: string;
  organization: string;
  avatar?: string;
  contextLength: number;
  maxOutputTokens: number;
  tags: string[];
  /** USD per 1M tokens. */
  inputPrice: number;
  outputPrice: number;
  cachePrice: number;
}

/** Per-token credit multipliers for a model. */
export interface AtlasMultipliers {
  input: number;
  output: number;
  cache: number;
}

export interface AtlasUsageSummary {
  requests: number;
  input: number;
  output: number;
  cache: number;
  credits: number;
  /** Aggregated per model, richest-first by credits. */
  byModel: AtlasModelUsage[];
}

export interface AtlasModelUsage {
  model: string;
  requests: number;
  input: number;
  output: number;
  cache: number;
  credits: number;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class AtlasError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AtlasError";
    this.status = status;
  }
}

// ── Provider detection / origin ──────────────────────────────────────────────

export function isAtlasCloudProvider(provider: { id?: string; baseUrl?: string }): boolean {
  if (provider.id === ATLAS_PROVIDER_ID) return true;
  const host = safeHost(provider.baseUrl);
  return host !== null && /(^|\.)atlascloud\.ai$/.test(host);
}

/** Resolve the API origin (scheme + host) from a provider base URL. */
export function deriveAtlasOrigin(baseUrl?: string): string {
  const host = safeHost(baseUrl);
  if (host !== null && /(^|\.)atlascloud\.ai$/.test(host)) {
    try {
      return new URL(baseUrl as string).origin;
    } catch {
      /* fall through */
    }
  }
  return ATLAS_API_ORIGIN;
}

function safeHost(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

// ── Low-level fetch ──────────────────────────────────────────────────────────

async function atlasFetch(
  url: string,
  key: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AtlasError(atlasHttpMessage(res.status, body), res.status);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof AtlasError) throw err;
    if ((err as { name?: string })?.name === "AbortError") {
      throw new AtlasError("Request cancelled");
    }
    throw new AtlasError((err as Error)?.message || "Network request failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function atlasHttpMessage(status: number, body: string): string {
  if (status === 401 || status === 403) return "Invalid or unauthorized API key.";
  if (status === 429) return "Rate limited by Atlas Cloud — try again shortly.";
  const snippet = body.slice(0, 120).replace(/\s+/g, " ").trim();
  return `Atlas Cloud request failed (${status})${snippet ? `: ${snippet}` : ""}`;
}

function num(v: Num): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Coding plan ──────────────────────────────────────────────────────────────

/** Fetch the active coding plan, or `null` when the account has no plan. */
export async function fetchCodePlan(
  origin: string,
  key: string,
  signal?: AbortSignal,
): Promise<AtlasCodePlan | null> {
  const json = (await atlasFetch(
    `${origin}/api/v1/codeplan/get`,
    key,
    { method: "POST", body: "" },
    signal,
  )) as { data?: RawCodePlan[] };
  const raw = json?.data?.[0];
  if (!raw) return null;
  return {
    planName: raw.PlanName ?? "Coding Plan",
    planType: raw.PlanType ?? "monthly",
    status: raw.Status ?? "active",
    accountId: num(raw.AccountID),
    priceUsd: num(raw.Price),
    balance: num(raw.balance),
    totalQuota: num(raw.total_quota),
    usedQuota: num(raw.used_quota),
    dailyQuota: num(raw.DailyQuota),
    weeklyCap: num(raw.weekly_cap ?? raw.weekly_quota),
    weeklyUsed: num(raw.weekly_used),
    weeklyRemaining: num(raw.weekly_remaining),
    startedAt: num(raw.StartedAt),
    expiredAt: num(raw.ExpiredAt),
  };
}

// ── Cost history ─────────────────────────────────────────────────────────────

interface CostsQuery {
  startTime: number;
  endTime: number;
  pageNo?: number;
  pageSize?: number;
}

async function fetchCostsPage(
  origin: string,
  key: string,
  q: CostsQuery,
  signal?: AbortSignal,
): Promise<{ items: AtlasCostItem[]; total: number }> {
  const params = new URLSearchParams({
    pageNo: String(q.pageNo ?? 1),
    pageSize: String(q.pageSize ?? 100),
    startTime: String(q.startTime),
    endTime: String(q.endTime),
  });
  const json = (await atlasFetch(
    `${origin}/api/v1/codeplan/costs?${params.toString()}`,
    key,
    { method: "GET" },
    signal,
  )) as { data?: { total?: Num; items?: RawCostItem[] } };
  const items = (json?.data?.items ?? []).map(normalizeCostItem);
  return { items, total: num(json?.data?.total) };
}

function normalizeCostItem(raw: RawCostItem): AtlasCostItem {
  return {
    finishTime: num(raw.finishTime),
    chatId: raw.chatId ?? "",
    model: raw.model ?? "unknown",
    credits: num(raw.modelCost ?? raw.amount),
    input: num(raw.usage?.input),
    output: num(raw.usage?.output),
    cache: num(raw.usage?.cache),
    apiKeyName: raw.apikeyName ?? "",
  };
}

/** Page through the full cost history in a window (bounded to `maxPages`). */
export async function fetchAllCosts(
  origin: string,
  key: string,
  q: CostsQuery & { maxPages?: number },
  signal?: AbortSignal,
): Promise<AtlasCostItem[]> {
  const pageSize = q.pageSize ?? 100;
  const maxPages = q.maxPages ?? 8;
  const first = await fetchCostsPage(origin, key, { ...q, pageNo: 1, pageSize }, signal);
  const out = [...first.items];
  const pages = Math.min(maxPages, Math.ceil(first.total / pageSize) || 1);
  for (let p = 2; p <= pages; p++) {
    const page = await fetchCostsPage(origin, key, { ...q, pageNo: p, pageSize }, signal);
    out.push(...page.items);
    if (page.items.length === 0) break;
  }
  return out;
}

// ── Balance (pay-as-you-go fallback) ─────────────────────────────────────────

export async function fetchBalance(
  origin: string,
  key: string,
  signal?: AbortSignal,
): Promise<AtlasBalance> {
  const json = (await atlasFetch(
    `${origin}/public/v1/balance`,
    key,
    { method: "GET" },
    signal,
  )) as {
    account?: { id?: string; name?: string; type?: string };
    available?: { value?: Num };
    subscription_bonus?: { value?: Num };
  };
  return {
    accountId: json?.account?.id ?? "",
    accountName: json?.account?.name ?? "",
    accountType: json?.account?.type ?? "",
    availableUsd: num(json?.available?.value),
    subscriptionBonusUsd: num(json?.subscription_bonus?.value),
  };
}

// ── Model catalog (pricing → multipliers) ────────────────────────────────────

const modelsCache = new Map<string, { at: number; models: AtlasModel[] }>();

/** Fetch the Text (LLM) model catalog; cached per-origin for a few minutes. */
export async function fetchAtlasTextModels(
  origin: string,
  key: string,
  signal?: AbortSignal,
): Promise<AtlasModel[]> {
  const cached = modelsCache.get(origin);
  if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) return cached.models;
  const json = (await atlasFetch(
    `${origin}/api/v1/models?sort=new`,
    key,
    { method: "GET" },
    signal,
  )) as { data?: RawModel[] };
  const models = (json?.data ?? [])
    .filter((m) => m.type === "Text")
    .map(normalizeModel)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  modelsCache.set(origin, { at: Date.now(), models });
  return models;
}

function normalizeModel(raw: RawModel): AtlasModel {
  const p = raw.price?.actual ?? {};
  return {
    id: raw.model ?? "",
    displayName: raw.displayName || (raw.model ?? "Model"),
    organization: raw.organization ?? "",
    avatar: raw.avatar,
    contextLength: num(raw.contextLength),
    maxOutputTokens: num(raw.maxCompletionTokens),
    tags: raw.tags ?? [],
    inputPrice: num(p.input_price),
    outputPrice: num(p.output_price),
    cachePrice: num(p.cache_price),
  };
}

// ── Credit ⇄ token math ──────────────────────────────────────────────────────

/** Per-token credit multipliers from a model's USD pricing. */
export function multipliersFromPrice(model: AtlasModel): AtlasMultipliers {
  return {
    input: model.inputPrice * CREDIT_PER_PRICE_UNIT,
    output: model.outputPrice * CREDIT_PER_PRICE_UNIT,
    cache: model.cachePrice * CREDIT_PER_PRICE_UNIT,
  };
}

/**
 * Effective credits-per-token for a set of history items (optionally filtered to
 * one model). This is the *honest* rate — it already reflects the real
 * input/output/cache mix — so `credits / rate` answers "how many tokens can I
 * still run". Returns `null` when there aren't enough tokens to be meaningful.
 */
export function effectiveRate(items: AtlasCostItem[], model?: string): number | null {
  let credits = 0;
  let tokens = 0;
  for (const it of items) {
    if (model && it.model !== model) continue;
    credits += it.credits;
    tokens += it.input + it.output + it.cache;
  }
  if (tokens < 500 || credits <= 0) return null;
  return credits / tokens;
}

/** Convert remaining credits into a token estimate at a credits/token rate. */
export function creditsToTokens(credits: number, rate: number | null): number | null {
  if (rate == null || rate <= 0) return null;
  return Math.max(0, Math.round(credits / rate));
}

/** Aggregate cost history into totals + per-model breakdown. */
export function summarizeCosts(items: AtlasCostItem[]): AtlasUsageSummary {
  const perModel = new Map<string, AtlasModelUsage>();
  let requests = 0;
  let input = 0;
  let output = 0;
  let cache = 0;
  let credits = 0;
  for (const it of items) {
    requests += 1;
    input += it.input;
    output += it.output;
    cache += it.cache;
    credits += it.credits;
    const m = perModel.get(it.model) ?? {
      model: it.model,
      requests: 0,
      input: 0,
      output: 0,
      cache: 0,
      credits: 0,
    };
    m.requests += 1;
    m.input += it.input;
    m.output += it.output;
    m.cache += it.cache;
    m.credits += it.credits;
    perModel.set(it.model, m);
  }
  return {
    requests,
    input,
    output,
    cache,
    credits,
    byModel: [...perModel.values()].sort((a, b) => b.credits - a.credits),
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** 1_424_794 → "1.42M", 82_500_000 → "82.5M", 950 → "950". */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Compact relative time: "3m", "5h", "2d". */
export function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** "moonshotai/kimi-k2.7-code" → "kimi-k2.7-code". */
export function shortModel(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

// ── Seeded provider preset ───────────────────────────────────────────────────

interface Seed {
  id: string;
  alias: string;
  in: number;
  out: number;
  cache: number;
}

/**
 * Curated coding/agentic LLMs on Atlas Cloud, seeded with normal (non-`-coding`)
 * model ids — the ids the OpenAI-compatible endpoint accepts. Pricing (USD/1M)
 * comes straight from the console catalog so cost badges are correct on first
 * run; everything is user-overridable.
 */
const ATLAS_SEED_MODELS: Seed[] = [
  { id: "zai-org/glm-5.2", alias: "GLM 5.2", in: 1.33, out: 4.18, cache: 0.247 },
  { id: "zai-org/glm-4.7", alias: "GLM 4.7", in: 0.52, out: 1.85, cache: 0.12 },
  { id: "moonshotai/kimi-k2.7-code", alias: "Kimi K2.7 Code", in: 0.95, out: 4, cache: 0.16 },
  { id: "moonshotai/kimi-k2.5", alias: "Kimi K2.5", in: 0.49, out: 2.5, cache: 0.2 },
  { id: "anthropic/claude-sonnet-4.6", alias: "Claude Sonnet 4.6", in: 3, out: 15, cache: 0.3 },
  { id: "anthropic/claude-opus-4.8", alias: "Claude Opus 4.8", in: 5, out: 25, cache: 0.5 },
  { id: "deepseek-ai/DeepSeek-V3.1-Terminus", alias: "DeepSeek V3.1 Terminus", in: 0.3, out: 0.95, cache: 0.13 },
  { id: "Qwen/Qwen3-Coder", alias: "Qwen3 Coder", in: 0.78, out: 3.8, cache: 0.2 },
  { id: "qwen/qwen3-coder-next", alias: "Qwen3 Coder Next", in: 0.18, out: 1.35, cache: 0.18 },
  { id: "minimaxai/minimax-m2.7", alias: "MiniMax M2.7", in: 0.3, out: 1.2, cache: 0.06 },
  { id: "xai/grok-4.3", alias: "Grok 4.3", in: 1.25, out: 2.5, cache: 0.2 },
  { id: "meituan-longcat/longcat-2.0", alias: "LongCat 2.0", in: 0.3, out: 1.18, cache: 0.006 },
];

export const ATLAS_CLOUD_PRESET: ProviderCatalogPreset = {
  id: ATLAS_PROVIDER_ID,
  name: "Atlas Cloud",
  nickname: "Atlas Cloud",
  baseUrl: ATLAS_API_BASE,
  model: ATLAS_SEED_MODELS[0].id,
  contextWindow: 262144,
  maxOutputTokens: 65536,
  supportsThinking: true,
  supportsToolStream: true,
  providerType: "openai",
  requiresApiKey: true,
  customModels: ATLAS_SEED_MODELS.map((m) => m.id),
  modelAliases: Object.fromEntries(ATLAS_SEED_MODELS.map((m) => [m.id, m.alias])),
  modelPricing: Object.fromEntries(
    ATLAS_SEED_MODELS.map((m) => [
      m.id,
      { cacheHitPerMtok: m.cache, cacheMissPerMtok: m.in, outputPerMtok: m.out },
    ]),
  ),
};
