/**
 * OpenCode Go — provider preset (the data the settings store seeds from).
 * Usage, model discovery and wire routing live with the agent window
 * (`apps/agent/services/providers/opencode.ts`).
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

export const OPENCODE_PROVIDER_ID = "opencode-go";

/** The subscription surface. `/zen/v1` — the credit API — is deliberately unused. */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * The OpenCode Go provider row.
 *
 * `customModels` is empty: the plan decides what exists and the list is pulled
 * from the account, so seeding a guess would put models in the picker that a
 * refresh then contradicts.
 *
 * No pricing, because usage bills against the subscription — a zero would
 * render as a measured `$0.00` rather than "not applicable".
 */
export const OPENCODE_PRESET: ProviderCatalogPreset = {
  id: OPENCODE_PROVIDER_ID,
  name: "OpenCode Go",
  nickname: "OpenCode",
  baseUrl: OPENCODE_GO_BASE_URL,
  // A real id on the Go list, so a fresh install with nothing chosen still has
  // something sendable rather than a placeholder that fails on first use.
  model: "glm-5.2",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: false,
  // The row-level type is only a fallback now: every turn resolves the wire
  // from the MODEL (`applyOpenCodeWire`). It is set to the wire `model` above
  // actually answers on, so that even a fallback lands somewhere that works —
  // this shipped as Responses while the default model was GLM-5.2, which is a
  // guaranteed 500 on the first turn of a fresh install.
  providerType: "opencode-go-chat",
  requiresApiKey: true,
  customModels: [],
};
