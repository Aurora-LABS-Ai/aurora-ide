import { auroraInvoke as invoke } from "../lib/runtime";

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
