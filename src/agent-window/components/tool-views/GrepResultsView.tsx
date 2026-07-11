/**
 * Agent Window — grep view [tool result].
 *
 * Matches grouped by file; each hit shown as `<line>  <content>`. Monospace, not
 * Shiki-highlighted (a hot grep with hundreds of hits would jank the thread).
 * Re-themed with `--agw-*` + `AgentIcon`.
 */

import React, { useMemo } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { FileIcon } from "../../../components/explorer/FileIcons";
import { baseName, type GrepData, type GrepMatch } from "./tool-result";

export const GrepResultsView: React.FC<{ data: GrepData }> = ({ data }) => {
  const grouped = useMemo(() => {
    const map = new Map<string, GrepMatch[]>();
    for (const m of data.matches) {
      // Guard against a malformed match with no `file` — an undefined map key
      // crashes the per-file render (baseName/split on undefined).
      const key = m.file || "(unknown file)";
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [data.matches]);

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="search" size={11} style={{ color: "var(--agw-text-subtle)" }} />
        <span className="agw-rv-title">Search Results</span>
        {data.pattern && <span className="agw-rv-path">{data.pattern}</span>}
        <span className="agw-rv-stats">
          <span>
            {data.totalMatches ?? data.matches.length} hits · {grouped.length} files
          </span>
          {data.truncated ? <span className="agw-rv-warn">truncated</span> : null}
        </span>
      </div>
      <div className="agw-rv-body agw-scroll">
        {grouped.map(([file, hits]) => (
          <div key={file} className="agw-grep-file">
            <div className="agw-grep-file-head">
              <FileIcon name={baseName(file)} path={file} className="agw-file-ico" />
              <span className="agw-grep-file-name">{baseName(file)}</span>
              <span className="agw-grep-file-count">{hits.length}</span>
            </div>
            {hits.map((m, idx) => (
              <div key={`${m.file}-${m.line}-${idx}`} className="agw-grep-hit">
                <span className="agw-grep-line">{m.line || ""}</span>
                <pre className="agw-grep-code">{m.content?.trim() || ""}</pre>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
