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
 * ── The lifecycle contract ───────────────────────────────────────────
 * The ghost is a RENDERING ARTIFACT, never document content. Every editing
 * gesture must behave exactly as if it weren't there:
 *
 *   1. **No native edit ever executes against a DOM containing the ghost.**
 *      `onKeyDown` drops the ghost synchronously before any key that can
 *      mutate or move (pure modifiers and the accept key excepted), so
 *      Backspace always deletes the user's character — Chromium's
 *      "backspace before a contenteditable=false element deletes the whole
 *      element" rule can never fire, and typed characters can never land on
 *      the far side of the span (the caret-normalization quirk that made
 *      text append AFTER the grey ghost).
 *   2. **Insertion is split-free and the caret is re-pinned.** The span goes
 *      in with `Text.after()` (no `splitText` residue) and the selection is
 *      explicitly collapsed back before it. Any residue from fallback paths
 *      is cleaned on removal.
 *   3. **A stale ghost cannot outlive its caret.** A `selectionchange`
 *      listener drops the ghost the moment the caret is no longer at the
 *      end (mouse clicks move the caret without a keydown).
 *   4. **Autocorrect is atomic and invisible**: one range replacement → one
 *      input event → one native undo entry. It refuses to cross anything
 *      that isn't plain text (pills, line breaks), and its own mutations are
 *      flagged so they never re-enter the correction/learn pipeline
 *      (`isProgrammaticEdit` lets the composer skip side-effects too).
 *   5. **The undo affordance is durable**: modifiers and caret keys don't
 *      consume the Backspace-to-undo window, and Ctrl+Z on a fresh
 *      correction teaches the engine the same "never again" lesson while
 *      native undo restores the text — no fight loop.
 *   6. **IME composition is sacred**: nothing runs while composing.
 *
 * `serializeEditor` skips `data-ghost`, so the ghost never leaks into the
 * sent message; `serializeFragment` here mirrors the pill treatment so the
 * engine reasons about the same text the message will carry.
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
} from "@/apps/agent/adapters/typing-assist";
import { useAgentTypingStore } from "@/apps/agent/store/composer/useAgentTypingStore";

/** Word char = letter or in-word apostrophe (mirrors the Rust `is_word_char`). */
const WORD_CHAR = /[A-Za-z']/;
/** Boundary keys that finish a word for autocorrect / next-word. */
const BOUNDARY = /[ .,;:!?]$/;
/** How long a Backspace still means "undo that correction". */
const UNDO_WINDOW_MS = 8000;
/** Idle delay before asking the engine for ghost text. */
const GHOST_DEBOUNCE_MS = 110;

/** Keys that neither edit nor move the caret — the ghost survives them. */
const PURE_MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "ContextMenu",
]);

interface PendingUndo {
  original: string;
  corrected: string;
  boundary: string;
  previous: string;
  at: number;
}

