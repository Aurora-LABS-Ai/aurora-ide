/**
 * Agent Window — typing-assistance preferences (feature state).
 *
 * Four independent toggles for the composer's local, statistical typing help,
 * mirroring the "TypeAssist" experience. Each can be enabled on its own — e.g.
 * completion on, autocorrect off — so the user composes exactly the assistance
 * they want. Persisted under its own key; the Rust engine is lazily built the
 * first time any of these turns on.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AgentTypingState {
  /** Fix a misspelled word in place when you type a space / punctuation. */
  autocorrect: boolean;
  /** Inline gray ghost text completing the word you're typing (→ to accept). */
  completion: boolean;
  /** After a space, ghost-predict the likely next word (→ to accept). */
  nextWord: boolean;
  /** Learn the words you actually type (improves both, kept fully local). */
  learn: boolean;

  setAutocorrect: (v: boolean) => void;
  setCompletion: (v: boolean) => void;
  setNextWord: (v: boolean) => void;
  setLearn: (v: boolean) => void;
}

export const useAgentTypingStore = create<AgentTypingState>()(
  persist(
    (set) => ({
      autocorrect: false,
      completion: false,
      nextWord: false,
      learn: true,

      setAutocorrect: (v) => set({ autocorrect: v }),
      setCompletion: (v) => set({ completion: v }),
      setNextWord: (v) => set({ nextWord: v }),
      setLearn: (v) => set({ learn: v }),
    }),
    { name: "aurora-agent-window-typing" },
  ),
);

/** True when any feature that needs the engine loaded is on. */
export function typingEngineWanted(s: AgentTypingState): boolean {
  return s.autocorrect || s.completion || s.nextWord;
}
