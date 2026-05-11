import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";

import {
  formatModelDisplayName,
  formatProviderNickname,
} from "../lib/provider-display";
import {
  DEFAULT_EXPLORER_ICON_PACK_ID,
  isExplorerIconPackAvailable,
  setActiveExplorerIconPackId,
} from "../lib/icon-packs";
import type { ExplorerIconPackId } from "../lib/icon-types";
import { resolveThinkingModelPair } from "../lib/thinking-models";
import { databaseService } from "../services/database";
import {
  normalizeAgentExecutionMode,
  type AgentExecutionMode,
} from "../services/agent-execution-mode";
import { providerCatalogService, type ProviderCatalogPreset } from "../services/provider-catalog";
import type { ProviderConfig } from "../services/providers/types";
import { MAX_ENABLED_SKILLS } from "../services/skills";
import type {
  AppSettings as DbAppSettings,
  DbLLMProvider,
  DbProviderModel,
} from "../types/database";
import { useIconPackStore } from "./useIconPackStore";

const countEnabledSkillToggles = (toggles: Record<string, boolean>): number => {
  let count = 0;
  for (const value of Object.values(toggles)) {
    if (value === true) count += 1;
  }
  return count;
};

const UI_FONT_FAMILIES: Record<string, string> = {
  system: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
  inter: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  segoe: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
  roboto: "'Roboto', -apple-system, BlinkMacSystemFont, sans-serif",
  manrope: "'Manrope', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  poppins: "'Poppins', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sourceSans: "'Source Sans 3', 'Source Sans Pro', 'Segoe UI', sans-serif",
  openSans: "'Open Sans', 'Segoe UI', Roboto, sans-serif",
  nunito: "'Nunito Sans', 'Nunito', 'Segoe UI', sans-serif",
  lato: "'Lato', 'Segoe UI', Roboto, sans-serif",
  ubuntu: "'Ubuntu', 'Segoe UI', Roboto, sans-serif",
};

const clampTextScale = (value: number): number => Math.min(1.4, Math.max(0.85, value));

const applyUiPreferences = (fontFamily: string, textScale: number) => {
  if (typeof document === 'undefined') return;
  const resolvedFamily = UI_FONT_FAMILIES[fontFamily] ?? UI_FONT_FAMILIES.system;
  // UI scaling is intentionally disabled. Keep this hardcoded at 1.
  document.documentElement.style.setProperty('--aurora-ui-scale', '1');
  document.documentElement.style.setProperty('--aurora-ui-text-scale', String(clampTextScale(textScale)));
  document.documentElement.style.setProperty('--aurora-ui-font-family', resolvedFamily);
};

const normalizeSpeechRuntimePath = (value?: string | null): string => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "__bundled__" ? "" : trimmed;
};

// ============================================
// SETTINGS STATE TYPES
// ============================================
interface SettingsState {
  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => string;

  // File Changes Approval
  autoAcceptChanges: boolean;

  // Tool Approval
  autoApproveTools: boolean;
  agentExecutionMode: AgentExecutionMode;

  // Autosave Settings
  autoSave: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
  autoSaveDelay: number; // in milliseconds
  deleteProvider: (id: string) => void;

  // Editor Settings
  explorerIconPack: ExplorerIconPackId;
  fontSize: number;
  fireworksAccountId: string;
  fireworksTabEnabled: boolean;
  getAvailableModels: () => Array<{
    providerId: string;
    providerName: string;
    model: string;
    label: string;
  }>;
  getLLMConfig: () => ProviderConfig | null;
  getSelectedProvider: () => LLMProvider | undefined;
  getToolApproval: (toolName: string) => 'auto' | 'always_ask' | 'deny';

  // Onboarding
  hasSeenOnboarding: boolean;

  // Database operations
  initializeFromDatabase: () => Promise<void>;

  // Initialization state
  isInitialized: boolean;
  isLoading: boolean;

  // Max Tokens
  maxTokens: number;

  // Tool Settings
  maxToolCallsPerRequest: number;
  projectLayoutEnabled: boolean; // Include file tree in first message
  skillToggles: Record<string, boolean>;
  skillsEnabled: boolean;
  speechBackend: string;
  speechDevicePreference: 'auto' | 'cpu' | 'gpu';
  speechEnabled: boolean;
  speechEngine: string;
  speechLanguage: string;
  speechModelPath: string;
  speechRuntimePath: string;
  speechThreads: number;

  // Providers
  providers: LLMProvider[];
  saveToDatabase: () => Promise<void>;
  selectedModel: string; // Format: "providerId:model"
  setAutoAcceptChanges: (value: boolean) => void;
  setAutoApproveTools: (value: boolean) => void;
  setAgentExecutionMode: (mode: AgentExecutionMode) => void;
  setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => void;
  setAutoSaveDelay: (delay: number) => void;
  setExplorerIconPack: (packId: ExplorerIconPackId) => void;
  setFontSize: (size: number) => void;
  setFireworksAccountId: (accountId: string) => void;
  setFireworksTabEnabled: (enabled: boolean) => void;
  setHasSeenOnboarding: (seen: boolean) => void;
  setMaxTokens: (tokens: number) => void;
  setMaxToolCallsPerRequest: (max: number) => void;
  setProjectLayoutEnabled: (value: boolean) => void;
  setSelectedModel: (model: string) => void;
  /**
   * Toggle a skill on or off. Enabling is rejected (no-op + console warning)
   * when {@link MAX_ENABLED_SKILLS} skills are already enabled — callers must
   * disable a skill before enabling another. Disabling is always permitted.
   * Returns true if the toggle was applied, false if it was rejected.
   */
  setSkillEnabled: (storageKey: string, enabled: boolean) => boolean;
  setSkillsEnabled: (enabled: boolean) => void;
  setSpeechBackend: (backend: string) => void;
  setSpeechDevicePreference: (preference: 'auto' | 'cpu' | 'gpu') => void;
  setSpeechEnabled: (enabled: boolean) => void;
  setSpeechEngine: (engine: string) => void;
  setSpeechLanguage: (language: string) => void;
  setSpeechModelPath: (path: string) => void;
  setSpeechRuntimePath: (path: string) => void;
  setSpeechThreads: (threads: number) => void;
  setSyntaxValidationEnabled: (value: boolean) => void;
  setTemperature: (temp: number) => void;
  setTheme: (theme: "dark" | "light") => void;
  setThinkingEnabled: (enabled: boolean) => void;
  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => void;
  setUiFontFamily: (family: string) => void;
  setUiTextScale: (scale: number) => void;
  setWrapMode: (enabled: boolean) => void;

