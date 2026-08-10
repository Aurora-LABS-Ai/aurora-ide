/**
 * Agent Window — markdown renderer [view].
 *
 * Assistant content is markdown (headings, lists, inline/fenced code with syntax
 * highlighting, links, GFM tables). This mirrors the IDE chat's proven engine —
 * `Streamdown` (react-markdown + Shiki) which tolerates INCOMPLETE markdown so a
 * half-streamed ``` fence doesn't flash as broken — but it is re-themed for the
 * agent window: the code-block chrome and inline code use `--agw-*` tokens (no
 * `--aurora-*` bleed), copy routes through the Tauri-safe clipboard helper, and
 * everything else is styled by the scoped `.agw-md` rules in agent-window.css.
 */

import React, { useCallback, useContext, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { writeClipboardText } from "@/kernel/lib/clipboard";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useSmoothReveal } from "@/apps/agent/hooks/conversation/useSmoothReveal";
import { selectActiveAgentTheme, useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

/** Recursively collect text from a react node tree (for code copy). */
function collectText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (React.isValidElement(node)) {
    return collectText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/**
 * True while rendering inside a fenced `<pre>` block. The `code` mapper needs
 * this because a fence with NO language tag also has no `language-*` class —
 * className alone can't tell it apart from real inline code, and wrapping a
 * whole block in the inline chip paints the chip background behind every line.
 */
const PreContext = React.createContext(false);

/** First `language-*` tag found in a fence's rendered tree (e.g. "tsx"). */
function findFenceLanguage(node: React.ReactNode): string | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findFenceLanguage(child);
      if (found) return found;
    }
    return null;
  }
  if (React.isValidElement(node)) {
    const props = node.props as { className?: string; children?: React.ReactNode };
    const match = props.className?.match(/language-([\w+#.-]+)/);
    if (match) return match[1];
    return findFenceLanguage(props.children);
  }
  return null;
}

/** Copy affordance for a fenced code block (reads text at click time). */
const CodeCopy: React.FC<{ getText: () => string }> = ({ getText }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    const text = getText();
    if (!text) return;
    const ok = await writeClipboardText(text);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [getText]);

  return (
    <button type="button" className="agw-code-copy" onClick={onCopy} title="Copy code">
      <AgentIcon name={copied ? "check" : "copy"} size={13} />
    </button>
  );
};

/** Fenced code block — header (language tag + copy) over the Shiki body. Must be
 *  a top-level component (not an inline fn in `components`) so its hooks are legal. */
const PreBlock: React.FC<React.HTMLAttributes<HTMLPreElement>> = ({ children }) => {
  const codeRef = useRef<HTMLPreElement>(null);
  const language = useMemo(() => findFenceLanguage(children) ?? "plain", [children]);
  const getText = useCallback(() => {
    const fromTree = collectText(children);
    if (fromTree.trim().length > 0) return fromTree;
    return codeRef.current?.textContent ?? "";
  }, [children]);

  return (
    <div className="agw-codeblock group/code">
      <div className="agw-codeblock-head">
        <span className="agw-codeblock-lang">{language}</span>
        <CodeCopy getText={getText} />
      </div>
      <pre ref={codeRef} className="agw-codeblock-pre agw-scroll">
        <PreContext.Provider value={true}>{children}</PreContext.Provider>
      </pre>
    </div>
  );
};

/** Inline vs block code. Anything inside a `<pre>` (language-tagged or not) is
 *  block code and renders bare; only true inline code gets the chip. */
const CodeEl: React.FC<React.HTMLAttributes<HTMLElement>> = ({
  className,
  children,
  ...props
}) => {
  const inPre = useContext(PreContext);
  if (inPre || className?.includes("language-")) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code className="agw-code-inline" {...props}>
      {children}
    </code>
  );
};

const components = {
  pre: PreBlock,
  code: CodeEl,

  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    // Team-chat @mentions arrive as `[@Name](#mention-<id>)` links (see
    // `team-ui.prettifyMentions`). They are identity chips, not navigation —
    // render a chip span, never an anchor.
    if (href?.startsWith("#mention-")) {
      return <span className="agw-mention-chip">{children}</span>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

const AgentMarkdownImpl: React.FC<{
  content: string;
  /** Live turn — enables Streamdown's incremental animation + incomplete parse. */
  streaming?: boolean;
}> = ({ content, streaming = false }) => {
  const appearance = useAgentThemeStore((s) => selectActiveAgentTheme(s).appearance);
  const syntaxOn = useAgentThemeStore((s) => s.syntaxHighlighting);

  // Stable tuple so Streamdown's internal memo isn't busted every render.
  const shikiTheme = useMemo<
    ["github-light", "github-light"] | ["github-dark", "github-dark"]
  >(
    () =>
      appearance === "light"
        ? ["github-light", "github-light"]
        : ["github-dark", "github-dark"],
    [appearance],
  );

  // Even out the bursty token stream into a steady, weighty reveal. Streamdown's
  // own per-token fade is turned OFF — this owns the motion instead.
  const revealed = useSmoothReveal(content, streaming);

  if (!content) return null;

  return (
    <div className={syntaxOn ? "agw-md" : "agw-md agw-syntax-off"}>
      <Streamdown
        isAnimating={false}
        shikiTheme={shikiTheme}
        components={components}
        // Drop Streamdown's built-in block controls: the download/copy bar it
        // overlays on tables (the stray icons + the phantom extra column) and on
        // code blocks (we render our own copy button via the custom `pre`).
        controls={{ table: false, code: false }}
      >
        {revealed}
      </Streamdown>
    </div>
  );
};

/**
 * Memoized: the transcript re-renders the whole ACTIVE turn on every streamed
 * frame, but only the newest content segment actually changes — every earlier
 * segment would otherwise re-run Streamdown (markdown parse + Shiki) per frame
 * for identical props. Props are a string + a bool, so the default shallow
 * compare is exact.
 */
export const AgentMarkdown = React.memo(AgentMarkdownImpl);
