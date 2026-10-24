/**
 * Agent Window — the reply language: a whole laid-out answer in one fence
 * [pure].
 *
 * Transcript → Reply layout (opt-in). The model writes one `aurora-ui` fence,
 * one named part per line:
 *
 *   ```aurora-ui
 *   root = Page([scale, stack, gates])
 *   scale = Stats([Stat("Route handlers", 94), Stat("Client files", 189)])
 *   stack = Facts("Stack", ["Framework | Next.js 16 | App Router", "Auth | NextAuth v5"])
 *   gates = Diagram("Routing", [Column("Surfaces", [Node("Admin"), Node("API")]), Column("Gate", [Node("proxy.ts")])])
 *   ```
 *
 * Why its own text and not JSON or a library: our own probe
 * (`Documents/aurora-reply-language-designs.html`, 2026-10-16) measured the
 * same answer at 687 tokens as separate fences, 1,036 as report JSON and 800
 * here, and only this one draws line by line, nests, and branches. OpenUI
 * Lang has the same shape and was dropped for its install telemetry
 * (2026-10-11); this is ours.
 *
 * Every line is complete on its own, so a streaming reply draws each part the
 * moment its line ends; `root` comes first and names the order, and parts it
 * names that have not arrived yet draw nothing until they do. A statement the
 * model wrapped over several lines is read once its brackets close.
 *
 * Arguments are positional, so a title can never be read as a row (the
 * header-row bug the fences had). Row parts reuse the fences' row grammar
 * (`a | b | c`) and their parsers, so a Facts part and an `aurora-facts` fence
 * read a row the same way.
 *
 * There are no expressions and no handlers. Nothing the model writes computes
 * a value; the only interaction is the reader's own view state (tracing a
 * diagram node). A line or part that cannot be read is named in `problems`,
 * never guessed at.
 */

import { layoutIsEmpty, parseLayout, type ReplyLayout } from "./parse";

export const UI_FENCE_LANGUAGE = "aurora-ui";
export type UiFenceLanguage = typeof UI_FENCE_LANGUAGE;

/** Parts the root may place, plus the pieces they are made of. */
const ROW_PARTS = {
  Facts: "facts",
  Flow: "flow",
  Note: "note",
  Bars: "bars",
  Pairs: "pairs",
  Compare: "compare",
  Checklist: "checklist",
  Timeline: "timeline",
  Tree: "tree",
} as const;
type RowPartName = keyof typeof ROW_PARTS;

export const UI_PARTS = ["Page", "Text", "Stats", "Stat", "Diagram", "Column", "Node", "Link", "Sources", ...Object.keys(ROW_PARTS)] as const;

const MAX_SOURCES = 12;

const MAX_PARTS = 24;
const MAX_STATS = 8;
const MAX_COLUMNS = 6;
const MAX_NODES = 8;
/** A statement still open after this many lines is a broken one, not a long one.
 *  Was 24: a 23-row `Tree`, one row per line, ran 25 lines and was dropped as
 *  "never closed" (MiniMax M3.1, 2026-10-23). A part fits in this many rows. */
const MAX_STATEMENT_LINES = 80;
const MAX_REF_DEPTH = 8;
/** A one-field line the fence parsers take as the title; replaced by the real one. */
const TITLE_SLOT = "title";

export interface UiStat {
  label: string;
  value: string;
  note?: string;
}

export interface DiagramNode {
  title: string;
  caption?: string;
}

export interface DiagramColumn {
  label: string;
  nodes: DiagramNode[];
}

/** From node `from[1]` in column `from[0]` to node `to[1]` in the next column. */
export interface DiagramEdge {
  from: [number, number];
  to: [number, number];
}

/** A web address the reply points at, already checked to be http(s). */
export interface UiSource {
  url: string;
  /** `mvsep.com`, without `www.` — what the reader recognises. */
  host: string;
  title?: string;
}

