/**
 * Agent Window — inline context-compaction marker.
 *
 * Rendered in the transcript at the exact point compaction fired (see
 * `DOCS/compaction-design.md`). While the summary is being generated it shows
 * a left-to-right shimmer **and a running clock**; once done it greys out and
 * labels the drop and how long it took (`Context compacted · 198k → 64k · 42s`).
 * The summary text is NEVER shown — only the before/after model-context sizes.
 *
 * The clock is the whole reason this component has state. Compaction is a
 * single model call over the entire conversation, so it is the one row in the
 * transcript that can sit still for minutes; a shimmer alone cannot tell a
 * long summary apart from a stalled turn, and the difference matters enough
 * that it was diagnosed once by reading the session JSONL off disk.
 *
 * Compaction is a model-context operation: the messages above and below this
 * marker stay fully visible; only what the model re-ingests shrank.
 */

import { useEffect, useState } from "react";
import { Archive } from "lucide-react";

/** Compact a token count like the context ring does: 1234 → "1.2k". */
function fmtTokens(n: number): string {
  if (n <= 0) return "0";
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

/** Elapsed wall-clock, in the transcript's own style: `9s`, `3m 22s`. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Seconds since `startedAt`, ticking while `running`.
 *
 * The interval is torn down the moment it stops, so a finished marker sitting
 * in a long transcript is not still holding a timer. Returns `null` when there
 * is nothing to count — a marker restored from disk has no start time, and a
 * guessed one would read as a compaction that just happened.
 */
function useElapsed(startedAt: number | undefined, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || !startedAt) return;
    // No initial `setNow`: the first tick lands within a second, and a
    // compaction is measured in tens of seconds at best, so a second of
    // staleness on the transition costs nothing worth a state write here.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);

  if (!startedAt) return null;
  return Math.max(0, now - startedAt);
}

export function CompactionCard({
  beforeTokens,
  afterTokens,
  running,
  startedAt,
  durationMs,
}: {
  beforeTokens: number;
  afterTokens: number;
  running: boolean;
  /** When compaction began, for the live clock. Absent on a restored marker. */
  startedAt?: number;
  /** How long it took, once known. Absent on a restored marker. */
  durationMs?: number;
}) {
  const elapsed = useElapsed(startedAt, running);

  // A running compaction says how long it has been running. It is one model
  // call over the whole conversation and can genuinely take minutes; without a
  // number on screen the only difference between "working" and "hung" is how
  // patient you happen to be feeling. Measured 2026-08-27: 3m 22s of identical
  // shimmer, diagnosed by reading the session file off disk.
  const label = running
    ? elapsed === null
      ? "Compacting context…"
      : `Compacting context… ${fmtElapsed(elapsed)}`
    : [
        beforeTokens > 0 && afterTokens > 0
          ? `Context compacted · ${fmtTokens(beforeTokens)} → ${fmtTokens(afterTokens)}`
          : "Context compacted",
        durationMs === undefined ? null : fmtElapsed(durationMs),
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <div
      className={`agw-compaction${running ? " agw-compaction-running" : ""}`}
      role="status"
      aria-label={label}
    >
      <span className="agw-compaction-line" aria-hidden />
      <span className="agw-compaction-chip">
        <Archive size={12} strokeWidth={2} />
        <span>{label}</span>
      </span>
      <span className="agw-compaction-line" aria-hidden />
    </div>
  );
}
