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
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    if (!code || !lang) {
      setTokens(null);
      return;
    }
    if (code.length > MAX_HIGHLIGHT_BYTES) {
      setTokens(null);
      return;
    }
    // Quick line-count check before paying for tokenization.
    let approxLines = 0;
    for (let i = 0; i < code.length; i += 1) {
      if (code.charCodeAt(i) === 10 /* \n */) approxLines += 1;
      if (approxLines > MAX_HIGHLIGHT_LINES) break;
    }
    if (approxLines > MAX_HIGHLIGHT_LINES) {
      setTokens(null);
      return;
    }

    let cancelled = false;
    getHighlighter()
      .then((h) => {
        if (cancelled) return;
        try {
          // `lang` is constrained at the call site to values from our
          // `extToShikiLang` allow-list, which all map to bundled
          // languages we eagerly loaded above — but Shiki's signature
          // is keyed on the `BundledLanguage` literal union, so cast
          // here rather than widening the public API.
          const result = h.codeToTokens(code, {
            lang: lang as BundledLanguage,
            theme: (theme === "light"
              ? "github-light"
              : "github-dark") as BundledTheme,
          });
          if (!cancelled) setTokens(result.tokens);
        } catch {
          // Unknown language at runtime (shouldn't happen with our
          // allow-list, but be defensive): fall back to plain.
          if (!cancelled) setTokens(null);
        }
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  return tokens;
}
