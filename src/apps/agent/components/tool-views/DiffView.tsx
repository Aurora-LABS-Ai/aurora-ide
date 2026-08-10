/**
 * Agent Window — diff view [view].
 *
 * Renders a real line-level diff (computed by `computeDiff` from the file's full
 * before/after content) in one of two layouts:
 *   - "unified": one column, removed (red) above added (green), context muted;
 *   - "split":   side-by-side old | new, the Codex default.
 * Both fold long unchanged runs into a quiet "N unchanged lines" marker and use
 * dual line-number gutters. View-only — there is no editing here (to edit, open
 * the file in the IDE). Themed entirely with `--agw-*`.
 */

import React, { useMemo } from "react";

import { computeDiff, toSplitRows, type DiffRow, type SplitCell } from "@/apps/agent/components/tool-views/diff";

export type DiffMode = "unified" | "split";

const sign = (kind: DiffRow["kind"]) =>
  kind === "add" ? "+" : kind === "del" ? "−" : " ";

const UnifiedLine: React.FC<{ row: DiffRow }> = ({ row }) => {
  if (row.kind === "gap") {
    return (
      <div className="agw-dl-gap">
        <span>⋯</span>
        <span>{row.text}</span>
      </div>
    );
  }
  return (
    <div className={`agw-dl agw-dl-${row.kind}`}>
      <span className="agw-dl-no">{row.oldNo ?? ""}</span>
      <span className="agw-dl-no">{row.newNo ?? ""}</span>
      <span className="agw-dl-sign">{sign(row.kind)}</span>
      <span className="agw-dl-code">{row.text === "" ? " " : row.text}</span>
    </div>
  );
};

/** One side of a split row; `side` tints the change (red old / green new). */
const SplitSide: React.FC<{ cell: SplitCell | null; tint: "del" | "add" | "ctx" }> = ({
  cell,
  tint,
}) => (
  <>
    <span className="agw-dl-no">{cell?.no ?? ""}</span>
    <span className={`agw-dl-code agw-ds-${cell ? tint : "empty"}`}>
      {cell ? (cell.text === "" ? " " : cell.text) : ""}
    </span>
  </>
);

export const DiffView: React.FC<{
  oldText: string;
  newText: string;
  mode?: DiffMode;
  /** Cap the scroll height (inline cards use a smaller cap than the panel). */
  maxHeight?: number;
}> = ({ oldText, newText, mode = "unified", maxHeight = 360 }) => {
  const { rows } = useMemo(() => computeDiff(oldText, newText), [oldText, newText]);
  const splitRows = useMemo(
    () => (mode === "split" ? toSplitRows(rows) : null),
    [mode, rows],
  );

  if (rows.length === 0) {
    return <div className="agw-diff-empty">No content changes</div>;
  }

  if (splitRows) {
    return (
      <div className="agw-diffview agw-diffview-split agw-scroll" style={{ maxHeight }}>
        {splitRows.map((row, i) =>
          row.kind === "gap" ? (
            <div key={i} className="agw-dl-gap agw-dl-gap-split">
              <span>⋯</span>
              <span>{row.text}</span>
            </div>
          ) : (
            <div key={i} className={`agw-ds agw-ds-row-${row.kind}`}>
              <SplitSide cell={row.left} tint={row.kind === "change" ? "del" : "ctx"} />
              <SplitSide cell={row.right} tint={row.kind === "change" ? "add" : "ctx"} />
            </div>
          ),
        )}
      </div>
    );
  }

  return (
    <div className="agw-diffview agw-scroll" style={{ maxHeight }}>
      {rows.map((row, i) => (
        <UnifiedLine key={i} row={row} />
      ))}
    </div>
  );
};