  // Agent Guardrails
  syntaxValidationEnabled: boolean; // Pre-save syntax validation

  // Temperature
  temperature: number;

  // Theme
  theme: "dark" | "light";

  // Thinking Settings
  thinkingEnabled: boolean;
  toolApprovalSettings: Record<string, 'auto' | 'always_ask' | 'deny'>;

  // UI Settings
  uiFontFamily: string;
  uiTextScale: number;

  // Provider actions
  updateProvider: (id: string, updates: Partial<LLMProvider>) => void;

  // ── Models slice (v15+) ─────────────────────────────────────────
  models: LLMModel[];
  modelsForProvider: (providerId: string) => LLMModel[];
  /** Look up the active model from `selectedModel` (`providerId:modelKey`). */
  getActiveModel: () => LLMModel | undefined;
  /** Active model with overrides resolved against the provider's defaults. */
  getResolvedActiveModel: () => ResolvedLLMModel | undefined;
  addModel: (
    providerId: string,
    init: Omit<LLMModel, "id" | "providerId" | "sortOrder"> & { sortOrder?: number },
  ) => string;
  updateModel: (id: string, updates: Partial<Omit<LLMModel, "id" | "providerId">>) => void;
  deleteModel: (id: string) => void;
  /** Bulk replace the model list for a provider in one transaction. */
  replaceModelsForProvider: (
    providerId: string,
    models: Array<Omit<LLMModel, "id" | "providerId" | "sortOrder">>,
  ) => void;

  wrapMode: boolean;
}


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
  providerType?: "openai" | "fireworks" | "deepseek" | "glm" | "anthropic" | "minimax" | "lmstudio" | "ollama" | "custom"; // Explicit provider type
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
const DEFAULT_SELECTED_MODEL = "fireworks:accounts/fireworks/routers/kimi-k2p6-turbo";

const presetToProvider = (preset: ProviderCatalogPreset): LLMProvider => ({
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
  apiKey: "",
  enabled: true,
  isCustom: false,
});