export type UiPart =
  | { kind: "title"; key: string; text: string }
  /** One page worth opening: title, what it is, and an optional fact about it ("Paid only"). */
  | { kind: "link"; key: string; title: string; source: UiSource; caption?: string; badge?: string }
  /** Where the claim above came from. */
  | { kind: "sources"; key: string; sources: UiSource[] }
  | { kind: "text"; key: string; text: string }
  | { kind: "stats"; key: string; stats: UiStat[] }
  | { kind: "diagram"; key: string; title: string; columns: DiagramColumn[]; edges: DiagramEdge[] }
  /** A row part, drawn by the fence renderer. A flow carries its title as a heading. */
  | { kind: "block"; key: string; heading?: string; layout: ReplyLayout };

export interface UiLayout {
  kind: "ui";
  parts: UiPart[];
  problems: string[];
}

// ── Expressions ─────────────────────────────────────────────────────────────

export type UiValue =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "list"; v: UiValue[] }
  | { t: "ref"; v: string }
  | { t: "call"; name: string; args: UiValue[] };

/** The text ended inside a construct: wait for the next line. */
class Incomplete extends Error {}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER = /^-?\d+(?:\.\d+)?/;

function readExpression(src: string, start: number): [UiValue, number] {
  let i = start;
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i += 1;
  };
  const items = (close: string): UiValue[] => {
    const out: UiValue[] = [];
    skip();
    while (src[i] !== close) {
      if (i >= src.length) throw new Incomplete();
      const [value, next] = readExpression(src, i);
      out.push(value);
      i = next;
      skip();
      if (src[i] === ",") {
        i += 1;
        skip();
      } else if (i < src.length && src[i] !== close) {
        throw new Error(`expected "," or "${close}" but found "${src[i]}"`);
      }
    }
    i += 1;
    return out;
  };

  skip();
  if (i >= src.length) throw new Incomplete();
  const ch = src[i];
  if (ch === '"') {
    let text = "";
    i += 1;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === "\\" && i + 1 < src.length) {
        // Only the escapes the guide teaches are escapes: `\"` and `\\`, and
        // `\|`, which stays escaped for the row splitter. Any other backslash
        // is text. Dropping it turned `C:\Users\Alvan\Documents\tv-remote`
        // into `C:UsersAlvanDocumentstv-remote` (Alvan, 2026-10-23), and a
        // `\n` read as a line break would break `\node_modules`.
        const next = src[i + 1];
        if (next === '"' || next === "\\") {
          text += next;
          i += 2;
        } else if (next === "|") {
          text += "\\|";
          i += 2;
        } else {
          text += "\\";
          i += 1;
        }
        continue;
      }
      // A statement wrapped over lines keeps one space where the break was.
      text += src[i] === "\n" ? " " : src[i];
      i += 1;
    }
    if (i >= src.length) throw new Incomplete();
    return [{ t: "str", v: text }, i + 1];
  }
  if (ch === "[") {
    i += 1;
    return [{ t: "list", v: items("]") }, i];
  }
  const number = NUMBER.exec(src.slice(i));
  if (number) return [{ t: "num", v: Number(number[0]) }, i + number[0].length];
  const ident = IDENT.exec(src.slice(i));
  if (!ident) throw new Error(`unexpected "${ch}"`);
  i += ident[0].length;
  if (src[i] === "(") {
    i += 1;
    return [{ t: "call", name: ident[0], args: items(")") }, i];
  }
  return [{ t: "ref", v: ident[0] }, i];
}

interface Statement {
  name: string;
  value: UiValue;
}

/** `name = Part(…)`, or a bare part. Throws `Incomplete` when it has not ended. */
export function readStatement(text: string): Statement | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(text);
  const body = match ? text.slice(match[0].length) : text;
  const [value, end] = readExpression(body, 0);
  const rest = body.slice(end).trim().replace(/;$/, "");
  if (rest) throw new Error(`unexpected "${rest.slice(0, 20)}" after the part`);
  return { name: match ? match[1] : "", value };
}

