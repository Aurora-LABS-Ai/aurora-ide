import React, { useMemo } from "react";
import { ExplorerFileAssetIcon } from "../ExplorerFileAssetIcon";
import { openFileInEditor } from "../open-file";
import type { GrepMatch } from "../types";

interface GrepResultsViewProps {
  matches: GrepMatch[];
  pattern?: string;
  totalMatches?: number;
  truncated?: boolean;
}

/**
 * Render `grep` output as one collapsible block per file, with each
 * hit shown as `<line-number>  <content>`. Hit content is rendered
 * monospace; we deliberately don't run Shiki on every hit line — a
 * hot grep returning 200 hits would tokenize 200 separate lines and
 * jank the main thread.
 */
export const GrepResultsView: React.FC<GrepResultsViewProps> = ({
  matches,
  pattern,
  totalMatches,
  truncated,
}) => {
  const grouped = useMemo(() => {
    const map = new Map<string, GrepMatch[]>();
    for (const m of matches) {
      const list = map.get(m.file) ?? [];
      list.push(m);
      map.set(m.file, list);
    }
    return Array.from(map.entries());
  }, [matches]);

  return (
    <div className="mt-1 rounded-md border border-border/50 bg-code-block">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <span className="text-[10px] text-text-secondary uppercase tracking-wider">
          Search Results
        </span>
        {pattern && (
          <span className="truncate text-[10px] font-mono text-text-primary">
            {pattern}
          </span>
        )}
        <span className="ml-auto text-[9px] text-text-disabled font-mono">
          {typeof totalMatches === "number" ? totalMatches : matches.length}{" "}
          hits · {grouped.length} files
          {truncated && (
            <span className="ml-1 text-warning/80">· truncated</span>
          )}
        </span>
      </div>
      <div className="max-h-[280px] overflow-y-auto overflow-x-auto scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent">
        {grouped.map(([file, fileMatches]) => {
          const fileName = file.split(/[/\\]/).pop() || file;
          return (
            <div key={file} className="border-b border-border/30 last:border-b-0">
              <div className="flex items-center gap-1.5 bg-input/30 px-3 py-1">
                <ExplorerFileAssetIcon
                  fileName={fileName}
                  path={file}
                  className="w-3 h-3 flex-shrink-0"
                />
                <span className="truncate text-[10px] text-text-primary font-mono">
                  {file}
                </span>
                <span className="ml-auto text-[9px] text-text-disabled">
                  {fileMatches.length}
                </span>
              </div>
              <div className="py-0.5">
                {fileMatches.map((m, idx) => (
                  <button
                    key={`${m.file}-${m.line_number}-${idx}`}
                    type="button"
                    onClick={() => openFileInEditor(m.file)}
                    className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-sidebar-item-hover transition-colors"
                  >
                    <span className="w-10 flex-shrink-0 text-right text-[9.5px] font-mono text-text-disabled tabular-nums">
                      {m.line_number}
                    </span>
                    <pre className="m-0 flex-1 overflow-hidden whitespace-pre text-[10.5px] font-mono text-text-secondary break-all">
                      {m.content?.trim() || ""}
                    </pre>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
