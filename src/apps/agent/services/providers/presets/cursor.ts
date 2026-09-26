/**
 * Cursor — provider preset (the data the settings store seeds from). Sign-in
 * and the model catalogue live with the agent window
 * (`apps/agent/services/providers/cursor.ts`).
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

export const CURSOR_PROVIDER_ID = "cursor";

/**
 * The Cursor provider row.
 *
 * `customModels` is deliberately empty: the account decides what exists, and
 * the catalogue is pulled on connect. Seeding a guess here would put models in
 * the picker that a refresh then contradicts.
 *
 * Pricing is likewise absent rather than zeroed — usage bills against the
 * Cursor plan, so there is no per-token rate to state, and a zero would render
 * as a measured `$0.00` instead of "not applicable".
 */
export const CURSOR_PRESET: ProviderCatalogPreset = {
  id: CURSOR_PROVIDER_ID,
  name: "Cursor",
  nickname: "Cursor",
  // Informational only — the Rust adapter pins the real endpoint, so a stale
  // preset cannot misroute a turn.
  baseUrl: "https://api2.cursor.sh",
  // The account's router — the one id that is always reachable, and the model
  // the picker falls back to before anything has been switched on. It must be
  // the id Cursor actually publishes (`cursor-default`), not the word "default":
  // this value is sent verbatim, so a friendly-looking placeholder here would
  // fail the very first turn of a fresh install.
  model: "cursor-default",
  // Replaced per-model from models.dev once the catalogue loads; this is only
  // the floor a row starts at.
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: true,
  providerType: "cursor",
  requiresApiKey: false,
  customModels: [],
};
