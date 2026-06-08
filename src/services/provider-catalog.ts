import { auroraInvoke as invoke } from "../lib/runtime";

/**
 * Per-model default pricing (USD per 1M tokens). Mirrors the Rust
 * `ModelPricing` struct in `provider_catalog/types.rs`. Used to seed
 * new provider_model rows on first-run; existing rows in SQLite take
 * precedence over these defaults.
 */
export interface ProviderCatalogModelPricing {
  cacheHitPerMtok: number;
  cacheMissPerMtok: number;
  outputPerMtok: number;
}

export interface ProviderCatalogPreset {
  id: string;
  name: string;
  nickname?: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsToolStream?: boolean;
  customModels?: string[];
  modelAliases?: Record<string, string>;
  providerType: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  requiresApiKey: boolean;
  /** Keyed by API model id; missing entries fall back to user input. */
  modelPricing?: Record<string, ProviderCatalogModelPricing>;
}

class ProviderCatalogService {
  public async getPresets(): Promise<ProviderCatalogPreset[]> {
    try {
      return await invoke<ProviderCatalogPreset[]>("provider_catalog_get_presets");
    } catch (error) {
      console.error("Failed to load provider catalog:", error);
      return [];
    }
  }
}

export const providerCatalogService = new ProviderCatalogService();
