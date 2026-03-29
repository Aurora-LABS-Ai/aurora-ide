/**
 * Provider Registry - Central management for all LLM providers
 *
 * Features:
 * - Provider registration and lookup
 * - Rust-kernel-backed provider creation
 * - Singleton pattern for global access
 */
import { RustProvider } from "./rust-provider";
import type { IProvider, ProviderConfig } from "./types";

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
 * Create a provider instance.
 * The Rust provider kernel owns provider-specific request shaping and
 * transport details. Frontend construction stays intentionally thin.
 */
export function createProvider(config: ProviderConfig): IProvider {
  return new RustProvider(config);
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

// Re-export public types
export * from './types';
export {
  getDefaultContextWindow,
  getPresetContextWindow,
  getPresetMaxOutput,
} from "./provider-defaults";

export { RustProvider } from './rust-provider';

// Singleton instance
export const providerRegistry = new ProviderRegistry();

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================
let activeProvider: IProvider | null = null;
