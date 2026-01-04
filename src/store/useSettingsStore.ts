import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";

import { databaseService } from "../services/database";
import type { LLMProviderConfig } from "../services/llm-types";
import type { AppSettings as DbAppSettings, DbLLMProvider } from "../types/database";

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
  getAvailableModels: () => Array<{
    providerId: string;
    providerName: string;
    model: string;
    label: string;
  }>;
  getLLMConfig: () => LLMProviderConfig | null;
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

  // Providers
  providers: LLMProvider[];
  saveToDatabase: () => Promise<void>;
  selectedModel: string; // Format: "providerId:model"
  setAutoAcceptChanges: (value: boolean) => void;
  setAutoApproveTools: (value: boolean) => void;
  setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => void;
  setAutoSaveDelay: (delay: number) => void;
  setFontSize: (size: number) => void;
  setHasSeenOnboarding: (seen: boolean) => void;
  setMaxTokens: (tokens: number) => void;
  setMaxToolCallsPerRequest: (max: number) => void;
  setProjectLayoutEnabled: (value: boolean) => void;
  setSelectedModel: (model: string) => void;
  setSyntaxValidationEnabled: (value: boolean) => void;
  setTemperature: (temp: number) => void;
  setTheme: (theme: "dark" | "light") => void;
  setThinkingEnabled: (enabled: boolean) => void;
  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => void;
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
  name: string;
  providerType?: "openai" | "deepseek" | "glm" | "anthropic" | "minimax" | "custom"; // Explicit provider type
  requiresApiKey?: boolean; // Whether API key is required (false for local)
  supportsThinking: boolean;
  supportsToolStream?: boolean;
}

