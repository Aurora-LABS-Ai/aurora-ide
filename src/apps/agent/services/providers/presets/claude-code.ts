/**
 * Claude Code (claude.ai subscription) — provider preset (the data the
 * settings store seeds from). Sign-in and usage live with the agent window
 * (`apps/agent/services/providers/claude-code.ts`).
 */

import type { ModelReasoning } from "@/kernel/types/database";
import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/**
 * The Claude 5 family plus Haiku 4.5. Pricing is pinned to $0 on purpose:
 * usage bills against the claude.ai plan, and a zeroed row also stops the
 * models.dev enrichment pass from backfilling platform API prices that do
 * not apply here.
 */
const CLAUDE_CODE_SEED_MODELS = [
  { id: "claude-sonnet-5", alias: "Claude Sonnet 5" },
  { id: "claude-opus-5", alias: "Claude Opus 5" },
  { id: "claude-fable-5-1", alias: "Claude Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", alias: "Claude Haiku 4.5" },
];

/**
 * The effort picker the Claude 5 family takes, seeded so the composer's
 * reasoning control works on the first chat instead of after a trip to the
 * model row. Haiku 4.5 is left to its own default: it reasons on a token
 * budget, and the composer's budget control is set per model.
 */
const CLAUDE_5_EFFORT: ModelReasoning = {
  type: "effort",
  levels: ["low", "medium", "high", "xhigh", "max"],
  default: "high",
  supported: ["effort", "toggle"],
  toggleable: true,
  enabled: true,
};

export const CLAUDE_CODE_PRESET: ProviderCatalogPreset = {
  id: CLAUDE_CODE_PROVIDER_ID,
  name: "Claude Code (claude.ai)",
  nickname: "Claude Code",
  // Informational only — the Rust adapter pins the real endpoint.
  baseUrl: "https://api.anthropic.com/v1",
  model: CLAUDE_CODE_SEED_MODELS[0].id,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: true,
  providerType: CLAUDE_CODE_PROVIDER_ID,
  requiresApiKey: false,
  customModels: CLAUDE_CODE_SEED_MODELS.map((m) => m.id),
  modelAliases: Object.fromEntries(CLAUDE_CODE_SEED_MODELS.map((m) => [m.id, m.alias])),
  modelPricing: Object.fromEntries(
    CLAUDE_CODE_SEED_MODELS.map((m) => [
      m.id,
      { cacheHitPerMtok: 0, cacheMissPerMtok: 0, outputPerMtok: 0 },
    ]),
  ),
  modelReasoning: {
    "claude-sonnet-5": CLAUDE_5_EFFORT,
    "claude-opus-5": CLAUDE_5_EFFORT,
    "claude-fable-5-1": CLAUDE_5_EFFORT,
  },
};
