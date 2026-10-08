import React, { useMemo } from "react";

import {
  extToShikiLang,
  useShikiTokens,
  type ShikiThemeVariant,
} from "@/kernel/ui/useShikiTokens";
import {
  selectActiveAgentTheme,
  useAgentThemeStore,
} from "@/apps/agent/store/ui/useAgentThemeStore";
import { useProgressiveCount } from "@/apps/agent/components/tool-views/useProgressiveCount";

function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Above this size, tokenizing blocks the renderer long enough to jank the
 * whole window (and layout churn on that scale is what aggravates the
 * WebView2 crash) — mirror the editor's medium-file rule and fall back to
 * plaintext. Multi-file reads pass FULL file contents through here, so this
 * is a real path, not an edge case.
 */
const HIGHLIGHT_MAX_CHARS = 50_000;

export const ToolCode: React.FC<{ code: string; path: string | null }> = ({
  code,
  path,
}) => {
  const appearance = useAgentThemeStore((state) => selectActiveAgentTheme(state).appearance);
  const syntaxOn = useAgentThemeStore((state) => state.syntaxHighlighting);
  const variant: ShikiThemeVariant = appearance === "light" ? "light" : "dark";
  const language = useMemo(
    () =>
      syntaxOn && path && code.length <= HIGHLIGHT_MAX_CHARS
        ? extToShikiLang(extensionOf(path))
        : null,
    [syntaxOn, path, code],
  );
  const tokens = useShikiTokens(code, language, variant);
  // Coloured lines are a span per token; build the first screenful at once and
  // the rest after the card's opening motion. Until then the rest is one plain
  // text run, so the box's content — and its height — is complete throughout.
  const shown = useProgressiveCount(tokens?.length ?? 0);
  const rest = useMemo(
    () => (tokens && shown < tokens.length ? code.split("\n").slice(shown).join("\n") : ""),
    [tokens, shown, code],
  );

  if (!tokens) {
    return <pre className="agw-code agw-scroll agw-tool-result">{code}</pre>;
  }

  return (
    <pre className="agw-code agw-scroll agw-tool-result">
      <code>
        {tokens.slice(0, shown).map((line, lineIndex) => (
          <span key={lineIndex} className="agw-code-line">
            {line.length === 0 ? (
              "\n"
            ) : (
              <>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
                {"\n"}
              </>
            )}
          </span>
        ))}
        {rest && <span className="agw-code-line">{rest}</span>}
      </code>
    </pre>
  );
};