/** Split a string into the trailing word being typed and the word before it. */
export function splitTail(text: string): { current: string; previous: string } {
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

/**
 * Serialize a fragment/node to plain text: every pill kind → space, ghost →
 * "", br → \n.
 *
 * ALL pills (`@` file, `/` command, inspector pick) map to a single space:
 * each is one opaque token in the sentence, and a space is what keeps the
 * words on either side from fusing into a phantom word. Recursing into a
 * pill's label (the old behaviour for `/` and inspector pills) fed the
 * engine text that isn't in the message — corrections and predictions were
 * computed against words the user never typed.
 */
export function serializeFragment(node: Node): string {
  let out = "";
  const walk = (n: ChildNode) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.dataset.ghost) return; // never count ghost text
    if (el.dataset.rel || el.dataset.cmd || el.dataset.sel) {
      out += " "; // any pill is a word boundary
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
  /**
   * True while THIS hook is mutating the editor (applying / undoing a
   * correction). The input events those mutations fire are not user edits —
   * the composer uses this to keep side-effects (e.g. the refine-undo
   * affordance) from reacting to them.
   */
  isProgrammaticEdit: () => boolean;
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
  const composingRef = useRef(false);
  const programmaticRef = useRef(false);

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
    const span = ghostElRef.current;
    ghostElRef.current = null;
    ghostInfoRef.current = null;
    if (!span || !span.isConnected) return;
    const prev = span.previousSibling;
    const next = span.nextSibling;
    span.remove();
    // Clean the empty text node a `Range.insertNode` split leaves behind —
    // repeated show/remove cycles must not accumulate junk nodes (they are
    // what nudges Chromium's caret normalization to the wrong side of the
    // span). If the caret ended up inside the empty node, move it to the
    // end of the real text first so removal can't orphan the selection.
    if (next && next.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === "") {
      const sel = window.getSelection();
      if (sel && sel.anchorNode === next && prev && prev.nodeType === Node.TEXT_NODE) {
        sel.collapse(prev, (prev as Text).length);
      }
      (next as ChildNode).remove();
    }
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
    if (tail.length !== 0 && tail !== ghostText) return false;
    // `Range.toString()` renders <br> as nothing, so a caret at the end of a
    // line with EMPTY lines below it read as "at end" and the ghost rendered
    // mid-document. One trailing <br> is the contenteditable's placeholder;
    // more than one means real empty lines follow the caret.
    let brs = 0;
    const walk = (n: ChildNode): void => {
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const child = n as HTMLElement;
      if (child.dataset.ghost) return;
      if (child.tagName === "BR") {
        brs++;
        return;
      }
      child.childNodes.forEach(walk);
    };
    after.cloneContents().childNodes.forEach(walk);
    return brs <= 1;
  }, []);

  const insertText = (text: string) => document.execCommand("insertText", false, text);

  /**
   * Atomically replace the `count` characters before the caret with
   * `replacement`: one selection, one `insertText` → one input event, one
   * native undo entry, zero visible "backspacing".
   *
   * Walks backwards across TEXT NODES ONLY. Anything else in the way — a
   * pill, a <br> — aborts and returns false, because "delete N characters"
   * against a pill deletes the pill (the serialized guard maps pills to a
   * space, so a boundary space can BE a pill). Leaving a word uncorrected
   * is always safer than eating an attachment.
   */
  const replaceBeforeCaret = useCallback(
    (el: HTMLElement, count: number, replacement: string): boolean => {
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
        return false;
      }
      let node: Node | null = sel.anchorNode;
      let offset = sel.anchorOffset;
      if (node && node.nodeType !== Node.TEXT_NODE) {
        // Element-level caret: step into the text node just before it.
        const child: ChildNode | null = node.childNodes[offset - 1] ?? null;
        if (!child || child.nodeType !== Node.TEXT_NODE) return false;
        node = child;
        offset = (child as Text).length;
      }
      if (!node) return false;
      let startNode = node as Text;
      let startOffset = offset;
      let remaining = count;
      while (remaining > 0) {
        if (startOffset >= remaining) {
          startOffset -= remaining;
          remaining = 0;
          break;
        }
        remaining -= startOffset;
        let p: ChildNode | null = startNode.previousSibling;
        while (p && p.nodeType === Node.TEXT_NODE && (p.textContent ?? "") === "") {
          p = p.previousSibling;
        }
        if (!p || p.nodeType !== Node.TEXT_NODE) return false;
        startNode = p as Text;
        startOffset = (p as Text).length;
      }
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(node, offset);
      sel.removeAllRanges();
      sel.addRange(range);
      programmaticRef.current = true;
      try {
        return document.execCommand("insertText", false, replacement);
      } finally {
        programmaticRef.current = false;
      }
    },
    [],
  );

  const showGhost = useCallback(
    (ghost: TypingGhost) => {
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
      // Insert AT THE CARET, split-free: `Text.after()` never calls `splitText`,
      // so no empty text node is created between the ghost and what follows —
      // the residue that fed Chromium's caret-normalization quirk. The ghost
      // only ever shows with the caret at the end (`caretAtEnd` precondition),
      // so the caret's node boundary IS where the prediction continues.
      const sel = window.getSelection();
      let placed = false;
      if (sel && sel.rangeCount > 0 && sel.isCollapsed && el.contains(sel.anchorNode)) {
        const anchor = sel.anchorNode;
        if (anchor && anchor.nodeType === Node.TEXT_NODE) {
          (anchor as Text).after(span);
          placed = true;
        } else if (anchor) {
          const ref: ChildNode | null = anchor.childNodes[sel.anchorOffset] ?? null;
          anchor.insertBefore(span, ref);
          placed = true;
        }
      }
      if (!placed) {
        if (el.lastChild && el.lastChild.nodeName === "BR") {
          // Fallback (no usable selection): step in front of the placeholder <br>.
          el.insertBefore(span, el.lastChild);
        } else {
          el.appendChild(span);
        }
      }
      // Re-pin the caret explicitly BEFORE the span. Chromium can normalize a
      // boundary caret to the far side of a contenteditable=false inline; an
      // explicit collapse into the preceding text node removes the ambiguity,
      // so the next character always lands before the ghost.
      if (sel) {
        const prev = span.previousSibling;
        if (prev && prev.nodeType === Node.TEXT_NODE) {
          sel.collapse(prev, (prev as Text).length);
        } else {
          const pin = document.createRange();
          pin.setStartBefore(span);
          pin.collapse(true);
          sel.removeAllRanges();
          sel.addRange(pin);
        }
      }
      ghostElRef.current = span;
      ghostInfoRef.current = ghost;
    },
    [editorRef],
  );

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
        if (!replaceBeforeCaret(el, word.length + 1, corrected + boundary)) {
          // The characters before the caret weren't plain text (a pill sits
          // in the span) — leave the word as typed.
          if (learn) learnWord(previous, word);
          return;
        }
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
    [autocorrect, learn, textBeforeCaret, removeGhost, replaceBeforeCaret],
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
    // Mid-composition input is not text yet; our own mutations are not user
    // edits — neither may drive corrections, learning, or ghost churn.
    if (composingRef.current || programmaticRef.current) return;
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
      if (e.nativeEvent.isComposing) return false;

      // Accept ghost text with a bare → at the end of the input. Modified
      // arrows (Ctrl+→ word-jump, Shift+→ select) keep their native meaning.
      if (
        e.key === "ArrowRight" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
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

      // Ctrl/Cmd+Z on a fresh correction: native undo restores the typed
      // word — teach the engine the same lesson Backspace-undo does, or the
      // next boundary re-corrects it and the user loses the fight every time.
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "z" &&
        pendingUndoRef.current
      ) {
        const u = pendingUndoRef.current;
        pendingUndoRef.current = null;
        if (Date.now() - u.at <= UNDO_WINDOW_MS) {
          undoCorrect(u.previous, u.original);
        }
        // Fall through — the browser performs the actual undo.
      } else if (e.key === "Backspace" && pendingUndoRef.current) {
        // Backspace right after a correction = "you got it wrong, undo".
        const u = pendingUndoRef.current;
        pendingUndoRef.current = null;
        if (Date.now() - u.at <= UNDO_WINDOW_MS) {
          const before = textBeforeCaret(el);
          if (before !== null && before.endsWith(u.corrected + u.boundary)) {
            removeGhost();
            // preventDefault only on success — a failed replacement must
            // leave the Backspace to its native meaning, not eat it.
            if (replaceBeforeCaret(el, u.corrected.length + 1, u.original + u.boundary)) {
              e.preventDefault();
              undoCorrect(u.previous, u.original);
              return true;
            }
          }
        }
      } else if (
        (e.key.length === 1 && !e.ctrlKey && !e.metaKey) ||
        e.key === "Enter" ||
        e.key === "Delete" ||
        e.key === "Tab"
      ) {
        // Only keys that PRODUCE INPUT consume the undo window. Shift for a
        // capital, arrows, Home/End used to kill the promised 8-second
        // affordance before the user could reach Backspace.
        pendingUndoRef.current = null;
      }

      // Drop the ghost BEFORE any native edit or caret move executes, so the
      // browser never edits a DOM containing the non-editable span. This is
      // what guarantees Backspace deletes the user's character (never the
      // ghost-as-a-unit) and typed characters can't land after the ghost.
      // Pure modifiers keep it; Ctrl/Cmd+C is a read, not an edit.
      if (ghostInfoRef.current && !PURE_MODIFIER_KEYS.has(e.key)) {
        const isCopy = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c";
        if (!isCopy) removeGhost();
      }
      return false;
    },
    [editorRef, caretAtEnd, textBeforeCaret, removeGhost, replaceBeforeCaret, learn],
  );

  const clearGhost = useCallback(() => {
    removeGhost();
    pendingUndoRef.current = null;
  }, [removeGhost]);

  const isProgrammaticEdit = useCallback(() => programmaticRef.current, []);

  useEffect(() => () => removeGhost(), [removeGhost]);

  // A mouse click moves the caret without a keydown — a ghost left mid-text
  // while the caret is elsewhere is a lie about what → would do. Drop it the
  // moment the caret is no longer at the end.
  useEffect(() => {
    const onSelectionChange = () => {
      if (!ghostElRef.current) return;
      const el = editorRef.current;
      if (!el) return;
      if (!caretAtEnd(el)) removeGhost();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [editorRef, caretAtEnd, removeGhost]);

  // IME composition: the text is not committed until compositionend — running
  // corrections mid-composition garbles the composed string.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const start = () => {
      composingRef.current = true;
      removeGhost();
    };
    const end = () => {
      composingRef.current = false;
    };
    el.addEventListener("compositionstart", start);
    el.addEventListener("compositionend", end);
    return () => {
      el.removeEventListener("compositionstart", start);
      el.removeEventListener("compositionend", end);
    };
  }, [editorRef, removeGhost]);

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

  return { onInput, onKeyDown, clearGhost, isProgrammaticEdit };
}
