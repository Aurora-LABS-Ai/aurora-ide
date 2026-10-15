/**
 * Agent Window — reply layout blocks: what the model writes, parsed [pure].
 *
 * Transcript → Reply layout (opt-in). With it on, the model can lay out an
 * explanation with three kinds of page part inside its reply, each a fenced
 * block with one item per line and `|` between fields:
 *
 *   ```aurora-facts         a row of tiles: the figures the reader looks for first
 *   Framework | Next.js 16.2.3 | App Router · React 19
 *   ```
 *   ```aurora-flow          top-to-bottom steps; `||` puts items side by side
 *   Incoming request
 *   proxy.ts | Single routing and access-control gate
 *   Storefront / || Admin /admin || Auth /auth || API /api
 *   ```
 *   ```aurora-note          one boxed trap or caveat: a title, pairs, sentences
 *   The route-group trap
 *   File location | app/(client)/test-assets/page.tsx
 *   Actual public URL | /test-assets
 *   The folder is under the group, so a folder-tree search finds nothing.
 *   ```
 *
 * Pipes and one item per line, because every model already writes markdown
 * tables that way and a half-written line is still a line. Fields hold plain
 * text and `code`; nothing else (`inlineRuns`). No formulas, no state: these
 * are layout, and the answer box (`lib/answer-box`) stays the tool for numbers
 * the reader changes.
 *
 * A line the block cannot read is skipped and counted in `problems`, never
 * guessed at. Off, every one of these fences is a code block, as it was.
 */

export const LAYOUT_FENCE_LANGUAGES = {
  "aurora-facts": "facts",
  "aurora-flow": "flow",
  "aurora-note": "note",
  /** `Label | value / max` bars with the number beside each — a share, a count, a progression. */
  "aurora-bars": "bars",
  /** A titled key / value table — a route map, a config, an inventory. */
  "aurora-pairs": "pairs",
} as const;

export type LayoutLanguage = keyof typeof LAYOUT_FENCE_LANGUAGES;
export type LayoutKind = (typeof LAYOUT_FENCE_LANGUAGES)[LayoutLanguage];

export function isLayoutLanguage(info: string): info is LayoutLanguage {
  return Object.prototype.hasOwnProperty.call(LAYOUT_FENCE_LANGUAGES, info);
}

/** Text with `code` spans picked out, for drawing. */
export type InlineRun = { kind: "text"; text: string } | { kind: "code"; text: string };

export interface Fact {
  label: string;
  value: string;
  caption?: string;
}

export interface FlowItem {
  title: string;
  caption?: string;
}

/** One step. More than one item means they sit side by side. */
export interface FlowStep {
  items: FlowItem[];
}

export type NoteLine = { kind: "pair"; label: string; value: string } | { kind: "text"; text: string };

export interface Bar {
  label: string;
  value: number;
  max: number;
  /** The number as the model wrote it: "31 / 97", "64%". */
  shown: string;
  caption?: string;
}

export interface Pair {
  label: string;
  value: string;
}

export type ReplyLayout =
  | { kind: "facts"; facts: Fact[]; problems: string[] }
  | { kind: "flow"; steps: FlowStep[]; problems: string[] }
  | { kind: "note"; title: string; lines: NoteLine[]; problems: string[] }
  | { kind: "bars"; title: string; bars: Bar[]; problems: string[] }
  | { kind: "pairs"; title: string; pairs: Pair[]; problems: string[] };

/** Most items a block draws; the rest are reported, so a runaway list stays a list. */
export const MAX_ITEMS = 12;

/** Split on `|` that is not written `\|`, trimming each field; empty fields kept. */
export function splitFields(line: string, separator: "|" | "||" = "|"): string[] {
  const out: string[] = [];
  let field = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      field += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (separator === "||") {
        if (line[i + 1] === "|") {
          out.push(field.trim());
          field = "";
          i += 1;
          continue;
        }
        field += ch;
        continue;
      }
      out.push(field.trim());
      field = "";
      continue;
    }
    field += ch;
  }
  out.push(field.trim());
  return out;
}

/** Lines the block can read: blank lines dropped; while streaming, a last
 *  line without its newline is still being written and is left out. */
