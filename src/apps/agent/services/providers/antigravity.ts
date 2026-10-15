/**
 * Antigravity (Google account) — provider service.
 *
 * Gemini, Claude and GPT-OSS models on a Google account's Antigravity plan,
 * no API key. Auth lives in Rust (`api::antigravity`) in Aurora's OWN account
 * list; several accounts can be stored and one of them (main) serves chats.
 *
 * Two ways in. Sign in opens Google's page in the browser and Aurora waits
 * for it to come back. Import copies the account Antigravity IDE is signed
 * into: its settings are read once, never written.
 *
 * The model list is the account's, pulled after sign-in: exactly the models
 * Antigravity's own picker offers, with each one's limits. Quota is per model
 * GROUP (Gemini; Claude and GPT), read from `retrieveUserQuotaSummary`: a paid
 * plan has a weekly and a 5-hour bucket in each, a free plan the weekly only.
 * The card shows every bucket; the composer ring shows the 5-hour ones.
 */

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import type { ModelReasoning } from "@/kernel/types/database";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import { useAgentSettingsStore, type LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { ANTIGRAVITY_PROVIDER_ID } from "@/apps/agent/services/providers/presets/antigravity";

export { ANTIGRAVITY_PRESET, ANTIGRAVITY_PROVIDER_ID } from "@/apps/agent/services/providers/presets/antigravity";

// ── Wire types (mirror Rust `api::antigravity`) ──────────────────────────────

export interface AntigravityAuthStatus {
  signedIn: boolean;
  email: string | null;
  name: string | null;
  projectId: string | null;
  /** `free-tier`, `standard-tier`, … */
  tierId: string | null;
  /** The plan's own name, e.g. "Antigravity Starter Quota". */
  tierName: string | null;
  expiresAtMs: number | null;
  signedInAt: string | null;
  lastRefresh: string | null;
}

/** How an account arrived. An import shares Antigravity IDE's sign-in. */
export type AntigravityAccountSource = "sign-in" | "antigravity-import";

export interface AntigravityAccountRow {
  id: string;
  addedAt: string;
  source: AntigravityAccountSource;
  /** The account chats go to. Exactly one row is true. */
  isMain: boolean;
  status: AntigravityAuthStatus;
  /** 0–100: the least quota left on any of its models. */
  lowestRemainingPercent: number | null;
  quotaError: string | null;
}

export interface AntigravityModel {
  id: string;
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsImages: boolean;
  supportsThinking: boolean;
  /** `google`, `anthropic`, `openai`, … */
  vendor: string | null;
  /** 0–100. Null when the account reported none. */
  remainingPercent: number | null;
  /** RFC 3339, when the quota refills. */
  resetsAt: string | null;
  /** The backend's own label for a notice on this model, e.g. "Leaving Soon". */
  noticeTitle: string | null;
  notice: string | null;
}

export interface AntigravityCatalogue {
  models: AntigravityModel[];
  defaultModelId: string | null;
  fetchedAtMs: number;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function antigravityAuthStatus(): Promise<AntigravityAuthStatus> {
  return invoke<AntigravityAuthStatus>("antigravity_auth_status");
}

/** Opens Google's sign-in in the browser and resolves once it comes back. */
export function antigravityAuthLogin(): Promise<AntigravityAuthStatus> {
  return invoke<AntigravityAuthStatus>("antigravity_auth_login");
}

export function antigravityAuthCancelLogin(): Promise<void> {
  return invoke<void>("antigravity_auth_cancel_login");
}

/** Forgets the main account in Aurora. Antigravity IDE stays signed in. */
export function antigravityAuthLogout(): Promise<void> {
  return invoke<void>("antigravity_auth_logout");
}

export function antigravityAccountsList(): Promise<AntigravityAccountRow[]> {
  return invoke<AntigravityAccountRow[]>("antigravity_accounts_list");
}

export function antigravityAccountSetMain(id: string): Promise<void> {
  return invoke<void>("antigravity_account_set_main", { id });
}

export function antigravityAccountRemove(id: string): Promise<void> {
  return invoke<void>("antigravity_account_remove", { id });
}

/** Copies the account Antigravity IDE is signed into. Never writes its settings. */
export function antigravityAccountImportIde(): Promise<AntigravityAuthStatus> {
  return invoke<AntigravityAuthStatus>("antigravity_account_import_ide");
}

/** The main account's models, with the quota left on each. */
export function antigravityModelsList(): Promise<AntigravityCatalogue> {
  return invoke<AntigravityCatalogue>("antigravity_models_list");
}

// ── Detection / formatting ───────────────────────────────────────────────────

export function isAntigravityProvider(provider: { id?: string }): boolean {
  return provider.id === ANTIGRAVITY_PROVIDER_ID;
}

/**
 * The plan line on the card. The backend's own name when it sends one;
 * otherwise the tier id made readable (`free-tier` → "Free").
 */
export function antigravityPlanLabel(status: AntigravityAuthStatus | null | undefined): string | null {
  if (!status) return null;
  if (status.tierName?.trim()) return status.tierName.trim();
  const id = status.tierId?.trim();
  if (!id) return null;
  const words = id.replace(/-tier$/, "").split(/[-_]/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** "resets in 6d 4h", or null when the account did not say. */
export function antigravityResetLabel(resetsAt: string | null, nowMs = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const secs = Math.round((at - nowMs) / 1000);
  if (secs <= 0) return "resets now";
  return `resets in ${fmtDuration(secs)}`;
}

/** One quota window, as `retrieveUserQuotaSummary` reports it. */
export interface AntigravityQuotaBucket {
  /** `gemini-weekly`, `3p-5h`, … */
  id: string;
  /** The backend's own label, e.g. "Five Hour Limit Remaining". */
  label: string;
  /** `weekly`, `5h`, … */
  window: string;
  /** 0–100 left. */
  remainingPercent: number;
  resetsAt: string | null;
}

/** Models that share their limits: "Gemini Models", "Claude and GPT models". */
export interface AntigravityQuotaGroup {
  name: string;
  description: string | null;
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityQuota {
  groups: AntigravityQuotaGroup[];
  /** The plan name ("Google AI Pro") from the stored sign-in, when known. */
  plan: string | null;
  fetchedAtMs: number;
}

/**
 * The main account's quota. A paid plan has a weekly and a 5-hour bucket per
 * group; a free one only the weekly.
 */
export function antigravityQuotaGet(): Promise<AntigravityQuota> {
  return invoke<AntigravityQuota>("antigravity_quota_get");
}

/** "Weekly limit", "5-hour limit"; the backend's own label for anything else. */
export function antigravityBucketLabel(bucket: AntigravityQuotaBucket): string {
  if (bucket.window === "weekly") return "Weekly limit";
  if (bucket.window === "5h") return "5-hour limit";
  return bucket.label.replace(/\s+Remaining$/i, "");
}

/** One line under a bucket's meter: "98% left · resets in 6d 4h". */
export function antigravityBucketMeta(bucket: AntigravityQuotaBucket, nowMs = Date.now()): string {
  const left = `${Math.round(Math.min(100, Math.max(0, bucket.remainingPercent)))}% left`;
  const reset = antigravityResetLabel(bucket.resetsAt, nowMs);
  return reset ? `${left} · ${reset}` : left;
}

/**
 * The bucket the composer ring shows for a group: the 5-hour one, which is
 * what stops the next turn. A plan without one (free) shows its weekly.
 */
export function antigravityRingBucket(group: AntigravityQuotaGroup): AntigravityQuotaBucket | null {
  return group.buckets.find((b) => b.window === "5h") ?? group.buckets[0] ?? null;
}

/**
 * Notices the backend attached to models, one per distinct text, naming the
 * models each applies to. They are the account's own warnings (a model
 * leaving, a plan losing access on a date) and belong on the card verbatim.
 */
export function antigravityNotices(
  models: readonly AntigravityModel[],
): Array<{ title: string; text: string; models: string[] }> {
  const byText = new Map<string, { title: string; text: string; models: string[] }>();
  for (const m of models) {
    if (!m.notice) continue;
    const entry = byText.get(m.notice) ?? { title: m.noticeTitle ?? "Notice", text: m.notice, models: [] };
    entry.models.push(m.label);
    byText.set(m.notice, entry);
  }
  return [...byText.values()];
}

// ── Models into the picker ───────────────────────────────────────────────────

/**
 * Turn one account model into a row for the shared list. `previous` is the
 * row already there: its reasoning switch and any limits the user edited are
 * settings, not catalogue facts, and a refresh must not reset them.
 */
export function antigravityModelRow(
  model: AntigravityModel,
  previous: LLMModel | undefined,
): Omit<LLMModel, "id" | "providerId" | "sortOrder"> {
  const reasoning: ModelReasoning | undefined = model.supportsThinking
    ? {
        type: "toggle",
        default: previous?.reasoning?.type === "toggle" ? previous.reasoning.default : true,
        enabled: previous?.reasoning?.enabled,
        toggleable: true,
        supported: ["toggle"],
      }
    : undefined;
  return {
    modelKey: model.id,
    label: model.label,
    contextWindow: previous?.contextWindow ?? model.contextWindow ?? undefined,
    maxOutputTokens: previous?.maxOutputTokens ?? model.maxOutputTokens ?? undefined,
    supportsVision: model.supportsImages,
    supportsThinking: model.supportsThinking,
    // Every model in Antigravity's agent picker is an agent model.
    supportsToolStream: true,
    // Quota, not money: absent renders as "not applicable", a zero as $0.00.
    priceCacheHitPerMtok: undefined,
    priceCacheMissPerMtok: undefined,
    priceOutputPerMtok: undefined,
    priceCacheWritePerMtok: undefined,
    reasoning,
    enabled: previous?.enabled ?? true,
  };
}

/**
 * Mirror the account's models into the shared model list. Idempotent: running
 * it again after a refresh converges on the same rows. Returns how many
 * models the picker now offers.
 */
export function syncAntigravityModels(catalogue: AntigravityCatalogue): number {
  const store = useAgentSettingsStore.getState();
  const existing = new Map(
    store.models
      .filter((m) => m.providerId === ANTIGRAVITY_PROVIDER_ID)
      .map((m) => [m.modelKey, m]),
  );
  const rows = catalogue.models.map((m) => antigravityModelRow(m, existing.get(m.id)));
  store.replaceModelsForProvider(ANTIGRAVITY_PROVIDER_ID, rows);
  return rows.length;
}

/** Drop the mirrored models, after the last account is removed. */
export function clearAntigravityModels(): void {
  useAgentSettingsStore.getState().replaceModelsForProvider(ANTIGRAVITY_PROVIDER_ID, []);
}
