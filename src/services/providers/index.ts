/**
 * Provider Registry - Central management for all LLM providers
 *
 * Features:
 * - Provider registration and lookup
 * - Auto-detection of provider type
 * - Context window management from DB
 * - Singleton pattern for global access
 */

import type { ProviderConfig, ProviderType, IProvider } from './types';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';

// Re-export types
export * from './types';
export { TokenCounter, tokenCounter } from './token-counter';
export { OpenAIProvider } from './openai-provider';
export { AnthropicProvider } from './anthropic-provider';

// ============================================================
// PROVIDER FACTORY
// ============================================================

/**
 * Create a provider instance based on type
 */
export function createProvider(config: ProviderConfig): IProvider {
  const type = config.providerType || detectProviderType(config);

  switch (type) {
    case 'anthropic':
    case 'minimax':
      return new AnthropicProvider({ ...config, providerType: type });

    case 'openai':
    case 'deepseek':
    case 'glm':
    case 'custom':
    default:
      return new OpenAIProvider({ ...config, providerType: type });
  }
}

/**
 * Auto-detect provider type from config
 */
export function detectProviderType(config: Partial<ProviderConfig>): ProviderType {
  const baseUrl = config.baseUrl?.toLowerCase() || '';
  const model = config.model?.toLowerCase() || '';

  // Anthropic
  if (baseUrl.includes('anthropic.com') || model.includes('claude')) {
    return 'anthropic';
  }

  // MiniMax (supports both OpenAI and Anthropic formats)
  if (baseUrl.includes('minimax') || model.includes('minimax')) {
    // Check if using Anthropic endpoint
    if (baseUrl.includes('/anthropic')) {
      return 'minimax';
    }
    return 'openai'; // MiniMax OpenAI-compatible
  }

  // DeepSeek
  if (baseUrl.includes('deepseek.com') || model.includes('deepseek')) {
    return 'deepseek';
  }

  // GLM / Z.AI
  if (baseUrl.includes('z.ai') || model.includes('glm')) {
    return 'glm';
  }

  // OpenAI
  if (baseUrl.includes('openai.com') || model.includes('gpt')) {
    return 'openai';
  }

  // Default to custom (OpenAI-compatible)
  return 'custom';
}

// ============================================================
// PROVIDER REGISTRY
// ============================================================

class ProviderRegistry {
  private providers: Map<string, IProvider> = new Map();
  private currentProviderId: string | null = null;

  /**
   * Register a provider
   */
  register(config: ProviderConfig): IProvider {
    const provider = createProvider(config);
    this.providers.set(config.id, provider);
    return provider;
  }

  /**
   * Get provider by ID
   */
  get(id: string): IProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get current active provider
   */
  getCurrent(): IProvider | null {
    if (!this.currentProviderId) return null;
    return this.providers.get(this.currentProviderId) || null;
  }

  /**
   * Set current provider
   */
  setCurrent(id: string): boolean {
    if (this.providers.has(id)) {
      this.currentProviderId = id;
      return true;
    }
    return false;
  }

  /**
   * Remove provider
   */
  remove(id: string): boolean {
    if (this.currentProviderId === id) {
      this.currentProviderId = null;
    }
    return this.providers.delete(id);
  }

  /**
   * Clear all providers
   */
  clear(): void {
    this.providers.clear();
    this.currentProviderId = null;
  }

  /**
   * Get all registered provider IDs
   */
  getIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if provider exists
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

let activeProvider: IProvider | null = null;

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
 * Get the active provider
 */
export function getProvider(): IProvider {
  if (!activeProvider) {
    throw new Error('Provider not initialized. Call initProvider first.');
  }
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
    (activeProvider as any).updateConfig(config);
  }
}

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
