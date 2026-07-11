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

  setEnabled: (v: boolean) => void;
  setLlamaDir: (v: string) => void;
  setModelPath: (v: string) => void;
  setDevice: (v: RefineDevice) => void;
}

export const useAgentRefineStore = create<AgentRefineState>()(
  persist(
    (set) => ({
      enabled: false,
      llamaDir: "",
      modelPath: "",
      device: "gpu",

      setEnabled: (v) => set({ enabled: v }),
      setLlamaDir: (v) => set({ llamaDir: v }),
      setModelPath: (v) => set({ modelPath: v }),
      setDevice: (v) => set({ device: v }),
    }),
    { name: "aurora-agent-window-refine" },
  ),
);

/** True when refine is enabled AND both paths are set (button can show). */
export function refineConfigured(s: AgentRefineState): boolean {
  return s.enabled && s.llamaDir.trim() !== "" && s.modelPath.trim() !== "";
}
