/**
 * Agent Window — minimal ANSI/SGR renderer (leaf, non-component).
 *
 * Shell tools return raw terminal output; linters, test runners and git all
 * colorize via ANSI escapes. This turns that byte stream into styled spans for
 * the shell card instead of leaking `\x1b[31m` noise into a plain <pre>.
 *
 * Scope is deliberately narrow: SGR (`…m`) sequences style text; every other
 * CSI/OSC sequence is stripped. Backgrounds are intentionally ignored — a
 * block of colored background inside a quiet tool card reads as damage, and
 * foreground + weight carries all the real signal.
 */

export interface AnsiSpan {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** Fast pre-check so ANSI-free output (the common case) skips parsing. */
export function hasAnsi(text: string): boolean {
  return text.includes(ESC);
}

/**
 * The 16 base colors, tuned to stay legible on BOTH theme appearances (pure
 * black/white terminal values vanish against the card surfaces). Themes may
 * override via `--agw-ansi-*`; the literal is the fallback.
 */
const BASE_COLORS: readonly string[] = [
  "var(--agw-ansi-black, #6c7086)",
  "var(--agw-ansi-red, #e5484d)",
  "var(--agw-ansi-green, #46a758)",
  "var(--agw-ansi-yellow, #c19a2e)",
  "var(--agw-ansi-blue, #4f80ff)",
  "var(--agw-ansi-magenta, #b667e0)",
  "var(--agw-ansi-cyan, #12a5b8)",
  "var(--agw-ansi-white, #a8aeb8)",
];

const BRIGHT_COLORS: readonly string[] = [
  "var(--agw-ansi-bright-black, #7f849c)",
  "var(--agw-ansi-bright-red, #ff6369)",
  "var(--agw-ansi-bright-green, #55c065)",
  "var(--agw-ansi-bright-yellow, #d3ad3e)",
  "var(--agw-ansi-bright-blue, #6f95ff)",
  "var(--agw-ansi-bright-magenta, #cc85f0)",
  "var(--agw-ansi-bright-cyan, #2ec8db)",
  "var(--agw-ansi-bright-white, #d8dde5)",
];

function xterm256(n: number): string {
  if (n < 0 || n > 255) return "";
  if (n < 8) return BASE_COLORS[n];
  if (n < 16) return BRIGHT_COLORS[n - 8];
  if (n < 232) {
    const cube = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    const r = level(Math.floor(cube / 36));
    const g = level(Math.floor(cube / 6) % 6);
    const b = level(cube % 6);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const gray = 8 + 10 * (n - 232);
  return `rgb(${gray}, ${gray}, ${gray})`;
}

interface SgrState {
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      delete state.color;
      delete state.bold;
      delete state.dim;
      delete state.italic;
      delete state.underline;
    } else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 22) {
      delete state.bold;
      delete state.dim;
    } else if (p === 23) delete state.italic;
    else if (p === 24) delete state.underline;
    else if (p >= 30 && p <= 37) state.color = BASE_COLORS[p - 30];
    else if (p === 39) delete state.color;
    else if (p >= 90 && p <= 97) state.color = BRIGHT_COLORS[p - 90];
    else if (p === 38 || p === 48) {
      // Extended color — consume its arguments even for backgrounds (48),
      // which are dropped, so following params don't misparse.
      const mode = params[i + 1];
      if (mode === 5) {
        if (p === 38) {
          const c = xterm256(params[i + 2] ?? -1);
          if (c) state.color = c;
        }
        i += 2;
      } else if (mode === 2) {
        if (p === 38) {
          const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
          if ([r, g, b].every((v) => typeof v === "number" && v >= 0 && v <= 255)) {
            state.color = `rgb(${r}, ${g}, ${b})`;
          }
        }
        i += 4;
      }
    }
    // 40-47 / 100-107 (backgrounds) and everything else: ignored.
  }
}

/**
 * Parse text with ANSI escapes into styled spans. Non-SGR CSI sequences and
 * OSC sequences (window title etc.) are consumed silently; a truncated escape
 * at the end of the buffer is dropped rather than leaked as raw bytes.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const state: SgrState = {};
  let plain = "";

  const flush = () => {
    if (!plain) return;
    spans.push({ text: plain, ...state });
    plain = "";
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== ESC) {
      plain += char;
      continue;
    }
    const kind = text[i + 1];
    if (kind === "[") {
      // CSI: parameters then a final byte in @–~.
      let j = i + 2;
      while (j < text.length && !/[@-~]/.test(text[j])) j++;
      if (j >= text.length) break; // truncated escape at buffer end
      if (text[j] === "m") {
        flush();
        const params = text
          .slice(i + 2, j)
          .split(";")
          .map((v) => (v === "" ? 0 : Number.parseInt(v, 10)))
          .filter((v) => Number.isFinite(v));
        applySgr(state, params.length > 0 ? params : [0]);
      }
      i = j;
    } else if (kind === "]") {
      // OSC: runs to BEL or ST (ESC \).
      let j = i + 2;
      while (j < text.length && text[j] !== BEL) {
        if (text[j] === ESC && text[j + 1] === "\\") {
          j++;
          break;
        }
        j++;
      }
      i = Math.min(j, text.length - 1);
    } else if (kind !== undefined) {
      // Bare two-byte escape (ESC + one char): consume both.
      i += 1;
    }
  }
  flush();
  return spans;
}

/** Plain text with every ANSI escape removed (for summaries / clipboard). */
export function stripAnsi(text: string): string {
  if (!hasAnsi(text)) return text;
  return parseAnsi(text)
    .map((span) => span.text)
    .join("");
}
