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

import React, { useCallback, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { writeClipboardText } from "../../lib/clipboard";
import { AgentIcon } from "../shared/AgentIcon";
import { useSmoothReveal } from "../hooks/useSmoothReveal";
import { selectActiveAgentTheme, useAgentThemeStore } from "../store/useAgentThemeStore";

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

/** Fenced code block — themed wrapper + Shiki-highlighted body + copy. Must be a
 *  top-level component (not an inline fn in `components`) so its hooks are legal. */
const PreBlock: React.FC<React.HTMLAttributes<HTMLPreElement>> = ({ children }) => {
  const codeRef = useRef<HTMLPreElement>(null);
  const getText = useCallback(() => {
    const fromTree = collectText(children);
    if (fromTree.trim().length > 0) return fromTree;
    return codeRef.current?.textContent ?? "";
  }, [children]);

  return (
    <div className="agw-codeblock group/code">
      <CodeCopy getText={getText} />
      <pre ref={codeRef} className="agw-codeblock-pre agw-scroll">
        {children}
      </pre>
    </div>
  );
};

const components = {
  pre: PreBlock,

  // Inline vs block code. Block code (inside <pre>) carries `language-*` and
  // already has Shiki colour on its spans, so we only set the family. Inline
  // code gets the agw chip treatment.
  code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) => {
    if (className?.includes("language-")) {
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
  },

  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
};

export const AgentMarkdown: React.FC<{
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
