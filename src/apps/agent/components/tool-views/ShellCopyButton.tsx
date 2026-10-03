/**
 * Agent Window — copy a shell card's command or its output.
 *
 * Same button as the code-block copy in messages (`agw-code-copy`), so one
 * picture means "copy" across the window. Each one sits on the thing it
 * copies: the command row, and the output area's corner.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { writeClipboardText } from "@/kernel/lib/clipboard";

export const ShellCopyButton: React.FC<{
  /** Read at click time, so a live view copies what has printed so far. */
  getText: () => string;
  label: string;
  className?: string;
}> = ({ getText, label, className }) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    const text = getText();
    if (!text) return;
    const ok = await writeClipboardText(text);
    setState(ok ? "copied" : "failed");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setState("idle"), 1600);
  }, [getText]);

  const title = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : label;
  return (
    <button
      type="button"
      className={`agw-code-copy agw-shell-copy${className ? ` ${className}` : ""}`}
      onClick={onCopy}
      title={title}
      aria-label={title}
      data-state={state}
    >
      <AgentIcon name={state === "copied" ? "check" : state === "failed" ? "close" : "copy"} size={13} />
    </button>
  );
};