// ── Parts ───────────────────────────────────────────────────────────────────

class Reader {
  readonly problems: string[] = [];
  private readonly env = new Map<string, UiValue>();
  private readonly used = new Set<string>();
  /** The fence is closed: a name that never arrived is now a fault. */
  private readonly closed: boolean;

  constructor(statements: Statement[], closed: boolean) {
    this.closed = closed;
    for (const s of statements) if (s.name) this.env.set(s.name, s.value);
  }

  has(name: string): boolean {
    return this.env.has(name);
  }

  /** Follow names to the value they stand for. `null` while it has not arrived. */
  resolve(value: UiValue | undefined, depth = 0): UiValue | null {
    if (!value) return null;
    if (value.t !== "ref") return value;
    if (depth > MAX_REF_DEPTH) {
      this.problems.push(`${value.v} — names refer to each other in a loop`);
      return null;
    }
    this.used.add(value.v);
    const target = this.env.get(value.v);
    if (!target) {
      if (this.closed) this.problems.push(`${value.v} — used but never written`);
      return null;
    }
    return this.resolve(target, depth + 1);
  }

  text(value: UiValue | undefined): string | null {
    const v = this.resolve(value);
    if (!v) return null;
    if (v.t === "str") return v.v;
    if (v.t === "num") return String(v.v);
    return null;
  }

  list(value: UiValue | undefined): UiValue[] | null {
    const v = this.resolve(value);
    return v && v.t === "list" ? v.v : null;
  }

  calls(value: UiValue | undefined, name: string, where: string): Extract<UiValue, { t: "call" }>[] {
    const out: Extract<UiValue, { t: "call" }>[] = [];
    for (const item of this.list(value) ?? []) {
      const v = this.resolve(item);
      if (!v) continue;
      if (v.t === "call" && v.name === name) out.push(v);
      else this.problems.push(`${where} — expects ${name}(…) items`);
    }
    return out;
  }

  unused(): string[] {
    return [...this.env.keys()].filter((name) => name !== "root" && !this.used.has(name));
  }
}

/** Title first is optional: `Facts([...])` is `Facts("", [...])`. */
function titleAndList(reader: Reader, args: UiValue[]): { title: string; list: UiValue | undefined; rest: UiValue[] } {
  const first = reader.resolve(args[0]);
  if (first && first.t === "list") return { title: "", list: args[0], rest: args.slice(1) };
  return { title: reader.text(args[0]) ?? "", list: args[1], rest: args.slice(2) };
}

function rowPart(reader: Reader, name: RowPartName, args: UiValue[], key: string): UiPart | null {
  const kind = ROW_PARTS[name];
  const { title, list, rest } = titleAndList(reader, args);
  const rows: string[] = [];
  for (const item of reader.list(list) ?? []) {
    const row = reader.text(item);
    if (row === null) reader.problems.push(`${key} — a ${name} row is text in quotes`);
    else if (row.trim()) rows.push(row.replace(/\n/g, " "));
  }
  // The fence parsers read a one-field first line as the title. A stand-in
  // title line takes that place, so a first row is never read as a title
  // whatever it holds, and the real title is set on the result untouched. A
  // flow has no title line; its title is drawn as a heading instead.
  const lines = kind === "flow" ? rows : [TITLE_SLOT, ...rows];
  if (kind === "note") {
    const closing = reader.text(rest[0]);
    if (closing) lines.push(closing.replace(/\|/g, "\\|"));
  }
  if (rows.length === 0 && lines.length <= 1 && !title) return null;
  const parsed = parseLayout(`aurora-${kind}`, lines.join("\n"), true);
  const layout = "title" in parsed && kind !== "flow" ? { ...parsed, title } : parsed;  // A drawn block names its own skipped rows inside its card (`layout.problems`).
  // Only a block with nothing to draw hands them to the reply-level list, with
  // its name, since no card is left to hold them.
  if (layoutIsEmpty(layout)) {
    for (const problem of parsed.problems) reader.problems.push(`${key}: ${problem}`);
    return null;
  }
  return { kind: "block", key, ...(kind === "flow" && title ? { heading: title } : {}), layout };
}

