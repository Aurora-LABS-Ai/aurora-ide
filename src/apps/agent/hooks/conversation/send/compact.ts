/**
 * Agent Window — send pipeline: a manual `/compact` on an idle conversation.
 */

import { AgentService } from "@/apps/agent/services";
import type { DbThread } from "@/apps/agent/services/threads/thread-service";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveModelRequest,
} from "@/apps/agent/services/runtime/model-request-config";
import {
  effectiveExecutionMode,
  effectiveProjectRoot,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { resolveThreadModel } from "@/apps/agent/lib/thread/thread-model";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentContextStore } from "@/apps/agent/store/conversation/useAgentContextStore";
import { genId, nowIso, runningAgents } from "./turn-registry";

export interface CompactInput {
  threadId: string;
  /** The transcript the live turn opens on. */
  seed: DbThread;
  /** A docked chat's own project, else the window's. */
  projectRootHint: string | null;
}

/**
 * Compact `threadId` now. The caller has checked that no turn is live on it.
 */
export async function runManualCompaction({
  threadId,
  seed,
  projectRootHint,
}: CompactInput): Promise<void> {
  const store = useAgentChatStore.getState();
  const settings = useAgentSettingsStore.getState();
  // Compaction is a real model call on this conversation's history, so it
  // rides the conversation's own model — not whichever one is selected now.
  const modelSelection = resolveThreadModel(threadId);
  let compactRequest: ReturnType<typeof resolveModelRequest>;
  try {
    compactRequest = resolveModelRequest(modelSelection, settings.thinkingEnabled);
  } catch {
    return;
  }
  if (!compactRequest) return;
  const llmConfig = compactRequest.providerConfig;
  let compactionProvider;
  try {
    compactionProvider = settings.compactionModel
      ? resolveModelRequest(settings.compactionModel, settings.thinkingEnabled)
          ?.providerConfig
      : undefined;
  } catch {
    // A stale auxiliary Cursor variant must not prevent the conversation's
    // own model from compacting. Undefined deliberately falls back to it.
    compactionProvider = undefined;
  }

  // Chat wins outright over the Build mode the window was left in.
  const executionMode = effectiveExecutionMode(
    settings.auroraSurface,
    settings.agentExecutionMode,
  );
  // A docked chat compacts against ITS project, not the window's current
  // scope — the window may have been re-scoped since the tab was opened. A
  // chat has no project at all, so the summarizer is not handed one either.
  const projectRoot = effectiveProjectRoot(executionMode, projectRootHint);
  const markerId = genId();
  let markerStarted = false;
  let markerSettled = false;
  // When the summary call began, for the card's live clock and for the
  // duration it settles to. Compaction is one model call over the whole
  // conversation and routinely runs for minutes, so a shimmer with no number
  // beside it cannot be told apart from a hang — the same reason the
  // mid-turn marker stamps one (`appendCompaction`).
  let markerStartedAt = 0;

  store.beginTurn(threadId, seed, projectRoot);
  store.setThreadActivity(threadId, { label: "Compacting context…" });

  const agent = new AgentService();
  runningAgents.set(threadId, agent);
  agent.setProvider(llmConfig);
  agent.setThreadId(threadId);
  agent.updateConfig({
    executionMode,
    reasoning: compactRequest.reasoning,
    workspacePath: projectRoot,
    maxTokens:
      llmConfig.defaultMaxTokens ?? llmConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    compactionThresholdPct: settings.compactionThresholdPct,
    compactionSummaryBudget: settings.compactionSummaryBudget,
    // A manual `/compact` honours the pinned summarizer exactly as an
    // automatic one does — same call, same model.
    compactionProvider,
    workspaceAccess: settings.workspaceAccess,
  });

  /** How long the run took, or `undefined` when it never started a clock. */
  const settledDuration = () =>
    markerStartedAt > 0 ? Date.now() - markerStartedAt : undefined;

  const completeMarker = (beforeTokens: number, afterTokens: number) => {
    markerSettled = true;
    const content = JSON.stringify({
      beforeTokens,
      afterTokens,
      status: "completed",
      startedAt: markerStartedAt || undefined,
      durationMs: settledDuration(),
    });
    if (!markerStarted) {
      markerStarted = true;
      store.appendTurnMessage(threadId, {
        id: markerId,
        role: "compaction",
        content,
        timestamp: nowIso(),
      });
    } else {
      store.patchTurnMessage(threadId, markerId, (message) => ({
        ...message,
        content,
      }));
    }
    // Drop the ring to the post-compaction size immediately; the next real
    // request replaces it with a measurement. Recorded as a PROJECTION, not
    // as usage — overwriting the provider's own numbers with ours made the
    // card claim the provider had reported nothing and erased the cache-hit
    // row along with it.
    useAgentContextStore.getState().setProjectedUsage(threadId, afterTokens);
  };

  const failMarker = (info: { beforeTokens: number; reason: string; cancelled: boolean }) => {
    markerSettled = true;
    const content = JSON.stringify({
      beforeTokens: info.beforeTokens,
      afterTokens: 0,
      status: info.cancelled ? "cancelled" : "failed",
      reason: info.reason,
      startedAt: markerStartedAt || undefined,
      durationMs: settledDuration(),
    });
    if (!markerStarted) {
      markerStarted = true;
      store.appendTurnMessage(threadId, {
        id: markerId,
        role: "compaction",
        content,
        timestamp: nowIso(),
      });
    } else {
      store.patchTurnMessage(threadId, markerId, (message) => ({ ...message, content }));
    }
  };

  try {
    const result = await agent.compactThread({
      onCompactionStarted: () => {
        markerStarted = true;
        markerStartedAt = Date.now();
        store.appendTurnMessage(threadId, {
          id: markerId,
          role: "compaction",
          content: JSON.stringify({
            beforeTokens: 0,
            afterTokens: 0,
            status: "running",
            startedAt: markerStartedAt,
          }),
          timestamp: nowIso(),
        });
      },
      onCompactionCompleted: completeMarker,
      onCompactionFailed: failMarker,
    });
    if (result && !markerStarted) {
      completeMarker(result.beforeTokens, result.afterTokens);
    }
  } catch (error) {
    console.error("[agent-window] manual compaction failed:", error);
    if (markerStarted && !markerSettled) {
      failMarker({ beforeTokens: 0, reason: "runtime_error", cancelled: false });
    }
  } finally {
    runningAgents.delete(threadId);
    // The summarization request carried the whole head of the conversation
    // — routinely the single largest charge in a long chat. `sendTurn` marks
    // the cost basis stale in its own `finally`; this path never did, so the
    // card kept serving its pre-compaction copy and the charge appeared
    // nowhere in Aurora. In `finally` for the same reason as there: a failed
    // compaction still spent the tokens it spent.
    useAgentContextStore.getState().invalidateBreakdown(threadId);
    await store.refreshThreads();
    store.endTurn(threadId);
  }
}
