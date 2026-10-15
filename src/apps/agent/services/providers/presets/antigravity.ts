/**
 * Antigravity (Google account) — provider preset (the data the settings
 * store seeds from). Sign-in, accounts and the model list live with the
 * agent window (`apps/agent/services/providers/antigravity.ts`).
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/**
 * The Antigravity provider row.
 *
 * `customModels` is empty on purpose, as for Cursor: the account decides
 * which models exist (a free plan and a paid one differ, and the backend
 * retires models on its own schedule), and the list is pulled from the
 * account once it is signed in.
 *
 * Pricing is absent rather than zeroed: usage counts against the account's
 * Antigravity quota, so there is no per-token rate to state.
 */
export const ANTIGRAVITY_PRESET: ProviderCatalogPreset = {
  id: ANTIGRAVITY_PROVIDER_ID,
  name: "Antigravity",
  nickname: "Antigravity",
  // Informational only — the Rust adapter pins the real endpoint.
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  // Antigravity's own default (`defaultAgentModelId`, 2026-10-12).
  model: "gemini-3.8-flash-high",
  // Floors a row starts at; replaced per model from the account's list.
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: true,
  providerType: ANTIGRAVITY_PROVIDER_ID,
  requiresApiKey: false,
  customModels: [],
};
