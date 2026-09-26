/**
 * Atlas Cloud — provider preset (the data the settings store seeds from).
 *
 * The usage service that reads the Coding Plan is
 * `apps/agent/services/providers/atlascloud.ts`; this file is only what the
 * settings store seeds from, kept apart so the store does not pull in the
 * usage service.
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

export const ATLAS_API_ORIGIN = "https://api.atlascloud.ai";
export const ATLAS_API_BASE = `${ATLAS_API_ORIGIN}/v1`;
export const ATLAS_PROVIDER_ID = "atlascloud";

interface Seed {
  id: string;
  alias: string;
  in: number;
  out: number;
  cache: number;
}

/**
 * Curated coding/agentic LLMs on Atlas Cloud, seeded with normal (non-`-coding`)
 * model ids — the ids the OpenAI-compatible endpoint accepts. Pricing (USD/1M)
 * comes straight from the console catalog so cost badges are correct on first
 * run; everything is user-overridable.
 */
const ATLAS_SEED_MODELS: Seed[] = [
  { id: "zai-org/glm-5.2", alias: "GLM 5.2", in: 1.33, out: 4.18, cache: 0.247 },
  { id: "zai-org/glm-4.7", alias: "GLM 4.7", in: 0.52, out: 1.85, cache: 0.12 },
  { id: "moonshotai/kimi-k2.7-code", alias: "Kimi K2.7 Code", in: 0.95, out: 4, cache: 0.16 },
  { id: "moonshotai/kimi-k2.5", alias: "Kimi K2.5", in: 0.49, out: 2.5, cache: 0.2 },
  { id: "anthropic/claude-sonnet-4.6", alias: "Claude Sonnet 4.6", in: 3, out: 15, cache: 0.3 },
  { id: "anthropic/claude-opus-4.8", alias: "Claude Opus 4.8", in: 5, out: 25, cache: 0.5 },
  { id: "deepseek-ai/DeepSeek-V3.1-Terminus", alias: "DeepSeek V3.1 Terminus", in: 0.3, out: 0.95, cache: 0.13 },
  { id: "Qwen/Qwen3-Coder", alias: "Qwen3 Coder", in: 0.78, out: 3.8, cache: 0.2 },
  { id: "qwen/qwen3-coder-next", alias: "Qwen3 Coder Next", in: 0.18, out: 1.35, cache: 0.18 },
  { id: "minimaxai/minimax-m2.7", alias: "MiniMax M2.7", in: 0.3, out: 1.2, cache: 0.06 },
  { id: "xai/grok-4.3", alias: "Grok 4.3", in: 1.25, out: 2.5, cache: 0.2 },
  { id: "meituan-longcat/longcat-2.0", alias: "LongCat 2.0", in: 0.3, out: 1.18, cache: 0.006 },
];

export const ATLAS_CLOUD_PRESET: ProviderCatalogPreset = {
  id: ATLAS_PROVIDER_ID,
  name: "Atlas Cloud",
  nickname: "Atlas Cloud",
  baseUrl: ATLAS_API_BASE,
  model: ATLAS_SEED_MODELS[0].id,
  contextWindow: 262144,
  maxOutputTokens: 65536,
  supportsThinking: true,
  supportsToolStream: true,
  providerType: "openai",
  requiresApiKey: true,
  customModels: ATLAS_SEED_MODELS.map((m) => m.id),
  modelAliases: Object.fromEntries(ATLAS_SEED_MODELS.map((m) => [m.id, m.alias])),
  modelPricing: Object.fromEntries(
    ATLAS_SEED_MODELS.map((m) => [
      m.id,
      { cacheHitPerMtok: m.cache, cacheMissPerMtok: m.in, outputPerMtok: m.out },
    ]),
  ),
};