function statsPart(reader: Reader, args: UiValue[], key: string): UiPart | null {
  const stats: UiStat[] = [];
  for (const call of reader.calls(args[0], "Stat", key)) {
    const label = reader.text(call.args[0]);
    const value = reader.text(call.args[1]);
    if (!label || value === null) {
      reader.problems.push(`${key} — a stat is Stat("Label", value)`);
      continue;
    }
    if (stats.length >= MAX_STATS) {
      reader.problems.push(`${key} — more than ${MAX_STATS} stats`);
      break;
    }
    const note = reader.text(call.args[2]);
    stats.push(note ? { label, value, note } : { label, value });
  }
  return stats.length > 0 ? { kind: "stats", key, stats } : null;
}

function diagramPart(reader: Reader, args: UiValue[], key: string): UiPart | null {
  const { title, list } = titleAndList(reader, args);
  const columns: DiagramColumn[] = [];
  /** Per column, per node: the titles it names in the next column, if any. */
  const links: (string[] | null)[][] = [];
  for (const column of reader.calls(list, "Column", key)) {
    if (columns.length >= MAX_COLUMNS) {
      reader.problems.push(`${key} — more than ${MAX_COLUMNS} columns`);
      break;
    }
    const { title: label, list: nodeList } = titleAndList(reader, column.args);
    const nodes: DiagramNode[] = [];
    const nodeLinks: (string[] | null)[] = [];
    for (const node of reader.calls(nodeList, "Node", key)) {
      const nodeTitle = reader.text(node.args[0]);
      if (!nodeTitle) {
        reader.problems.push(`${key} — a node is Node("Title", "Optional caption")`);
        continue;
      }
      if (nodes.length >= MAX_NODES) {
        reader.problems.push(`${key} — more than ${MAX_NODES} nodes in "${label}"`);
        break;
      }
      // Node("A", ["B"]) and Node("A", "caption", ["B"]) both name links.
      const second = reader.resolve(node.args[1]);
      const caption = second && second.t !== "list" ? reader.text(node.args[1]) : null;
      const linkList = second && second.t === "list" ? node.args[1] : node.args[2];
      const to = reader.list(linkList);
      nodes.push(caption ? { title: nodeTitle, caption } : { title: nodeTitle });
      nodeLinks.push(to ? to.map((t) => reader.text(t) ?? "").filter(Boolean) : null);
    }
    if (nodes.length === 0) continue;
    columns.push({ label, nodes });
    links.push(nodeLinks);
  }
  if (columns.length === 0) return null;

  // Each column feeds the next. Without named links every node meets every
  // node of the next column — the fan in and out the probe drew. Named links
  // replace that for the column that names them; nothing is paired by guess.
  const edges: DiagramEdge[] = [];
  for (let c = 0; c + 1 < columns.length; c += 1) {
    const named = links[c].some((l) => l !== null);
    columns[c].nodes.forEach((node, n) => {
      if (!named) {
        columns[c + 1].nodes.forEach((_, m) => edges.push({ from: [c, n], to: [c + 1, m] }));
        return;
      }
      for (const target of links[c][n] ?? []) {
        const m = columns[c + 1].nodes.findIndex((next) => next.title === target);
        if (m < 0) reader.problems.push(`${key} — "${node.title}" links to "${target}", which is not in the next column`);
        else edges.push({ from: [c, n], to: [c + 1, m] });
      }
    });
  }
  return { kind: "diagram", key, title, columns, edges };
}

/** Only http(s) reaches the reader's browser; anything else is a fault, never a link. */
export function readSource(url: string, title?: string): UiSource | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^www\./, "");
  return title ? { url: parsed.toString(), host, title } : { url: parsed.toString(), host };
}

