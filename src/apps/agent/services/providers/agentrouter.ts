/**
 * AgentRouter — provider preset.
 *
 * AgentRouter (https://agentrouter.org) proxies frontier coding models
 * (GLM, GPT-5.x, Claude, …) behind one account. It exposes an
 * OpenAI-compatible endpoint at `/v1` (Bearer-token auth) — the shape
 * Aurora uses here — and a separate Anthropic-messages endpoint at the
 * root. This preset wires the OpenAI-compatible one.
 *
 * ## Client fingerprint (required)
 *
 * AgentRouter gates requests on the calling client: without the right
 * `User-Agent` + `X-Title` it returns HTTP 401 `unauthorized_client_error`.
 * We ship the accepted `opencode` fingerprint pre-filled in
 * {@link AGENT_ROUTER_HEADERS}; the Rust OpenAI-compat adapter sends them
 * verbatim (custom headers override reqwest defaults). Users can edit them
 * in Settings → Providers → Extra headers.
 *
 * ## Key pool
 *
 * AgentRouter users commonly run several accounts. Add every key to the
 * provider's API-key pool (Settings → Providers) and the runtime rotates
 * them round-robin per turn and fails over to the next on a 401/429/5xx —
 * a generic capability, not specific to AgentRouter.
 *
 * This is a frontend preset (like Atlas Cloud and Codex): it seeds the
 * provider row + models without a Rust catalog rebuild.
 */

import type { ProviderCatalogPreset } from "@/apps/agent/services/providers/provider-catalog";

// ── Constants ────────────────────────────────────────────────────────────────

export const AGENT_ROUTER_PROVIDER_ID = "agentrouter";
export const AGENT_ROUTER_BASE_URL = "https://agentrouter.org/v1";
export const AGENT_ROUTER_CONSOLE_URL = "https://agentrouter.org";

/**
 * The client fingerprint AgentRouter accepts. Sent on every request; without
 * it AgentRouter answers 401. Verified live against the `/v1` endpoint.
 */
export const AGENT_ROUTER_HEADERS: Record<string, string> = {
  "User-Agent": "opencode/1.17.18",
  "X-Title": "opencode",
};

/**
 * Seed models. Ids are the exact strings sent to the API. GLM-5.2 is the
 * default (it streams `reasoning_content`, so thinking is on); GPT-5.5 is
 * offered as a second option. Add more from the Providers page.
 */
const AGENT_ROUTER_SEED_MODELS = [
  { id: "glm-5.2", alias: "GLM-5.2" },
  { id: "gpt-5.5", alias: "GPT-5.5" },
];

export const AGENT_ROUTER_PRESET: ProviderCatalogPreset = {
  id: AGENT_ROUTER_PROVIDER_ID,
  name: "AgentRouter",
  nickname: "AgentRouter",
  baseUrl: AGENT_ROUTER_BASE_URL,
  model: AGENT_ROUTER_SEED_MODELS[0].id,
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
  supportsThinking: true,
  supportsToolStream: true,
  // OpenAI-compatible wire shape → routes to the OpenAICompat adapter.
  providerType: "openai",
  requiresApiKey: true,
  customModels: AGENT_ROUTER_SEED_MODELS.map((m) => m.id),
  modelAliases: Object.fromEntries(
    AGENT_ROUTER_SEED_MODELS.map((m) => [m.id, m.alias]),
  ),
  // Pricing intentionally omitted — AgentRouter meters in credits/CNY and
  // only returns cost on non-streaming calls, so the UI enriches token
  // metadata from models.dev instead of showing a (missing) live cost.
  customHeaders: AGENT_ROUTER_HEADERS,
};

/** True when a provider is the AgentRouter preset. */
export function isAgentRouterProvider(provider: { id?: string }): boolean {
  return provider.id === AGENT_ROUTER_PROVIDER_ID;
}
