/**
 * Agent Window — composer typing assistance (controller hook).
 *
 * Wires the local Rust typing engine into the contenteditable composer:
 *   • inline gray ghost text completing the current word / predicting the next
 *     one, accepted with → (Right-arrow) when the caret is at the end;
 *   • autocorrect of a misspelled word the instant you type a space/punctuation,
 *     with an 8-second Backspace-to-undo window that also teaches "never fix
 *     this word again";
 *   • learning the words you actually type.
 *
 * Design notes for the contenteditable:
 *   – Ghost text is a single `data-ghost` span appended at the very end of the
 *     editor. It only renders when the caret is at the end (so → is unambiguous
 *     and there's no fragile mid-text caret surgery). `serializeEditor` skips
 *     `data-ghost`, so the ghost never leaks into the sent message.
 *   – DOM edits for accept/correct/undo go through `execCommand("insertText"/
 *     "delete")` so the browser's native Ctrl+Z history stays intact.
 *   – The hook exposes `onInput` / `onKeyDown` that the composer calls from its
 *     existing handlers, plus `clearGhost` for submit/blur/unmount.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  correctWord,
  ensureTypingReady,
  flushTyping,
  learnWord,
  queryTyping,
  undoCorrect,
  type TypingGhost,
} from "../adapters/typing-assist";
import { useAgentTypingStore } from "../store/useAgentTypingStore";

/** Word char = letter or in-word apostrophe (mirrors the Rust `is_word_char`). */
const WORD_CHAR = /[A-Za-z']/;
/** Boundary keys that finish a word for autocorrect / next-word. */
const BOUNDARY = /[ .,;:!?]$/;
/** How long a Backspace still means "undo that correction". */
const UNDO_WINDOW_MS = 8000;
/** Idle delay before asking the engine for ghost text. */
const GHOST_DEBOUNCE_MS = 110;

interface PendingUndo {
  original: string;
  corrected: string;
  boundary: string;
  previous: string;
  at: number;
}

/** Split a string into the trailing word being typed and the word before it. */
function splitTail(text: string): { current: string; previous: string } {
  let end = text.length;
  let curStart = end;
  while (curStart > 0 && WORD_CHAR.test(text[curStart - 1])) curStart--;
  const current = text.slice(curStart, end);
  end = curStart;
  while (end > 0 && !WORD_CHAR.test(text[end - 1])) end--;
  let prevStart = end;
  while (prevStart > 0 && WORD_CHAR.test(text[prevStart - 1])) prevStart--;
  const previous = text.slice(prevStart, end);
  return { current, previous };
}

/** Serialize a fragment/node to plain text: pills → space, ghost → "", br → \n. */
function serializeFragment(node: Node): string {
  let out = "";
  const walk = (n: ChildNode) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.dataset.ghost) return; // never count ghost text
    if (el.dataset.rel) {
      out += " "; // a file pill is a word boundary
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    el.childNodes.forEach(walk);
  };
  node.childNodes.forEach(walk);
  return out;
}

export interface ComposerTyping {
  /** Call from the composer's `onInput` (after it serializes/emits). */
  onInput: () => void;
  /**
   * Call at the TOP of the composer's `onKeyDown`. Returns `true` when it
   * handled the key (accept ghost / undo correction) — the composer should then
   * `return` without its own handling.
   */
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => boolean;
  /** Remove any ghost text + cancel pending work (submit / blur / unmount). */
  clearGhost: () => void;
}

