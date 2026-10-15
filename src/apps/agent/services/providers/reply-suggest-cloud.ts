/**
 * Reply suggestions written by one of the user's configured models.
 *
 * The local llama.cpp model is the default; this is the other choice the
 * "Quick reply model" picker offers. The selection resolves through the same
 * path a real turn uses (`resolveModelRequest` → `buildProviderConfigSnapshot`),
 * and Rust sends it through the same adapter factory, so any provider that can
 * chat can write suggestions, including the sign-in ones.
 *
 * Only the conversation's id travels: Rust reads the conversation from disk
 * and builds the brief the model reads (`src-tauri/src/reply_suggest`). Rust
 * also writes every run to the conversation's `suggestions.jsonl` under
 * `runId`, which `recordSuggestionOutcome` echoes back.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { AgentRuntimeClient } from "@/apps/agent/services/runtime/agent-runtime-client";
import { resolveModelRequest } from "@/apps/agent/services/runtime/model-request-config";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import type { SuggestionOutcome } from "@/apps/agent/store/composer/useAgentSuggestStore";

/**
 * Ask `selection` (`providerId:modelKey`) for up to 4 replies to where the
 * conversation `threadId` stands now. Rejects when the selection names no
 * configured provider, so a deleted model reads as "no chips" rather than
 * quietly billing whatever model happens to be active.
 */
export async function runCloudReplySuggestions(
  selection: string,
  threadId: string,
  runId: string,
): Promise<string[]> {
  // `resolveModelRequest` falls back to the active provider for a selection
  // that no longer exists. Right for a turn, wrong here: check the pick is
  // still a configured model before resolving it.
  const picked = useAgentSettingsStore.getState().getModelFor(selection);
  // Thinking off: four short replies do not need it, and it is the cost.
  const resolved = picked ? resolveModelRequest(selection, false) : null;
  if (!picked || !resolved || resolved.providerConfig.id !== picked.providerId) {
    throw new Error("The reply-suggestion model is no longer configured.");
  }
  const { providerConfig } = resolved;
  return auroraInvoke<string[]>("reply_suggest_cloud", {
    config: AgentRuntimeClient.buildProviderConfigSnapshot(providerConfig),
    model: providerConfig.model,
    threadId,
    runId,
  });
}

/**
 * Write what the user did with a set of suggestions to the conversation's
 * suggestion log (and the project's outcome file the cloud model learns from).
 * Best effort: a failed write is reported in the console and never interrupts
 * the send it describes.
 */
export function recordSuggestionOutcome(threadId: string, outcome: SuggestionOutcome): void {
  void auroraInvoke<void>("reply_suggest_outcome", { threadId, outcome }).catch((err) => {
    console.warn("[agent-window] suggestion outcome not recorded:", err);
  });
}
