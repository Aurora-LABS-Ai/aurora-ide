/**
 * The `aurora-box` format: one line per part, read top to bottom.
 *
 * ```aurora-box
 * stepper people "Number of people" 6 min=1 max=30 unit="person/people"
 * title "Your shopping list"
 * row "Bone-in leg of lamb" = people * 400 g
 * total "Each of {people} pays" = bill / people $
 * note "Amounts include you"
 * ```
 *
 * Line-shaped on purpose. A reply streams token by token, and a format where
 * every line stands alone can draw each line the moment it is complete — no
 * half-open brackets to guess at. A bad line is skipped and named; it never
 * takes the rest of the box with it.
 */

import {
  BoxExpressionError,
  FUNCTION_NAMES,
  parseExpression,
  referencedNames,
  type Expression,
} from "./expression";

/** Text with `{formula}` holes: "Each of {people} pays". */
export type BoxTemplate = Array<string | Expression>;

export interface BoxStepper {
  kind: "stepper";
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export interface BoxNumber {
  kind: "number";
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  prefix?: string;
  suffix?: string;
}

export interface BoxChoice {
  kind: "choice";
  id: string;
  label: string;
  value: number;
  options: Array<{ label: string; value: number }>;
}

export type BoxInput = BoxStepper | BoxNumber | BoxChoice;

export type BoxPart =
  | BoxInput
  | { kind: "let"; id: string; expr: Expression }
  | { kind: "title"; text: BoxTemplate }
  | { kind: "row"; label: BoxTemplate; expr: Expression; unit?: string; places?: number; emphasis: boolean }
  | { kind: "metric"; id: string; label: string; better: "low" | "high"; unit?: string }
  | { kind: "item"; name: string; values: Record<string, number> }
  | { kind: "note"; text: BoxTemplate };

export interface BoxLineError {
  /** 1-based, counted inside the box. */
  line: number;
  message: string;
}

export interface BoxSpec {
  parts: Array<BoxPart & { line: number }>;
  errors: BoxLineError[];
}

/** More than this is a page, not a tool in a reply. */
export const MAX_BOX_LINES = 80;

const ID = /^[a-z_][a-z0-9_]{0,39}$/;
const CURRENCY_OR_SIGN = /^[$£€¥₹%]$/;

class LineError extends Error {}

/** A cursor over one line. */
class Reader {
  i = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipSpace() {
    while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i++;
  }

  done(): boolean {
    this.skipSpace();
    return this.i >= this.text.length;
  }

  peekChar(): string {
    this.skipSpace();
    return this.text[this.i] ?? "";
  }

  string(what: string): string {
    this.skipSpace();
    if (this.text[this.i] !== '"') throw new LineError(`expected ${what} in "double quotes"`);
    let out = "";
    let j = this.i + 1;
    for (; j < this.text.length; j++) {
      const ch = this.text[j];
      if (ch === "\\" && j + 1 < this.text.length) {
        out += this.text[++j];
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    if (j >= this.text.length) throw new LineError(`${what} is missing its closing quote`);
    this.i = j + 1;
    return out;
  }

  word(what: string): string {
    this.skipSpace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.i));
    if (!match) throw new LineError(`expected ${what}`);
    this.i += match[0].length;
    return match[0];
  }

  number(what: string): number {
    this.skipSpace();
    const match = /^-?(?:\d[\d_]*)?(?:\.\d+)?/.exec(this.text.slice(this.i));
    const raw = match?.[0] ?? "";
    if (raw === "" || raw === "-" || raw === ".") throw new LineError(`expected ${what} as a number`);
    this.i += raw.length;
    return Number(raw.replace(/_/g, ""));
  }

  equals() {
    this.skipSpace();
    if (this.text[this.i] !== "=") throw new LineError('expected "="');
    this.i++;
  }

  expression(): Expression {
    try {
      const { expr, end } = parseExpression(this.text, this.i);
      this.i = end;
      return expr;
    } catch (err) {
      if (err instanceof BoxExpressionError) throw new LineError(`the formula: ${err.message}`);
      throw err;
    }
  }

  /** A unit: a word, a "quoted string", or one of `$ £ € ¥ ₹ %`. */
  unit(): string {
    const ch = this.peekChar();
    if (ch === '"') return this.string("the unit");
    if (CURRENCY_OR_SIGN.test(ch)) {
      this.i++;
      return ch;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_/]*/.exec(this.text.slice(this.i));
    if (!match) throw new LineError(`"${ch}" can't start a unit`);
    this.i += match[0].length;
    return match[0];
  }

