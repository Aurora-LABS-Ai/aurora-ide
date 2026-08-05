/**
 * Provider connection test — fires one real, minimal turn at a single
 * configured model and reports what came back.
 *
 * The config is resolved through the same path a real turn uses
 * (`resolveModelRequest` → `AgentRuntimeClient.buildProviderConfigSnapshot`),
 * and Rust runs it through the same adapter factory. Nothing about the
 * probe is a special case, which is the only way its verdict can be
 * trusted.
 */

import { auroraInvoke } from "../lib/runtime";
import { AgentRuntimeClient } from "./agent-runtime-client";
import { resolveModelRequest } from "./model-request-config";

export interface ProviderTestReport {
  ok: boolean;
  /** "Responses", "Chat Completions", "Anthropic Messages", "Codex". */
  wireShape: string;
  /** The provider type dispatch resolved to — proves the API type was honoured. */
  resolvedType: string;
  /** The endpoint actually called. */
  url: string;
  /** First slice of the model's reply. Empty on failure. */
  snippet: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

/**
 * Test one `"providerId:modelKey"` selection.
 *
 * Never throws for a provider-side failure — those arrive as a report
 * with `ok: false` and a human-readable `error`. It only rejects when the
 * selection names no configured provider, or the IPC call itself fails.
 */
export async function testProviderModel(
  selection: string,
  thinkingPreference = true,
): Promise<ProviderTestReport> {
  const resolved = resolveModelRequest(selection, thinkingPreference);
  if (!resolved) {
    throw new Error("This model is not attached to a configured provider.");
  }

  const { providerConfig, thinkingEnabled, thinkingBudgetTokens } = resolved;

  return auroraInvoke<ProviderTestReport>("provider_test_model", {
    config: AgentRuntimeClient.buildProviderConfigSnapshot(providerConfig),
    model: providerConfig.model,
    thinkingEnabled,
    thinkingBudgetTokens,
  });
}
