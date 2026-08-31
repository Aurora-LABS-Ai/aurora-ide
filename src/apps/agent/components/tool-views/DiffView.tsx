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
 *
 * ## Syntax colour
 *
 * Appearance → Code & chips → Syntax highlighting governs this view too; it
 * promises colour "in tool cards", and a diff is the tool card people read most.
 * The two sides are tokenized as WHOLE documents rather than line by line,
 * because a line is not a parseable unit: tokenizing `  }` on its own tells
 * Shiki nothing, and a line inside a template literal or a block comment only
 * knows what it is from the lines above it.
 *
 * Add/remove stays legible without borrowing the foreground: the row keeps its
 * tinted background and its `+`/`−` sign, and only the code itself takes the
 * language colours. Losing the flat green would only matter if the tint and the
 * sign were not already carrying that meaning twice over.
 */

import React, { useMemo } from "react";
import type { ThemedToken } from "shiki";

import { computeDiff, toSplitRows, type DiffRow, type SplitCell } from "@/apps/agent/components/tool-views/diff";
import {
  selectActiveAgentTheme,
  useAgentThemeStore,
} from "@/apps/agent/store/ui/useAgentThemeStore";
import {
  extToShikiLang,
  useShikiTokens,
  type ShikiThemeVariant,
} from "@/kernel/ui/useShikiTokens";

export type DiffMode = "unified" | "split";

/**
 * Above this, tokenizing costs more than the colour is worth — the same ceiling
 * `ToolCode` uses, and for the same reason: a multi-file read pushes whole file
 * contents through here, so this is a routine path rather than an edge case. A
 * diff pays it twice (before and after), which is why it is checked per side.
 */
const HIGHLIGHT_MAX_CHARS = 50_000;

const sign = (kind: DiffRow["kind"]) =>
  kind === "add" ? "+" : kind === "del" ? "−" : " ";

function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * One side's tokens, addressable by 1-based line number.
 *
 * `lines` is kept beside the tokens so a lookup can prove it found the right
 * line before colouring it. The row numbers come from `computeDiff` and the
 * tokens from Shiki — two passes over the same string that agree today, and a
 * mismatch would paint one line's colours onto another's text, which is worse
 * than no colour at all.
 */
interface SideTokens {
  tokens: ThemedToken[][] | null;
  lines: string[];
}

function lineTokens(
  side: SideTokens,
  no: number | null | undefined,
  text: string,
): ThemedToken[] | null {
  if (!side.tokens || no == null) return null;
  const index = no - 1;
  if (side.lines[index] !== text) return null;
  return side.tokens[index] ?? null;
}

/**
 * A line of code, coloured when this file's language is known and plain
 * otherwise. An empty line renders one space so the row keeps its height.
 */
const CodeText: React.FC<{ text: string; tokens: ThemedToken[] | null }> = ({
  text,
  tokens,
}) => {
  if (!tokens || tokens.length === 0) return <>{text === "" ? " " : text}</>;
  return (
    <>
      {tokens.map((token, i) => (
        <span key={i} style={{ color: token.color }}>
          {token.content}
        </span>
      ))}
    </>
  );
};

const UnifiedLine: React.FC<{ row: DiffRow; old: SideTokens; next: SideTokens }> = ({
  row,
  old,
  next,
}) => {
  if (row.kind === "gap") {
    return (
      <div className="agw-dl-gap">
        <span>⋯</span>
        <span>{row.text}</span>
      </div>
    );
  }
  // A removed line only exists on the old side; everything else reads from the
  // new side, falling back to the old one for a context line the fold kept.
  const tokens =
    row.kind === "del"
      ? lineTokens(old, row.oldNo, row.text)
      : lineTokens(next, row.newNo, row.text) ?? lineTokens(old, row.oldNo, row.text);
  return (
    <div className={`agw-dl agw-dl-${row.kind}`}>
      <span className="agw-dl-no">{row.oldNo ?? ""}</span>
      <span className="agw-dl-no">{row.newNo ?? ""}</span>
      <span className="agw-dl-sign">{sign(row.kind)}</span>
      <span className="agw-dl-code">
        <CodeText text={row.text} tokens={tokens} />
      </span>
    </div>
  );
};

/** One side of a split row; `side` tints the change (red old / green new). */
const SplitSide: React.FC<{
  cell: SplitCell | null;
  tint: "del" | "add" | "ctx";
  side: SideTokens;
}> = ({ cell, tint, side }) => (
  <>
    <span className="agw-dl-no">{cell?.no ?? ""}</span>
    <span className={`agw-dl-code agw-ds-${cell ? tint : "empty"}`}>
      {cell ? (
        <CodeText text={cell.text} tokens={lineTokens(side, cell.no, cell.text)} />
      ) : (
        ""
      )}
    </span>
  </>
);

export const DiffView: React.FC<{
  oldText: string;
  newText: string;
  mode?: DiffMode;
  /** Cap the scroll height (inline cards use a smaller cap than the panel). */
  maxHeight?: number;
  /** File path — the only thing that can name the language. Omit for none. */
  path?: string | null;
}> = ({ oldText, newText, mode = "unified", maxHeight = 360, path }) => {
  const appearance = useAgentThemeStore((s) => selectActiveAgentTheme(s).appearance);
  const syntaxOn = useAgentThemeStore((s) => s.syntaxHighlighting);
  const variant: ShikiThemeVariant = appearance === "light" ? "light" : "dark";

  const language = useMemo(() => {
    if (!syntaxOn || !path) return null;
    if (oldText.length > HIGHLIGHT_MAX_CHARS) return null;
    if (newText.length > HIGHLIGHT_MAX_CHARS) return null;
    return extToShikiLang(extensionOf(path));
  }, [syntaxOn, path, oldText, newText]);

  const oldTokens = useShikiTokens(oldText, language, variant);
  const newTokens = useShikiTokens(newText, language, variant);
  const old = useMemo<SideTokens>(
    () => ({ tokens: oldTokens, lines: oldTokens ? oldText.split("\n") : [] }),
    [oldTokens, oldText],
  );
  const next = useMemo<SideTokens>(
    () => ({ tokens: newTokens, lines: newTokens ? newText.split("\n") : [] }),
    [newTokens, newText],
  );

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
              <SplitSide
                cell={row.left}
                tint={row.kind === "change" ? "del" : "ctx"}
                side={old}
              />
              <SplitSide
                cell={row.right}
                tint={row.kind === "change" ? "add" : "ctx"}
                side={next}
              />
            </div>
          ),
        )}
      </div>
    );
  }

  return (
    <div className="agw-diffview agw-scroll" style={{ maxHeight }}>
      {rows.map((row, i) => (
        <UnifiedLine key={i} row={row} old={old} next={next} />
      ))}
    </div>
  );
};
