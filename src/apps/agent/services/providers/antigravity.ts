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

/** The effort tiers Antigravity spells into its ids, lowest first. */
const ANTIGRAVITY_LEVELS = ["low", "medium", "high"] as const;
const LEVEL_SUFFIX = /-(low|medium|high)$/;
const LEVEL_LABEL_SUFFIX = /\s*\((low|medium|high)\)$/i;

/**
 * One model as the picker offers it. Antigravity lists each effort tier as its
 * own id (`gemini-4-argon-low`, `-medium`, `-high`); those are one model with
 * an effort setting, so they become one row whose `levels` are the tiers. The
 * id sent on the wire is rebuilt from the row and its effort at send time
 * (`applyAntigravityVariant`). A model with a single tier stays as listed.
 */
export interface AntigravityFamily {
  /** The account's entry the row takes its facts from, re-keyed to the stem. */
  model: AntigravityModel;
  /** Tiers the account offers for it, lowest first. Empty when not folded. */
  levels: string[];
}

/** `gemini-4-argon-high` → `gemini-4-argon`; anything else unchanged. */
export function antigravityStem(id: string): string {
  return id.replace(LEVEL_SUFFIX, "");
}

export function foldAntigravityVariants(models: readonly AntigravityModel[]): AntigravityFamily[] {
  const byStem = new Map<string, AntigravityModel[]>();
  for (const m of models) {
    const stem = antigravityStem(m.id);
    byStem.set(stem, [...(byStem.get(stem) ?? []), m]);
  }
  const out: AntigravityFamily[] = [];
  for (const [stem, variants] of byStem) {
    if (variants.length < 2) {
      out.push({ model: variants[0], levels: [] });
      continue;
    }
    const level = (m: AntigravityModel) => m.id.match(LEVEL_SUFFIX)?.[1] ?? "";
    const levels = ANTIGRAVITY_LEVELS.filter((l) => variants.some((v) => level(v) === l));
    const base = variants.find((v) => level(v) === "high") ?? variants[0];
    const withNotice = variants.find((v) => v.notice);
    out.push({
      levels: [...levels],
      model: {
        ...base,
        id: stem,
        label: base.label.replace(LEVEL_LABEL_SUFFIX, ""),
        noticeTitle: withNotice?.noticeTitle ?? null,
        notice: withNotice?.notice ?? null,
      },
    });
  }
  return out;
}

/**
 * Turn one account model into a row for the shared list. `previous` is the
 * row already there: its reasoning choice and any limits the user edited are
 * settings, not catalogue facts, and a refresh must not reset them. A folded
 * model (`levels` set) gets an effort control over its tiers; `preferred` is
 * the tier to start on when the row is new (the one the user had picked as a
 * separate id before the fold).
 */
