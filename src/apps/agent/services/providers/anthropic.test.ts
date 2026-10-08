import { describe, expect, it } from "vitest";

import {
  cacheWritePerMtok,
  isAnthropicApiProvider,
  promptCacheTtl,
  withPromptCacheTtl,
} from "@/apps/agent/services/providers/anthropic";
import { resolveProviderType } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { modelsFromPreset } from "@/apps/agent/store/settings/provider-model";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

describe("the built-in Anthropic row", () => {
  it("moves a row stored as the plain Messages wire onto its own type at launch", () => {
    // Rows seeded before the first-party adapter carry `anthropic`. The launch
    // merge must hand them the new type, or they keep the gateway adapter.
    expect(resolveProviderType("anthropic-api", "anthropic")).toBe("anthropic-api");
  });

  it("is never confused with a gateway that speaks the Anthropic wire", () => {
    expect(isAnthropicApiProvider({ id: "anthropic", providerType: "anthropic-api" })).toBe(true);
    // A user-added gateway typed `anthropic` must keep the plain adapter: it
    // would answer the first-party-only fields with a 400.
    expect(isAnthropicApiProvider({ id: "51a8c559", providerType: "anthropic" })).toBe(false);
  });

  it("stores the one-hour cache as one key and the default as none", () => {
    const hour = withPromptCacheTtl({ other: 1 }, "1h");
    expect(hour).toEqual({ other: 1, prompt_cache_ttl: "1h" });
    expect(promptCacheTtl({ customParams: hour })).toBe("1h");

    // Back to the default removes the key rather than storing "5m", and a row
    // left with nothing else has no params at all.
    expect(withPromptCacheTtl(hour, "5m")).toEqual({ other: 1 });
    expect(withPromptCacheTtl({ prompt_cache_ttl: "1h" }, "5m")).toBeUndefined();
    expect(promptCacheTtl({ customParams: undefined })).toBe("5m");
  });

  it("prices cache writes at 2x input once the one-hour cache is on", () => {
    const model = { priceCacheMissPerMtok: 4, priceCacheWritePerMtok: 5 };
    const anthropic = { providerType: "anthropic-api" as const };
    expect(cacheWritePerMtok({ ...anthropic, customParams: undefined }, model)).toBe(5);
    expect(cacheWritePerMtok({ ...anthropic, customParams: { prompt_cache_ttl: "1h" } }, model)).toBe(8);
    // A gateway row never reads this setting; its own price stands.
    expect(
      cacheWritePerMtok({ providerType: "anthropic", customParams: { prompt_cache_ttl: "1h" } }, model),
    ).toBe(5);
  });

  it("seeds the cache-write price, so cost cards stop pricing writes as fresh input", () => {
    const preset: ProviderCatalogPreset = {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-opus-5-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
      providerType: "anthropic-api",
      requiresApiKey: true,
      customModels: ["claude-opus-5-5"],
      modelPricing: {
        "claude-opus-5-5": {
          cacheHitPerMtok: 0.2,
          cacheMissPerMtok: 4,
          outputPerMtok: 20,
          cacheWritePerMtok: 5,
        },
      },
    };
    const [model] = modelsFromPreset(preset);
    expect(model.priceCacheWritePerMtok).toBe(5);
    expect(model.priceCacheMissPerMtok).toBe(4);
  });
});
