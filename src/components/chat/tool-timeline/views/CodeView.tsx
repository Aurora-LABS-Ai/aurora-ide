import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useThemeStore } from "../../../../store/useThemeStore";
import { extToShikiLang, useShikiTokens } from "../../useShikiTokens";
import { cn, unescapeContent } from "../helpers";
import { ExplorerFileAssetIcon } from "../ExplorerFileAssetIcon";

interface CodeViewProps {
  data?: boolean | number | object | string | null;
  error?: string;
  isStreaming?: boolean;
  fileName?: string;
  variant?: "added" | "removed" | "normal";
  hideHeader?: boolean;
}

/**
 * Shiki-highlighted code dropdown used by file_read / file_write /
 * search_replace and as the catch-all fallback when no rich renderer
 * matches. Streams scroll-to-bottom while `isStreaming` is true,
 * collapses to 8 lines until the user expands.
 */
export const CodeView: React.FC<CodeViewProps> = ({
  data,
  error,
  isStreaming,
  fileName,
  variant = "normal",
  hideHeader = false,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Active theme type drives the Shiki theme variant so a tool result
  // and a code fence inside the surrounding markdown render at the
  // same contrast. We don't subscribe to the whole `themes` array —
  // only the resolved type — so a theme switch is the only thing that
  // re-tokenizes.
  const themeVariant = useThemeStore((state) => {
    const active = state.themes.find((t) => t.id === state.activeThemeId);
    return active?.type === "light" ? ("light" as const) : ("dark" as const);
  });

  // Derive every input the hook needs *before* the early-return checks
  // below so the hook order stays stable across renders (rules of
  // hooks). When `data` is missing we feed the hook empty strings; it
  // short-circuits to `null` internally.
  const isStringData = typeof data === "string";
  const rawContent =
    data === null || data === undefined
      ? ""
      : isStringData
        ? (data as string)
        : JSON.stringify(data, null, 2);
  const content = unescapeContent(rawContent);
  const ext = fileName?.split(".").pop()?.toLowerCase() || "";
  const isCode = [
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "rs",
    "go",
    "css",
    "scss",
    "html",
    "json",
    "md",
  ].includes(ext);

  // Pick a Shiki language. Prefer the file extension; otherwise fall
  // back to JSON when the data is non-string (we already stringified
  // it above) or when the string content looks like JSON. Anything
  // else stays in plain-text mode — Shiki is opt-in, not forced.
  let shikiLang: string | null = ext ? extToShikiLang(ext) : null;
  if (!shikiLang) {
    if (!isStringData && content.length > 0) {
      shikiLang = "json";
    } else if (isStringData) {
      const trimmed = content.trimStart();
      if (
        (trimmed.startsWith("{") && content.trimEnd().endsWith("}")) ||
        (trimmed.startsWith("[") && content.trimEnd().endsWith("]"))
      ) {
        shikiLang = "json";
      }
    }
  }

  const highlightedLines = useShikiTokens(content, shikiLang, themeVariant);

  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [data, isStreaming]);

  if (error) {
    // Warm callout instead of a red alarm banner. The icon + heading
    // do the "this didn't work" work; the actual message renders in
    // text-primary so it reads as information rather than an
    // emergency. Surface uses the warning (amber) palette at low
    // opacity — same family as the "Didn't complete" pill upstream
    // so the whole failed card hangs together visually.
    return (
      <div className="mt-2 rounded-md border border-warning/25 bg-warning/[0.06] px-2.5 py-2">
        <div className="flex items-start gap-2">
          <AlertTriangle
            size={12}
            className="mt-0.5 flex-shrink-0 text-warning"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase tracking-wide text-warning/90">
              Tool didn't complete
            </div>
            <div className="mt-1 font-mono text-[10.5px] leading-[1.55] text-text-primary whitespace-pre-wrap break-words">
              {error}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!data && data !== 0 && data !== false) return null;

  const lines = content.split("\n");
  const isLongContent = lines.length > 8;
  const displayLines = isExpanded ? lines : lines.slice(0, 8);

  return (
    <div
      className={cn(
        "relative mt-2 group border rounded-md overflow-hidden transition-colors",
        variant === "added"
          ? "border-diff-added/20"
          : variant === "removed"
            ? "border-diff-removed/12"
            : "border-border/50",
      )}
    >
      {fileName && !hideHeader && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 border-b rounded-t-md",
            variant === "added"
              ? "bg-diff-added/10 border-diff-added/20 text-diff-added"
              : variant === "removed"
                ? "bg-diff-removed/[0.05] border-diff-removed/12 text-diff-removed/85"
                : "bg-code-block border-border/50 text-text-secondary",
          )}
        >
          <ExplorerFileAssetIcon
            fileName={fileName}
            className="w-3.5 h-3.5 flex-shrink-0 opacity-90"
          />
          <span className="text-[10.5px] font-mono tracking-tight">
            {fileName}
          </span>

          <div className="ml-auto flex items-center gap-1.5 ">
            {variant === "added" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-mono bg-diff-added/20 text-diff-added border border-diff-added/20">
                <span className="opacity-80">new</span>
                <span className="font-semibold">+{lines.length}</span>
              </span>
            )}
            {variant === "removed" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-mono bg-diff-removed/[0.08] text-diff-removed/85 border border-diff-removed/12">
                <span className="opacity-80">removed</span>
                <span className="font-semibold">-{lines.length}</span>
              </span>
            )}
            {variant === "normal" && (
              <span className="text-[9px] text-text-disabled">
                {lines.length} lines
              </span>
            )}
          </div>
        </div>
      )}

      <div
        ref={contentRef}
        style={{
          maxHeight: isExpanded ? "400px" : "180px",
          ...(variant === "removed"
            ? {
                backgroundImage:
                  "repeating-linear-gradient(-45deg, transparent, transparent 10px, color-mix(in srgb, currentColor 2%, transparent) 10px, color-mix(in srgb, currentColor 2%, transparent) 20px)",
              }
            : {}),
        }}
        className={cn(
          "font-mono text-[10.5px] leading-[1.65] overflow-y-auto overflow-x-auto scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent",
          !fileName || hideHeader ? "rounded-md" : "rounded-b-md",
          variant === "added"
            ? "bg-diff-added/[0.04] text-diff-added"
            : variant === "removed"
              ? "bg-diff-removed/[0.025] text-diff-removed/85"
              : "bg-code-block text-text-secondary",
        )}
      >
        <table className="w-full border-collapse">
          <tbody>
            {displayLines.map((line, idx) => {
              // Shiki returns one token-array per source line. When
              // available, render colorized tokens; otherwise fall
              // back to the raw line text. The fallback path matches
              // the pre-highlighting behaviour exactly, so a card
              // whose language we don't recognise (or whose result
              // exceeded the size cap) keeps looking the way it did
              // before this change.
              const tokens = highlightedLines?.[idx];
              return (
                <tr
                  key={idx}
                  className={cn(
                    "hover:bg-sidebar-item-hover transition-colors",
                    variant === "added" && "hover:bg-diff-added/10",
                    variant === "removed" && "hover:bg-diff-removed/[0.06]",
                  )}
                >
                  <td
                    className={cn(
                      "text-[9px] text-right pr-3 pl-2 py-0 select-none w-10 align-top border-r",
                      variant === "added"
                        ? "text-diff-added/50 border-diff-added/20"
                        : variant === "removed"
                          ? "text-diff-removed/45 border-diff-removed/12"
                          : "text-text-disabled/50 border-border/40",
                    )}
                  >
                    {idx + 1}
                  </td>
                  <td className="pl-3 pr-4 py-0">
                    <pre className="whitespace-pre-wrap break-all inline-block w-full">
                      <code
                        className={cn(
                          variant === "added"
                            ? "text-diff-added/90"
                            : variant === "removed"
                              ? "text-diff-removed/80"
                              : isCode
                                ? "text-text-primary"
                                : "text-text-secondary",
                        )}
                      >
                        {tokens && tokens.length > 0 ? (
                          tokens.map((tok, ti) => (
                            <span
                              key={ti}
                              style={
                                tok.color && variant === "normal"
                                  ? { color: tok.color }
                                  : undefined
                              }
                            >
                              {tok.content}
                            </span>
                          ))
                        ) : (
                          line || " "
                        )}
                      </code>
                    </pre>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isLongContent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className={cn(
            "w-full text-center text-[9.5px] py-1 border-t transition-colors",
            variant === "added"
              ? "bg-diff-added/10 border-diff-added/20 text-diff-added/70 hover:text-diff-added"
              : variant === "removed"
                ? "bg-diff-removed/[0.05] border-diff-removed/12 text-diff-removed/65 hover:text-diff-removed/85"
                : "bg-code-block border-border/50 text-text-disabled hover:text-text-primary",
          )}
        >
          {isExpanded ? "Show Less" : `Show ${lines.length - 8} More Lines`}
        </button>
      )}
    </div>
  );
};
