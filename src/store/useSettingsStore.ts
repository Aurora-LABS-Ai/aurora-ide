import { create } from "zustand";
import { persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import type { LLMProviderConfig } from "../services/llm-types";

// ============================================
// PROVIDER TYPES
// ============================================

export interface LLMProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsToolStream?: boolean;
  enabled: boolean;
  isCustom?: boolean; // User-added provider
  customModels?: string[];
  // Advanced configuration
  customHeaders?: Record<string, string>; // Extra headers to send
  customParams?: Record<string, unknown>; // Extra params in request body
  providerType?: "openai" | "deepseek" | "glm" | "anthropic" | "custom"; // Explicit provider type
  defaultTemperature?: number; // Provider-specific default temperature
  defaultMaxTokens?: number; // Provider-specific default max token request
  requiresApiKey?: boolean; // Whether API key is required (false for local)
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
    customModels: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    providerType: "openai",
    defaultTemperature: 1.0,
    requiresApiKey: true,
  },
];

// ============================================
// SETTINGS STATE TYPES
// ============================================

interface SettingsState {
  // Providers
  providers: LLMProvider[];
  selectedModel: string; // Format: "providerId:model"

  // Provider actions
  updateProvider: (id: string, updates: Partial<LLMProvider>) => void;
  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => string;
  deleteProvider: (id: string) => void;
  setSelectedModel: (model: string) => void;
  getAvailableModels: () => Array<{
    providerId: string;
    providerName: string;
    model: string;
    label: string;
  }>;
  getSelectedProvider: () => LLMProvider | undefined;
  getLLMConfig: () => LLMProviderConfig | null;

  // Tool Approval
  autoApproveTools: boolean;
  setAutoApproveTools: (value: boolean) => void;

  // Editor Settings
  fontSize: number;
  setFontSize: (size: number) => void;

  // Theme
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;

  // Thinking Settings
  thinkingEnabled: boolean;
  setThinkingEnabled: (enabled: boolean) => void;

  // Max Tokens
  maxTokens: number;
  setMaxTokens: (tokens: number) => void;

  // Temperature
  temperature: number;
  setTemperature: (temp: number) => void;

  // Autosave Settings
  autoSave: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
  autoSaveDelay: number; // in milliseconds
  setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => void;
  setAutoSaveDelay: (delay: number) => void;

  // Tool Settings
  maxToolCallsPerRequest: number;
  setMaxToolCallsPerRequest: (max: number) => void;
  toolApprovalSettings: Record<string, 'auto' | 'always_ask' | 'deny'>;
  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => void;
  getToolApproval: (toolName: string) => 'auto' | 'always_ask' | 'deny';
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

// ============================================
// SETTINGS STORE
// ============================================

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Providers
      providers: createDefaultProviders(),
      selectedModel: "glm:glm-4.7",

      updateProvider: (id: string, updates: Partial<LLMProvider>) => {
        set((state: SettingsState) => ({
          providers: state.providers.map((p: LLMProvider) =>
            p.id === id ? { ...p, ...updates } : p,
          ),
        }));
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
        }
      },

      setSelectedModel: (model: string) => {
        set({ selectedModel: model });
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

      // Tool Approval
      autoApproveTools: false,
      setAutoApproveTools: (value: boolean) => set({ autoApproveTools: value }),

      // Editor Settings
      fontSize: 14,
      setFontSize: (size: number) => set({ fontSize: size }),

      // Theme
      theme: "dark",
      setTheme: (theme: "dark" | "light") => set({ theme }),

      // Thinking Settings
      thinkingEnabled: true,
      setThinkingEnabled: (enabled: boolean) =>
        set({ thinkingEnabled: enabled }),

      // Max Tokens
      maxTokens: 8192,
      setMaxTokens: (tokens: number) => set({ maxTokens: tokens }),

      // Temperature
      temperature: 1.0,
      setTemperature: (temp: number) => set({ temperature: temp }),

      // Autosave Settings
      autoSave: 'off',
      autoSaveDelay: 1000,
      setAutoSave: (mode: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange') => 
        set({ autoSave: mode }),
      setAutoSaveDelay: (delay: number) => set({ autoSaveDelay: delay }),

      // Tool Settings
      maxToolCallsPerRequest: 25,
      setMaxToolCallsPerRequest: (max: number) => set({ maxToolCallsPerRequest: max }),
      toolApprovalSettings: {
        // Default: shell commands require approval, file reads are auto
        shell_execute: 'always_ask',
        shell_spawn: 'always_ask',
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
      },
      setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') =>
        set((state) => ({
          toolApprovalSettings: {
            ...state.toolApprovalSettings,
            [toolName]: setting,
          },
        })),
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
    }),
    {
      name: "aurora-settings",
      version: 3,
      partialize: (state: SettingsState) => ({
        providers: state.providers,
        selectedModel: state.selectedModel,
        autoApproveTools: state.autoApproveTools,
        fontSize: state.fontSize,
        theme: state.theme,
        thinkingEnabled: state.thinkingEnabled,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        autoSave: state.autoSave,
        autoSaveDelay: state.autoSaveDelay,
        maxToolCallsPerRequest: state.maxToolCallsPerRequest,
        toolApprovalSettings: state.toolApprovalSettings,
      }),
      merge: (
        persistedState: unknown,
        currentState: SettingsState,
      ): SettingsState => {
        const persisted = persistedState as Partial<SettingsState> | undefined;

        // Merge persisted providers with defaults, keeping custom providers
        const defaultProviders = createDefaultProviders();
        const persistedProviders = persisted?.providers || [];

        // Start with default providers, update with persisted data
        const mergedProviders = defaultProviders.map(
          (defaultP: LLMProvider) => {
            const found = persistedProviders.find(
              (p: LLMProvider) => p.id === defaultP.id,
            );
            return found
              ? { ...defaultP, ...found, isCustom: false }
              : defaultP;
          },
        );

        // Add any custom providers from persisted state
        const customProviders = persistedProviders.filter(
          (p: LLMProvider) => p.isCustom,
        );
        mergedProviders.push(...customProviders);

        return {
          ...currentState,
          ...persisted,
          providers: mergedProviders,
        };
      },
    },
  ),
);
