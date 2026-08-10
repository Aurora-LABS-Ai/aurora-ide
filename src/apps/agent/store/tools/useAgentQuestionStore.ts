/**
 * Agent Window — interactive question store (feature state).
 *
 * Holds the single in-flight `ask_question` request and the promise resolver
 * that unblocks the agent turn. The flow:
 *
 *   tool executor → question-bridge.requestUserQuestions(req)
 *      → (handler registered in AgentWindow) → store.ask(req)  ── sets `pending`,
 *        returns a Promise the executor awaits
 *   user answers in `QuestionPrompt` → store.submit(result)  ── resolves it
 *   user dismisses / new turn          → store.skip()         ── resolves skipped
 *
 * The resolver is kept module-local (not in the rendered state) so it never gets
 * serialised or triggers re-renders. Only one prompt can be live at a time —
 * starting a new `ask` while one is pending auto-skips the previous one so the
 * older tool call resolves instead of leaking.
 */

import { create } from "zustand";
import type {
  AskQuestionRequest,
  AskQuestionResult,
} from "@/apps/agent/services/tools/question-bridge";

let resolveActive: ((result: AskQuestionResult) => void) | null = null;

function settle(result: AskQuestionResult): void {
  const resolve = resolveActive;
  resolveActive = null;
  resolve?.(result);
}

interface AgentQuestionState {
  /** The live request, or `null` when no prompt is showing. */
  pending: AskQuestionRequest | null;

  /** Show a prompt and resolve once the user answers/skips. */
  ask: (request: AskQuestionRequest) => Promise<AskQuestionResult>;
  /** Resolve the live prompt with the user's answers and dismiss it. */
  submit: (result: AskQuestionResult) => void;
  /** Resolve the live prompt as skipped and dismiss it. */
  skip: () => void;
}

export const useAgentQuestionStore = create<AgentQuestionState>((set) => ({
  pending: null,

  ask: (request) => {
    // A new request supersedes any stale one — resolve the old as skipped.
    if (resolveActive) settle({ skipped: true, answers: [] });
    return new Promise<AskQuestionResult>((resolve) => {
      resolveActive = resolve;
      set({ pending: request });
    });
  },

  submit: (result) => {
    settle(result);
    set({ pending: null });
  },

  skip: () => {
    settle({ skipped: true, answers: [] });
    set({ pending: null });
  },
}));
