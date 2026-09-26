/**
 * Provider and model rows: their types, how they map to and from the
 * database, how presets seed them, and how a selection resolves to a
 * `ProviderConfig`. Re-exported from `useAgentSettingsStore`.
 */
import {
  formatModelDisplayName,
  formatProviderNickname,
} from "@/kernel/lib/llm/provider-display";
import { resolveThinkingModelPair } from "@/kernel/lib/llm/thinking-models";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";
import type { ProviderConfig } from "@/kernel/services/providers/types";
import { normalizeProviderDescription } from "./values";
import type {
  DbLLMProvider,
  DbProviderModel,
  ModelReasoning,
} from "@/kernel/types/database";

// ============================================
// PROVIDER TYPES
// ============================================
//
// As of schema v15 a provider holds **transport, auth, defaults
// only**. Per-model capabilities and per-model context/output
// overrides live on `LLMModel` rows in the `models` slice.
//
// The `customModels`, `modelAliases`, `supportsThinking`, and
// `supportsVision` fields below are **synthesized in-memory** from
// the models slice on every read so legacy UI (Fireworks tab,
// LocalProviderPanel, the old ProviderCard) keeps reading the
// shape it expects without changes. Writes through `updateProvider`
// translate them back into models-slice operations. The fields are
// never round-tripped to the `llm_providers` table.
export interface LLMProvider {
  apiKey: string;
  /**
   * API-key POOL (v20+). When more than one non-blank key is present the
   * Rust runtime rotates them round-robin per turn and fails over to the
   * next key on an auth / rate-limit / server error — same request, next
   * key. Empty/undefined → only `apiKey` is used. Generic across providers
   * (AgentRouter, with its 5+ accounts, is the first consumer).
   */
  apiKeys?: string[];
  baseUrl: string;
  contextWindow: number;

  // Advanced configuration
  customHeaders?: Record<string, string>; // Extra headers to send
  /** @deprecated v15 — synthesized from `models` slice. Reads work; writes via `updateProvider` are translated into model upserts. */
  customModels?: string[];
  customParams?: Record<string, unknown>; // Extra params in request body
  defaultMaxTokens?: number; // Provider-specific default max token request
  defaultTemperature?: number; // Provider-specific default temperature
  enabled: boolean;
  id: string;
  isCustom?: boolean; // User-added provider
  maxOutputTokens: number;
  model: string;
  /** @deprecated v15 — synthesized from `models` slice (model.label). */
  modelAliases?: Record<string, string>;
  name: string;
  nickname?: string;
  /**
   * A line the user wrote about this provider — the account, what it is for,
   * whatever the name does not say. Shown under the title on its card.
   * At most `PROVIDER_DESCRIPTION_MAX` characters; empty is "none".
   */
  description?: string;
  // `kenari` / `kenari-messages` / `kenari-responses` are ONE provider whose
  // wire format is switchable — kenari serves the same account over OpenAI
  // chat completions, the Anthropic Messages shape, and the Codex Responses
  // shape. The choice rides here rather than in a separate field so everything
  // downstream (URL builder, streaming client, reasoning replay) follows from
  // one value that cannot disagree with itself.
  // `modal` / `modal-messages` / `modal-responses` follow the same rule: one
  // workspace token, three wires on one gateway, the wire stored as the type.
  // `deepseek` / `deepseek-messages` / `deepseek-responses` likewise — one
  // `sk-` key, three shapes, and on this one the Messages wire also lives on
  // its own path, so the picker rewrites the row's URL alongside the type.
  providerType?: "openai" | "openai-responses" | "codex" | "claude-code" | "cursor" | "fireworks" | "deepseek" | "deepseek-messages" | "deepseek-responses" | "glm" | "anthropic" | "minimax" | "lmstudio" | "ollama" | "kenari" | "kenari-messages" | "kenari-responses" | "ark" | "ark-messages" | "ark-responses" | "modal" | "modal-messages" | "modal-responses" | "meta" | "meta-messages" | "meta-responses" | "opencode-go" | "opencode-go-chat" | "opencode-go-messages" | "custom"; // Explicit provider type
  requiresApiKey?: boolean; // Whether API key is required (false for local)
  /** @deprecated v15 — read the active `LLMModel.supportsThinking` instead. */
  supportsThinking: boolean;
  supportsToolStream?: boolean;
  /**
   * @deprecated v15 — read the active `LLMModel.supportsVision` instead.
   * Synthesized from the `models` slice.
   */
  supportsVision?: boolean;
}

