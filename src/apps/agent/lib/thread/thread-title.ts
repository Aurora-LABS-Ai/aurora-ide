/**
 * Title derivation for chat threads.
 *
 * Mirrors the Rust implementation in `src-tauri/src/threads/title.rs` so the
 * UI can produce the same clean preview the backend will eventually persist —
 * eliminating the flash of raw user input (with code fences, JSON blobs, etc.)
 * in the chat list while we wait for the `thread-event-appended` event.
 *
 * Pipeline (each stage is small enough to reason about and unit-test):
 *
 *   1. stripFencedCodeBlocks  — drop ``` … ``` and ~~~ … ~~~ regions.
 *   2. stripInlineCode        — replace short `foo` with `foo`; drop long ones.
 *   3. stripJsonBlobs         — drop standalone JSON-looking lines.
 *   4. collapseWhitespace     — fold whitespace runs to single spaces.
 *   5. trimDecorativeChars    — trim surrounding markdown/punctuation noise.
 *   6. truncateToTitle        — word-cap then char-cap with ellipsis.
 *
 * If everything strips away (e.g. the message was *only* a code block), the
 * fallback `New Chat` is returned. Pure UTF-16 safe — no regex dependencies.
 */

export const MAX_TITLE_WORDS = 8;
export const MAX_TITLE_CHARS = 60;
export const FALLBACK_TITLE = "New Chat";

const MAX_INLINE_CODE_KEEP_LEN = 30;
const ELLIPSIS = "\u2026";

/**
 * Derive a clean thread title from a raw user message.
 * Returns {@link FALLBACK_TITLE} when the message is empty or contains only
 * stripped material.
 */
export function deriveThreadTitle(message: string): string {
  if (!message || !message.trim()) return FALLBACK_TITLE;

  const stage1 = stripFencedCodeBlocks(message);
  const stage2 = stripInlineCode(stage1);
  const stage3 = stripJsonBlobs(stage2);
  const stage4 = collapseWhitespace(stage3);
  const stage5 = trimDecorativeChars(stage4);

  if (!stage5) return FALLBACK_TITLE;

  return truncateToTitle(stage5, MAX_TITLE_WORDS, MAX_TITLE_CHARS);
}

// ============================================================================
// STAGE 1 — fenced code blocks
// ============================================================================

export function stripFencedCodeBlocks(s: string): string {
  const out: string[] = [];
  let fence: "`" | "~" | null = null;
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.replace(/^[ \t]+/, "");
    if (fence) {
      if (lineIsFence(trimmed, fence)) fence = null;
      continue;
    }
    if (lineIsFence(trimmed, "`")) {
      fence = "`";
      continue;
    }
    if (lineIsFence(trimmed, "~")) {
      fence = "~";
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function lineIsFence(line: string, ch: "`" | "~"): boolean {
  return line.length >= 3 && line[0] === ch && line[1] === ch && line[2] === ch;
}

// ============================================================================
// STAGE 2 — inline code
// ============================================================================

export function stripInlineCode(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== "`") {
      out += c;
      i += 1;
      continue;
    }
    // Walk to the next backtick.
    let j = i + 1;
    let buf = "";
    while (j < s.length && s[j] !== "`") {
      buf += s[j];
      j += 1;
    }
    if (j >= s.length) {
      // Unmatched — keep verbatim.
      out += "`" + buf;
      i = j;
      continue;
    }
    const len = buf.length;
    if (len > 0 && len <= MAX_INLINE_CODE_KEEP_LEN) {
      out += buf;
    } else {
      out += " ";
    }
    i = j + 1;
  }
  return out;
}

// ============================================================================
// STAGE 3 — bare JSON blobs
// ============================================================================

/**
 * Strip JSON-looking regions, both single-line and multi-line.
 *
 * Strategy: a tiny state machine that tracks brace/bracket depth across
 * lines, ignoring braces inside string literals. We enter "json mode" when
 * a line either:
 *   - is *only* `{` or `[` (classic multi-line opener), or
 *   - starts with `{`/`[` AND contains a `"` or `:` (single-line JSON-ish).
 * We exit when brace depth returns to zero.
 *
 * Lines outside JSON mode pass through unchanged. This keeps prose like
 * "Wrap this in {curly braces}" intact while stripping pasted config blobs.
 */
export function stripJsonBlobs(s: string): string {
  const out: string[] = [];
  let inBlock = false;
  let depth = 0;
  for (const line of s.split(/\r?\n/)) {
    const trim = line.trim();

    if (!inBlock) {
      const startsBrace = trim.startsWith("{") || trim.startsWith("[");
      // Lone opener (e.g. `{`) — definitely the start of a multi-line blob.
      const isLoneOpener = trim === "{" || trim === "[";
      // Single-line JSON-ish: starts with brace AND has quote/colon.
      const looksJson =
        startsBrace && (line.includes('"') || trim.includes(":"));

      if (!isLoneOpener && !looksJson) {
        out.push(line);
        continue;
      }

      const balance = braceBalance(line);
      if (balance <= 0) {
        // Self-contained on one line — drop and continue.
        continue;
      }
      // Opener of a multi-line region.
      inBlock = true;
      depth = balance;
      continue;
    }

    depth += braceBalance(line);
    if (depth <= 0) {
      inBlock = false;
      depth = 0;
    }
    // In-block lines are dropped regardless.
  }
  return out.join("\n");
}

/**
 * Net brace/bracket depth change across the line, ignoring characters
 * inside string literals (handles backslash escapes).
 */
function braceBalance(line: string): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return depth;
}

// ============================================================================
// STAGE 4 — whitespace folding
// ============================================================================

export function collapseWhitespace(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

// ============================================================================
// STAGE 5 — decorative chars
// ============================================================================

const DECORATIVE_CHARS = new Set<string>([
  "#",
  ">",
  "<",
  "*",
  "-",
  "=",
  "_",
  "~",
  "`",
  '"',
  "'",
  "\u201C",
  "\u201D",
  "\u2018",
  "\u2019",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  "\\",
  "/",
  ",",
  ".",
  ":",
  ";",
  "!",
  "?",
]);

function isStripChar(c: string): boolean {
  return /\s/.test(c) || DECORATIVE_CHARS.has(c);
}

export function trimDecorativeChars(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isStripChar(s[start])) start += 1;
  while (end > start && isStripChar(s[end - 1])) end -= 1;
  return s.slice(start, end);
}

// ============================================================================
// STAGE 6 — truncation
// ============================================================================

export function truncateToTitle(
  s: string,
  maxWords: number,
  maxChars: number,
): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  let truncated = words.length > maxWords;
  let joined = words.slice(0, maxWords).join(" ");

  // Use Array.from for codepoint-aware char counting (handles surrogate pairs
  // and combining marks the same way the Rust .chars() iterator does).
  const charArr = Array.from(joined);
  if (charArr.length > maxChars) {
    truncated = true;
    const target = Math.max(1, maxChars - 1);
    let cut = charArr.slice(0, target).join("");
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
    joined = cut.replace(/[\s,.:;\-\u2014\u2013]+$/u, "");
  }

  if (truncated) joined += ELLIPSIS;
  return joined;
}
