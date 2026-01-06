/**
 * Provider Registry - Central management for all LLM providers
 * 
 * Features:
 * - Provider registration and lookup
 * - Auto-detection of provider type using presets
 * - Context window management from DB
 * - Singleton pattern for global access
 */
import { AnthropicProvider } from "./anthropic-provider";
import { LMStudioProvider } from "./lmstudio-provider";
import { OpenAIProvider } from "./openai-provider";
import { PROVIDER_PRESETS, detectProviderType, getProviderPreset } from "./provider-presets";
import type { IProvider, ProviderConfig, ProviderType } from "./types";

// ============================================================
// PROVIDER REGISTRY
// ============================================================
class ProviderRegistry {
  private currentProviderId: string | null = null;
  private providers: Map<string, IProvider> = new Map();

  /**
   * Clear all providers
   */
  public clear(): void {
    this.providers.clear();
    this.currentProviderId = null;
  }

  /**
   * Get provider by ID
   */
  public get(id: string): IProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get current active provider
   */
  public getCurrent(): IProvider | null {
    if (!this.currentProviderId) return null;
    return this.providers.get(this.currentProviderId) || null;
  }

  /**
   * Get all registered provider IDs
   */
  public getIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if provider exists
   */
  public has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Register a provider
   */
  public register(config: ProviderConfig): IProvider {
    const provider = createProvider(config);
    this.providers.set(config.id, provider);
    return provider;
  }

  /**
   * Remove provider
   */
  public remove(id: string): boolean {
    if (this.currentProviderId === id) {
      this.currentProviderId = null;
    }
    return this.providers.delete(id);
  }

  /**
   * Set current provider
   */
  public setCurrent(id: string): boolean {
    if (this.providers.has(id)) {
      this.currentProviderId = id;
      return true;
    }
    return false;
  }
}

// ============================================================
// PROVIDER FACTORY
// ============================================================

/**
 * Create a provider instance based on type
 * Uses the preset system for proper configuration
 */
export function createProvider(config: ProviderConfig): IProvider {
  // Use explicit providerType if set, otherwise auto-detect
  const type = config.providerType || detectProviderType(config.baseUrl, config.model);

  // Get the preset for this provider type
  const preset = getProviderPreset(type);

  // Route to appropriate provider class based on API format
  if (preset.baseFormat === 'anthropic') {
    return new AnthropicProvider({ ...config, providerType: type as ProviderType });
  }

  // Use LM Studio provider for local servers that prefer async-openai
  // This uses the Rust async-openai crate for more reliable streaming
  if (type === 'lmstudio' || type === 'ollama' || (preset as { useNativeOpenAI?: boolean }).useNativeOpenAI) {
    return new LMStudioProvider({ ...config, providerType: type as ProviderType });
  }

  // Default to OpenAI-compatible provider
  return new OpenAIProvider({ ...config, providerType: type as ProviderType });
}

/**
 * Get default context window for a model
 */
export function getDefaultContextWindow(model: string): number {
  // Check exact match
  if (DEFAULT_CONTEXT_WINDOWS[model]) {
    return DEFAULT_CONTEXT_WINDOWS[model];
  }

  // Check partial match
  for (const [key, value] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
    if (model.toLowerCase().includes(key.toLowerCase())) {
      return value;
    }
  }

  return DEFAULT_CONTEXT_WINDOWS['default'];
}

/**
 * Get context window from preset
 */
export function getPresetContextWindow(providerType: string): number {
  const preset = PROVIDER_PRESETS[providerType];
  return preset?.defaultContextWindow || DEFAULT_CONTEXT_WINDOWS['default'];
}

/**
 * Get max output tokens from preset
 */
export function getPresetMaxOutput(providerType: string): number {
  const preset = PROVIDER_PRESETS[providerType];
  return preset?.defaultMaxOutput || 8192;
}

/**
 * Get the active provider
 */
export function getProvider(): IProvider {
  if (!activeProvider) {
    throw new Error('Provider not initialized. Call initProvider first.');
  }
  return activeProvider;
}

/**
 * Initialize provider from config (convenience function)
 */
export function initProvider(config: ProviderConfig): IProvider {
  activeProvider = createProvider(config);
  providerRegistry.register(config);
  providerRegistry.setCurrent(config.id);
  return activeProvider;
}

/**
 * Check if provider is initialized
 */
export function isProviderInitialized(): boolean {
  return activeProvider !== null;
}

/**
 * Update active provider config
 */
export function updateProvider(config: Partial<ProviderConfig>): void {
  if (activeProvider) {
    activeProvider.updateConfig(config);
  }
}

// Re-export types and utilities
export * from './types';

export * from './provider-presets';

export { OpenAIProvider } from './openai-provider';

export { AnthropicProvider } from './anthropic-provider';

export { LMStudioProvider } from './lmstudio-provider';

// Singleton instance
export const providerRegistry = new ProviderRegistry();

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================
let activeProvider: IProvider | null = null;

// ============================================================
// DEFAULT CONTEXT WINDOWS
// ============================================================

/**
 * Default context windows for known models
 * These should be stored in DB per provider, but this serves as fallback
 */
export const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'o1': 200000,
  'o1-mini': 128000,
  'gpt-5': 400000, // Future

  // Anthropic
  'claude-opus-4-5-20251101': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,

  // DeepSeek
  'deepseek-chat': 64000,
  'deepseek-reasoner': 64000,

  // GLM
  'glm-4.7': 200000,
  'glm-4.6': 200000,
  'glm-4.5': 128000,

  // MiniMax
  'MiniMax-M2.1': 200000, // 200k context (128k max output)

  // Gemini
  'gemini-2.0-flash': 1000000,
  'gemini-3-pro': 1000000, // 1M context

  // Default
  'default': 200000,
};