function linkPart(reader: Reader, args: UiValue[], key: string): UiPart | null {
  const title = reader.text(args[0]);
  const url = reader.text(args[1]);
  if (!title || !url) {
    reader.problems.push(`${key} — a link is Link("Title", "https://…", "Optional line", "Optional badge")`);
    return null;
  }
  const source = readSource(url);
  if (!source) {
    reader.problems.push(`${key} — "${url}" is not an http(s) address`);
    return null;
  }
  const caption = reader.text(args[2]);
  const badge = reader.text(args[3]);
  return { kind: "link", key, title, source, ...(caption ? { caption } : {}), ...(badge ? { badge } : {}) };
}

/** Each item is a bare address or `Title | address`. */
function sourcesPart(reader: Reader, args: UiValue[], key: string): UiPart | null {
  const sources: UiSource[] = [];
  for (const item of reader.list(args[0]) ?? []) {
    const row = reader.text(item);
    if (!row) continue;
    const pipe = row.lastIndexOf("|");
    const [title, url] = pipe >= 0 ? [row.slice(0, pipe).trim(), row.slice(pipe + 1).trim()] : ["", row.trim()];
    const source = readSource(url, title || undefined);
    if (!source) {
      reader.problems.push(`${key} — "${url}" is not an http(s) address`);
      continue;
    }
    if (sources.length >= MAX_SOURCES) {
      reader.problems.push(`${key} — more than ${MAX_SOURCES} sources`);
      break;
    }
    sources.push(source);
  }
  return sources.length > 0 ? { kind: "sources", key, sources } : null;
}

function part(reader: Reader, value: UiValue | undefined, key: string): UiPart | null {
  const v = reader.resolve(value);
  if (!v) return null;
  if (v.t === "str") return v.v.trim() ? { kind: "text", key, text: v.v } : null;
  if (v.t !== "call") {
    reader.problems.push(`${key} — expected a part like Facts(…)`);
    return null;
  }
  if (v.name in ROW_PARTS) return rowPart(reader, v.name as RowPartName, v.args, key);
  switch (v.name) {
    case "Text": {
      const text = reader.text(v.args[0]);
      return text ? { kind: "text", key, text } : null;
    }
    case "Stats":
      return statsPart(reader, v.args, key);
    case "Diagram":
      return diagramPart(reader, v.args, key);
    case "Link":
      return linkPart(reader, v.args, key);
    case "Sources":
      return sourcesPart(reader, v.args, key);
    case "Page":
    case "Stat":
    case "Column":
    case "Node":
      reader.problems.push(`${key} — ${v.name} belongs inside ${v.name === "Stat" ? "Stats" : v.name === "Page" ? "nothing (only root is a Page)" : v.name === "Column" ? "Diagram" : "Column"}`);
      return null;
    default:
      reader.problems.push(`${key} — unknown part "${v.name}"`);
      return null;
  }
}

/**
 * Read an `aurora-ui` fence. While it streams (`closed` false) a half-written
 * statement and names that have not arrived are waited for, not reported.
 */
