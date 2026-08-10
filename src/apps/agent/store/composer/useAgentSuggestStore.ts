/**
 * Agent Window — reply-suggestion chips (feature state).
 *
 * After a turn finishes, the local prompt-refine model proposes up to 3 short
 * replies the user could tap instead of typing (part of the "composer assists"
 * preference, shared with dictation cleanup). Suggestions are keyed per thread
 * so a background chat's chips never bleed into the open one, and they are
 * cleared the moment that thread sends again — chips always describe the LAST
 * settled turn. Not persisted: stale suggestions after a restart would refer
 * to a conversation state the user no longer sees.
 */

import { create } from "zustand";

interface AgentSuggestState {
  /** threadId → chips for that thread's last settled turn. */
  byThread: Record<string, string[]>;
  /** Replace a thread's chips (empty array clears the row). */
  setSuggestions: (threadId: string, suggestions: string[]) => void;
  /** Drop a thread's chips (send started / chip tapped / turn superseded). */
  clear: (threadId: string) => void;
}

export const useAgentSuggestStore = create<AgentSuggestState>((set) => ({
  byThread: {},

  setSuggestions: (threadId, suggestions) =>
    set((s) => {
      const next = { ...s.byThread };
      if (suggestions.length > 0) next[threadId] = suggestions;
      else delete next[threadId];
      return { byThread: next };
    }),

  clear: (threadId) =>
    set((s) => {
      if (!(threadId in s.byThread)) return s;
      const next = { ...s.byThread };
      delete next[threadId];
      return { byThread: next };
    }),
}));
