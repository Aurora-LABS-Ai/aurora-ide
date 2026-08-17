import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";

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
  /**
   * Whether the seeded models accept images.
   *
   * Absent means "no" for a preset that genuinely has no vision — but it used
   * to be the ONLY answer, because seeding hardcoded `supportsVision: false`
   * for every preset. A vision model therefore arrived switched off and every
   * user had to find the toggle in Settings › Providers before they could
   * paste a screenshot. A preset that knows its models see has to be able to
   * say so.
   */
  supportsVision?: boolean;
  customModels?: string[];
  modelAliases?: Record<string, string>;
  providerType: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  requiresApiKey: boolean;
  /** Keyed by API model id; missing entries fall back to user input. */
  modelPricing?: Record<string, ProviderCatalogModelPricing>;
  /**
   * Transport headers to seed onto the created provider. Used by frontend
   * presets (e.g. AgentRouter) that require specific headers to authenticate
   * — AgentRouter fingerprints the client via `User-Agent` + `X-Title` and
   * returns 401 without them. Rust catalog presets omit this.
   */
  customHeaders?: Record<string, string>;
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