export function parseUi(source: string, closed: boolean): UiLayout {
  const problems: string[] = [];
  const statements: Statement[] = [];

  const lines = source.split("\n");
  // The last line has not ended until its newline (or the fence) arrives.
  if (!closed && !source.endsWith("\n")) lines.pop();
  let buffer: string[] = [];
  for (const line of lines) {
    if (buffer.length === 0 && (!line.trim() || line.trim().startsWith("//"))) continue;
    buffer.push(line);
    try {
      const statement = readStatement(buffer.join("\n"));
      if (statement) statements.push(statement);
      buffer = [];
    } catch (error) {
      if (error instanceof Incomplete && buffer.length < MAX_STATEMENT_LINES) continue;
      const head = buffer[0].trim().slice(0, 48);
      problems.push(`${head}${buffer[0].trim().length > 48 ? "…" : ""} — ${error instanceof Incomplete ? "never closed" : (error as Error).message}`);
      buffer = [];
    }
  }
  if (closed && buffer.length > 0) problems.push(`${buffer[0].trim().slice(0, 48)}… — never closed`);

  const reader = new Reader(statements, closed);
  const parts: UiPart[] = [];
  const placed = new Set<string>();
  const place = (value: UiValue, key: string) => {
    if (placed.has(key)) {
      reader.problems.push(`${key} — placed twice`);
      return;
    }
    placed.add(key);
    if (parts.length >= MAX_PARTS) {
      reader.problems.push(`${key} — more than ${MAX_PARTS} parts`);
      return;
    }
    const drawn = part(reader, value, key);
    if (drawn) parts.push(drawn);
  };

  const root = statements.find((s) => s.name === "root");
  if (root) {
    reader.resolve({ t: "ref", v: "root" });
    const page = root.value;
    if (page.t !== "call" || page.name !== "Page") {
      reader.problems.push(`root — must be Page([…])`);
    } else {
      const { title, list } = titleAndList(reader, page.args);
      if (title) parts.push({ kind: "title", key: "root", text: title });
      (reader.list(list) ?? []).forEach((item, i) => {
        // A name the root lists that has not arrived yet draws nothing until it does.
        if (item.t === "ref" && !reader.has(item.v) && !closed) return;
        place(item, item.t === "ref" ? item.v : `root[${i}]`);
      });
    }
  } else {
    // No root: every statement, in the order written. Pieces used inside
    // another part (a Column, a Stat) are drawn by that part.
    const inner = new Set(["Stat", "Column", "Node"]);
    statements.forEach((s, i) => {
      if (s.value.t === "call" && inner.has(s.value.name)) return;
      if (s.name && statements.some((o) => o !== s && refers(o.value, s.name))) return;
      place(s.value, s.name || `line ${i + 1}`);
    });
  }

  if (closed && root) {
    const unused = reader.unused();
    if (unused.length > 0) reader.problems.push(`${unused.join(", ")} — written but not placed in root`);
  }
  // A part resolves a name more than once; name each fault once.
  return { kind: "ui", parts, problems: [...new Set([...problems, ...reader.problems])] };
}

function refers(value: UiValue, name: string): boolean {
  switch (value.t) {
    case "ref":
      return value.v === name;
    case "list":
      return value.v.some((v) => refers(v, name));
    case "call":
      return value.args.some((v) => refers(v, name));
    default:
      return false;
  }
}

/** Whether a parsed fence has anything to draw. */
export function uiIsEmpty(layout: UiLayout): boolean {
  return layout.parts.length === 0;
}

export type DiagramNodeId = `${number}:${number}`;
const nodeId = ([c, n]: [number, number]): DiagramNodeId => `${c}:${n}`;

/**
 * Every node and edge reachable from `start`, upstream and downstream — what
 * a diagram lights when the reader selects a node. Never sideways: from one
 * surface, the others feeding the same gate stay unlit.
 */
export function traceDiagram(start: [number, number], edges: DiagramEdge[]): { nodes: Set<DiagramNodeId>; edges: Set<number> } {
  const nodes = new Set<DiagramNodeId>([nodeId(start)]);
  const lit = new Set<number>();
  for (const forward of [true, false]) {
    let frontier = new Set<DiagramNodeId>([nodeId(start)]);
    while (frontier.size > 0) {
      const next = new Set<DiagramNodeId>();
      edges.forEach((edge, i) => {
        const [from, to] = forward ? [nodeId(edge.from), nodeId(edge.to)] : [nodeId(edge.to), nodeId(edge.from)];
        if (frontier.has(from) && !lit.has(i)) {
          lit.add(i);
          nodes.add(to);
          next.add(to);
        }
      });
      frontier = next;
    }
  }
  return { nodes, edges: lit };
}
