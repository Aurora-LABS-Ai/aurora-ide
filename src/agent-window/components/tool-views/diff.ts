/**
 * Agent Window — line diff engine (leaf, non-component).
 *
 * Computes a real, line-level unified diff between a file's full BEFORE and
 * AFTER content (delivered by the modify tools as `oldContent`/`newContent`).
 * This is NOT a guess from the model's edit hunk — it's the actual change.
 *
 * Strategy (robust + fast for the common case):
 *   1. Trim the shared prefix and suffix — a small edit in a large file leaves
 *      only a tiny middle to diff, so the O(n·m) LCS stays cheap.
 *   2. LCS-backtrack the middle into add / del / context rows.
 *   3. If the middle is still pathologically large (full rewrite of a big file),
 *      fall back to a coarse "all removed then all added" block — bounded work.
 *   4. Fold long runs of unchanged lines into a single "gap" marker, keeping a
 *      few context lines around every change (à la a real diff viewer).
 */

export type DiffRowKind = "add" | "del" | "ctx" | "gap";

export interface DiffRow {
  kind: DiffRowKind;
  /** 1-based line number on the OLD side (null for added / gap rows). */
  oldNo: number | null;
  /** 1-based line number on the NEW side (null for removed / gap rows). */
  newNo: number | null;
  /** Line text, or for a "gap" row the fold label (e.g. "12 unchanged lines"). */
  text: string;
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when the file was diffed coarsely (block) due to size. */
  coarse: boolean;
}

/** Context lines kept on each side of a change before folding. */
const CONTEXT = 3;
/** Above this LCS matrix size we skip the exact diff and emit a block. */
const MAX_MATRIX = 4_000_000;

/** Split into lines, dropping a single trailing newline's empty element so
 *  "a\nb\n" → ["a","b"] (not ["a","b",""]). */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface RawOp {
  kind: "add" | "del" | "ctx";
  a: number; // index into old lines, or -1
  b: number; // index into new lines, or -1
}

/** Exact LCS diff of two line arrays (used on the trimmed middle only). */
function lcsDiff(a: string[], b: string[]): RawOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ kind: "add" as const, a: -1, b: j }));
  if (m === 0) return a.map((_, i) => ({ kind: "del" as const, a: i, b: -1 }));

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }

  const ops: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", a: i, b: j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ kind: "del", a: i, b: -1 });
      i++;
    } else {
      ops.push({ kind: "add", a: -1, b: j });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", a: i++, b: -1 });
  while (j < m) ops.push({ kind: "add", a: -1, b: j++ });
  return ops;
}

/** Fold runs of unchanged rows longer than 2·CONTEXT into a single gap. */
function foldContext(rows: DiffRow[]): DiffRow[] {
  // Mark which ctx rows to keep: any within CONTEXT of a change.
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "add" || rows[i].kind === "del") {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) {
        keep[k] = true;
      }
    }
  }
  const out: DiffRow[] = [];
  let folded = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "ctx" && !keep[i]) {
      folded++;
      const atEnd = i === rows.length - 1 || !(rows[i + 1].kind === "ctx" && !keep[i + 1]);
      if (atEnd) {
        out.push({
          kind: "gap",
          oldNo: null,
          newNo: null,
          text: `${folded} unchanged line${folded === 1 ? "" : "s"}`,
        });
        folded = 0;
      }
    } else {
      out.push(rows[i]);
    }
  }
  return out;
}

// ── Side-by-side (split) layout ──────────────────────────────────────

export interface SplitCell {
  no: number | null;
  text: string;
}
export interface SplitRow {
  kind: "ctx" | "change" | "gap";
  /** Old side (null = empty filler on an unbalanced change). */
  left: SplitCell | null;
  /** New side (null = empty filler on an unbalanced change). */
  right: SplitCell | null;
  /** Fold label for a "gap" row. */
  text?: string;
}

/**
 * Re-shape unified diff rows into aligned old|new pairs. A run of removals and
 * additions is zipped row-for-row (extra removals get an empty new side and
 * vice-versa); context lines mirror on both sides; gaps span the full width.
 */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "ctx") {
      out.push({
        kind: "ctx",
        left: { no: r.oldNo, text: r.text },
        right: { no: r.newNo, text: r.text },
      });
      i++;
      continue;
    }
    if (r.kind === "gap") {
      out.push({ kind: "gap", left: null, right: null, text: r.text });
      i++;
      continue;
    }
    // Collect the maximal run of changes, split into removals / additions.
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && (rows[i].kind === "del" || rows[i].kind === "add")) {
      (rows[i].kind === "del" ? dels : adds).push(rows[i]);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k];
      const a = adds[k];
      out.push({
        kind: "change",
        left: d ? { no: d.oldNo, text: d.text } : null,
        right: a ? { no: a.newNo, text: a.text } : null,
      });
    }
  }
  return out;
}

export function computeDiff(oldText: string, newText: string): DiffResult {
  const a = toLines(oldText);
  const b = toLines(newText);

  // 1. Shared prefix / suffix.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  const coarse = midA.length * midB.length > MAX_MATRIX;
  const midOps: RawOp[] = coarse
    ? [
        ...midA.map((_, i) => ({ kind: "del" as const, a: pre + i, b: -1 })),
        ...midB.map((_, j) => ({ kind: "add" as const, a: -1, b: pre + j })),
      ]
    : lcsDiff(midA, midB).map((op) => ({
        kind: op.kind,
        a: op.a < 0 ? -1 : pre + op.a,
        b: op.b < 0 ? -1 : pre + op.b,
      }));

  // 2. Stitch prefix + middle + suffix back into a full op list.
  const ops: RawOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: "ctx", a: i, b: i });
  ops.push(...midOps);
  for (let s = suf - 1; s >= 0; s--) {
    ops.push({ kind: "ctx", a: a.length - 1 - s, b: b.length - 1 - s });
  }

  // 3. Materialise rows with line numbers + tally.
  let added = 0;
  let removed = 0;
  const rows: DiffRow[] = ops.map((op) => {
    if (op.kind === "add") {
      added++;
      return { kind: "add", oldNo: null, newNo: op.b + 1, text: b[op.b] };
    }
    if (op.kind === "del") {
      removed++;
      return { kind: "del", oldNo: op.a + 1, newNo: null, text: a[op.a] };
    }
    return { kind: "ctx", oldNo: op.a + 1, newNo: op.b + 1, text: a[op.a] };
  });

  return { rows: foldContext(rows), added, removed, coarse };
}
