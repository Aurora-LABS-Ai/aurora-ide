/**
 * Agent Window — send pipeline: the AI title for a new chat's first message.
 */

import { threadService } from "@/apps/agent/services";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { AgentRuntimeClient } from "@/apps/agent/services/runtime/agent-runtime-client";
import { resolveModelRequest } from "@/apps/agent/services/runtime/model-request-config";
import { asChatFormat, runLocalTitle } from "@/apps/agent/adapters/prompt-refine";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  refineConfig,
  refinePathsConfigured,
  useAgentRefineStore,
} from "@/apps/agent/store/composer/useAgentRefineStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

/**
 * AI title maker — for the FIRST message of a NEW chat only. Depending on the
 * configured mode, asks a configured provider/custom endpoint (cloud)
 * or the local prompt-refine llama.cpp model (local) for a short title,
 * persists it, and reflects it in the live store + rail. Fully non-blocking
 * and non-fatal: any failure (off, unconfigured, network, bad key) silently
 * keeps the locally-derived title. The runtime's own auto-title is gated on
 * the sidecar still reading "New Chat", so whichever write lands first, this
 * title wins (and on failure the derived title stands).
 */
export async function maybeGenerateTitle(threadId: string, firstMessage: string): Promise<void> {
  const s = useAgentSettingsStore.getState();
  if (s.titleMakerMode === "off" || !firstMessage.trim()) return;

  try {
    let title: string;
    if (s.titleMakerMode === "local") {
      const refine = useAgentRefineStore.getState();
      // The llama.cpp FOLDER is always the shared one from prompt refine —
      // there is one runtime on the machine. Only the model can differ.
      if (!refine.llamaDir.trim()) return;
      const ownModel = s.titleMakerLocalModel.trim();
      if (!ownModel && !refinePathsConfigured(refine)) return;
      title = await runLocalTitle(`title_${threadId}`, firstMessage, {
        ...refineConfig(refine),
        ...(ownModel
          ? {
              modelPath: ownModel,
              chatFormat: asChatFormat(s.titleMakerLocalChatFormat),
            }
          : {}),
      });
    } else if (s.titleMakerCloudModel.trim()) {
      // One of the configured models, resolved the way the quick-reply
      // picker's choice is: checked against the provider list first, so a
      // deleted model means "keep the derived title", not "bill whatever is
      // active".
      const selection = s.titleMakerCloudModel.trim();
      const picked = s.getModelFor(selection);
      const resolved = picked ? resolveModelRequest(selection, false) : null;
      if (!picked || !resolved || resolved.providerConfig.id !== picked.providerId) return;
      title = await auroraInvoke<string>("generate_thread_title_cloud", {
        config: AgentRuntimeClient.buildProviderConfigSnapshot(resolved.providerConfig),
        model: resolved.providerConfig.model,
        userMessage: firstMessage,
        threadId,
      });
    } else {
      const baseUrl = s.titleMakerBaseUrl.trim();
      const model = s.titleMakerModel.trim();
      if (!baseUrl || !model) return;
      title = await threadService.generateTitle({
        baseUrl,
        apiKey: s.titleMakerApiKey.trim() || null,
        model,
        userMessage: firstMessage,
      });
    }
    const clean = (title ?? "").trim();
    if (!clean) return;

    await threadService.updateTitle(threadId, clean);
    // Reflect in every visible title immediately after persistence. Waiting for
    // the full disk listing to refresh made the sidebar lag behind the header.
    useAgentChatStore.setState((state) => {
      const live = state.liveTurns[threadId];
      return {
        threads: state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, title: clean } : thread,
        ),
        allThreads: state.allThreads.map((thread) =>
          thread.id === threadId ? { ...thread, title: clean } : thread,
        ),
        liveTurns: live
          ? { ...state.liveTurns, [threadId]: { ...live, title: clean } }
          : state.liveTurns,
        currentThread:
          state.currentThreadId === threadId && state.currentThread
            ? { ...state.currentThread, title: clean }
            : state.currentThread,
      };
    });
    void useAgentChatStore.getState().refreshThreads();
  } catch (err) {
    console.warn("[agent-window] title maker failed; keeping derived title:", err);
  }
}
