import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";

import {
  formatModelDisplayName,
  formatProviderNickname,
} from "../lib/provider-display";
import { resolveThinkingModelPair } from "../lib/thinking-models";
import { databaseService } from "../services/database";
import { providerCatalogService, type ProviderCatalogPreset } from "../services/provider-catalog";
import type { ProviderConfig } from "../services/providers/types";
import type { AppSettings as DbAppSettings, DbLLMProvider } from "../types/database";

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


// ============================================
// SETTINGS STATE TYPES
// ============================================
interface SettingsState {
  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => string;

  // File Changes Approval
  autoAcceptChanges: boolean;

  // Tool Approval
  autoApproveTools: boolean;

  // Autosave Settings
  autoSave: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
  autoSaveDelay: number; // in milliseconds
  deleteProvider: (id: string) => void;

  // Editor Settings
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

  // Providers
  providers: LLMProvider[];
  saveToDatabase: () => Promise<void>;
  selectedModel: string; // Format: "providerId:model"
  setAutoAcceptChanges: (value: boolean) => void;
  setAutoApproveTools: (value: boolean) => void;
  setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => void;
  setAutoSaveDelay: (delay: number) => void;
  setFontSize: (size: number) => void;
  setFireworksAccountId: (accountId: string) => void;
  setFireworksTabEnabled: (enabled: boolean) => void;
  setHasSeenOnboarding: (seen: boolean) => void;
  setMaxTokens: (tokens: number) => void;
  setMaxToolCallsPerRequest: (max: number) => void;
  setProjectLayoutEnabled: (value: boolean) => void;
  setSelectedModel: (model: string) => void;
  setSkillEnabled: (storageKey: string, enabled: boolean) => void;
  setSkillsEnabled: (enabled: boolean) => void;
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
  wrapMode: boolean;
}


// ============================================
// PROVIDER TYPES
// ============================================
export interface LLMProvider {
  apiKey: string;
  baseUrl: string;
  contextWindow: number;

  // Advanced configuration
  customHeaders?: Record<string, string>; // Extra headers to send
  customModels?: string[];
  customParams?: Record<string, unknown>; // Extra params in request body
  defaultMaxTokens?: number; // Provider-specific default max token request
  defaultTemperature?: number; // Provider-specific default temperature
  enabled: boolean;
  id: string;
  isCustom?: boolean; // User-added provider
  maxOutputTokens: number;
  model: string;
  modelAliases?: Record<string, string>;
  name: string;
  nickname?: string;
  providerType?: "openai" | "fireworks" | "deepseek" | "glm" | "anthropic" | "minimax" | "lmstudio" | "ollama" | "custom"; // Explicit provider type
  requiresApiKey?: boolean; // Whether API key is required (false for local)
  supportsThinking: boolean;
  supportsToolStream?: boolean;
}

// ============================================
// DEFAULT VALUES
// ============================================
const DEFAULT_SELECTED_MODEL = "fireworks:accounts/fireworks/models/kimi-k2-instruct-0905";

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

