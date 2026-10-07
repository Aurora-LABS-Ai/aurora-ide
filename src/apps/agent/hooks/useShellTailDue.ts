/**
 * Whether a running shell command has run long enough to show its live tail
 * (`ShellLiveTail`). Quick commands finish before `TAIL_APPEARS_AFTER_MS` and
 * never draw one, so they stay a single row (probe round 2,
 * Documents/aurora-shell-live-output-designs.html).
 */

import { useEffect, useState } from "react";

import { tailDueInMs } from "@/apps/agent/components/tool-views/shell-tail";

/** Stands in for a command with no recorded start in the "which run" key. */
const NO_START = "unstarted";

export function useShellTailDue(startedAt: number | undefined, running: boolean): boolean {
  const runKey = startedAt === undefined ? NO_START : String(startedAt);
  // The run the timer last fired for. Derived against `runKey` below, so a
  // command that ends (or a new run) reads as not due without a reset write.
  const [dueFor, setDueFor] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const wait = tailDueInMs(startedAt, Date.now(), Date.now());
    const id = window.setTimeout(() => setDueFor(runKey), wait);
    return () => window.clearTimeout(id);
  }, [startedAt, running, runKey]);

  return running && dueFor === runKey;
}
