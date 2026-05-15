import React from "react";
import type { WebSearchResultItem } from "../types";

interface WebSearchViewProps {
  action: "search" | "fetch" | string;
  query?: string;
  url?: string;
  results?: WebSearchResultItem[];
  fetchedTitle?: string;
  fetchedUrl?: string;
}

/**
 * Render `auroro_websearch` results. For `action="search"` we show a
 * list of result cards (title + URL + snippet). For `action="fetch"`
 * we show the page header (title + URL) and let the caller route the
 * body text through `CodeView` for proper truncation / scroll (the
 * body can be tens of KiB).
 */
export const WebSearchView: React.FC<WebSearchViewProps> = ({
  action,
  query,
  url,
  results,
  fetchedTitle,
  fetchedUrl,
}) => {
  const handleOpenUrl = async (target: string) => {
    // Same dynamic-import pattern as `FireworksSettingsTab` /
    // `LocalServerHeader` — `@tauri-apps/plugin-shell` is wired in
    // `lib.rs` (`tauri_plugin_shell::init()`). Fall back to the
    // browser's own opener when the call rejects (e.g. dev-server
    // running outside Tauri context).
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(target);
    } catch {
      window.open(target, "_blank", "noopener");
    }
  };

  const headline =
    action === "fetch"
      ? fetchedTitle || fetchedUrl || url || "Fetched page"
      : query || "Web search";

  return (
    <div className="mt-1 rounded-md border border-border/50 bg-code-block">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <span className="text-[10px] text-text-secondary uppercase tracking-wider">
          {action === "fetch" ? "Web Fetch" : "Web Search"}
        </span>
        <span className="truncate text-[10px] font-mono text-text-primary">
          {headline}
        </span>
        {results && (
          <span className="ml-auto text-[9px] text-text-disabled">
            {results.length} results
          </span>
        )}
      </div>
      {action === "search" && results && results.length > 0 && (
        <div className="max-h-[280px] overflow-y-auto py-1 scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent">
          {results.map((r, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => r.url && handleOpenUrl(r.url)}
              className="block w-full text-left px-3 py-1.5 hover:bg-sidebar-item-hover transition-colors border-b border-border/20 last:border-b-0"
            >
              <div className="truncate text-[10.5px] text-text-primary font-medium">
                {r.title || r.url || "(untitled)"}
              </div>
              {r.url && (
                <div className="truncate text-[9.5px] text-info/80 font-mono">
                  {r.url}
                </div>
              )}
              {(r.snippet || r.description) && (
                <div className="mt-0.5 line-clamp-2 text-[10px] text-text-secondary">
                  {r.snippet || r.description}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
      {action === "fetch" && fetchedUrl && (
        <div className="px-3 py-1.5">
          <button
            type="button"
            onClick={() => handleOpenUrl(fetchedUrl)}
            className="truncate text-[10px] text-info/80 hover:text-info underline-offset-2 hover:underline font-mono"
          >
            {fetchedUrl}
          </button>
        </div>
      )}
    </div>
  );
};