// ============================================
// MODEL TYPES (v15+)
// ============================================
//
// One row per model exposed by a provider. Capabilities are always
// per-model (the same OpenAI key can address GPT-4o-mini and GPT-4o,
// which have different vision support). `contextWindow` and
// `maxOutputTokens` are nullable — `null` means "inherit from the
// provider's default". Use `getResolvedModel()` to merge.
export interface LLMModel {
  /** `${providerId}::${modelKey}` — primary key. */
  id: string;
  providerId: string;
  modelKey: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsToolStream: boolean;
  enabled: boolean;
  sortOrder: number;
  /**
   * Pricing (USD per 1M tokens). All four fields are optional; the
   * usage badge only displays cost when both `cacheMiss` and `output`
   * are set. `cacheHit` falls back to `cacheMiss` if unset (no discount
   * assumed). `currency` defaults to `"USD"` when missing.
   */
  priceCacheHitPerMtok?: number;
  priceCacheMissPerMtok?: number;
  priceOutputPerMtok?: number;
  /**
   * USD per 1M cache-CREATION tokens. Unset means "bill cache writes at
   * `priceCacheMissPerMtok`", which is what OpenAI-compatible gateways
   * charge. Set it for providers that price cache creation differently
   * (Anthropic native charges 1.25x base). Never treated as zero — cache
   * writes are real spend and used to be dropped from the total entirely.
   */
  priceCacheWritePerMtok?: number;
  priceCurrency?: string;
  /** Reasoning capability + chosen default (models.dev, v17+). */
  reasoning?: ModelReasoning;
  /**
   * Extra request-body fields the user added manually for this model (e.g.
   * `{ thinking: { type: "enabled" } }`). Merged verbatim into the outgoing
   * request body at send time — the manual escape hatch for provider-specific
   * fields we don't model structurally. (v18+)
   */
  extraBody?: Record<string, unknown>;
  /**
   * Sampling temperature for this model. `undefined` inherits — the provider's
   * `defaultTemperature`, then {@link DEFAULT_TEMPERATURE}.
   *
   * Per-model because that is what it is: one key can address a model that
   * wants 0.2 and another that rejects the parameter outright. Models that
   * reject sampling (Claude 5+) have it stripped in the Rust adapter whatever
   * is set here, so a stale value is inert rather than a 400. (v22+)
   */
  temperature?: number;
  /**
   * Wire format for this one model. `undefined` inherits the provider's own
   * type, which is right for every provider whose format is a property of the
   * account rather than of the model. (v24+)
   *
   * OpenCode Go is why this exists. One base URL and one key answer
   * `/chat/completions`, `/messages` and `/responses`, and each model accepts
   * only its own — GLM-5.2 returns 500 on anything but chat completions,
   * GPT 5.6 Luna returns 500 on anything but responses, and the Qwen and
   * MiniMax ids want messages. It is also editable rather than fixed, because
   * the plan gains models faster than any table can be updated and the wire a
   * new one wants is not published anywhere.
   */
  providerType?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A model with its per-row overrides resolved against provider defaults. */
export interface ResolvedLLMModel extends LLMModel {
  /** Always non-null after resolution (falls back to provider.contextWindow). */
  resolvedContextWindow: number;
  /** Always non-null after resolution (falls back to provider.maxOutputTokens). */
  resolvedMaxOutputTokens: number;
  /** Always non-null after resolution (falls back to model.modelKey). */
  displayLabel: string;
}

// ============================================
// DEFAULT VALUES
// ============================================
export const DEFAULT_SELECTED_MODEL = "fireworks:accounts/fireworks/routers/kimi-k2p6-turbo";

export const presetToProvider = (preset: ProviderCatalogPreset): LLMProvider => ({
  id: preset.id,
  name: preset.name,
  nickname: preset.nickname,
  baseUrl: preset.baseUrl,
  model: preset.model,
  contextWindow: preset.contextWindow,
  maxOutputTokens: preset.maxOutputTokens,
  supportsThinking: preset.supportsThinking,
  supportsToolStream: preset.supportsToolStream,
  customModels: preset.customModels,
  modelAliases: preset.modelAliases,
  providerType: preset.providerType as LLMProvider["providerType"],
  defaultTemperature: preset.defaultTemperature,
  defaultMaxTokens: preset.defaultMaxTokens,
  requiresApiKey: preset.requiresApiKey,
  // Frontend presets (AgentRouter, …) can ship required transport headers
  // pre-filled — e.g. AgentRouter's client fingerprint (`User-Agent` +
  // `X-Title`), without which it returns 401. Rust catalog presets omit it.
  customHeaders: preset.customHeaders,
  apiKey: "",
  enabled: true,
  isCustom: false,
});

/**
 * Which provider type survives a merge with the catalogue.
 *
 * The catalogue normally wins, and should: a stored type can be stale or was
 * never written at all, and repairing it on load is what keeps an upgraded
 * install pointed at the right wire.
 *
 * The exception is a provider whose wire FORMAT is the user's choice. kenari
 * answers the same account over three of them (`kenari`, `kenari-messages`,
 * `kenari-responses`), and blindly restoring the catalogue's value would undo
 * that setting on every launch — the setting would appear to save, work for the
 * session, and be gone the next morning, which is the worst way for a control
 * to fail. A stored type that is a variant of the preset's own is therefore
 * kept.
 *
 * AgentRouter is the second such provider: its two wires are the plain
 * `openai` / `anthropic` types (no variant prefix to detect), so its stored
 * choice is preserved by name at the call site — see
 * {@link isAgentRouterWireChoice}.
 */
export function resolveProviderType(
  presetType: LLMProvider["providerType"],
  storedType: LLMProvider["providerType"],
): LLMProvider["providerType"] {
  if (!storedType || !presetType) return presetType;
  return storedType.startsWith(`${presetType}-`) ? storedType : presetType;
}

export const createDefaultProviders = (presets: ProviderCatalogPreset[]): LLMProvider[] => {
  return presets.map((preset) => presetToProvider(preset));
};

const getProviderModelList = (provider: LLMProvider): string[] => {
  const models = provider.customModels?.length ? provider.customModels : [provider.model];
  return Array.from(new Set(models.filter(Boolean)));
};

const getProviderNickname = (provider: Pick<LLMProvider, "name" | "nickname">): string =>
  formatProviderNickname(provider.name, provider.nickname);

const isProviderReady = (provider: LLMProvider): boolean => {
  if (!provider.enabled) return false;

  const normalizedBaseUrl = provider.baseUrl.toLowerCase();
  const isLocal =
    normalizedBaseUrl.includes("localhost") ||
    normalizedBaseUrl.includes("127.0.0.1");

  return isLocal || provider.requiresApiKey === false || provider.apiKey.trim().length > 0;
};

export const buildAvailableModelOptions = (providers: LLMProvider[]) => {
  const models: Array<{
    providerId: string;
    providerName: string;
    model: string;
    label: string;
  }> = [];

  for (const provider of providers) {
    if (!isProviderReady(provider)) continue;

    const providerName = getProviderNickname(provider);
    const modelAliases = provider.modelAliases || {};

    for (const model of getProviderModelList(provider)) {
      models.push({
        providerId: provider.id,
        providerName,
        model,
        label: formatModelDisplayName(model, modelAliases[model]),
      });
    }
  }

  return models;
};

export const resolveSelectedModel = (
  preferredModel: string,
  providers: LLMProvider[],
): string => {
  const availableModels = buildAvailableModelOptions(providers);

  if (
    availableModels.some(
      ({ providerId, model }) => `${providerId}:${model}` === preferredModel,
    )
  ) {
    return preferredModel;
  }

  const firstAvailable = availableModels[0];
  if (!firstAvailable) return preferredModel;

  return `${firstAvailable.providerId}:${firstAvailable.model}`;
};

/**
 * Reconcile `thinkingEnabled` with whatever model the user just
 * selected. Two distinct behaviors:
 *
 *  1. Capability gate — if the active model can't think at all, force
 *     the toggle OFF so the UI reflects what the runtime will do.
 *     Previously the function returned the *unchanged* value here,
 *     leaving the toggle stuck "on" after the user switched from a
 *     thinking-capable model (e.g. claude-sonnet-thinking) to a plain
 *     model (e.g. gpt-4o).
 *
 *  2. Pair swap — for providers that ship paired thinking/non-thinking
 *     variants of the same model family, set the flag to match the
 *     selected variant so the toggle UI looks right (the click that
 *     selected the variant is what flips the flag — not the user
 *     toggling thinking).
 *
 * `models` is the LLMModel slice — when non-empty it's the authoritative
 * capability source. We fall back to the synthesized provider flag when
 * the slice hasn't loaded yet (initial-load path).
 */
export const syncThinkingForSelectedModel = (
  selectedModel: string,
  providers: LLMProvider[],
  models: LLMModel[],
  currentThinkingEnabled: boolean
): boolean => {
  const [providerId, modelKey] = selectedModel.split(":");
  if (!providerId || !modelKey) return currentThinkingEnabled;

  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return currentThinkingEnabled;

  // Capability gate. Prefer the LLMModel row when available — it's
  // the per-model truth; the provider-level flag is just a synthesized
  // OR/active mirror that may lag the slice for non-active models.
  const activeModel = models.find(
    (m) => m.providerId === providerId && m.modelKey === modelKey,
  );
  const modelSupportsThinking = activeModel
    ? activeModel.supportsThinking
    : provider.supportsThinking ?? false;

  if (!modelSupportsThinking) {
    return false;
  }

  // Pair swap.
  const pair = resolveThinkingModelPair(modelKey, getProviderModelList(provider));
  if (!pair) return currentThinkingEnabled;

  return pair.currentModelIsThinking;
};

export function dbToProvider(db: DbLLMProvider): LLMProvider {
  // Note: legacy fields (customModels, modelAliases, supportsThinking,
  // supportsVision) are populated post-hoc by `synthesizeLegacyProviderFields`
  // after the models slice is loaded. We intentionally leave them
  // unset here so a provider that loses all its models reflects an
  // empty list rather than ghost data.
  return {
    id: db.id,
    name: db.name,
    baseUrl: db.baseUrl,
    apiKey: db.apiKey,
    apiKeys: db.apiKeys && db.apiKeys.length > 0 ? db.apiKeys : undefined,
    model: db.model,
    contextWindow: db.contextWindow,
    maxOutputTokens: db.maxOutputTokens,
    supportsThinking: false,
    supportsToolStream: db.supportsToolStream,
    supportsVision: false,
    enabled: db.enabled,
    isCustom: db.isCustom,
    customHeaders: db.customHeaders || undefined,
    customParams: db.customParams || undefined,
    nickname: db.nickname || undefined,
    description: normalizeProviderDescription(db.description),
    providerType: db.providerType as LLMProvider['providerType'],
    defaultTemperature: db.defaultTemperature || undefined,
    defaultMaxTokens: db.defaultMaxTokens || undefined,
    requiresApiKey: db.requiresApiKey,
  };
}

// ============================================
// HELPER: Convert between store and DB formats
// ============================================
export function providerToDb(provider: LLMProvider, sortOrder: number): DbLLMProvider {
  const now = new Date().toISOString();
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeys:
      provider.apiKeys && provider.apiKeys.some((k) => k.trim().length > 0)
        ? provider.apiKeys.filter((k) => k.trim().length > 0)
        : null,
    model: provider.model,
    contextWindow: provider.contextWindow,
    maxOutputTokens: provider.maxOutputTokens,
    supportsToolStream: provider.supportsToolStream || false,
    enabled: provider.enabled,
    isCustom: provider.isCustom || false,
    customHeaders: provider.customHeaders || null,
    customParams: provider.customParams || null,
    nickname: provider.nickname?.trim() || null,
    description: normalizeProviderDescription(provider.description) ?? null,
    providerType: provider.providerType || null,
    defaultTemperature: provider.defaultTemperature || null,
    defaultMaxTokens: provider.defaultMaxTokens || null,
    requiresApiKey: provider.requiresApiKey ?? true,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// MODEL <-> DB CONVERTERS (v15+)
// ============================================
/**
 * Master on/off state for a model's reasoning. `enabled` is the source of truth
 * once set from the composer; when undefined we fall back to: ON for
 * effort/budget models, and the legacy `default` boolean for toggle models.
 */
export function reasoningIsOn(r: ModelReasoning): boolean {
  // Natively-reasoning models can't be turned off — always on.
  if (r.toggleable === false) return true;
  if (typeof r.enabled === "boolean") return r.enabled;
  if (r.type === "toggle") return r.default !== false;
  return true;
}

export function dbToModel(row: DbProviderModel): LLMModel {
  return {
    id: row.id,
    providerId: row.providerId,
    modelKey: row.modelKey,
    label: row.label || undefined,
    contextWindow: row.contextWindow ?? undefined,
    maxOutputTokens: row.maxOutputTokens ?? undefined,
    supportsVision: !!row.supportsVision,
    supportsThinking: !!row.supportsThinking,
    supportsToolStream: !!row.supportsToolStream,
    enabled: !!row.enabled,
    sortOrder: row.sortOrder ?? 0,
    priceCacheHitPerMtok: row.priceCacheHitPerMtok ?? undefined,
    priceCacheMissPerMtok: row.priceCacheMissPerMtok ?? undefined,
    priceOutputPerMtok: row.priceOutputPerMtok ?? undefined,
    priceCacheWritePerMtok: row.priceCacheWritePerMtok ?? undefined,
    priceCurrency: row.priceCurrency ?? undefined,
    reasoning: row.reasoning ?? undefined,
    extraBody: row.extraBody ?? undefined,
    temperature: row.temperature ?? undefined,
    providerType: row.providerType ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function modelToDb(model: LLMModel): DbProviderModel {
  const now = new Date().toISOString();
  return {
    id: model.id || `${model.providerId}::${model.modelKey}`,
    providerId: model.providerId,
    modelKey: model.modelKey,
    label: model.label?.trim() || null,
    contextWindow: model.contextWindow ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
    supportsVision: model.supportsVision,
    supportsThinking: model.supportsThinking,
    supportsToolStream: model.supportsToolStream,
    enabled: model.enabled,
    sortOrder: model.sortOrder,
    priceCacheHitPerMtok: model.priceCacheHitPerMtok ?? null,
    priceCacheMissPerMtok: model.priceCacheMissPerMtok ?? null,
    priceOutputPerMtok: model.priceOutputPerMtok ?? null,
    priceCacheWritePerMtok: model.priceCacheWritePerMtok ?? null,
    priceCurrency: model.priceCurrency ?? null,
    reasoning: model.reasoning ?? null,
    extraBody: model.extraBody ?? null,
    temperature: model.temperature ?? null,
    providerType: model.providerType ?? null,
    createdAt: model.createdAt || now,
    updatedAt: now,
  };
}

/**
 * Build LLMModel rows from a preset's `customModels[]` + provider-level
 * capability flags. Used on first-run when no rows exist in the
 * `provider_models` table yet — the v15 DB migration handles the same
 * thing for upgrades, this is the fresh-install path.
 */
export function modelsFromPreset(preset: ProviderCatalogPreset): LLMModel[] {
  const keys = preset.customModels?.length ? preset.customModels : [preset.model];
  const aliases = preset.modelAliases || {};
  const pricing = preset.modelPricing || {};
  const windows = preset.modelContextWindows || {};
  const reasoningByKey = preset.modelReasoning || {};
  const visionByKey = preset.modelVision || {};
  return Array.from(new Set(keys.filter(Boolean))).map((modelKey, idx) => {
    const p = pricing[modelKey];
    return {
      id: `${preset.id}::${modelKey}`,
      providerId: preset.id,
      modelKey,
      label: aliases[modelKey] || undefined,
      // Only where the preset says so; `undefined` leaves the row without a
      // reasoning control, exactly as seeding has always done.
      reasoning: reasoningByKey[modelKey],
      // Set only where the preset says this model differs from its provider;
      // `undefined` falls back to `provider.contextWindow` at resolve time.
      contextWindow: windows[modelKey],
      maxOutputTokens: undefined,
      // From the preset, not hardcoded `false`. Every seeded model used to
      // arrive claiming no vision regardless of what it actually does, so a
      // user who added OpenAI (Responses) and pasted a screenshot got nothing
      // until they hunted down the per-model toggle. A capability the
      // catalogue knows about must not need re-entering by hand.
      //
      // Per model where the preset says the models disagree, which is the case
      // the provider-wide flag cannot express: DeepSeek Flash sees and V4 Pro
      // answers 400 on an image, so one answer has to be wrong for one of them.
      supportsVision: visionByKey[modelKey] ?? !!preset.supportsVision,
      supportsThinking: !!preset.supportsThinking,
      supportsToolStream: !!preset.supportsToolStream,
      enabled: true,
      sortOrder: idx,
      priceCacheHitPerMtok: p?.cacheHitPerMtok,
      priceCacheMissPerMtok: p?.cacheMissPerMtok,
      priceOutputPerMtok: p?.outputPerMtok,
      priceCurrency: p ? 'USD' : undefined,
    } satisfies LLMModel;
  });
}

/**
 * Re-populate the `customModels`, `modelAliases`, `supportsThinking`,
 * and `supportsVision` fields on `LLMProvider` from the `models`
 * slice. Called after the models slice changes so legacy code that
 * still reads these fields sees a consistent view. The synthesized
 * `supportsThinking`/`supportsVision` reflect the **active** model
 * (selected by the global `selectedModel`), not OR-aggregated across
 * the whole provider — that's the correct behavior for capability
 * gating downstream.
 */
export function synthesizeLegacyProviderFields(
  providers: LLMProvider[],
  models: LLMModel[],
  selectedModel: string,
): LLMProvider[] {
  const [activeProviderId, activeModelKey] = selectedModel.split(":");
  return providers.map((provider) => {
    const ownModels = models
      .filter((m) => m.providerId === provider.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const customModels = ownModels.map((m) => m.modelKey);
    const modelAliases = ownModels.reduce<Record<string, string>>((acc, m) => {
      if (m.label && m.label.trim()) acc[m.modelKey] = m.label.trim();
      return acc;
    }, {});

    let activeFlags: { supportsVision: boolean; supportsThinking: boolean } = {
      supportsVision: false,
      supportsThinking: false,
    };
    if (provider.id === activeProviderId) {
      const active = ownModels.find((m) => m.modelKey === activeModelKey) ?? ownModels[0];
      if (active) {
        activeFlags = {
          supportsVision: active.supportsVision,
          supportsThinking: active.supportsThinking,
        };
      }
    } else {
      // For non-active providers, surface the OR over their models so
      // the Settings UI can show capability badges. Capability gating
      // for the runtime always uses the resolved active model below.
      activeFlags = {
        supportsVision: ownModels.some((m) => m.supportsVision),
        supportsThinking: ownModels.some((m) => m.supportsThinking),
      };
    }

    return {
      ...provider,
      customModels: customModels.length ? customModels : undefined,
      modelAliases: Object.keys(modelAliases).length ? modelAliases : undefined,
      supportsThinking: activeFlags.supportsThinking,
      supportsVision: activeFlags.supportsVision,
    };
  });
}

/** Resolve a model's nullable overrides against its provider's defaults. */
export function resolveModel(model: LLMModel, provider: LLMProvider): ResolvedLLMModel {
  return {
    ...model,
    resolvedContextWindow: model.contextWindow ?? provider.contextWindow,
    resolvedMaxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    displayLabel:
      model.label?.trim() || formatModelDisplayName(model.modelKey),
  };
}

/**
 * Build a {@link ProviderConfig} for an explicit `"providerId:modelKey"`
 * selection (the same string shape as `selectedModel`). Returns `null` when
 * the provider isn't found, so callers can fall back to the active config.
 *
 * This is the generalized core of `getLLMConfig` — used by the Agent Team
 * model overrides (`getTeamLeadConfig` / `getTeamMemberConfig`) so the Lead
 * and the IC team can each ride a different configured provider.
 */
export function buildProviderConfigForSelection(
  selection: string,
  providers: LLMProvider[],
  models: LLMModel[],
): ProviderConfig | null {
  const separator = selection.indexOf(":");
  const providerId = separator < 0 ? selection : selection.slice(0, separator);
  const modelKey = separator < 0 ? "" : selection.slice(separator + 1);
  if (!providerId) return null;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  const activeModel = models.find(
    (m) => m.providerId === providerId && m.modelKey === modelKey,
  );
  const resolved = activeModel ? resolveModel(activeModel, provider) : undefined;

  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: resolved?.modelKey || modelKey || provider.model,
    maxOutputTokens: resolved?.resolvedMaxOutputTokens ?? provider.maxOutputTokens,
    contextWindow: resolved?.resolvedContextWindow ?? provider.contextWindow,
    supportsThinking: resolved?.supportsThinking ?? false,
    supportsToolStream:
      resolved?.supportsToolStream ?? provider.supportsToolStream ?? false,
    supportsVision: resolved?.supportsVision ?? false,
    // The wire can belong to the model. Schema v24 already persists this, but
    // the generic resolver used to ignore it and only OpenCode's one-off
    // post-processor read the field. That made the settings test and a live
    // turn disagree for every other mixed-format gateway.
    providerType:
      (resolved?.providerType as LLMProvider["providerType"] | undefined) ??
      provider.providerType ??
      "custom",
    customHeaders: provider.customHeaders,
    customParams: provider.customParams,
    defaultTemperature: provider.defaultTemperature,
    // ONLY the user's explicit provider-wide override. It must NOT fall back to
    // `provider.maxOutputTokens`: consumers read `defaultMaxTokens ?? maxOutputTokens`,
    // so a legacy provider-row value (often a stale 8192) would outrank the
    // per-model cap resolved just above and silently cap a 128k model at 8k.
    defaultMaxTokens: provider.defaultMaxTokens ?? undefined,
  };
}
