/**
 * Formulas in an answer box: `people * 400`, `ceil(people * 1.6)`,
 * `round(total * (1 + tip) / people, 2)`.
 *
 * A small arithmetic language parsed here and evaluated here. Never `eval`,
 * never `Function`: the text comes from a model, and the only things it can
 * name are the box's own inputs and the six functions below.
 */

export class BoxExpressionError extends Error {}

type Node =
  | { k: "num"; v: number }
  | { k: "ref"; name: string }
  | { k: "neg"; arg: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
  | { k: "call"; fn: string; args: Node[] };

export type Expression = Node;

type Token =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "(" | ")" | "," };

const FUNCTIONS: Record<string, { min: number; max: number; run: (args: number[]) => number }> = {
  round: {
    min: 1,
    max: 2,
    run: ([value, places = 0]) => {
      const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(places)));
      return Math.round(value * factor) / factor;
    },
  },
  ceil: { min: 1, max: 1, run: ([value]) => Math.ceil(value) },
  floor: { min: 1, max: 1, run: ([value]) => Math.floor(value) },
  abs: { min: 1, max: 1, run: ([value]) => Math.abs(value) },
  min: { min: 1, max: 32, run: (args) => Math.min(...args) },
  max: { min: 1, max: 32, run: (args) => Math.max(...args) },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

/**
 * Read as much of `text` from `start` as forms one formula, and say where it
 * stopped. A row's unit follows its formula on the same line
 * (`= people * 400 g`), so stopping at the first thing that cannot continue a
 * formula is the point, not an error.
 */
export function parseExpression(text: string, start = 0): { expr: Expression; end: number } {
  let i = start;
  // Tokenise lazily: only as far as a formula can reach.
  const readToken = (): (Token & { at: number; end: number }) | null => {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= text.length) return null;
    const at = i;
    const ch = text[i];
    if ((ch >= "0" && ch <= "9") || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const match = /^(?:\d[\d_]*)?(?:\.\d+)?/.exec(text.slice(i));
      const raw = match?.[0] ?? "";
      i += raw.length;
      return { t: "num", v: Number(raw.replace(/_/g, "")), at, end: i };
    }
    if (/[A-Za-z_]/.test(ch)) {
      const raw = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))![0];
      i += raw.length;
      return { t: "name", v: raw, at, end: i };
    }
    if ("+-*/(),".includes(ch)) {
      i += 1;
      return { t: "op", v: ch as "+", at, end: i };
    }
    return null;
  };
  let peeked: (Token & { at: number; end: number }) | null | undefined;
  const peek = () => {
    if (peeked === undefined) peeked = readToken();
    return peeked;
  };
  const next = () => {
    const token = peek();
    peeked = undefined;
    return token;
  };
  let consumed = start;

  const primary = (): Node => {
    const token = next();
    if (!token) throw new BoxExpressionError("the formula ends too early");
    consumed = token.end;
    if (token.t === "num") {
      if (!Number.isFinite(token.v)) throw new BoxExpressionError("a number could not be read");
      return { k: "num", v: token.v };
    }
    if (token.t === "name") {
      const after = peek();
      if (after?.t === "op" && after.v === "(") {
        next();
        consumed = after.end;
        const args: Node[] = [];
        const close = peek();
        if (!(close?.t === "op" && close.v === ")")) {
          for (;;) {
            args.push(additive());
            const sep = next();
            if (!sep) throw new BoxExpressionError(`${token.v}( is never closed`);
            consumed = sep.end;
            if (sep.t === "op" && sep.v === ")") break;
            if (!(sep.t === "op" && sep.v === ",")) {
              throw new BoxExpressionError(`expected "," or ")" in ${token.v}(…)`);
            }
          }
        } else {
          next();
          consumed = close.end;
        }
        const fn = FUNCTIONS[token.v];
        if (!fn) {
          throw new BoxExpressionError(
            `"${token.v}" is not a function here (there is ${FUNCTION_NAMES.join(", ")})`,
          );
        }
        if (args.length < fn.min || args.length > fn.max) {
          throw new BoxExpressionError(`${token.v}() takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} values`);
        }
        return { k: "call", fn: token.v, args };
      }
      return { k: "ref", name: token.v };
    }
    if (token.v === "(") {
      const inner = additive();
      const close = next();
      if (!(close?.t === "op" && close.v === ")")) throw new BoxExpressionError("a ( is never closed");
      consumed = close.end;
      return inner;
    }
    if (token.v === "-") return { k: "neg", arg: primary() };
    if (token.v === "+") return primary();
    throw new BoxExpressionError(`unexpected "${token.v}"`);
  };

  const multiplicative = (): Node => {
    let left = primary();
    for (;;) {
      const token = peek();
      if (!(token?.t === "op" && (token.v === "*" || token.v === "/"))) return left;
      next();
      left = { k: "bin", op: token.v, left, right: primary() };
    }
  };

  const additive = (): Node => {
    let left = multiplicative();
    for (;;) {
      const token = peek();
      if (!(token?.t === "op" && (token.v === "+" || token.v === "-"))) return left;
      next();
      left = { k: "bin", op: token.v, left, right: multiplicative() };
    }
  };

  const expr = additive();
  return { expr, end: consumed };
}

/** Every input or value a formula reads, so a box can check them before running it. */
export function referencedNames(expr: Expression, into: Set<string> = new Set()): Set<string> {
  switch (expr.k) {
    case "ref":
      into.add(expr.name);
      break;
    case "neg":
      referencedNames(expr.arg, into);
      break;
    case "bin":
      referencedNames(expr.left, into);
      referencedNames(expr.right, into);
      break;
    case "call":
      for (const arg of expr.args) referencedNames(arg, into);
      break;
    default:
      break;
  }
  return into;
}

/** Run a formula. Throws `BoxExpressionError` for an unknown name or a result that is not a number. */
export function evaluateExpression(expr: Expression, scope: ReadonlyMap<string, number>): number {
  const run = (node: Node): number => {
    switch (node.k) {
      case "num":
        return node.v;
      case "ref": {
        const value = scope.get(node.name);
        if (value === undefined) throw new BoxExpressionError(`nothing in this box is called "${node.name}"`);
        return value;
      }
      case "neg":
        return -run(node.arg);
      case "bin": {
        const left = run(node.left);
        const right = run(node.right);
        if (node.op === "+") return left + right;
        if (node.op === "-") return left - right;
        if (node.op === "*") return left * right;
        if (right === 0) throw new BoxExpressionError("divides by zero");
        return left / right;
      }
      case "call":
        return FUNCTIONS[node.fn].run(node.args.map(run));
      default:
        throw new BoxExpressionError("unknown formula");
    }
  };
  const result = run(expr);
  if (!Number.isFinite(result)) throw new BoxExpressionError("the result is not a number");
  return result;
}
