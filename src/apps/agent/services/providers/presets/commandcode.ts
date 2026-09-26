/**
 * Command Code — provider preset (the data the settings store seeds from).
 * Account, sign-in and model import live with the agent window
 * (`apps/agent/services/providers/commandcode.ts`).
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

export const COMMANDCODE_PROVIDER_ID = "commandcode";

/**
 * Base URL on the provider row.
 *
 * Recorded for the settings page to display, not used to route: the endpoint
 * is fixed in the Rust adapter so a stale row cannot misdirect a subscription
 * call.
 */
export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai";

/**
 * The shipped provider row.
 *
 * `customModels` is empty because the catalog is pulled from the account, and a
 * seeded guess would put ids in the picker that the first refresh contradicts.
 *
 * No pricing. Command Code publishes per-million rates and also bills a
 * subscription, so a hardcoded table would be a maintenance trap that goes
 * quietly wrong; unset renders as "not applicable" rather than as a measured
 * zero. Anyone who wants cost tracking can set rates per model with the same
 * controls every other provider uses.
 *
 * `requiresApiKey` is false: the row works with nothing pasted when the CLI is
 * already signed in. Marking it true would put a "needs a key" warning on a
 * provider that is ready to use.
 */
export const COMMANDCODE_PRESET: ProviderCatalogPreset = {
  id: COMMANDCODE_PROVIDER_ID,
  name: "Command Code",
  baseUrl: COMMANDCODE_BASE_URL,
  // A real id on the cheapest tier, so a fresh install with nothing chosen has
  // something sendable rather than a placeholder that fails on first use.
  model: "zai-org/GLM-5.2",
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: false,
  providerType: "commandcode",
  requiresApiKey: false,
  customModels: [],
};