function usableLines(source: string, closed: boolean): string[] {
  const lines = source.split("\n");
  if (!closed && !source.endsWith("\n")) lines.pop();
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

function parseFacts(lines: string[]): ReplyLayout {
  const facts: Fact[] = [];
  const problems: string[] = [];
  for (const line of lines) {
    const [label = "", value = "", caption = ""] = splitFields(line);
    if (!label || !value) {
      problems.push(`${line} — a fact is "Label | Value" with an optional "| Caption"`);
      continue;
    }
    if (facts.length >= MAX_ITEMS) {
      problems.push(`${line} — more than ${MAX_ITEMS} facts`);
      continue;
    }
    facts.push(caption ? { label, value, caption } : { label, value });
  }
  return { kind: "facts", facts, problems };
}

function parseFlow(lines: string[]): ReplyLayout {
  const steps: FlowStep[] = [];
  const problems: string[] = [];
  for (const line of lines) {
    if (steps.length >= MAX_ITEMS) {
      problems.push(`${line} — more than ${MAX_ITEMS} steps`);
      continue;
    }
    const items: FlowItem[] = [];
    for (const part of splitFields(line, "||")) {
      const [title = "", caption = ""] = splitFields(part);
      if (!title) continue;
      items.push(caption ? { title, caption } : { title });
    }
    if (items.length === 0) {
      problems.push(`${line} — a step is "Title | Caption"`);
      continue;
    }
    steps.push({ items });
  }
  return { kind: "flow", steps, problems };
}

function parseNote(lines: string[]): ReplyLayout {
  const problems: string[] = [];
  const [first = "", ...rest] = lines;
  // The title is the first line; a pipe there is the model skipping the
  // title, so the line is read as a pair and the title stays blank.
  const titleFields = splitFields(first);
  const title = titleFields.length === 1 ? first : "";
  const body = titleFields.length === 1 ? rest : lines;
  const out: NoteLine[] = [];
  for (const line of body) {
    if (out.length >= MAX_ITEMS) {
      problems.push(`${line} — more than ${MAX_ITEMS} lines`);
      continue;
    }
    const fields = splitFields(line);
    if (fields.length >= 2 && fields[0] && fields[1]) {
      out.push({ kind: "pair", label: fields[0], value: fields.slice(1).join(" | ") });
    } else {
      out.push({ kind: "text", text: line });
    }
  }
  return { kind: "note", title, lines: out, problems };
}

/** A title is a first line with no pipe in it; a pipe means the model went
 *  straight to the rows. */
function titleAndRows(lines: string[]): { title: string; rows: string[] } {
  const [first = "", ...rest] = lines;
  if (first && splitFields(first).length === 1) return { title: first, rows: rest };
  return { title: "", rows: lines };
}

/** "31", "31 / 97", "64%", "1,204" → the number(s) it holds. */
function readAmount(field: string): { value: number; max?: number } | null {
  const cleaned = field.replace(/,/g, "").trim();
  const slash = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(?:\/|of)\s*(-?\d+(?:\.\d+)?)/i);
  if (slash) return { value: Number(slash[1]), max: Number(slash[2]) };
  const percent = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*%/);
  if (percent) return { value: Number(percent[1]), max: 100 };
  const plain = cleaned.match(/^(-?\d+(?:\.\d+)?)/);
  if (plain) return { value: Number(plain[1]) };
  return null;
}

function parseBars(lines: string[]): ReplyLayout {
  const { title, rows } = titleAndRows(lines);
  const bars: Bar[] = [];
  const problems: string[] = [];
  for (const line of rows) {
    const [label = "", amount = "", third = "", fourth = ""] = splitFields(line);
    const read = amount ? readAmount(amount) : null;
    if (!label || !read) {
      problems.push(`${line} — a bar is "Label | 31 / 97" or "Label | 64%", with an optional "| Caption"`);
      continue;
    }
    if (bars.length >= MAX_ITEMS) {
      problems.push(`${line} — more than ${MAX_ITEMS} bars`);
      continue;
    }
    // "Label | 31 | 97 | caption" is read too: a bare number in the third
    // field is the max, otherwise the third field is the caption.
    let max = read.max;
    let caption = third;
    if (max === undefined) {
      const thirdNumber = third ? readAmount(third) : null;
      if (thirdNumber && !thirdNumber.max && /^[\d.,\s]+$/.test(third.trim())) {
        max = thirdNumber.value;
        caption = fourth;
      }
    }
    const shown = max !== undefined && read.max === undefined ? `${amount.trim()} / ${max}` : amount.trim();
    bars.push({
      label,
      value: read.value,
      // No max given: the largest bar is the full width.
      max: max ?? Number.NaN,
      shown,
      ...(caption ? { caption } : {}),
    });
  }
  const largest = bars.reduce((m, b) => (Number.isNaN(b.max) ? Math.max(m, b.value) : m), 0);
  for (const bar of bars) if (Number.isNaN(bar.max)) bar.max = largest || 1;
  return { kind: "bars", title, bars, problems };
}

function parsePairs(lines: string[]): ReplyLayout {
  const { title, rows } = titleAndRows(lines);
  const pairs: Pair[] = [];
  const problems: string[] = [];
  for (const line of rows) {
    const fields = splitFields(line);
    if (fields.length < 2 || !fields[0] || !fields[1]) {
      problems.push(`${line} — a pair is "Label | Value"`);
      continue;
    }
    if (pairs.length >= MAX_ITEMS) {
      problems.push(`${line} — more than ${MAX_ITEMS} pairs`);
      continue;
    }
    pairs.push({ label: fields[0], value: fields.slice(1).join(" | ") });
  }
  return { kind: "pairs", title, pairs, problems };
}

export function parseLayout(language: LayoutLanguage, source: string, closed: boolean): ReplyLayout {
  const lines = usableLines(source, closed);
  switch (LAYOUT_FENCE_LANGUAGES[language]) {
    case "facts":
      return parseFacts(lines);
    case "flow":
      return parseFlow(lines);
    case "note":
      return parseNote(lines);
    case "bars":
      return parseBars(lines);
    case "pairs":
      return parsePairs(lines);
  }
}

/** Whether a parsed block has anything to draw. */
export function layoutIsEmpty(layout: ReplyLayout): boolean {
  switch (layout.kind) {
    case "facts":
      return layout.facts.length === 0;
    case "flow":
      return layout.steps.length === 0;
    case "note":
      return !layout.title && layout.lines.length === 0;
    case "bars":
      return layout.bars.length === 0;
    case "pairs":
      return layout.pairs.length === 0;
  }
}

/** `code` spans in a field. An unclosed backtick is text. */
export function inlineRuns(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let rest = text;
  while (rest.length > 0) {
    const open = rest.indexOf("`");
    if (open < 0) break;
    const close = rest.indexOf("`", open + 1);
    if (close < 0) break;
    if (open > 0) runs.push({ kind: "text", text: rest.slice(0, open) });
    runs.push({ kind: "code", text: rest.slice(open + 1, close) });
    rest = rest.slice(close + 1);
  }
  if (rest.length > 0) runs.push({ kind: "text", text: rest });
  return runs;
}
