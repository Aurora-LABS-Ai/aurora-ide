/**
 * Agent Window — prompt-refine bridge (adapter / outbound channel).
 *
 * Thin IPC wrappers over the Rust `prompt_refine_*` commands, which shell out to
 * the user's own `llama-completion.exe` (a ~1s one-shot child process — no
 * server, no port, no crate). Everything degrades to a no-op off the desktop
 * runtime so the composer never breaks.
 */

import { auroraInvoke, isDesktopRuntime } from "../../lib/runtime";
import type { RefineDevice } from "../store/useAgentRefineStore";

/**
 * Max characters we'll refine. Refine is for an INSTRUCTION, not a data dump —
 * a huge paste (console logs, a whole file) would overflow the model context.
 * The composer disables the button past this; the backend enforces the same.
 * Keep in lockstep with `MAX_INPUT_CHARS` in `src-tauri/src/prompt_refine`.
 */
export const MAX_REFINE_CHARS = 8000;

export interface RefineConfig {
  llamaDir: string;
  modelPath: string;
  device: RefineDevice;
}

export interface RefineValidation {
  ready: boolean;
  completionOk: boolean;
  modelOk: boolean;
  message: string;
}

/** Validate the llama.cpp folder + model (powers the Preferences check). */
export async function validateRefine(config: RefineConfig): Promise<RefineValidation> {
  if (!isDesktopRuntime()) {
    return {
      ready: false,
      completionOk: false,
      modelOk: false,
      message: "Prompt refine needs the desktop app.",
    };
  }
  return auroraInvoke<RefineValidation>("prompt_refine_validate", { config });
}

/** Refine `text` once; resolves to the rewritten prompt. Rejects on error/cancel. */
export async function runRefine(
  requestId: string,
  text: string,
  config: RefineConfig,
): Promise<string> {
  return auroraInvoke<string>("prompt_refine_run", { requestId, text, config });
}

/** Cancel an in-flight refine (kills the child process). */
export async function cancelRefine(requestId: string): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    return await auroraInvoke<boolean>("prompt_refine_cancel", { requestId });
  } catch {
    return false;
  }
}
