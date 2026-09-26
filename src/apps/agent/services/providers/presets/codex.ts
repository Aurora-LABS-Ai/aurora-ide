/**
 * Codex (ChatGPT subscription) — provider preset (the data the settings store
 * seeds from). Sign-in and usage live with the agent window
 * (`apps/agent/services/providers/codex.ts`).
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

export const CODEX_PROVIDER_ID = "codex";

/**
 * Codex-entitled model roster: the GPT-5.5 and GPT-5.6 families, matching the
 * "OpenAI (Responses)" preset they share a dialect with. Everything older was
 * retired upstream — a seeded row for a retired model looks selectable, is
 * priced, and then fails at the first request, which is worse than not
 * offering it. Rows seeded by an earlier build stay in the user's database
 * (this seeds, it does not prune); remove those in Settings › Providers.
 *
 * Pricing is pinned to $0 on purpose: usage bills against the ChatGPT
 * subscription, and a zeroed row also stops the models.dev enrichment pass
 * from backfilling platform API prices that don't apply here.
 */
const CODEX_SEED_MODELS = [
  // No bare `gpt-5.6`: the 5.6 generation ships only as the named variants.
  { id: "gpt-5.6-sol", alias: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", alias: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", alias: "GPT-5.6 Luna" },
  { id: "gpt-5.5", alias: "GPT-5.5" },
  { id: "gpt-5.5-pro", alias: "GPT-5.5 Pro" },
];

export const CODEX_PRESET: ProviderCatalogPreset = {
  id: CODEX_PROVIDER_ID,
  name: "Codex (ChatGPT)",
  nickname: "Codex",
  // Informational only — the Rust adapter pins the real endpoint.
  baseUrl: "https://chatgpt.com/backend-api/codex",
  model: CODEX_SEED_MODELS[0].id,
  // **The subscription serves a quarter of what the API does, for the same
  // model.** Measured 2026-08-30 from the Codex backend's own catalogue
  // (`~/.codex/models_cache.json`, fetched 06:09Z by CLI 0.151.0): every slug
  // it serves reports `context_window: 272_000` with
  // `effective_context_window_percent: 95` — so ~258k usable — while
  // `max_context_window` shows what the model could do elsewhere
  // (872_000 for the 5.6 family, 1_000_000 for gpt-5.4).
  //
  // This used to read 1_050_000 "because the 5.4+ tier carries ~1.05M", which
  // is the API's number and not this route's. `context_window` is what drives
  // compaction, so believing 1M against a 272k backend does not merely
  // overstate a figure in the UI — the turn sails past the real cap, gets a
  // context-overflow rejection, and `is_context_overflow` refuses to retry it.
  // The conversation ends instead of compacting.
  //
  // NOTE: the models.dev enrichment pass reads platform API windows, which are
  // the wrong ones here for exactly the same reason the pricing below is
  // pinned to zero. A row it has already enriched keeps its value.
  contextWindow: 260_000,
  maxOutputTokens: 128_000,
  supportsThinking: true,
  supportsToolStream: true,
  // Same family as the "OpenAI (Responses)" preset, so the same answer: these
  // models take images. Stated here rather than left to the seeding default,
  // which used to assume no vision for every preset and made the user switch
  // it on per model before a screenshot would go through.
  supportsVision: true,
  providerType: "codex",
  requiresApiKey: false,
  customModels: CODEX_SEED_MODELS.map((m) => m.id),
  modelAliases: Object.fromEntries(CODEX_SEED_MODELS.map((m) => [m.id, m.alias])),
  modelPricing: Object.fromEntries(
    CODEX_SEED_MODELS.map((m) => [
      m.id,
      { cacheHitPerMtok: 0, cacheMissPerMtok: 0, outputPerMtok: 0 },
    ]),
  ),
};