  /** `key=value` pairs to the end of the line. */
  options(allowed: Record<string, "number" | "text">): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    while (!this.done()) {
      const key = this.word("an option such as min=1");
      const kind = allowed[key];
      if (!kind) {
        throw new LineError(`"${key}" is not an option here (there is ${Object.keys(allowed).join(", ")})`);
      }
      this.equals();
      if (kind === "number") out[key] = this.number(key);
      else out[key] = this.peekChar() === '"' ? this.string(key) : this.unit();
    }
    return out;
  }

  end() {
    if (!this.done()) throw new LineError(`unexpected "${this.text.slice(this.i).trim()}" at the end`);
  }
}

function id(reader: Reader): string {
  const name = reader.word("a name such as people");
  if (!ID.test(name)) throw new LineError(`"${name}" must be lower case letters, digits and _`);
  if (FUNCTION_NAMES.includes(name)) throw new LineError(`"${name}" is a function name; pick another`);
  return name;
}

function template(text: string): BoxTemplate {
  const out: BoxTemplate = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf("{");
    if (open === -1) break;
    const close = rest.indexOf("}", open);
    if (close === -1) throw new LineError("a { in the text is never closed");
    if (open > 0) out.push(rest.slice(0, open));
    const inside = rest.slice(open + 1, close);
    try {
      const { expr, end } = parseExpression(inside);
      if (inside.slice(end).trim()) throw new BoxExpressionError(`unexpected "${inside.slice(end).trim()}"`);
      out.push(expr);
    } catch (err) {
      if (err instanceof BoxExpressionError) throw new LineError(`{${inside}}: ${err.message}`);
      throw err;
    }
    rest = rest.slice(close + 1);
  }
  if (rest) out.push(rest);
  return out;
}

function parseLine(kind: string, reader: Reader): BoxPart {
  switch (kind) {
    case "stepper": {
      const name = id(reader);
      const label = reader.string("the label");
      const value = reader.number("the starting value");
      const opts = reader.options({ min: "number", max: "number", step: "number", unit: "text" });
      const min = (opts.min as number | undefined) ?? 0;
      const max = (opts.max as number | undefined) ?? Math.max(min, value) * 10 + 10;
      const step = (opts.step as number | undefined) ?? 1;
      if (min > max) throw new LineError("min is above max");
      if (step <= 0) throw new LineError("step must be above zero");
      return {
        kind,
        id: name,
        label,
        value: Math.min(max, Math.max(min, value)),
        min,
        max,
        step,
        unit: opts.unit as string | undefined,
      };
    }
    case "number": {
      const name = id(reader);
      const label = reader.string("the label");
      const value = reader.number("the starting value");
      const opts = reader.options({ min: "number", max: "number", prefix: "text", suffix: "text" });
      return {
        kind,
        id: name,
        label,
        value,
        min: opts.min as number | undefined,
        max: opts.max as number | undefined,
        prefix: opts.prefix as string | undefined,
        suffix: opts.suffix as string | undefined,
      };
    }
    case "choice": {
      const name = id(reader);
      const label = reader.string("the label");
      const value = reader.number("the starting value");
      const options: Array<{ label: string; value: number }> = [];
      while (!reader.done()) {
        const optionLabel = reader.string("an option label");
        reader.equals();
        options.push({ label: optionLabel, value: reader.number(`the value of "${optionLabel}"`) });
      }
      if (options.length < 2) throw new LineError('a choice needs at least two options: "None"=0 "15%"=0.15');
      if (options.length > 6) throw new LineError("a choice takes at most six options");
      if (!options.some((option) => option.value === value)) {
        throw new LineError(`the starting value ${value} is not one of the options`);
      }
      return { kind, id: name, label, value, options };
    }
    case "let": {
      const name = id(reader);
      reader.equals();
      const expr = reader.expression();
      reader.end();
      return { kind, id: name, expr };
    }
    case "title": {
      const text = template(reader.string("the title"));
      reader.end();
      return { kind, text };
    }
    case "row":
    case "total": {
      const label = template(reader.string("the label"));
      reader.equals();
      const expr = reader.expression();
      let unit: string | undefined;
      let places: number | undefined;
      while (!reader.done()) {
        if (/^dp\s*=/.test(reader.text.slice(reader.i).trimStart())) {
          reader.word("dp");
          reader.equals();
          places = Math.max(0, Math.min(6, Math.trunc(reader.number("dp"))));
        } else if (unit === undefined) {
          unit = reader.unit();
        } else {
          reader.end();
        }
      }
      return { kind: "row", label, expr, unit, places, emphasis: kind === "total" };
    }
    case "metric": {
      const name = id(reader);
      const label = reader.string("the label");
      const better = reader.word("low or high");
      if (better !== "low" && better !== "high") throw new LineError(`expected low or high, not "${better}"`);
      const unit = reader.done() ? undefined : reader.unit();
      reader.end();
      return { kind, id: name, label, better, unit };
    }
    case "item": {
      const name = reader.string("the item's name");
      const values: Record<string, number> = {};
      while (!reader.done()) {
        const key = reader.word("a metric name");
        reader.equals();
        values[key] = reader.number(key);
      }
      return { kind, name, values };
    }
    case "note": {
      const text = template(reader.string("the note"));
      reader.end();
      return { kind, text };
    }
    default:
      throw new LineError(
        `"${kind}" is not a line this box knows (there is stepper, number, choice, let, title, row, total, metric, item, note)`,
      );
  }
}