const createDefaultProviders = (presets: ProviderCatalogPreset[]): LLMProvider[] => {
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

const buildAvailableModelOptions = (providers: LLMProvider[]) => {
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

const resolveSelectedModel = (
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

const syncThinkingForSelectedModel = (
  selectedModel: string,
  providers: LLMProvider[],
  currentThinkingEnabled: boolean
): boolean => {
  const [providerId, model] = selectedModel.split(":");
  if (!providerId || !model) return currentThinkingEnabled;

  const provider = providers.find((p) => p.id === providerId);
  if (!provider || !provider.supportsThinking) return currentThinkingEnabled;

  const pair = resolveThinkingModelPair(model, getProviderModelList(provider));
  if (!pair) return currentThinkingEnabled;

  return pair.currentModelIsThinking;
};

function dbToProvider(db: DbLLMProvider): LLMProvider {
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
    providerType: db.providerType as LLMProvider['providerType'],
    defaultTemperature: db.defaultTemperature || undefined,
    defaultMaxTokens: db.defaultMaxTokens || undefined,
    requiresApiKey: db.requiresApiKey,
  };
}

// ============================================
// HELPER: Convert between store and DB formats
// ============================================
function providerToDb(provider: LLMProvider, sortOrder: number): DbLLMProvider {
  const now = new Date().toISOString();
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    contextWindow: provider.contextWindow,
    maxOutputTokens: provider.maxOutputTokens,
    supportsToolStream: provider.supportsToolStream || false,
    enabled: provider.enabled,
    isCustom: provider.isCustom || false,
    customHeaders: provider.customHeaders || null,
    customParams: provider.customParams || null,
    nickname: provider.nickname?.trim() || null,
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
function dbToModel(row: DbProviderModel): LLMModel {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function modelToDb(model: LLMModel): DbProviderModel {
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
function modelsFromPreset(preset: ProviderCatalogPreset): LLMModel[] {
  const keys = preset.customModels?.length ? preset.customModels : [preset.model];
  const aliases = preset.modelAliases || {};
  return Array.from(new Set(keys.filter(Boolean))).map((modelKey, idx) => ({
    id: `${preset.id}::${modelKey}`,
    providerId: preset.id,
    modelKey,
    label: aliases[modelKey] || undefined,
    contextWindow: undefined,
    maxOutputTokens: undefined,
    supportsVision: false,
    supportsThinking: !!preset.supportsThinking,
    supportsToolStream: !!preset.supportsToolStream,
    enabled: true,
    sortOrder: idx,
  }));
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
function synthesizeLegacyProviderFields(
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
function resolveModel(model: LLMModel, provider: LLMProvider): ResolvedLLMModel {
  return {
    ...model,
    resolvedContextWindow: model.contextWindow ?? provider.contextWindow,
    resolvedMaxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    displayLabel:
      model.label?.trim() || formatModelDisplayName(model.modelKey),
  };
}

const DEFAULT_TOOL_APPROVAL_SETTINGS: Record<string, 'auto' | 'always_ask' | 'deny'> = {
  // Shell commands require approval
  shell_execute: 'always_ask',
  shell_spawn: 'always_ask',
  // File write operations require approval
  file_write: 'always_ask',
  file_create: 'always_ask',
  file_delete: 'always_ask',
  file_patch: 'always_ask',
  folder_create: 'always_ask',
  folder_move: 'always_ask',
  folder_delete: 'always_ask',
  // Read operations are generally safe
  file_read: 'auto',
  file_read_lines: 'auto',
  file_exists: 'auto',
  file_search: 'auto',
  workspace_info: 'auto',
  workspace_list_files: 'auto',
  workspace_tree: 'auto',
  workspace_find_files: 'auto',
  workspace_grep: 'auto',
  // Editor operations
  editor_open_file: 'auto',
  editor_get_active_file: 'auto',
  editor_get_selection: 'auto',
  editor_get_open_tabs: 'auto',
  editor_insert_text: 'always_ask',
  editor_close_tab: 'always_ask',
};

// ============================================
// SETTINGS STORE
// ============================================
export const useSettingsStore = create<SettingsState>()((set, get) => ({
  // Initialization state
  isInitialized: false,
  isLoading: false,

  // Providers
  providers: [],
  // Models slice (v15+) — per-model capability profiles. Hydrated in
  // initializeFromDatabase from `provider_models`; legacy fields on
  // LLMProvider are synthesized from this on every change.
  models: [],
  selectedModel: DEFAULT_SELECTED_MODEL,
  explorerIconPack: DEFAULT_EXPLORER_ICON_PACK_ID,

  // Tool Approval
  autoApproveTools: false,
  agentExecutionMode: "agent",

  // File Changes Approval
  autoAcceptChanges: false,

  // Agent Guardrails (default: enabled)
  syntaxValidationEnabled: true,
  projectLayoutEnabled: true,

  // Editor Settings
  fontSize: 14,
  wrapMode: true,

  // UI Settings
  uiFontFamily: "system",
  uiTextScale: 1,

  fireworksTabEnabled: false,
  fireworksAccountId: "",


  // Theme
  theme: "dark",

  // Thinking Settings
  thinkingEnabled: true,

  // Max Tokens
  maxTokens: 8192,

  // Temperature
  temperature: 1.0,

  // Autosave Settings
  autoSave: 'off',
  autoSaveDelay: 1000,

  // Tool Settings
  maxToolCallsPerRequest: 25,
  toolApprovalSettings: { ...DEFAULT_TOOL_APPROVAL_SETTINGS },
  skillsEnabled: true,
  skillToggles: {},
  speechEnabled: false,
  speechEngine: "qwen3-rust",
  speechRuntimePath: "",
  speechModelPath: "",
  speechBackend: "auto",
  speechDevicePreference: "auto",
  speechThreads: 4,
  speechLanguage: "auto",

  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  initializeFromDatabase: async () => {
    const state = get();
    if (state.isLoading || state.isInitialized) return;

    set({ isLoading: true });

    try {
      await useIconPackStore.getState().initializeFromDatabase();
      const presetProviders = await providerCatalogService.getPresets();

      // Check if we have providers in the database
      const hasProviders = await databaseService.hasProviders();

      if (hasProviders) {
        // Load providers from database
        const dbProviders = await databaseService.getAllProviders();
        const providers = dbProviders.map(dbToProvider);

        // Merge with preset providers (in case new presets were added)
        const mergedProviders = presetProviders.map((preset) => {
          const presetProvider = presetToProvider(preset);
          const dbProvider = providers.find(p => p.id === preset.id);
          if (dbProvider) {
            // Keep the stored API key and settings, but update with any new preset fields
            return {
              ...presetProvider,
              ...dbProvider,
              isCustom: false,
              providerType: presetProvider.providerType,
              supportsToolStream: presetProvider.supportsToolStream ?? dbProvider.supportsToolStream,
              nickname: dbProvider.nickname || presetProvider.nickname,
            };
          }
          return presetProvider;
        });

        // Add any custom providers (ensure isCustom is set)
        const customProviders = providers
          .filter(p => p.isCustom)
          .map(p => ({ ...p, isCustom: true as const }));
        mergedProviders.push(...customProviders);

        // ── Models slice (v15+) ────────────────────────────────────
        // Load model rows for each provider, then merge with preset
        // models (so newly-added presets get their model roster
        // populated even if the user already has a v14-migrated DB).
        const dbModels = await databaseService.listProviderModels();
        const modelsFromDb = dbModels.map(dbToModel);
        const mergedModels: LLMModel[] = [];
        const seenIds = new Set<string>();
        for (const m of modelsFromDb) {
          if (!seenIds.has(m.id)) {
            mergedModels.push(m);
            seenIds.add(m.id);
          }
        }
        // For each preset, ensure every model_key appears at least once.
        // Preset-supplied capabilities only seed; user edits stick.
        for (const preset of presetProviders) {
          const presetModels = modelsFromPreset(preset);
          for (const pm of presetModels) {
            if (!seenIds.has(pm.id)) {
              mergedModels.push(pm);
              seenIds.add(pm.id);
              // Persist the seeded preset model row.
              databaseService.upsertProviderModel(modelToDb(pm)).catch(console.error);
            }
          }
        }
        // Custom providers may not have any model rows yet (e.g. a
        // user upgraded from v14 with `model = 'foo'` and nothing in
        // customModels[]). Seed one default row per custom provider
        // that currently has zero models.
        for (const provider of mergedProviders) {
          if (!provider.isCustom) continue;
          const hasAny = mergedModels.some((m) => m.providerId === provider.id);
          if (!hasAny && provider.model.trim()) {
            const seeded: LLMModel = {
              id: `${provider.id}::${provider.model}`,
              providerId: provider.id,
              modelKey: provider.model,
              supportsVision: false,
              supportsThinking: provider.supportsThinking ?? false,
              supportsToolStream: provider.supportsToolStream ?? false,
              enabled: true,
              sortOrder: 0,
            };
            mergedModels.push(seeded);
            databaseService.upsertProviderModel(modelToDb(seeded)).catch(console.error);
          }
        }

        // selectedModel hasn't been loaded from app_settings yet —
        // synthesize against DEFAULT_SELECTED_MODEL for now; we'll
        // re-synthesize once selectedModel resolves below.
        const providersWithLegacy = synthesizeLegacyProviderFields(
          mergedProviders,
          mergedModels,
          DEFAULT_SELECTED_MODEL,
        );
        set({ providers: providersWithLegacy, models: mergedModels });
      } else {
        // First time: save default providers AND seed the models
        // slice from preset.customModels[].
        const defaultProviders = createDefaultProviders(presetProviders);
        const dbProviders = defaultProviders.map((p, i) => providerToDb(p, i));
        await databaseService.saveAllProviders(dbProviders);

        const seededModels: LLMModel[] = presetProviders.flatMap(modelsFromPreset);
        for (const m of seededModels) {
          await databaseService.upsertProviderModel(modelToDb(m));
        }
        const providersWithLegacy = synthesizeLegacyProviderFields(
          defaultProviders,
          seededModels,
          DEFAULT_SELECTED_MODEL,
        );
        set({ providers: providersWithLegacy, models: seededModels });
      }

      // Load app settings
      const appSettings = await databaseService.getAppSettings();
      if (appSettings) {
        const uiFontFamily = appSettings.uiFontFamily ?? "system";
        const uiTextScale = appSettings.uiTextScale ?? 1;
        const explorerIconPack = isExplorerIconPackAvailable(
          appSettings.explorerIconPack || DEFAULT_EXPLORER_ICON_PACK_ID,
        )
          ? (appSettings.explorerIconPack || DEFAULT_EXPLORER_ICON_PACK_ID)
          : DEFAULT_EXPLORER_ICON_PACK_ID;
        const selectedModel = resolveSelectedModel(
          appSettings.selectedModel || DEFAULT_SELECTED_MODEL,
          get().providers,
        );
        const persistedExecutionMode = normalizeAgentExecutionMode(
          appSettings.agentExecutionMode,
        );
        const persistedThinkingEnabled = appSettings.thinkingEnabled ?? true;
        const syncedThinkingEnabled = syncThinkingForSelectedModel(
          selectedModel,
          get().providers,
          persistedThinkingEnabled
        );

        set({
          selectedModel,
          autoApproveTools: appSettings.autoApproveTools ?? false,
          agentExecutionMode: persistedExecutionMode,
          autoAcceptChanges: appSettings.autoAcceptChanges ?? false,
          explorerIconPack,
          syntaxValidationEnabled: appSettings.syntaxValidationEnabled ?? true,
          projectLayoutEnabled: appSettings.projectLayoutEnabled ?? true,
          skillsEnabled: appSettings.skillsEnabled ?? true,
          skillToggles: appSettings.skillToggles ?? {},
          speechEnabled: appSettings.speechEnabled ?? false,
          speechEngine: appSettings.speechEngine ?? "qwen3-rust",
          speechRuntimePath: normalizeSpeechRuntimePath(appSettings.speechRuntimePath),
          speechModelPath: appSettings.speechModelPath ?? "",
          speechBackend: appSettings.speechBackend ?? "auto",
          speechDevicePreference: appSettings.speechDevicePreference ?? "auto",
          speechThreads: appSettings.speechThreads ?? 4,
          speechLanguage: appSettings.speechLanguage ?? "auto",
          fireworksTabEnabled: appSettings.fireworksTabEnabled ?? false,
          fireworksAccountId: appSettings.fireworksAccountId ?? "",
          fontSize: appSettings.fontSize ?? 14,
          wrapMode: appSettings.wrapMode ?? true,
          theme: (appSettings.theme as 'dark' | 'light') || "dark",
          thinkingEnabled: syncedThinkingEnabled,
          maxTokens: appSettings.maxTokens ?? 8192,
          temperature: appSettings.temperature ?? 1.0,
          autoSave: (appSettings.autoSave as SettingsState['autoSave']) || 'off',
          autoSaveDelay: appSettings.autoSaveDelay ?? 1000,
          maxToolCallsPerRequest: appSettings.maxToolCallsPerRequest ?? 25,
          uiFontFamily,
          uiTextScale,
        });

        setActiveExplorerIconPackId(explorerIconPack);
        applyUiPreferences(uiFontFamily, uiTextScale);

        // Re-sync the legacy capability fields against the now-known
        // selected model so legacy reads see the active model's
        // vision/thinking flags rather than the OR-aggregate seeded
        // above.
        const reSynced = synthesizeLegacyProviderFields(
          get().providers,
          get().models,
          selectedModel,
        );
        set({ providers: reSynced });
      }


      // Load tool settings
      const toolSettings = await databaseService.getAllToolSettings();
      if (toolSettings.length > 0) {
        const settings = { ...DEFAULT_TOOL_APPROVAL_SETTINGS };
        for (const ts of toolSettings) {
          settings[ts.toolName] = ts.approvalMode;
        }
        set({ toolApprovalSettings: settings });
      }

      const { uiTextScale, uiFontFamily } = get();
      setActiveExplorerIconPackId(get().explorerIconPack);
      applyUiPreferences(uiFontFamily, uiTextScale);

      set({ isInitialized: true, isLoading: false });


      // Load onboarding state from localStorage
      const hasSeen = localStorage.getItem('aurora_has_seen_onboarding') === 'true';
      set({ hasSeenOnboarding: hasSeen });
    } catch (error) {
      console.error('Failed to initialize settings from database:', error);
      set({ isInitialized: true, isLoading: false });
    }
  },

  saveToDatabase: async () => {
    const state = get();

    try {
      // Save app settings
      const appSettings: DbAppSettings = {
        selectedModel: state.selectedModel,
        agentExecutionMode: state.agentExecutionMode,
        autoApproveTools: state.autoApproveTools,
        autoAcceptChanges: state.autoAcceptChanges,
        explorerIconPack: state.explorerIconPack,
        syntaxValidationEnabled: state.syntaxValidationEnabled,
        projectLayoutEnabled: state.projectLayoutEnabled,
        skillsEnabled: state.skillsEnabled,
        skillToggles: state.skillToggles,
        speechEnabled: state.speechEnabled,
        speechEngine: state.speechEngine,
        speechRuntimePath: state.speechRuntimePath,
        speechModelPath: state.speechModelPath,
        speechBackend: state.speechBackend,
        speechDevicePreference: state.speechDevicePreference,
        speechThreads: state.speechThreads,
        speechLanguage: state.speechLanguage,
        fireworksTabEnabled: state.fireworksTabEnabled,
        fireworksAccountId: state.fireworksAccountId,
        fontSize: state.fontSize,
        wrapMode: state.wrapMode,
        theme: state.theme,
        thinkingEnabled: state.thinkingEnabled,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        autoSave: state.autoSave,
        autoSaveDelay: state.autoSaveDelay,
        maxToolCallsPerRequest: state.maxToolCallsPerRequest,
        uiFontFamily: state.uiFontFamily,
        uiScale: 1,
        uiTextScale: state.uiTextScale,
      };

      await databaseService.saveAppSettings(appSettings);

      // Save providers
      const dbProviders = state.providers.map((p, i) => providerToDb(p, i));
      await databaseService.saveAllProviders(dbProviders);

      // Save tool settings
      const toolSettingsArray: [string, string][] = Object.entries(state.toolApprovalSettings);
      await databaseService.saveAllToolSettings(toolSettingsArray);

      // Save onboarding state
      // (For now using localStorage as it's UI state, but could be DB if needed)
      // Actually let's assume it's part of app settings in next migration or just use localStorage for this specific flag
      // since it's purely frontend "seen" state.
    } catch (error) {
      console.error('Failed to save settings to database:', error);
    }
  },

  // Onboarding
  hasSeenOnboarding: false,
  setHasSeenOnboarding: (seen: boolean) => {
    set({ hasSeenOnboarding: seen });
    localStorage.setItem('aurora_has_seen_onboarding', String(seen));
  },

  // ============================================
  // PROVIDER ACTIONS
  // ============================================

  updateProvider: (id: string, updates: Partial<LLMProvider>) => {
    // Translate writes to legacy fields back into models-slice ops.
    // This keeps existing UI (Fireworks tab, LocalProviderPanel) and
    // their `updateProvider({ customModels, modelAliases, supportsThinking,
    // supportsVision })` calls working without per-call rewrites.
    const {
      customModels: nextCustomModels,
      modelAliases: nextModelAliases,
      supportsThinking: nextSupportsThinking,
      supportsVision: nextSupportsVision,
      ...providerUpdates
    } = updates;

    set((state: SettingsState) => {
      const providers = state.providers.map((provider: LLMProvider) => {
        if (provider.id !== id) return provider;

        const nextProvider = {
          ...provider,
          ...providerUpdates,
        };

        return {
          ...nextProvider,
          nickname: nextProvider.nickname?.trim() || undefined,
        };
      });

      // ── Reconcile legacy field writes against the models slice ──
      let nextModels = state.models;
      if (nextCustomModels !== undefined) {
        const targetKeys = Array.from(
          new Set((nextCustomModels || []).filter(Boolean)),
        );
        const existing = state.models.filter((m) => m.providerId === id);
        const others = state.models.filter((m) => m.providerId !== id);
        const reconciled = targetKeys.map((modelKey, idx) => {
          const prior = existing.find((m) => m.modelKey === modelKey);
          if (prior) return { ...prior, sortOrder: idx };
          return {
            id: `${id}::${modelKey}`,
            providerId: id,
            modelKey,
            label: nextModelAliases?.[modelKey] || undefined,
            contextWindow: undefined,
            maxOutputTokens: undefined,
            supportsVision: false,
            supportsThinking: nextSupportsThinking ?? false,
            supportsToolStream: false,
            enabled: true,
            sortOrder: idx,
          } satisfies LLMModel;
        });
        nextModels = [...others, ...reconciled];
        // Persist the new roster (fire-and-forget; UI doesn't block).
        databaseService
          .replaceProviderModels(id, reconciled.map(modelToDb))
          .catch(console.error);
      }

      if (nextModelAliases !== undefined) {
        nextModels = nextModels.map((m) => {
          if (m.providerId !== id) return m;
          const nextLabel = nextModelAliases[m.modelKey];
          if (nextLabel === undefined && !m.label) return m;
          if (nextLabel === m.label) return m;
          const updated = { ...m, label: nextLabel?.trim() || undefined };
          databaseService.upsertProviderModel(modelToDb(updated)).catch(console.error);
          return updated;
        });
      }

      // Provider-level capability writes propagate to the active
      // model row (this is the closest match to the v14 semantics).
      const [activeProviderId, activeModelKey] = state.selectedModel.split(":");
      if (
        (nextSupportsVision !== undefined || nextSupportsThinking !== undefined) &&
        activeProviderId === id
      ) {
        nextModels = nextModels.map((m) => {
          if (m.providerId !== id || m.modelKey !== activeModelKey) return m;
          const updated: LLMModel = {
            ...m,
            supportsVision:
              nextSupportsVision !== undefined ? nextSupportsVision : m.supportsVision,
            supportsThinking:
              nextSupportsThinking !== undefined ? nextSupportsThinking : m.supportsThinking,
          };
          databaseService.upsertProviderModel(modelToDb(updated)).catch(console.error);
          return updated;
        });
      }

      const selectedModel = resolveSelectedModel(state.selectedModel, providers);
      const synthesized = synthesizeLegacyProviderFields(
        providers,
        nextModels,
        selectedModel,
      );

      return {
        providers: synthesized,
        models: nextModels,
        selectedModel,
        thinkingEnabled: syncThinkingForSelectedModel(
          selectedModel,
          synthesized,
          state.thinkingEnabled,
        ),
      };
    });
    // Debounced save to database
    setTimeout(() => get().saveToDatabase(), 500);
  },

  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => {
    const id = uuidv4();
    const newProvider: LLMProvider = {
      ...provider,
      id,
      isCustom: true,
      nickname: provider.nickname?.trim() || undefined,
    };

    // Seed the models slice from the legacy fields the caller passed.
    // Old AddProviderForm hands us `{ model, customModels: [model],
    // supportsThinking, supportsVision }`; the new ProvidersHubTab
    // calls `addModel` separately. Both paths land in the same place.
    const seedKeys = Array.from(
      new Set(
        [provider.model, ...(provider.customModels || [])].filter(
          (k): k is string => !!k && !!k.trim(),
        ),
      ),
    );
    const seededModels: LLMModel[] = seedKeys.map((modelKey, idx) => ({
      id: `${id}::${modelKey}`,
      providerId: id,
      modelKey,
      label: provider.modelAliases?.[modelKey] || undefined,
      contextWindow: undefined,
      maxOutputTokens: undefined,
      supportsVision: !!provider.supportsVision,
      supportsThinking: !!provider.supportsThinking,
      supportsToolStream: !!provider.supportsToolStream,
      enabled: true,
      sortOrder: idx,
    }));

    set((state: SettingsState) => {
      const nextProviders = [...state.providers, newProvider];
      const nextModels = [...state.models, ...seededModels];
      const synthesized = synthesizeLegacyProviderFields(
        nextProviders,
        nextModels,
        state.selectedModel,
      );
      return { providers: synthesized, models: nextModels };
    });

    // Persist provider + models.
    get().saveToDatabase();
    for (const m of seededModels) {
      databaseService.upsertProviderModel(modelToDb(m)).catch(console.error);
    }
    return id;
  },

  deleteProvider: (id: string) => {
    const state = get();
    const provider = state.providers.find((p: LLMProvider) => p.id === id);
    // Only allow deleting custom providers
    if (provider?.isCustom) {
      set((state: SettingsState) => {
        const nextProviders = state.providers.filter((p: LLMProvider) => p.id !== id);
        const nextModels = state.models.filter((m) => m.providerId !== id);
        const nextSelected = state.selectedModel.startsWith(id + ":")
          ? DEFAULT_SELECTED_MODEL
          : state.selectedModel;
        const synthesized = synthesizeLegacyProviderFields(
          nextProviders,
          nextModels,
          nextSelected,
        );
        return {
          providers: synthesized,
          models: nextModels,
          selectedModel: nextSelected,
        };
      });
      // Delete from database. Models cascade via FK, but we also call
      // the explicit delete to keep things tidy on platforms where
      // foreign_keys is off.
      databaseService.deleteProvider(id).catch(console.error);
      get().saveToDatabase();
    }
  },

  setSelectedModel: (model: string) => {
    set((state) => {
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        state.models,
        model,
      );
      return {
        selectedModel: model,
        providers: synthesized,
        thinkingEnabled: syncThinkingForSelectedModel(
          model,
          synthesized,
          state.thinkingEnabled,
        ),
      };
    });
    get().saveToDatabase();
  },

  // ============================================
  // MODELS SLICE ACTIONS (v15+)
  // ============================================

  modelsForProvider: (providerId: string) => {
    return get()
      .models
      .filter((m) => m.providerId === providerId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  },

  getActiveModel: () => {
    const state = get();
    const [providerId, modelKey] = state.selectedModel.split(":");
    if (!providerId || !modelKey) return undefined;
    return state.models.find(
      (m) => m.providerId === providerId && m.modelKey === modelKey,
    );
  },

  getResolvedActiveModel: () => {
    const state = get();
    const [providerId] = state.selectedModel.split(":");
    const provider = state.providers.find((p) => p.id === providerId);
    const model = state.getActiveModel();
    if (!provider || !model) return undefined;
    return resolveModel(model, provider);
  },

  addModel: (providerId, init) => {
    const id = `${providerId}::${init.modelKey}`;
    const sortOrder =
      init.sortOrder ?? get().models.filter((m) => m.providerId === providerId).length;
    const newModel: LLMModel = {
      id,
      providerId,
      sortOrder,
      ...init,
    };
    set((state) => {
      const nextModels = [...state.models.filter((m) => m.id !== id), newModel];
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        state.selectedModel,
      );
      return { models: nextModels, providers: synthesized };
    });
    databaseService.upsertProviderModel(modelToDb(newModel)).catch(console.error);
    return id;
  },

  updateModel: (id, updates) => {
    set((state) => {
      let updatedRow: LLMModel | undefined;
      const nextModels = state.models.map((m) => {
        if (m.id !== id) return m;
        const next: LLMModel = { ...m, ...updates };
        updatedRow = next;
        return next;
      });
      if (updatedRow) {
        databaseService
          .upsertProviderModel(modelToDb(updatedRow))
          .catch(console.error);
      }
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        state.selectedModel,
      );
      return { models: nextModels, providers: synthesized };
    });
  },

  deleteModel: (id) => {
    const state = get();
    const target = state.models.find((m) => m.id === id);
    if (!target) return;
    const nextModels = state.models.filter((m) => m.id !== id);
    databaseService
      .deleteProviderModel(target.providerId, target.modelKey)
      .catch(console.error);
    // If the deleted model was selected, fall back to first available.
    let nextSelected = state.selectedModel;
    const [activeProviderId, activeModelKey] = state.selectedModel.split(":");
    if (activeProviderId === target.providerId && activeModelKey === target.modelKey) {
      const fallback = nextModels
        .filter((m) => m.providerId === activeProviderId && m.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0];
      if (fallback) {
        nextSelected = `${fallback.providerId}:${fallback.modelKey}`;
      } else {
        // No models left under this provider — fall back across all.
        const cross = nextModels
          .filter((m) => m.enabled)
          .sort((a, b) => a.sortOrder - b.sortOrder)[0];
        if (cross) nextSelected = `${cross.providerId}:${cross.modelKey}`;
      }
    }
    const synthesized = synthesizeLegacyProviderFields(
      state.providers,
      nextModels,
      nextSelected,
    );
    set({ models: nextModels, selectedModel: nextSelected, providers: synthesized });
    get().saveToDatabase();
  },

  replaceModelsForProvider: (providerId, init) => {
    const reconciled: LLMModel[] = init.map((m, idx) => ({
      ...m,
      id: `${providerId}::${m.modelKey}`,
      providerId,
      sortOrder: idx,
    }));
    databaseService
      .replaceProviderModels(providerId, reconciled.map(modelToDb))
      .catch(console.error);
    set((state) => {
      const others = state.models.filter((m) => m.providerId !== providerId);
      const nextModels = [...others, ...reconciled];
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        state.selectedModel,
      );
      return { models: nextModels, providers: synthesized };
    });
  },

  getAvailableModels: () => {
    return buildAvailableModelOptions(get().providers);
  },

  getSelectedProvider: () => {
    const state = get();
    const [providerId] = state.selectedModel.split(":");
    return state.providers.find((p: LLMProvider) => p.id === providerId);
  },

  // ============================================
  // SETTINGS ACTIONS
  // ============================================

  setAutoApproveTools: (value: boolean) => {
    set({ autoApproveTools: value });
    get().saveToDatabase();
  },

  setAgentExecutionMode: (mode: AgentExecutionMode) => {
    const nextMode = normalizeAgentExecutionMode(mode);
    set({ agentExecutionMode: nextMode });
    get().saveToDatabase();
  },

  setAutoAcceptChanges: (value: boolean) => {
    set({ autoAcceptChanges: value });
    get().saveToDatabase();
  },

  setSyntaxValidationEnabled: (value: boolean) => {
    set({ syntaxValidationEnabled: value });
    get().saveToDatabase();
  },

  setProjectLayoutEnabled: (value: boolean) => {
    set({ projectLayoutEnabled: value });
    get().saveToDatabase();
  },

  setSkillsEnabled: (enabled: boolean) => {
    set({ skillsEnabled: enabled });
    get().saveToDatabase();
  },

  setSkillEnabled: (storageKey: string, enabled: boolean) => {
    const state = get();
    const isCurrentlyEnabled = state.skillToggles[storageKey] === true;

    // No-op: nothing to change.
    if (isCurrentlyEnabled === enabled) {
      return true;
    }

    // Enforce hard cap when turning ON. Turning OFF is always allowed.
    if (enabled) {
      const enabledCount = countEnabledSkillToggles(state.skillToggles);
      if (enabledCount >= MAX_ENABLED_SKILLS) {
        console.warn(
          `[Skills] Cannot enable more than ${MAX_ENABLED_SKILLS} skills at once. ` +
            `Disable an existing skill before enabling \`${storageKey}\`.`
        );
        return false;
      }
    }

    set((current) => ({
      skillToggles: {
        ...current.skillToggles,
        [storageKey]: enabled,
      },
    }));
    get().saveToDatabase();
    return true;
  },

  setSpeechEnabled: (enabled: boolean) => {
    set({ speechEnabled: enabled });
    get().saveToDatabase();
  },

  setSpeechEngine: (engine: string) => {
    set({ speechEngine: engine || "qwen3-rust" });
    get().saveToDatabase();
  },

  setSpeechRuntimePath: (path: string) => {
    set({ speechRuntimePath: normalizeSpeechRuntimePath(path) });
    get().saveToDatabase();
  },

  setSpeechModelPath: (path: string) => {
    set({ speechModelPath: path });
    get().saveToDatabase();
  },

  setSpeechBackend: (backend: string) => {
    set({ speechBackend: backend || "auto" });
    get().saveToDatabase();
  },

  setSpeechDevicePreference: (preference: 'auto' | 'cpu' | 'gpu') => {
    set({ speechDevicePreference: preference });
    get().saveToDatabase();
  },

  setSpeechThreads: (threads: number) => {
    set({ speechThreads: Math.min(32, Math.max(1, Math.round(threads) || 4)) });
    get().saveToDatabase();
  },

  setSpeechLanguage: (language: string) => {
    set({ speechLanguage: language || "auto" });
    get().saveToDatabase();
  },

  setFontSize: (size: number) => {
    set({ fontSize: size });
    get().saveToDatabase();
  },

  setExplorerIconPack: (packId: ExplorerIconPackId) => {
    const nextPackId = isExplorerIconPackAvailable(packId)
      ? packId
      : DEFAULT_EXPLORER_ICON_PACK_ID;
    set({ explorerIconPack: nextPackId });
    setActiveExplorerIconPackId(nextPackId);
    get().saveToDatabase();
  },

  setFireworksTabEnabled: (enabled: boolean) => {
    set({ fireworksTabEnabled: enabled });
    get().saveToDatabase();
  },

  setFireworksAccountId: (accountId: string) => {
    set({ fireworksAccountId: accountId });
    get().saveToDatabase();
  },

  setWrapMode: (enabled: boolean) => {
    set({ wrapMode: enabled });
    get().saveToDatabase();
  },

  setUiTextScale: (scale: number) => {
    const clamped = clampTextScale(scale);
    set({ uiTextScale: clamped });
    applyUiPreferences(get().uiFontFamily, clamped);
    get().saveToDatabase();
  },

  setUiFontFamily: (family: string) => {
    set({ uiFontFamily: family });
    applyUiPreferences(family, get().uiTextScale);
    get().saveToDatabase();
  },

  setTheme: (theme: "dark" | "light") => {
    set({ theme });
    get().saveToDatabase();
  },


  setThinkingEnabled: (enabled: boolean) => {
    set({ thinkingEnabled: enabled });
    get().saveToDatabase();
  },

  setMaxTokens: (tokens: number) => {
    set({ maxTokens: tokens });
    get().saveToDatabase();
  },

  setTemperature: (temp: number) => {
    set({ temperature: temp });
    get().saveToDatabase();
  },

  setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => {
    set({ autoSave: mode });
    get().saveToDatabase();
  },

  setAutoSaveDelay: (delay: number) => {
    set({ autoSaveDelay: delay });
    get().saveToDatabase();
  },

  setMaxToolCallsPerRequest: (max: number) => {
    set({ maxToolCallsPerRequest: max });
    get().saveToDatabase();
  },

  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => {
    set((state) => ({
      toolApprovalSettings: {
        ...state.toolApprovalSettings,
        [toolName]: setting,
      },
    }));
    // Save individual tool setting
    databaseService.setToolApproval(toolName, setting).catch(console.error);
  },

  getToolApproval: (toolName: string) => {
    const state = get();
    return state.toolApprovalSettings[toolName] || 'always_ask';
  },

  // Get current LLM provider config based on selectedModel.
  //
  // v15+: capability flags (supportsVision, supportsThinking,
  // supportsToolStream) and per-model context/output overrides come
  // from the resolved active `LLMModel`, not from the provider row.
  // This is what drives `browser_screenshot` tool gating in
  // agent-service and `<aurora_image>` routing in the API adapters.
  getLLMConfig: () => {
    const state = get();
    const [providerId, modelKey] = state.selectedModel.split(":");
    const provider = state.providers.find(
      (p: LLMProvider) => p.id === providerId,
    );
    const activeModel =
      provider &&
      state.models.find(
        (m) => m.providerId === providerId && m.modelKey === modelKey,
      );

    if (provider) {
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
        providerType: provider.providerType ?? "custom",
        customHeaders: provider.customHeaders,
        customParams: provider.customParams,
        defaultTemperature: provider.defaultTemperature,
        defaultMaxTokens:
          provider.defaultMaxTokens ?? provider.maxOutputTokens,
      };
    }

    // Fallback to first available provider with API key
    const fallback = state.providers.find(
      (p: LLMProvider) => p.enabled && p.apiKey,
    );
    if (fallback) {
      const fallbackModel = state.models
        .filter((m) => m.providerId === fallback.id && m.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0];
      const resolved = fallbackModel
        ? resolveModel(fallbackModel, fallback)
        : undefined;
      return {
        id: fallback.id,
        name: fallback.name,
        baseUrl: fallback.baseUrl,
        apiKey: fallback.apiKey,
        model: resolved?.modelKey || fallback.model,
        maxOutputTokens: resolved?.resolvedMaxOutputTokens ?? fallback.maxOutputTokens,
        contextWindow: resolved?.resolvedContextWindow ?? fallback.contextWindow,
        supportsThinking: resolved?.supportsThinking ?? false,
        supportsToolStream:
          resolved?.supportsToolStream ?? fallback.supportsToolStream ?? false,
        supportsVision: resolved?.supportsVision ?? false,
        providerType: fallback.providerType ?? "custom",
        customHeaders: fallback.customHeaders,
        customParams: fallback.customParams,
        defaultTemperature: fallback.defaultTemperature,
        defaultMaxTokens:
          fallback.defaultMaxTokens ?? fallback.maxOutputTokens,
      };
    }

    // No provider available
    return null;
  },
}));

// Initialize settings from database when the module loads (for Tauri)
if (typeof window !== 'undefined') {
  // Wait for Tauri to be ready
  setTimeout(() => {
    useSettingsStore.getState().initializeFromDatabase();
  }, 100);
}
