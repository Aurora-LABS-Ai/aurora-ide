/**
 * Where a vision model's tool-result images go, and when a provider offers the
 * choice.
 *
 * On the Messages wire the image always rides inside `tool_result`: that is
 * Anthropic's own shape and every endpoint tested reads it. On the Chat and
 * Responses wires Aurora sends it in a user message right after the tool
 * output by default, because some gateways drop an image placed inside the
 * tool output and still answer 200 (Modal's Responses wire; a relay that
 * billed ~12k tokens for a placeholder, measured 2026-10-19). The provider
 * row's switch moves it inside for endpoints the user has checked.
 */

import type { LLMModel, LLMProvider } from "@/apps/agent/store/settings/provider-model";
import { openCodeWireFor } from "./opencode";

export type ToolImageWire = "chat" | "responses" | "messages" | "native";

const MESSAGES_TYPES = new Set([
  "anthropic",
  "anthropic-api",
  "minimax",
  "kenari-messages",
  "opencode-go-messages",
  "modal-messages",
  "ark-messages",
  "meta-messages",
  "deepseek-messages",
]);

const RESPONSES_TYPES = new Set([
  "openai-responses",
  "openai_responses",
  "kenari-responses",
  "opencode-go",
  "modal-responses",
  "ark-responses",
  "meta-responses",
  "deepseek-responses",
]);

/** Wires with their own adapter, where neither placement is Aurora's to choose. */
const NATIVE_TYPES = new Set([
  "codex",
  "claude-code",
  "cursor",
  "commandcode",
  "command-code",
  "antigravity",
]);

/**
 * The wire a provider type speaks, as the Rust factory decides it
 * (`ProviderKind::detect` in `src-tauri/src/api/client.rs`). Anything unknown
 * is OpenAI Chat Completions there, and here.
 */
export function toolImageWire(providerType: string | null | undefined): ToolImageWire {
  const type = (providerType ?? "").trim();
  if (MESSAGES_TYPES.has(type)) return "messages";
  if (RESPONSES_TYPES.has(type)) return "responses";
  if (NATIVE_TYPES.has(type)) return "native";
  return "chat";
}

/** The wire one model row actually uses: its own type, else the provider's. */
function modelWire(
  provider: Pick<LLMProvider, "providerType">,
  model: Pick<LLMModel, "modelKey" | "providerType">,
): ToolImageWire {
  // OpenCode Go picks the wire per model id when the row sets none.
  if ((provider.providerType ?? "").startsWith("opencode-go")) {
    return toolImageWire(openCodeWireFor(model));
  }
  return toolImageWire(model.providerType ?? provider.providerType);
}

/**
 * Whether the provider shows the switch: some vision model on it speaks Chat
 * or Responses. A provider with no vision model, or only Messages and native
 * wires, has nothing for the switch to change.
 */
export function offersToolImagePlacement(
  provider: Pick<LLMProvider, "providerType">,
  models: ReadonlyArray<Pick<LLMModel, "modelKey" | "providerType" | "supportsVision">>,
): boolean {
  return models.some((model) => {
    if (!model.supportsVision) return false;
    const wire = modelWire(provider, model);
    return wire === "chat" || wire === "responses";
  });
}
