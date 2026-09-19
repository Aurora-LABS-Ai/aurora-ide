/**
 * Agent Window — composer prompt-refine (controller hook).
 *
 * Drives the ✦ button: serialize the composer, send it to the local
 * llama-completion child process, and stream the rewritten prompt back into the
 * editor with a quick typewriter reveal — keeping the original for one-click
 * undo. Refine is for an INSTRUCTION, so it refuses over-long inputs (a pasted
 * console log / whole file) up front instead of overflowing the model context.
 *
 * Pills (`@file`) serialize to their `@path` token, which is exactly what the
 * agent receives anyway, so a refined prompt keeps every file reference intact
 * (as plain text) even though the visual pill styling flattens.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_REFINE_CHARS,
  cancelRefine,
  runRefine,
  type RefineConfig,
} from "@/apps/agent/adapters/prompt-refine";
import { refineConfigured, useAgentRefineStore } from "@/apps/agent/store/composer/useAgentRefineStore";

export type RefinePhase = "idle" | "refining" | "refined";

export interface ComposerRefine {
  /** Feature enabled + both paths configured (button may show). */
  ready: boolean;
  phase: RefinePhase;
  /** Transient user-facing notice (error / too-long), auto-clears. */
  notice: string | null;
  /** Start a refine of the current composer text. */
  run: () => void;
  /** Cancel an in-flight refine. */
  cancel: () => void;
  /** Revert to the pre-refine text. */
  undo: () => void;
  /** Composer calls this on real user edits so the undo state clears. */
  onUserEdit: () => void;
}

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Reveal `text` into `el` with a short typewriter animation. */
function typewrite(el: HTMLElement, text: string): Promise<void> {
  return new Promise((resolve) => {
    el.innerHTML = "";
    const total = text.length;
    const duration = Math.min(700, Math.max(240, total * 3));
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      el.textContent = text.slice(0, Math.floor(t * total));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = text;
        placeCaretAtEnd(el);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

export function useComposerRefine(
  editorRef: React.RefObject<HTMLDivElement | null>,
  serialize: (el: HTMLElement) => string,
  afterChange: () => void,
): ComposerRefine {
  const enabled = useAgentRefineStore((s) => s.enabled);
  const llamaDir = useAgentRefineStore((s) => s.llamaDir);
  const modelPath = useAgentRefineStore((s) => s.modelPath);
  const device = useAgentRefineStore((s) => s.device);
  const chatFormat = useAgentRefineStore((s) => s.chatFormat);
  const ready = useAgentRefineStore(refineConfigured);

  const [phase, setPhase] = useState<RefinePhase>("idle");
  const [notice, setNotice] = useState<string | null>(null);

  const originalHtmlRef = useRef<string | null>(null);
  const reqIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4500);
  }, []);

  const run = useCallback(() => {
    const el = editorRef.current;
    if (!el || !ready || phase === "refining") return;
    const text = serialize(el).trim();
    if (!text) return;
    if (text.length > MAX_REFINE_CHARS) {
      flashNotice(
        `Prompt is too long to refine (over ${MAX_REFINE_CHARS.toLocaleString()} characters).`,
      );
      return;
    }

    const config: RefineConfig = { llamaDir, modelPath, device, chatFormat };
    const reqId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());
    originalHtmlRef.current = el.innerHTML;
    reqIdRef.current = reqId;
    cancelledRef.current = false;
    setNotice(null);
    setPhase("refining");

    void runRefine(reqId, text, config)
      .then(async (refined) => {
        if (cancelledRef.current) {
          setPhase("idle");
          return;
        }
        const clean = refined.trim();
        if (!clean) {
          flashNotice("The model returned nothing to apply.");
          setPhase("idle");
          return;
        }
        await typewrite(el, clean);
        afterChange();
        setPhase("refined");
      })
      .catch((err) => {
        if (cancelledRef.current) {
          setPhase("idle");
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        flashNotice(msg || "Refine failed.");
        setPhase("idle");
      });
  }, [
    editorRef,
    ready,
    phase,
    serialize,
    llamaDir,
    modelPath,
    device,
    chatFormat,
    afterChange,
    flashNotice,
  ]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const id = reqIdRef.current;
    if (id) void cancelRefine(id);
    setPhase("idle");
  }, []);

  const undo = useCallback(() => {
    const el = editorRef.current;
    if (!el || originalHtmlRef.current === null) return;
    el.innerHTML = originalHtmlRef.current;
    originalHtmlRef.current = null;
    setPhase("idle");
    afterChange();
  }, [editorRef, afterChange]);

  const onUserEdit = useCallback(() => {
    if (phase === "refined") {
      originalHtmlRef.current = null;
      setPhase("idle");
    }
  }, [phase]);

  // If the feature is turned off mid-flight, drop any pending state.
  useEffect(() => {
    if (!enabled && phase !== "idle") {
      cancelledRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the feature is turned off
      setPhase("idle");
    }
  }, [enabled, phase]);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  return { ready, phase, notice, run, cancel, undo, onUserEdit };
}
