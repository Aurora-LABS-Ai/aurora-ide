/**
 * Agent Window — typing-assist bridge (adapter / outbound channel).
 *
 * Thin IPC wrappers over the Rust `typing_assist_*` commands. The heavy engine
 * (an ~82k-word trie + ~242k bigrams + your personal lexicon) lives in the
 * backend; here we just ferry the text before the caret and get back a ghost
 * suggestion or a correction. Everything degrades to a no-op off the desktop
 * runtime (web build) so the composer never breaks.
 */

import { auroraInvoke, isDesktopRuntime } from "../../lib/runtime";

export type TypingGhostKind = "completion" | "next_word";

export interface TypingGhost {
  /** Text to insert at the caret when the suggestion is accepted. */
  insert: string;
  /** The full word (so we can teach the lexicon on accept). */
  word: string;
  kind: TypingGhostKind;
}

let readyPromise: Promise<boolean> | null = null;

/**
 * Build the engine on first use (copies the bundled dictionaries into app-data,
 * then indexes them — ~200ms once). Coalesces concurrent callers; retries on a
 * previous failure. Resolves `false` off-desktop or if loading failed.
 */
export async function ensureTypingReady(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  if (!readyPromise) {
    readyPromise = auroraInvoke<boolean>("typing_assist_ensure_ready").catch((err) => {
      console.warn("[typing-assist] engine load failed:", err);
      readyPromise = null; // allow a later retry
      return false;
    });
  }
  return readyPromise;
}

/** The best inline ghost suggestion for the text before the caret, or `null`. */
export async function queryTyping(
  textBeforeCaret: string,
  wantCompletion: boolean,
  wantNextWord: boolean,
): Promise<TypingGhost | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const ghost = await auroraInvoke<TypingGhost | null>("typing_assist_query", {
      textBeforeCaret,
      wantCompletion,
      wantNextWord,
    });
    return ghost ?? null;
  } catch {
    return null;
  }
}

/** The correction for a finished word, or `null` to leave it as typed. */
export async function correctWord(word: string, previous: string): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const fixed = await auroraInvoke<string | null>("typing_assist_correct", {
      word,
      previous,
    });
    return fixed ?? null;
  } catch {
    return null;
  }
}

/** Teach the lexicon a finished word (fire-and-forget). */
export function learnWord(previous: string, word: string): void {
  if (!isDesktopRuntime()) return;
  void auroraInvoke("typing_assist_learn", { previous, word }).catch(() => {});
}

/** Record that the user reverted a correction — never correct it again. */
export function undoCorrect(previous: string, original: string): void {
  if (!isDesktopRuntime()) return;
  void auroraInvoke("typing_assist_undo_correct", { previous, original }).catch(() => {});
}

/** Persist the personal lexicon now (e.g. on window close). */
export function flushTyping(): void {
  if (!isDesktopRuntime()) return;
  void auroraInvoke("typing_assist_flush").catch(() => {});
}
