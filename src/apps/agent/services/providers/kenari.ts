/**
 * kenari — one account, one key, three wire formats.
 *
 * kenari is a gateway: a single `kn-` key reaches models from Anthropic,
 * OpenAI, Google, DeepSeek, Qwen, GLM, MiniMax and xAI, billed in Rupiah from a
 * prepaid balance. What makes it unlike Aurora's other providers is that the
 * SAME account answers on three different wires, and the choice is real — each
 * one behaves differently under a tool-calling agent.
 *
 * All three were measured against the live API on `deepseek-v4-pro` before this
 * was written; the notes below are results, not readings of a docs page.
 *
 * **All three return the model's actual reasoning trace, in full.** That is
 * worth stating because the Responses wire delivers it through events named
 * `response.reasoning_summary_text.*` — OpenAI's summary channel, and the only
 * reasoning channel that wire defines. The name is inherited; the content is
 * the raw first-person trace, the same shorthand the other two wires return.
 *
 * Where they genuinely differ:
 *
 * - **Chat** (`/chat/completions`) — the default, and the one to use. The only
 *   wire every chat model serves: all 54 in the live catalogue list
 *   `endpoints: ["chat"]`. Reasoning arrives in `reasoning` + `reasoning_content`,
 *   both of which Aurora's OpenAI reader already handles, and effort is asked
 *   for with the `reasoning_effort` field Aurora already sends.
 * - **Messages** (`/messages`) — the Anthropic shape. The one wire that streams
 *   a `signature` alongside each thinking block, so a Claude model's reasoning
 *   can be replayed intact. Authenticates with `x-api-key` as well as Bearer,
 *   so Aurora's existing Anthropic client works against it unchanged.
 * - **Responses** (`/responses`) — the Codex wire. Stateless only
 *   (`previous_response_id` is a hard 400) and it silently drops any tool that
 *   is not a plain function. It exists upstream because recent Codex CLI has no
 *   chat wire left, which is a reason for kenari to offer it, not a reason for
 *   us to choose it.
 */

import type { LLMProvider } from "@/kernel/store/useSettingsStore";

export const KENARI_PROVIDER_ID = "kenari";

/** kenari's base address. Every client appends its own path to this. */
export const KENARI_BASE_URL = "https://kenari.id/v1";

/** The public, keyless catalogue. kenari's own docs say not to hard-code a list. */
export const KENARI_MODELS_URL = `${KENARI_BASE_URL}/models`;

export type KenariWire = "kenari" | "kenari-messages" | "kenari-responses";

/**
 * The wire choices, in the order they are offered. Chat is first because it is
 * the default and the one with no caveats.
 */
export const KENARI_WIRES: ReadonlyArray<{
  value: KenariWire;
  label: string;
  /** Shown under the picker so the choice is made with its cost visible. */
  detail: string;
}> = [
  {
    value: "kenari",
    label: "Chat",
    detail:
      "Recommended. Reaches every model kenari offers, streams the full reasoning trace, and handles tool calls.",
  },
  {
    value: "kenari-messages",
    label: "Messages",
    detail:
      "Anthropic's format. The only one that signs each reasoning block, so a Claude model's thinking survives into the next turn.",
  },
  {
    value: "kenari-responses",
    label: "Responses",
    detail:
      "Built for Codex. Cannot carry a conversation forward on its own, and drops any tool that is not a plain function.",
  },
];

/** Whether this provider row is kenari, on any of its three wires. */
export function isKenariProvider(
  provider: Pick<LLMProvider, "id" | "providerType">,
): boolean {
  return (
    provider.id === KENARI_PROVIDER_ID ||
    (provider.providerType ?? "").startsWith("kenari")
  );
}

/**
 * The wire this provider is set to. Falls back to chat, which is both the
 * default and the safe answer for a row stored before the picker existed.
 */
export function kenariWire(
  provider: Pick<LLMProvider, "id" | "providerType">,
): KenariWire {
  const type = provider.providerType;
  if (type === "kenari-messages" || type === "kenari-responses") return type;
  return "kenari";
}
