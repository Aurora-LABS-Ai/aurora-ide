import React, { useMemo } from "react";

import {
  extToShikiLang,
  useShikiTokens,
  type ShikiThemeVariant,
} from "../../../components/chat/useShikiTokens";
import {
  selectActiveAgentTheme,
  useAgentThemeStore,
} from "../../store/useAgentThemeStore";

function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export const ToolCode: React.FC<{ code: string; path: string | null }> = ({
  code,
  path,
}) => {
  const appearance = useAgentThemeStore((state) => selectActiveAgentTheme(state).appearance);
  const syntaxOn = useAgentThemeStore((state) => state.syntaxHighlighting);
  const variant: ShikiThemeVariant = appearance === "light" ? "light" : "dark";
  const language = useMemo(
    () => (syntaxOn && path ? extToShikiLang(extensionOf(path)) : null),
    [syntaxOn, path],
  );
  const tokens = useShikiTokens(code, language, variant);

  if (!tokens) {
    return <pre className="agw-code agw-scroll agw-tool-result">{code}</pre>;
  }

  return (
    <pre className="agw-code agw-scroll agw-tool-result">
      <code>
        {tokens.map((line, lineIndex) => (
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
      </code>
    </pre>
  );
};
