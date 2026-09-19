/**
 * Agent Window — prompt-refine bridge (adapter / outbound channel).
 *
 * Thin IPC wrappers over the Rust `prompt_refine_*` commands, which shell out to
 * the user's own `llama-completion.exe` (a ~1s one-shot child process — no
 * server, no port, no crate). Everything degrades to a no-op off the desktop
 * runtime so the composer never breaks.
 */

import { auroraInvoke, isDesktopRuntime } from "@/kernel/lib/ipc/runtime";
import type { RefineDevice } from "@/apps/agent/store/composer/useAgentRefineStore";

/**
 * Max characters we'll refine. Refine is for an INSTRUCTION, not a data dump —
 * a huge paste (console logs, a whole file) would overflow the model context.
 * The composer disables the button past this; the backend enforces the same.
 * Keep in lockstep with `MAX_INPUT_CHARS` in `src-tauri/src/prompt_refine`.
 */
export const MAX_REFINE_CHARS = 8000;

/**
 * How the conversation is formatted for a local model. Mirrors `ChatFormat` in
 * `src-tauri/src/prompt_refine/mod.rs` — these exact strings are the wire, and
 * a rename on either side silently stops the setting applying (there is a Rust
 * test pinning them).
 *
 * A setting rather than a guess: the two models measured here need OPPOSITE
 * formats. Qwen3.5 hard-crashes llama-completion through its own template;
 * LFM2.5 returns fused nonsense through hand-written ChatML. `auto` resolves
 * from the model path and is right for almost everything, so nobody has to
 * touch this until a model arrives that it guesses wrong.
 */
export type ChatFormat = "auto" | "model-template" | "chatml" | "chatml-no-think" | "raw";

/** Label for each format, for the Preferences dropdowns. */
export const CHAT_FORMAT_LABELS: Record<ChatFormat, string> = {
  auto: "Auto (detect from model)",
  "model-template": "Model's own template",
  chatml: "ChatML",
  "chatml-no-think": "ChatML, skip thinking",
  raw: "Raw completion",
};

/** Narrow an arbitrary stored string; anything unrecognised falls back to auto. */
export function asChatFormat(value: string | undefined | null): ChatFormat {
  return value && value in CHAT_FORMAT_LABELS ? (value as ChatFormat) : "auto";
}

export interface RefineConfig {
  llamaDir: string;
  modelPath: string;
  device: RefineDevice;
  /** Omitted by callers that predate the setting; the backend defaults to auto. */
  chatFormat?: ChatFormat;
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

/**
 * Generate a short chat title from the first user message with the SAME local
 * llama.cpp setup as refine. Rejects on any error — the caller keeps the
 * locally-derived title, so this is always safe to attempt.
 */
export async function runLocalTitle(
  requestId: string,
  text: string,
  config: RefineConfig,
): Promise<string> {
  return auroraInvoke<string>("prompt_refine_title", { requestId, text, config });
}

/**
 * Rewrite a voice-dictation transcript into clean written text (punctuation,
 * casing, filler removal) with the local model. Rejects on any error — the
 * caller inserts the raw transcript unchanged.
 */
export async function runDictationCleanup(
  requestId: string,
  text: string,
  config: RefineConfig,
): Promise<string> {
  return auroraInvoke<string>("prompt_refine_dictation", { requestId, text, config });
}

/**
 * Generate up to 4 tappable reply suggestions from the last exchange. The
 * model sees the user's own message AND the assistant's reply, and answers as
 * the user. May resolve with fewer (or an empty array) when the model's
 * output fails the backend quality filters.
 */
export async function runReplySuggestions(
  requestId: string,
  userText: string,
  text: string,
  config: RefineConfig,
): Promise<string[]> {
  return auroraInvoke<string[]>("prompt_refine_suggest", {
    requestId,
    userText,
    text,
    config,
  });
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
