/**
 * Agent Window — prompt-refine preferences (feature state).
 *
 * Optional, fully-local prompt refinement: the user points Aurora at a prebuilt
 * llama.cpp folder (`llama-completion.exe` + DLLs) and a small GGUF model. The
 * ✦ button in the composer then rewrites the typed prompt clearer without
 * changing intent. Nothing runs (and the button is hidden) until enabled +
 * configured. Persisted under its own key.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RefineDevice = "gpu" | "cpu";

interface AgentRefineState {
  enabled: boolean;
  /** Folder containing llama-completion.exe + its DLLs (or a direct exe path). */
  llamaDir: string;
  /** Path to the .gguf model. */
  modelPath: string;
  device: RefineDevice;
  /** Polish voice dictation with the local model before it lands in the
   *  composer. Independent of `replySuggestionsEnabled` — they share the
   *  model setup, not a switch. */
  dictationCleanupEnabled: boolean;
  /** Offer tappable reply chips after each settled turn. */
  replySuggestionsEnabled: boolean;

  setEnabled: (v: boolean) => void;
  setLlamaDir: (v: string) => void;
  setModelPath: (v: string) => void;
  setDevice: (v: RefineDevice) => void;
  setDictationCleanupEnabled: (v: boolean) => void;
  setReplySuggestionsEnabled: (v: boolean) => void;
}

export const useAgentRefineStore = create<AgentRefineState>()(
  persist(
    (set) => ({
      enabled: false,
      llamaDir: "",
      modelPath: "",
      device: "gpu",
      dictationCleanupEnabled: false,
      replySuggestionsEnabled: false,

      setEnabled: (v) => set({ enabled: v }),
      setLlamaDir: (v) => set({ llamaDir: v }),
      setModelPath: (v) => set({ modelPath: v }),
      setDevice: (v) => set({ device: v }),
      setDictationCleanupEnabled: (v) => set({ dictationCleanupEnabled: v }),
      setReplySuggestionsEnabled: (v) => set({ replySuggestionsEnabled: v }),
    }),
    { name: "aurora-agent-window-refine" },
  ),
);

/** True when refine is enabled AND both paths are set (button can show). */
export function refineConfigured(s: AgentRefineState): boolean {
  return s.enabled && s.llamaDir.trim() !== "" && s.modelPath.trim() !== "";
}

/** True when the llama.cpp folder + model are set, regardless of whether the
 *  ✦ refine button is enabled — other local features (chat titles) share this
 *  setup without requiring refine itself to be on. */
export function refinePathsConfigured(s: AgentRefineState): boolean {
  return s.llamaDir.trim() !== "" && s.modelPath.trim() !== "";
}

/** Dictation cleanup should actually run: its switch is on AND the model is set up. */
export function dictationCleanupReady(s: AgentRefineState): boolean {
  return s.dictationCleanupEnabled && refinePathsConfigured(s);
}

/** Reply suggestions should actually run: its switch is on AND the model is set up. */
export function replySuggestionsReady(s: AgentRefineState): boolean {
  return s.replySuggestionsEnabled && refinePathsConfigured(s);
}
