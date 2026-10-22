/**
 * Agent Window — send pipeline: wall-clock timing per tool call.
 *
 * Anchored on the runtime's execution-start / result events. Native Rust
 * tools emit execution_start BEFORE their permission gate, so approval
 * windows are recorded separately and only the part overlapping [start, end]
 * is subtracted — a 40-second approval must never read as a 40-second tool.
 * Bridge tools (MCP) start AFTER approval, so their overlap is naturally zero.
 */

export interface ToolTimer {
  /** The call began executing (idempotent). */
  start: (id: string) => void;
  /** The call ended: its duration with approval waits taken out, or `undefined` if never started. */
  settle: (id: string) => number | undefined;
  /** The call was rejected before running: nothing to time. */
  forget: (id: string) => void;
  /** The user was deciding between `from` and `to`; excluded from the duration. */
  noteApproval: (id: string, from: number, to: number) => void;
}

export function createToolTimer(): ToolTimer {
  const timings = new Map<
    string,
    { start: number; approval: Array<{ from: number; to: number }> }
  >();
  return {
    start: (id) => {
      if (!timings.has(id)) {
        timings.set(id, { start: performance.now(), approval: [] });
      }
    },
    settle: (id) => {
      const timing = timings.get(id);
      if (!timing) return undefined;
      timings.delete(id);
      const end = performance.now();
      let approvalWait = 0;
      for (const w of timing.approval) {
        approvalWait += Math.max(
          0,
          Math.min(w.to, end) - Math.max(w.from, timing.start),
        );
      }
      return Math.max(0, end - timing.start - approvalWait);
    },
    forget: (id) => {
      timings.delete(id);
    },
    noteApproval: (id, from, to) => {
      timings.get(id)?.approval.push({ from, to });
    },
  };
}
