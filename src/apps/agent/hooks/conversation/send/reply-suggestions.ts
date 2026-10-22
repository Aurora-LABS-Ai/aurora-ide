/**
 * Agent Window — send pipeline: the reply chips offered after a turn.
 */

import { runReplySuggestions } from "@/apps/agent/adapters/prompt-refine";
import { runCloudReplySuggestions } from "@/apps/agent/services/providers/reply-suggest-cloud";
import {
  refineConfig,
  replySuggestModelReady,
  replySuggestionsReady,
  useAgentRefineStore,
} from "@/apps/agent/store/composer/useAgentRefineStore";
import { useAgentSuggestStore } from "@/apps/agent/store/composer/useAgentSuggestStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { runningAgents } from "./turn-registry";

/**
 * Reply suggestions — after a turn settles, ask the picked model (the local
 * prompt-refine model unless a configured one is chosen in Preferences) for
 * up to 4 short replies the user could tap instead of typing. Fire-and-
 * forget (the ~4s of model calls must never delay turn teardown); the
 * assistant text is captured synchronously because the live turn closes right
 * after this is invoked. Results are dropped if a new turn started meanwhile,
 * and any failure simply means no chips. Gated on the shared composer-assists
 * preference.
 *
 * Every run gets an id, written with it to the conversation's
 * `suggestions.jsonl` and held in the suggest store while it runs, so the
 * user's next send can be recorded against the run it answered.
 */
function generateSuggestionsFrom(
  threadId: string,
  messages: Array<{ role: string; content?: string | null }>,
): void {
  const refine = useAgentRefineStore.getState();
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && (m.content ?? "").trim());
  const text = (lastAssistant?.content ?? "").trim();
  if (!text) return;

  const runId = crypto.randomUUID();
  const suggest = useAgentSuggestStore.getState();
  suggest.startRun(threadId, runId);

  // A picked model writes them in the cloud from the whole conversation, which
  // Rust reads from disk. None picked means the local llama.cpp model, which
  // stays light: it reads the last exchange only — the user's message (it
  // role-plays as the user, so it needs what they asked for) and the reply.
  const cloudModel = refine.replySuggestModel.trim();
  let request: Promise<string[]>;
  if (cloudModel) {
    request = runCloudReplySuggestions(cloudModel, threadId, runId);
  } else {
    const lastUser = [...messages]
      .reverse()
      .find((m) => m.role === "user" && (m.content ?? "").trim());
    const userText = (lastUser?.content ?? "").trim();
    request = runReplySuggestions(
      `suggest_${threadId}_${Date.now()}`,
      userText,
      text,
      refineConfig(refine),
      { threadId, runId },
    );
  }

  void request
    .then((suggestions) => {
      // A newer turn owns the conversation now — these chips describe a
      // message that's no longer the latest.
      if (runningAgents.has(threadId)) {
        useAgentSuggestStore.getState().failRun(threadId, runId);
        return;
      }
      useAgentSuggestStore.getState().finishRun(threadId, runId, suggestions);
    })
    .catch((err) => {
      useAgentSuggestStore.getState().failRun(threadId, runId);
      console.warn("[agent-window] reply suggestions skipped:", err);
    });
}

/** After a turn settled cleanly: chips if the preference is on. */
export function maybeSuggestReplies(threadId: string): void {
  if (!replySuggestionsReady(useAgentRefineStore.getState())) return;
  const messages = useAgentChatStore.getState().liveTurns[threadId]?.messages ?? [];
  generateSuggestionsFrom(threadId, messages);
}

/**
 * Manual `/suggest` trigger from the composer. Explicit intent — gated only
 * on a suggestion model being ready, NOT on the auto-suggestions toggle,
 * and reads the SETTLED thread (live turns have already closed by the time
 * the user can type a slash command).
 */
export function requestReplySuggestions(threadId: string): void {
  if (!replySuggestModelReady(useAgentRefineStore.getState())) return;
  if (runningAgents.has(threadId)) return; // mid-turn — chips would be stale
  const messages = useAgentChatStore.getState().currentThread?.messages ?? [];
  generateSuggestionsFrom(threadId, messages);
}
