/**
 * Agent Window — send pipeline: which turns are running, and on what.
 *
 * Module state shared by every pipeline instance in the window: the main
 * pane's and each docked chat's. Keyed by thread id, so turns on different
 * threads never see each other.
 */

import type { AgentService } from "@/apps/agent/services";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

/**
 * One `AgentService` PER in-flight thread. Each instance owns its own runtime
 * client + provider/workspace config, so turns on different threads run fully
 * in parallel (the Rust runtime already locks per-thread and isolates events by
 * turnId). Keyed by thread id; entries are removed when the turn settles.
 */
export const runningAgents = new Map<string, AgentService>();

/**
 * The model each running turn was started on, keyed by thread id, for exactly
 * as long as `runningAgents` holds the turn.
 *
 * A message sent while a turn runs normally steers it — it rides in at the
 * next tool boundary. But a turn cannot change model mid-flight, so when the
 * conversation's model has moved since the turn started, steering would hand
 * the new message to the OLD model. Comparing against this is how a send knows
 * to end the turn and start a fresh one on the model now chosen.
 */
export const turnModels = new Map<string, string>();

/** How long a model switch waits for the cancelled turn to wind down. */
export const MODEL_SWITCH_END_TIMEOUT_MS = 15_000;

/**
 * Resolve once `threadId` has no live turn, or `false` after `timeoutMs`.
 *
 * Reads the store rather than the agent map: the live turn is what the rest of
 * the pipeline checks before it will open another one on the same thread.
 */
export function waitForTurnEnd(threadId: string, timeoutMs: number): Promise<boolean> {
  if (!useAgentChatStore.getState().liveTurns[threadId]) return Promise.resolve(true);
  return new Promise((resolve) => {
    const unsubscribe = useAgentChatStore.subscribe((state) => {
      if (state.liveTurns[threadId]) return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
  });
}

/**
 * Was this conversation started in deep research?
 *
 * Read from the thread, not from `deepResearchNext`. The setting seeds a NEW
 * chat and nothing else; a conversation's own answer is fixed at creation, and
 * that is exactly what lets the instruction live in the cacheable prefix.
 *
 * A thread the store has not loaded yet reads as `false`, which is the safe
 * direction: a missing instruction produces a normal answer, while a wrongly
 * added one changes the prompt of a conversation that was framed differently.
 */
export function threadIsDeepResearch(threadId: string | null): boolean {
  if (!threadId) return false;
  const { threads, allThreads } = useAgentChatStore.getState();
  const found =
    allThreads.find((t) => t.id === threadId) ?? threads.find((t) => t.id === threadId);
  return found?.deepResearch === true;
}

export const genId = () => Math.random().toString(36).slice(2, 11);

export function nowIso(): string {
  return new Date().toISOString();
}