const getModelAliasesForProvider = (
  provider: Pick<LLMProvider, "customModels" | "model" | "modelAliases">,
): Record<string, string> | undefined => {
  const supportedModels = new Set(getProviderModelList(provider as LLMProvider));
  const normalizedEntries = Object.entries(provider.modelAliases || {})
    .map(([modelId, alias]) => [modelId, alias.trim()] as const)
    .filter(([modelId, alias]) => supportedModels.has(modelId) && alias.length > 0);

  if (normalizedEntries.length === 0) return undefined;
  return Object.fromEntries(normalizedEntries);
};

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
  return {
    id: db.id,
    name: db.name,
    baseUrl: db.baseUrl,
    apiKey: db.apiKey,
    model: db.model,
    contextWindow: db.contextWindow,
    maxOutputTokens: db.maxOutputTokens,
    supportsThinking: db.supportsThinking,
    supportsToolStream: db.supportsToolStream,
    enabled: db.enabled,
    isCustom: db.isCustom,
    customModels: db.customModels || undefined,
    modelAliases: db.modelAliases || undefined,
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
    supportsThinking: provider.supportsThinking,
    supportsToolStream: provider.supportsToolStream || false,
    enabled: provider.enabled,
    isCustom: provider.isCustom || false,
    customModels: provider.customModels || null,
    modelAliases: getModelAliasesForProvider(provider) || null,
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
  selectedModel: DEFAULT_SELECTED_MODEL,

  // Tool Approval
  autoApproveTools: false,

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

  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  initializeFromDatabase: async () => {
    const state = get();
    if (state.isLoading || state.isInitialized) return;

    set({ isLoading: true });

    try {
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
              modelAliases: {
                ...(presetProvider.modelAliases || {}),
                ...(dbProvider.modelAliases || {}),
              },
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

        set({ providers: mergedProviders });
      } else {
        // First time: save default providers to database
        const defaultProviders = createDefaultProviders(presetProviders);
        const dbProviders = defaultProviders.map((p, i) => providerToDb(p, i));
        await databaseService.saveAllProviders(dbProviders);
        set({ providers: defaultProviders });
      }

      // Load app settings
      const appSettings = await databaseService.getAppSettings();
      if (appSettings) {
        const uiFontFamily = appSettings.uiFontFamily ?? "system";
        const uiTextScale = appSettings.uiTextScale ?? 1;
        const selectedModel = resolveSelectedModel(
          appSettings.selectedModel || DEFAULT_SELECTED_MODEL,
          get().providers,
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
          autoAcceptChanges: appSettings.autoAcceptChanges ?? false,
          syntaxValidationEnabled: appSettings.syntaxValidationEnabled ?? true,
          projectLayoutEnabled: appSettings.projectLayoutEnabled ?? true,
          skillsEnabled: appSettings.skillsEnabled ?? true,
          skillToggles: appSettings.skillToggles ?? {},
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

        applyUiPreferences(uiFontFamily, uiTextScale);
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
        autoApproveTools: state.autoApproveTools,
        autoAcceptChanges: state.autoAcceptChanges,
        syntaxValidationEnabled: state.syntaxValidationEnabled,
        projectLayoutEnabled: state.projectLayoutEnabled,
        skillsEnabled: state.skillsEnabled,
        skillToggles: state.skillToggles,
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
    set((state: SettingsState) => {
      const providers = state.providers.map((provider: LLMProvider) => {
        if (provider.id !== id) return provider;

        const nextProvider = {
          ...provider,
          ...updates,
        };

        return {
          ...nextProvider,
          modelAliases: getModelAliasesForProvider(nextProvider),
          nickname: nextProvider.nickname?.trim() || undefined,
        };
      });
      const selectedModel = resolveSelectedModel(state.selectedModel, providers);

      return {
        providers,
        selectedModel,
        thinkingEnabled: syncThinkingForSelectedModel(
          selectedModel,
          providers,
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
      modelAliases: getModelAliasesForProvider(provider as LLMProvider),
      nickname: provider.nickname?.trim() || undefined,
    };
    set((state: SettingsState) => ({
      providers: [...state.providers, newProvider],
    }));
    get().saveToDatabase();
    return id;
  },

  deleteProvider: (id: string) => {
    const state = get();
    const provider = state.providers.find((p: LLMProvider) => p.id === id);
    // Only allow deleting custom providers
    if (provider?.isCustom) {
      set((state: SettingsState) => ({
        providers: state.providers.filter((p: LLMProvider) => p.id !== id),
        // Reset selected model if it was from deleted provider
        selectedModel: state.selectedModel.startsWith(id + ":")
          ? DEFAULT_SELECTED_MODEL
          : state.selectedModel,
      }));
      // Delete from database
      databaseService.deleteProvider(id).catch(console.error);
      get().saveToDatabase();
    }
  },

  setSelectedModel: (model: string) => {
    set((state) => ({
      selectedModel: model,
      thinkingEnabled: syncThinkingForSelectedModel(model, state.providers, state.thinkingEnabled),
    }));
    get().saveToDatabase();
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
    set((state) => ({
      skillToggles: {
        ...state.skillToggles,
        [storageKey]: enabled,
      },
    }));
    get().saveToDatabase();
  },

  setFontSize: (size: number) => {
    set({ fontSize: size });
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

  // Get current LLM provider config based on selectedModel
  getLLMConfig: () => {
    const state = get();
    const [providerId, model] = state.selectedModel.split(":");
    const provider = state.providers.find(
      (p: LLMProvider) => p.id === providerId,
    );

    if (provider) {
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: model || provider.model,
        maxOutputTokens: provider.maxOutputTokens,
        contextWindow: provider.contextWindow,
        supportsThinking: provider.supportsThinking,
        supportsToolStream: provider.supportsToolStream ?? false,
        supportsVision: false,
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
      return {
        id: fallback.id,
        name: fallback.name,
        baseUrl: fallback.baseUrl,
        apiKey: fallback.apiKey,
        model: fallback.model,
        maxOutputTokens: fallback.maxOutputTokens,
        contextWindow: fallback.contextWindow,
        supportsThinking: fallback.supportsThinking,
        supportsToolStream: fallback.supportsToolStream ?? false,
        supportsVision: false,
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