export function useComposerTyping(
  editorRef: React.RefObject<HTMLDivElement | null>,
): ComposerTyping {
  const autocorrect = useAgentTypingStore((s) => s.autocorrect);
  const completion = useAgentTypingStore((s) => s.completion);
  const nextWord = useAgentTypingStore((s) => s.nextWord);
  const learn = useAgentTypingStore((s) => s.learn);

  const ghostElRef = useRef<HTMLSpanElement | null>(null);
  const ghostInfoRef = useRef<TypingGhost | null>(null);
  const pendingUndoRef = useRef<PendingUndo | null>(null);
  const debounceRef = useRef<number | null>(null);
  const tokenRef = useRef(0);

  // Warm the engine as soon as a feature that needs it is enabled.
  const wanted = autocorrect || completion || nextWord;
  useEffect(() => {
    if (wanted) void ensureTypingReady();
  }, [wanted]);

  // ── DOM helpers ────────────────────────────────────────────────────
  const removeGhost = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    tokenRef.current++;
    if (ghostElRef.current) {
      ghostElRef.current.remove();
      ghostElRef.current = null;
    }
    ghostInfoRef.current = null;
  }, []);

  /** Plain text from the start of the editor to the caret (pills → space). */
  const textBeforeCaret = useCallback((el: HTMLElement): string | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return null;
    const caret = sel.getRangeAt(0);
    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(caret.endContainer, caret.endOffset);
    return serializeFragment(range.cloneContents());
  }, []);

  /** True when nothing but (an optional) ghost span follows the caret. */
  const caretAtEnd = useCallback((el: HTMLElement): boolean => {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      return false;
    }
    const caret = sel.getRangeAt(0);
    const after = document.createRange();
    after.selectNodeContents(el);
    after.setStart(caret.endContainer, caret.endOffset);
    const tail = after.toString();
    const ghostText = ghostElRef.current?.textContent ?? "";
    return tail.length === 0 || tail === ghostText;
  }, []);

  const insertText = (text: string) => document.execCommand("insertText", false, text);
  const deleteBefore = (n: number) => {
    for (let i = 0; i < n; i++) document.execCommand("delete", false);
  };

  const showGhost = useCallback((ghost: TypingGhost) => {
    const el = editorRef.current;
    if (!el || !ghost.insert) return;
    if (ghostElRef.current) ghostElRef.current.remove();
    const span = document.createElement("span");
    span.className = "agw-ghost";
    span.dataset.ghost = "1";
    span.contentEditable = "false";
    span.appendChild(document.createTextNode(ghost.insert));
    // Accent "→" accept hint (visual only). Its text counts toward the span's
    // textContent, which `caretAtEnd` compares against the range tail — so accept
    // detection still matches; only `ghost.insert` is ever inserted on accept.
    const accept = document.createElement("span");
    accept.className = "agw-ghost-accept";
    accept.textContent = "→";
    span.appendChild(accept);
    el.appendChild(span);
    ghostElRef.current = span;
    ghostInfoRef.current = ghost;
  }, [editorRef]);

  // ── Autocorrect on a word boundary ─────────────────────────────────
  const maybeCorrect = useCallback(
    (el: HTMLElement, before: string) => {
      if (!BOUNDARY.test(before)) return;
      const boundary = before.slice(-1);
      const { current: word, previous } = splitTail(before.slice(0, -1));
      if (word.length === 0) return;

      if (!autocorrect) {
        if (learn) learnWord(previous, word);
        return;
      }

      void correctWord(word, previous).then((corrected) => {
        if (!corrected || corrected === word) {
          if (learn) learnWord(previous, word);
          return;
        }
        // Guard: the user may have typed on since we asked.
        const now = textBeforeCaret(el);
        if (now === null || !now.endsWith(word + boundary)) return;
        removeGhost();
        deleteBefore(word.length + 1);
        insertText(corrected + boundary);
        pendingUndoRef.current = {
          original: word,
          corrected,
          boundary,
          previous,
          at: Date.now(),
        };
        if (learn) learnWord(previous, corrected);
      });
    },
    [autocorrect, learn, textBeforeCaret, removeGhost],
  );

  // ── Ghost query (debounced) ────────────────────────────────────────
  const scheduleGhost = useCallback(
    (el: HTMLElement) => {
      if (!completion && !nextWord) return;
      if (document.activeElement !== el) return;
      if (!caretAtEnd(el)) return;
      const before = textBeforeCaret(el);
      if (before === null) return;

      const token = ++tokenRef.current;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(async () => {
        const ghost = await queryTyping(before, completion, nextWord);
        if (token !== tokenRef.current) return; // superseded
        if (!ghost) return;
        // Still valid? Same text, still focused, still at the end.
        if (document.activeElement !== el) return;
        if (textBeforeCaret(el) !== before || !caretAtEnd(el)) return;
        showGhost(ghost);
      }, GHOST_DEBOUNCE_MS);
    },
    [completion, nextWord, caretAtEnd, textBeforeCaret, showGhost],
  );

  // ── Public handlers ────────────────────────────────────────────────
  const onInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    removeGhost();
    if (!autocorrect && !completion && !nextWord && !learn) return;

    const before = textBeforeCaret(el);
    if (before === null) return;

    if (autocorrect || learn) maybeCorrect(el, before);
    scheduleGhost(el);
  }, [
    editorRef,
    autocorrect,
    completion,
    nextWord,
    learn,
    removeGhost,
    textBeforeCaret,
    maybeCorrect,
    scheduleGhost,
  ]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
      const el = editorRef.current;
      if (!el) return false;

      // Accept ghost text with → at the end of the input.
      if (
        e.key === "ArrowRight" &&
        !e.shiftKey &&
        ghostInfoRef.current &&
        caretAtEnd(el)
      ) {
        const ghost = ghostInfoRef.current;
        const before = textBeforeCaret(el) ?? "";
        // Word before the one being completed / the space we're predicting after.
        const previous = splitTail(before).previous;
        e.preventDefault();
        removeGhost();
        insertText(ghost.insert);
        if (learn) learnWord(previous, ghost.word);
        return true;
      }

      // Backspace right after a correction = "you got it wrong, undo".
      if (e.key === "Backspace" && pendingUndoRef.current) {
        const u = pendingUndoRef.current;
        pendingUndoRef.current = null;
        if (Date.now() - u.at <= UNDO_WINDOW_MS) {
          const before = textBeforeCaret(el);
          if (before !== null && before.endsWith(u.corrected + u.boundary)) {
            e.preventDefault();
            removeGhost();
            deleteBefore(u.corrected.length + 1);
            insertText(u.original + u.boundary);
            undoCorrect(u.previous, u.original);
            return true;
          }
        }
      } else if (e.key !== "Backspace") {
        pendingUndoRef.current = null;
      }

      // Any other key edits/moves — drop the stale ghost; onInput re-queries.
      if (e.key === "Escape" && ghostInfoRef.current) {
        removeGhost();
        return false;
      }
      return false;
    },
    [editorRef, caretAtEnd, textBeforeCaret, removeGhost, learn],
  );

  const clearGhost = useCallback(() => {
    removeGhost();
    pendingUndoRef.current = null;
  }, [removeGhost]);

  useEffect(() => () => removeGhost(), [removeGhost]);

  // Persist any recently-learned words before the window goes away (the engine
  // otherwise only auto-saves every 40 updates).
  useEffect(() => {
    if (!learn) return;
    const flush = () => flushTyping();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [learn]);

  return { onInput, onKeyDown, clearGhost };
}
