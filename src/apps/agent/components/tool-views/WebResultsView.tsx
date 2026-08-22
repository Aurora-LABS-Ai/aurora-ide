/**
 * Agent Window — web view [tool result].
 *
 * Two shapes from one tool, so two panels sharing one head.
 *
 * **Results.** A ranked list. The title leads because it is what a reader
 * scans; the domain sits beside it because deciding whether to trust a result
 * is deciding where it came from, and a full URL buries that in path segments.
 * Each row opens in the reader's own browser — a list of sources you cannot
 * follow is a screenshot of a search, not a search.
 *
 * **A page.** The fetched document, rendered as Markdown through the same
 * component the conversation uses, so a heading looks like a heading and a code
 * block is highlighted. It is prose the reader may want to actually read, and
 * prose in a monospace dump is prose nobody reads.
 *
 * Chrome, spacing and scroll behaviour are the shared `agw-rv-*` classes every
 * other result view uses. Only the row itself is new, because a result row has
 * no analogue among the file-shaped views.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentMarkdown } from "@/apps/agent/components/conversation/AgentMarkdown";
import type { WebData } from "@/apps/agent/components/tool-views/tool-result";

/** Host without `www.`, which is noise in a column of domains. */
function hostLabel(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Open a link the way the rest of the agent window does: the system browser
 * through Tauri's shell plugin, falling back to `window.open` outside Tauri so
 * the same component still works in the test environment.
 */
async function openExternal(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** "12,400 characters", and what is left when the page did not fit. */
function readLength(data: WebData): string | null {
  if (data.totalChars === undefined) return null;
  const total = data.totalChars.toLocaleString();
  if (!data.hasMore) return `${total} characters`;
  const shown = (data.content ?? "").length.toLocaleString();
  return `${shown} of ${total} characters`;
}

/** `article` reads as jargon on a card; say what the reader is looking at. */
function kindLabel(kind: string | undefined): string | null {
  switch (kind) {
    case "article":
      return "Article";
    case "page":
      return "Full page";
    case "text":
      return "Text file";
    case "data":
      return "Data";
    case "unsupported":
      return "Not readable";
    default:
      return null;
  }
}

const SearchHits: React.FC<{ data: WebData }> = ({ data }) => {
  const hits = data.hits ?? [];
  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="search" size={11} style={{ color: "var(--agw-text-subtle)" }} />
        <span className="agw-rv-title">Web Search</span>
        {data.heading && <span className="agw-rv-path">{data.heading}</span>}
        <span className="agw-rv-stats">
          <span>
            {hits.length} {hits.length === 1 ? "result" : "results"}
          </span>
        </span>
      </div>

      <div className="agw-rv-body agw-scroll">
        {hits.length === 0 ? (
          // An empty search is an answer. Saying so beats an empty panel that
          // reads as a component that failed to render.
          <div className="agw-web-empty">No results came back for this search.</div>
        ) : (
          hits.map((hit) => (
            <button
              key={`${hit.rank}:${hit.url}`}
              type="button"
              className="agw-web-hit"
              title={hit.url}
              onClick={() => void openExternal(hit.url)}
            >
              <span className="agw-web-rank" aria-hidden="true">
                {hit.rank}
              </span>
              <span className="agw-web-hit-main">
                <span className="agw-web-hit-title">{hit.title}</span>
                <span className="agw-web-hit-host">{hit.displayUrl || hostLabel(hit.url)}</span>
                {hit.snippet && <span className="agw-web-hit-snippet">{hit.snippet}</span>}
              </span>
            </button>
          ))
        )}
      </div>

      {data.note && <p className="agw-tree-note">{data.note}</p>}
    </div>
  );
};

const FetchedPage: React.FC<{ data: WebData }> = ({ data }) => {
  const length = readLength(data);
  const kind = kindLabel(data.documentKind);
  const host = hostLabel(data.source);

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="web-page" size={11} style={{ color: "var(--agw-text-subtle)" }} />
        <span className="agw-rv-title">{data.heading || "Web Page"}</span>
        {data.source && (
          <button
            type="button"
            className="agw-web-source"
            title={data.source}
            onClick={() => void openExternal(data.source!)}
          >
            {host}
          </button>
        )}
        <span className="agw-rv-stats">
          {kind && <span>{kind}</span>}
          {length && <span>{length}</span>}
        </span>
      </div>

      {data.content ? (
        <div className="agw-rv-body agw-scroll agw-web-doc">
          <AgentMarkdown content={data.content} />
        </div>
      ) : (
        <div className="agw-rv-body">
          <div className="agw-web-empty">Nothing on this page could be read as text.</div>
        </div>
      )}

      {/* The page continues past what was read. Said plainly, because a reader
          who sees a document end mid-sentence otherwise assumes it broke. */}
      {data.hasMore && (
        <p className="agw-tree-note">
          This is the first part of the page. The agent can read on from here.
        </p>
      )}
      {data.note && <p className="agw-tree-note">{data.note}</p>}
    </div>
  );
};

export const WebResultsView: React.FC<{ data: WebData }> = ({ data }) =>
  data.kind === "search" ? <SearchHits data={data} /> : <FetchedPage data={data} />;