// ============================================
// DEFAULT VALUES
// ============================================
const createDefaultProviders = (): LLMProvider[] => {
  return PRESET_PROVIDERS.map((preset) => ({
    ...preset,
    apiKey: "",
    enabled: true,
    isCustom: false,
  }));
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
    customHeaders: db.customHeaders || undefined,
    customParams: db.customParams || undefined,
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
    customHeaders: provider.customHeaders || null,
    customParams: provider.customParams || null,
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
// PRESET PROVIDERS (built-in, can't be deleted)
// ============================================
export const PRESET_PROVIDERS: Omit<LLMProvider, "apiKey" | "enabled">[] = [
  {
    id: "glm",
    name: "GLM-4.7 (Z.AI)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    model: "glm-4.7",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsThinking: true,
    customModels: ["glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-flash"],
    providerType: "glm",
    defaultTemperature: 1.0,
    requiresApiKey: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    customModels: ["claude-opus-4-5-20251101", "claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
    providerType: "anthropic",
    defaultTemperature: 1.0,
    requiresApiKey: true,
  },
  {
    id: "minimax",
    name: "MiniMax M2.1",
    baseUrl: "https://api.minimax.io/anthropic/v1", // Correct path: baseURL + /messages
    model: "MiniMax-M2.1",
    contextWindow: 200000, // 200k context
    maxOutputTokens: 128000,
    supportsThinking: true, // Native thinking blocks (better than OpenAI format)
    customModels: ["MiniMax-M2.1"],
    providerType: "anthropic", // ✅ Use Anthropic provider (official recommendation)
    defaultTemperature: 1.0,
    requiresApiKey: true,
    // No customParams needed - thinking mode is native in Anthropic format
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    contextWindow: 64000,
    maxOutputTokens: 64000,
    supportsThinking: true,
    customModels: ["deepseek-chat", "deepseek-reasoner"],
    providerType: "deepseek",
    defaultTemperature: 1.0,
    requiresApiKey: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsThinking: false,
    customModels: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "o1-mini"],
    providerType: "openai",
    defaultTemperature: 1.0,
    requiresApiKey: true,
  },
];
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
  providers: createDefaultProviders(),
  selectedModel: "glm:glm-4.7",

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

  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  initializeFromDatabase: async () => {
    const state = get();
    if (state.isLoading || state.isInitialized) return;

    set({ isLoading: true });

    try {
      // Check if we have providers in the database
      const hasProviders = await databaseService.hasProviders();

      if (hasProviders) {
        // Load providers from database
        const dbProviders = await databaseService.getAllProviders();
        const providers = dbProviders.map(dbToProvider);

        // Merge with preset providers (in case new presets were added)
        const mergedProviders = PRESET_PROVIDERS.map(preset => {
          const dbProvider = providers.find(p => p.id === preset.id);
          if (dbProvider) {
            // Keep the stored API key and settings, but update with any new preset fields
            return { ...preset, ...dbProvider, isCustom: false };
          }
          return { ...preset, apiKey: "", enabled: true, isCustom: false };
        });

        // Add any custom providers (ensure isCustom is set)
        const customProviders = providers
          .filter(p => p.isCustom)
          .map(p => ({ ...p, isCustom: true as const }));
        mergedProviders.push(...customProviders);

        set({ providers: mergedProviders });
      } else {
        // First time: save default providers to database
        const defaultProviders = createDefaultProviders();
        const dbProviders = defaultProviders.map((p, i) => providerToDb(p, i));
        await databaseService.saveAllProviders(dbProviders);
        set({ providers: defaultProviders });
      }

      // Load app settings
      const appSettings = await databaseService.getAppSettings();
      if (appSettings) {
        set({
          selectedModel: appSettings.selectedModel || "glm:glm-4.7",
          autoApproveTools: appSettings.autoApproveTools ?? false,
          autoAcceptChanges: appSettings.autoAcceptChanges ?? false,
          syntaxValidationEnabled: appSettings.syntaxValidationEnabled ?? true,
          projectLayoutEnabled: appSettings.projectLayoutEnabled ?? true,
          fontSize: appSettings.fontSize ?? 14,
          wrapMode: appSettings.wrapMode ?? true,
          theme: (appSettings.theme as 'dark' | 'light') || "dark",
          thinkingEnabled: appSettings.thinkingEnabled ?? true,
          maxTokens: appSettings.maxTokens ?? 8192,
          temperature: appSettings.temperature ?? 1.0,
          autoSave: (appSettings.autoSave as SettingsState['autoSave']) || 'off',
          autoSaveDelay: appSettings.autoSaveDelay ?? 1000,
          maxToolCallsPerRequest: appSettings.maxToolCallsPerRequest ?? 25,
        });
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
        fontSize: state.fontSize,
        wrapMode: state.wrapMode,
        theme: state.theme,
        thinkingEnabled: state.thinkingEnabled,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        autoSave: state.autoSave,
        autoSaveDelay: state.autoSaveDelay,
        maxToolCallsPerRequest: state.maxToolCallsPerRequest,
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
    set((state: SettingsState) => ({
      providers: state.providers.map((p: LLMProvider) =>
        p.id === id ? { ...p, ...updates } : p,
      ),
    }));
    // Debounced save to database
    setTimeout(() => get().saveToDatabase(), 500);
  },

  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => {
    const id = uuidv4();
    const newProvider: LLMProvider = {
      ...provider,
      id,
      isCustom: true,
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
          ? "glm:glm-4.7"
          : state.selectedModel,
      }));
      // Delete from database
      databaseService.deleteProvider(id).catch(console.error);
      get().saveToDatabase();
    }
  },

  setSelectedModel: (model: string) => {
    set({ selectedModel: model });
    get().saveToDatabase();
  },

  getAvailableModels: () => {
    const state = get();
    const models: Array<{
      providerId: string;
      providerName: string;
      model: string;
      label: string;
    }> = [];

    for (const provider of state.providers) {
      // Only include if enabled and has API key (or is local)
      const isLocal =
        provider.baseUrl.includes("localhost") ||
        provider.baseUrl.includes("127.0.0.1");
      if (!provider.enabled) continue;
      if (!isLocal && !provider.apiKey) continue;

      // Add all models for this provider
      const providerModels = provider.customModels?.length
        ? provider.customModels
        : [provider.model];

      for (const model of providerModels) {
        models.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          label: model,
        });
      }
    }

    return models;
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

  setFontSize: (size: number) => {
    set({ fontSize: size });
    get().saveToDatabase();
  },

  setWrapMode: (enabled: boolean) => {
    set({ wrapMode: enabled });
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
        supportsToolStream: provider.supportsToolStream,
        providerType: provider.providerType,
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
        supportsToolStream: fallback.supportsToolStream,
        providerType: fallback.providerType,
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
