/** Prompt refinement through the selected configured provider and its adapter. */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { AgentRuntimeClient } from "@/apps/agent/services/runtime/agent-runtime-client";
import { resolveModelRequest } from "@/apps/agent/services/runtime/model-request-config";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";

export async function runCloudRefine(
  requestId: string,
  text: string,
  selection: string,
): Promise<string> {
  // Resolution otherwise falls back to the active chat model for a stale pick.
  const picked = useAgentSettingsStore.getState().getModelFor(selection);
  const resolved = picked ? resolveModelRequest(selection, false) : null;
  if (!picked || !resolved || resolved.providerConfig.id !== picked.providerId) {
    throw new Error("The prompt-refine model is no longer configured. Choose a model in Preferences.");
  }
  const { providerConfig } = resolved;
  return auroraInvoke<string>("prompt_refine_cloud", {
    requestId,
    text,
    config: AgentRuntimeClient.buildProviderConfigSnapshot(providerConfig),
    model: providerConfig.model,
  });
}
