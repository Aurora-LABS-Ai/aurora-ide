/**
 * Shared Shiki tokenizer for the chat tool-result `CodeView`.
 *
 * The chat already loads `shiki` for the agent's markdown code blocks
 * (via `Streamdown` in `MarkdownRenderer`). We reuse the same theme set
 * (`github-dark` / `github-light`) so a tool-result card and a code
 * fence inside the same thinking block look identical.
 *
 * Lazy singleton policy:
 * - The highlighter is built on first call and shared across every
 *   tool card for the rest of the session. Subsequent tool results
 *   reuse the same WASM instance — no per-card cold-start.
 * - Languages are loaded eagerly when the highlighter is created so a
 *   bursting agent (10 tool cards in 200 ms) does not produce 10
 *   parallel `loadLanguage` requests.
 *
 * Cancellation: every call site uses a `cancelled` flag in its
 * `useEffect` cleanup so unmounting a card mid-tokenize doesn't try
 * to set state on a dead component.
 */
import { useEffect, useState } from "react";
import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
  type ThemedToken,
} from "shiki";

/**
 * Languages loaded into the highlighter at boot. Picked to cover the
 * common file types Aurora agents touch: web stack, systems languages
 * (the screenshot that motivated this work was a C++ project), and
 * the boring formats (JSON / YAML / Markdown / shell). Anything not
 * in this list falls back to plain text rendering — no per-token
 * lazy-load, which would stutter on each new extension.
 */
const SHIKI_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "rust",
  "go",
  "cpp",
  "c",
  "csharp",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "php",
  "lua",
  "bash",
  "shellscript",
  "sql",
  "css",
  "scss",
  "less",
  "html",
  "xml",
  "json",
  "jsonc",
  "yaml",
  "toml",
  "markdown",
  "dockerfile",
  "ini",
  "objective-c",
  "haskell",
  "elixir",
] as const;

const SHIKI_THEMES = ["github-dark", "github-light"] as const;

/**
 * Cap on how big a tool result we will tokenize. Shiki's tokenizer is
 * fast but not free — past ~3000 lines you start seeing main-thread
 * jank, especially for verbose languages like C++. Above the cap we
 * fall back to the plain-text rendering the component already does.
 */
