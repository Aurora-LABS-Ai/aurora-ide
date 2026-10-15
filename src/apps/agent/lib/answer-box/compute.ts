/**
 * A parsed box plus the reader's current inputs → what the box shows.
 *
 * Pure, so every number a box can display is testable without rendering it.
 */

import { BoxExpressionError, evaluateExpression } from "./expression";
import { formatBoxValue } from "./format";
import type { BoxInput, BoxLineError, BoxSpec, BoxTemplate } from "./parse";

export type BoxValues = Record<string, number>;

export interface ComputedRow {
  label: string;
  value: string;
  emphasis: boolean;
}

export interface ComputedCompare {
  metrics: Array<{ id: string; label: string; better: "low" | "high"; unit?: string }>;
  items: Array<{ name: string; values: Record<string, number> }>;
}

export type BoxBlock =
  | { kind: "input"; input: BoxInput; value: number }
  | { kind: "title"; text: string }
  | { kind: "rows"; rows: ComputedRow[] }
  | { kind: "compare"; compare: ComputedCompare };

export interface ComputedBox {
  blocks: BoxBlock[];
  note: string | null;
  /** Lines that could not be computed with the current inputs. */
  problems: BoxLineError[];
  /** True when one stepper is the only input: it takes the centre. */
  heroInput: boolean;
}

/** What each input starts at, as the model wrote it. */
export function defaultValues(spec: BoxSpec): BoxValues {
  const values: BoxValues = {};
  for (const part of spec.parts) {
    if (part.kind === "stepper" || part.kind === "number" || part.kind === "choice") {
      values[part.id] = part.value;
    }
  }
  return values;
}

/**
 * Saved values that still fit the box: inputs it still has, inside their
 * limits, and for a choice one of its options. Anything else falls back to
 * the model's own default rather than showing a number the box cannot reach.
 */
export function usableValues(spec: BoxSpec, saved: BoxValues | undefined): BoxValues {
  const values = defaultValues(spec);
  if (!saved) return values;
  for (const part of spec.parts) {
    if (!(part.kind === "stepper" || part.kind === "number" || part.kind === "choice")) continue;
    const value = saved[part.id];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (part.kind === "stepper" && (value < part.min || value > part.max)) continue;
    if (part.kind === "number" && ((part.min !== undefined && value < part.min) || (part.max !== undefined && value > part.max))) continue;
    if (part.kind === "choice" && !part.options.some((option) => option.value === value)) continue;
    values[part.id] = value;
  }
  return values;
}

/** Plain number for text: "6", "1,250.5". */
const inline = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function computeBox(spec: BoxSpec, values: BoxValues): ComputedBox {
  const scope = new Map<string, number>(Object.entries(values));
  const problems: BoxLineError[] = [];

  const fill = (template: BoxTemplate, line: number): string =>
    template
      .map((piece) => {
        if (typeof piece === "string") return piece;
        try {
          return inline(evaluateExpression(piece, scope));
        } catch (err) {
          if (!(err instanceof BoxExpressionError)) throw err;
          problems.push({ line, message: err.message });
          return "?";
        }
      })
      .join("");

  const blocks: BoxBlock[] = [];
  let note: string | null = null;
  const compare: ComputedCompare = { metrics: [], items: [] };
  let comparePlaced = false;

  for (const part of spec.parts) {
    switch (part.kind) {
      case "stepper":
      case "number":
      case "choice":
        blocks.push({ kind: "input", input: part, value: scope.get(part.id) ?? part.value });
        break;
      case "let":
        try {
          scope.set(part.id, evaluateExpression(part.expr, scope));
        } catch (err) {
          if (!(err instanceof BoxExpressionError)) throw err;
          problems.push({ line: part.line, message: err.message });
        }
        break;
      case "title":
        blocks.push({ kind: "title", text: fill(part.text, part.line) });
        break;
      case "row": {
        let value = "—";
        try {
          value = formatBoxValue(evaluateExpression(part.expr, scope), part.unit, part.places);
        } catch (err) {
          if (!(err instanceof BoxExpressionError)) throw err;
          problems.push({ line: part.line, message: err.message });
        }
        const row = { label: fill(part.label, part.line), value, emphasis: part.emphasis };
        const last = blocks[blocks.length - 1];
        if (last?.kind === "rows") last.rows.push(row);
        else blocks.push({ kind: "rows", rows: [row] });
        break;
      }
      case "metric":
      case "item":
        if (part.kind === "metric") compare.metrics.push(part);
        else compare.items.push(part);
        // The comparison draws where its first line was written.
        if (!comparePlaced) {
          blocks.push({ kind: "compare", compare });
          comparePlaced = true;
        }
        break;
      case "note":
        note = fill(part.text, part.line);
        break;
      default:
        break;
    }
  }

  const inputs = spec.parts.filter((p) => p.kind === "stepper" || p.kind === "number" || p.kind === "choice");
  return {
    blocks: blocks.filter((b) => b.kind !== "compare" || (b.compare.metrics.length > 0 && b.compare.items.length > 0)),
    note,
    problems,
    heroInput: inputs.length === 1 && inputs[0].kind === "stepper",
  };
}

/** Items in the order a metric ranks them: best first. Items missing it go last. */
export function rankItems(compare: ComputedCompare, metricId: string): ComputedCompare["items"] {
  const metric = compare.metrics.find((m) => m.id === metricId) ?? compare.metrics[0];
  if (!metric) return compare.items;
  const direction = metric.better === "low" ? 1 : -1;
  return [...compare.items].sort((a, b) => {
    const left = a.values[metric.id];
    const right = b.values[metric.id];
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return (left - right) * direction;
  });
}