/** Names each part reads, for the after-parse check. */
function readsOf(part: BoxPart): Set<string> {
  const names = new Set<string>();
  const fromTemplate = (parts: BoxTemplate) => {
    for (const piece of parts) if (typeof piece !== "string") referencedNames(piece, names);
  };
  if (part.kind === "let" || part.kind === "row") referencedNames(part.expr, names);
  if (part.kind === "row") fromTemplate(part.label);
  if (part.kind === "title" || part.kind === "note") fromTemplate(part.text);
  return names;
}

/**
 * Read a box. While its fence is still open (`complete: false`) the last line
 * may be cut off mid-word, so it is held back until a newline lands after it.
 */
export function parseBox(source: string, { complete }: { complete: boolean }): BoxSpec {
  let lines = source.split(/\r?\n/);
  if (!complete && !/\n$/.test(source)) lines = lines.slice(0, -1);

  const parts: BoxSpec["parts"] = [];
  const errors: BoxLineError[] = [];
  const named = new Map<string, number>();

  lines.forEach((raw, index) => {
    const text = raw.trim();
    const line = index + 1;
    if (!text || text.startsWith("#") || text.startsWith("//")) return;
    if (parts.length >= MAX_BOX_LINES) {
      if (parts.length === MAX_BOX_LINES) errors.push({ line, message: `a box holds at most ${MAX_BOX_LINES} lines` });
      return;
    }
    const reader = new Reader(text);
    try {
      const kind = reader.word("a line such as row or stepper");
      const part = parseLine(kind, reader);
      if ("id" in part) {
        const earlier = named.get(part.id);
        if (earlier !== undefined) throw new LineError(`"${part.id}" is already used on line ${earlier}`);
        named.set(part.id, line);
      }
      parts.push({ ...part, line });
    } catch (err) {
      if (!(err instanceof LineError)) throw err;
      errors.push({ line, message: err.message });
    }
  });

  // Names: inputs are known everywhere; a `let` only from the line it is on.
  const inputs = new Set(parts.filter((p) => p.kind === "stepper" || p.kind === "number" || p.kind === "choice").map((p) => (p as BoxInput).id));
  const known = new Set(inputs);
  const metrics = new Set(parts.filter((p) => p.kind === "metric").map((p) => (p as { id: string }).id));
  const keep: BoxSpec["parts"] = [];
  for (const part of parts) {
    const missing = [...readsOf(part)].filter((name) => !known.has(name));
    if (missing.length > 0) {
      const later = missing.find((name) => named.has(name) && !metrics.has(name));
      errors.push({
        line: part.line,
        message: later
          ? `"${later}" is used before the line that defines it`
          : `nothing in this box is called "${missing[0]}"`,
      });
      continue;
    }
    if (part.kind === "item") {
      const unknown = Object.keys(part.values).find((key) => !metrics.has(key));
      if (unknown) {
        errors.push({ line: part.line, message: `"${unknown}" is not a metric in this box` });
        continue;
      }
    }
    if (part.kind === "let") known.add(part.id);
    keep.push(part);
  }

  const items = keep.filter((p) => p.kind === "item").length;
  if (complete && metrics.size > 0 && items === 0) {
    const first = keep.find((p) => p.kind === "metric");
    errors.push({ line: first?.line ?? 1, message: "metrics need item lines to compare" });
  }

  errors.sort((a, b) => a.line - b.line);
  return { parts: keep, errors };
}