const MAX_HIGHLIGHT_LINES = 3000;
const MAX_HIGHLIGHT_BYTES = 256 * 1024; // 256 KiB

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: SHIKI_THEMES as unknown as string[],
      langs: SHIKI_LANGS as unknown as string[],
    }).catch((err) => {
      // Reset so a transient failure doesn't poison the singleton.
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

/**
 * Map a file extension (already lowercased, without the leading dot)
 * to the Shiki language id we registered. Returns `null` when the
 * extension is unknown — callers fall back to plain rendering rather
 * than misclassifying a binary blob as JavaScript.
 */
export function extToShikiLang(ext: string): string | null {
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
    case "h":
      return "cpp";
    case "c":
      return "c";
    case "cs":
      return "csharp";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "swift":
      return "swift";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "lua":
      return "lua";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "sql":
      return "sql";
    case "css":
      return "css";
    case "scss":
    case "sass":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
      return "html";
    case "xml":
    case "svg":
      return "xml";
    case "json":
      return "json";
    case "jsonc":
      return "jsonc";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "md":
    case "mdx":
      return "markdown";
    case "ini":
    case "cfg":
    case "conf":
      return "ini";
    case "m":
    case "mm":
      return "objective-c";
    case "hs":
      return "haskell";
    case "ex":
    case "exs":
      return "elixir";
    case "dockerfile":
      return "dockerfile";
    default:
      return null;
  }
}

/** Theme variant Shiki should render with. */
export type ShikiThemeVariant = "dark" | "light";

/**
 * Tokenize `code` with the given Shiki language into an array of
 * lines, each line being an array of styled tokens. Returns `null`
 * while the highlighter is still booting or when the input falls
 * outside the size cap (in which case the caller should render the
 * plain text it already has).
 *
 * The hook recomputes whenever `code`, `lang`, or `theme` changes,
 * and aborts in-flight work in the cleanup so a fast scroll past a
 * still-tokenizing card doesn't set state on the dead component.
 */
export function useShikiTokens(
  code: string | null | undefined,
  lang: string | null,
  theme: ShikiThemeVariant,
): ThemedToken[][] | null {
  const key = code && lang && highlightable(code) ? cacheKey(code, lang, theme) : null;
  // Stamped with the input it answers, so a changed input never shows the
  // previous one's colours. A cached answer is read during render: a card
  // reopened, or warmed on hover, is coloured on its first frame.
  const [result, setResult] = useState<{ key: string | null; tokens: ThemedToken[][] | null }>(
    () => ({ key, tokens: key ? cacheGet(key) : null }),
  );

  useEffect(() => {
    if (!key || !code || !lang) return;
    if (cacheGet(key)) return;
    let cancelled = false;
    void tokenize(code, lang, theme).then((tokens) => {
      if (!cancelled) setResult({ key, tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [key, code, lang, theme]);

  if (!key) return null;
  return result.key === key ? result.tokens : cacheGet(key);
}

// ── Tokenizing off the critical frames ─────────────────────────────────
//
// `codeToTokens` is synchronous and, for a few thousand lines, long enough to
// drop frames. It used to run in the microtask right after a card mounted —
// which is exactly when the card's opening animation runs — and again on every
// reopen. Now: answers are cached, work is scheduled for idle time, and a
// caller that knows a card is about to open (the pointer is on it) can start
// the work early with `warmShikiTokens`.

const TOKEN_CACHE_MAX = 24;
const tokenCache = new Map<string, ThemedToken[][]>();
const inflight = new Map<string, Promise<ThemedToken[][] | null>>();

function cacheKey(code: string, lang: string, theme: ShikiThemeVariant): string {
  return `${theme}\u0000${lang}\u0000${code}`;
}

function cacheGet(key: string): ThemedToken[][] | null {
  const hit = tokenCache.get(key);
  if (!hit) return null;
  // Most recently used last, so eviction takes the oldest.
  tokenCache.delete(key);
  tokenCache.set(key, hit);
  return hit;
}

function cachePut(key: string, tokens: ThemedToken[][]): void {
  tokenCache.set(key, tokens);
  while (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest === undefined) break;
    tokenCache.delete(oldest);
  }
}

/** Inside the size caps a highlight is allowed to cost. */
function highlightable(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_BYTES) return false;
  let lines = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 10 /* \n */) lines += 1;
    if (lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return true;
}

/** Run `work` when the renderer is idle (bounded, so it always runs). */
function whenIdle<T>(work: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      try {
        resolve(work());
      } catch (err) {
        reject(err);
      }
    };
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(run, { timeout: 400 });
    else setTimeout(run, 30);
  });
}

function tokenize(
  code: string,
  lang: string,
  theme: ShikiThemeVariant,
): Promise<ThemedToken[][] | null> {
  const key = cacheKey(code, lang, theme);
  const cached = cacheGet(key);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(key);
  if (running) return running;
  const job = getHighlighter()
    .then((h) =>
      whenIdle(() => {
        // `lang` is constrained at the call site to values from our
        // `extToShikiLang` allow-list, which all map to bundled languages we
        // eagerly loaded above — but Shiki's signature is keyed on the
        // `BundledLanguage` literal union, so cast here rather than widening
        // the public API.
        const result = h.codeToTokens(code, {
          lang: lang as BundledLanguage,
          theme: (theme === "light" ? "github-light" : "github-dark") as BundledTheme,
        });
        cachePut(key, result.tokens);
        return result.tokens;
      }),
    )
    // Unknown language at runtime (shouldn't happen with our allow-list) or a
    // highlighter that failed to boot: the caller renders plain text.
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/**
 * Start colouring `code` before it is shown, so the view that shows it has its
 * colours on the first frame. For a card the pointer has just reached. Free
 * when the answer is already cached or the input is past the caps.
 */
export function warmShikiTokens(
  code: string | null | undefined,
  lang: string | null,
  theme: ShikiThemeVariant,
): void {
  if (!code || !lang || !highlightable(code)) return;
  void tokenize(code, lang, theme);
}
