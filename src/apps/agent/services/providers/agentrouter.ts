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
import type { LLMProvider } from "@/kernel/store/useSettingsStore";

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
 * Seed models. Ids are the exact strings sent to the API. GLM-5.3 is the
 * default (it streams `reasoning_content`, so thinking is on); GPT-5.5 is
 * offered second because it is the model AgentRouter's own docs configure.
 * Which models an ACCOUNT actually serves varies by its plan group — a seed
 * the account lacks answers 503 "no available channel" and can simply be
 * deleted (deletes stick; see `removedPresetModelIds` in the store).
 */
const AGENT_ROUTER_SEED_MODELS = [
  { id: "glm-5.3", alias: "GLM-5.3" },
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

// ── Wire format ──────────────────────────────────────────────────────────────
//
// AgentRouter answers the same account on two wires every model serves:
// OpenAI chat completions (`/v1/chat/completions`) and Anthropic messages
// (`/v1/messages`). Both are standard shapes, so the choice is just the
// provider type — no dedicated adapter. A Responses wire (`/v1/responses`)
// exists but is routed PER MODEL (verified live 2026-08-27: gpt-5.6-sol
// answers it, glm is a 404, claude a 503 "no channel"), so offering it here
// would break every non-GPT model on the row — if it ever ships, it belongs
// on the model row, not the provider.

export type AgentRouterWire = "openai" | "anthropic";

/**
 * The wire choices, in the order they are offered. Chat is first because it
 * is the one whose cache held up under measurement (probed live 2026-08-27:
 * the chat wire read its prefix back on every backend, while the messages
 * wire landed on a cacheless backend on ~half of identical requests). The
 * shipped `detail` strings state the consequence, not the experiment — the
 * evidence trail lives here and in `.knowledge`, never in the UI.
 */
export const AGENT_ROUTER_WIRES: ReadonlyArray<{
  value: AgentRouterWire;
  label: string;
  /** Shown under the picker so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "openai",
    label: "Chat",
    detail:
      "Recommended. Long conversations stay cached, so each request pays " +
      "only for what is new. For GLM and DeepSeek models, turn on Thinking " +
      "replay on the model so their reasoning still travels back.",
  },
  {
    value: "anthropic",
    label: "Messages",
    detail:
      "Anthropic's format — thinking travels back on its own. Part of " +
      "AgentRouter's pool serves this format without a cache, so long " +
      "conversations often pay full price for their history.",
  },
];

/**
 * The wire this provider is set to. Falls back to chat — the preset's own
 * type, and the safe answer for a row stored before the picker existed.
 */
export function agentRouterWire(
  provider: Pick<LLMProvider, "id" | "providerType">,
): AgentRouterWire {
  return provider.providerType === "anthropic" ? "anthropic" : "openai";
}

/**
 * Whether this stored row carries a deliberate wire choice the catalog merge
 * must not undo. Only the two real wires qualify — anything else is a stale
 * or foreign value the preset should repair on load.
 */
export function isAgentRouterWireChoice(provider: {
  id?: string;
  providerType?: string;
}): boolean {
  return (
    provider.id === AGENT_ROUTER_PROVIDER_ID &&
    (provider.providerType === "openai" || provider.providerType === "anthropic")
  );
}
