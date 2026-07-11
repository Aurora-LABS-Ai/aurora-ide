/**
 * Agent Window — inline context-compaction marker.
 *
 * Rendered in the transcript at the exact point compaction fired (see
 * `DOCS/compaction-design.md`). While the summary is being generated it shows
 * a left-to-right shimmer; once done it greys out and labels the drop
 * (`Context compacted · 198k → 64k`). The summary text is NEVER shown — only
 * the before/after model-context sizes.
 *
 * Compaction is a model-context operation: the messages above and below this
 * marker stay fully visible; only what the model re-ingests shrank.
 */

import { Archive } from "lucide-react";

/** Compact a token count like the context ring does: 1234 → "1.2k". */
function fmtTokens(n: number): string {
  if (n <= 0) return "0";
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

export function CompactionCard({
  beforeTokens,
  afterTokens,
  running,
}: {
  beforeTokens: number;
  afterTokens: number;
  running: boolean;
}) {
  const label = running
    ? "Compacting context…"
    : beforeTokens > 0 && afterTokens > 0
      ? `Context compacted · ${fmtTokens(beforeTokens)} → ${fmtTokens(afterTokens)}`
      : "Context compacted";

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