export function antigravityModelRow(
  model: AntigravityModel,
  previous: LLMModel | undefined,
  levels: readonly string[] = [],
  preferred?: string,
): Omit<LLMModel, "id" | "providerId" | "sortOrder"> {
  const kept =
    previous?.reasoning?.type === "effort" && typeof previous.reasoning.default === "string"
      ? previous.reasoning.default
      : undefined;
  const reasoning: ModelReasoning | undefined =
    levels.length > 1
      ? {
          type: "effort",
          levels: [...levels],
          default: [kept, preferred, "medium"].find((l) => l && levels.includes(l)) ?? levels[0],
          enabled: true,
          // The tier is the id: there is no "off" id to send.
          toggleable: false,
          supported: ["effort"],
        }
      : model.supportsThinking
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
 * The rows the shared list should hold after a refresh: the account's models
 * in its own order, then every row already there that the account does not
 * list. Those are kept, not dropped: a model added by hand (a release Google
 * has not turned on for this account yet) must survive the refresh, and when
 * the account starts listing it, it becomes an ordinary row in place.
 */
export function antigravitySyncRows(
  catalogue: AntigravityCatalogue,
  current: readonly LLMModel[],
  selectedModel = "",
): Array<Omit<LLMModel, "id" | "providerId" | "sortOrder">> {
  const existing = new Map(current.map((m) => [m.modelKey, m]));
  const families = foldAntigravityVariants(catalogue.models);
  const offered = new Set(families.map((f) => f.model.id));
  const pickedKey = selectedModel.startsWith(`${ANTIGRAVITY_PROVIDER_ID}:`)
    ? selectedModel.slice(ANTIGRAVITY_PROVIDER_ID.length + 1)
    : "";
  const rows = families.map(({ model, levels }) =>
    antigravityModelRow(
      model,
      existing.get(model.id),
      levels,
      antigravityStem(pickedKey) === model.id ? pickedKey.match(LEVEL_SUFFIX)?.[1] : undefined,
    ),
  );
  // Passed whole: `replaceModelsForProvider` sets id, provider and order. A
  // tier row from before the fold (`…-high` beside its new `…` row) is the
  // same model, not a hand-added one, so it goes.
  const kept = current
    .filter((m) => !offered.has(m.modelKey) && !offered.has(antigravityStem(m.modelKey)))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return [...rows, ...kept];
}

/**
 * Rows in the model list that the account does not offer. Chats on them get
 * "not found" from Google until it turns them on for this account.
 */
export function antigravityNotOffered(
  catalogue: AntigravityCatalogue,
  current: readonly LLMModel[],
): LLMModel[] {
  const offered = new Set(foldAntigravityVariants(catalogue.models).map((f) => f.model.id));
  return current.filter(
    (m) =>
      m.providerId === ANTIGRAVITY_PROVIDER_ID &&
      !offered.has(m.modelKey) &&
      !offered.has(antigravityStem(m.modelKey)),
  );
}

/**
 * The id Antigravity expects for a folded row: its stem plus the chosen tier.
 * `null` for a row that was never folded (its key is already the id).
 */
export function antigravityWireModel(model: Pick<LLMModel, "modelKey" | "reasoning">): string | null {
  const r = model.reasoning;
  if (r?.type !== "effort" || !r.levels?.length) return null;
  if (!r.levels.every((l) => (ANTIGRAVITY_LEVELS as readonly string[]).includes(l))) return null;
  const level = typeof r.default === "string" && r.levels.includes(r.default) ? r.default : r.levels[r.levels.length - 1];
  return `${model.modelKey}-${level}`;
}

/**
 * Mirror the account's models into the shared model list. Idempotent: running
 * it again after a refresh converges on the same rows. Returns how many of
 * the account's models the picker now offers.
 */
export function syncAntigravityModels(catalogue: AntigravityCatalogue): number {
  const store = useAgentSettingsStore.getState();
  const current = store.models.filter((m) => m.providerId === ANTIGRAVITY_PROVIDER_ID);
  const rows = antigravitySyncRows(catalogue, current, store.selectedModel);
  // A selection naming a tier id from before the fold follows its model's row
  // instead of being reconciled away to some other model.
  const offered = new Set(rows.map((r) => r.modelKey));
  const renames: Record<string, string> = {};
  for (const m of current) {
    const stem = antigravityStem(m.modelKey);
    if (stem !== m.modelKey && offered.has(stem) && !offered.has(m.modelKey)) renames[m.modelKey] = stem;
  }
  store.replaceModelsForProvider(ANTIGRAVITY_PROVIDER_ID, rows, renames);
  return foldAntigravityVariants(catalogue.models).length;
}

/**
 * How often the window re-reads the account's models. Google turns new models
 * on per account without notice; this is how long one can take to appear in
 * the picker without opening the Providers page.
 */
export const ANTIGRAVITY_MODELS_REFRESH_MS = 30 * 60_000;

/**
 * Re-read the main account's models into the picker, when an account is
 * signed in. Signed out is left to the card, which clears the rows.
 */
export async function refreshAntigravityModels(): Promise<number | null> {
  const auth = await antigravityAuthStatus();
  if (!auth.signedIn) return null;
  return syncAntigravityModels(await antigravityModelsList());
}

/**
 * Refresh without letting a failure reach the caller: it runs on window start
 * and on a timer, while the person is doing something else. The picker keeps
 * the models it had.
 */
export function refreshAntigravityModelsQuietly(): void {
  void refreshAntigravityModels().catch((err) => {
    console.warn("[antigravity] could not refresh the model picker:", err);
  });
}

/** Drop the mirrored models, after the last account is removed. */
export function clearAntigravityModels(): void {
  useAgentSettingsStore.getState().replaceModelsForProvider(ANTIGRAVITY_PROVIDER_ID, []);
}
