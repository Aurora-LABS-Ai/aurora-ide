/**
 * Agent Window — glob view [tool result].
 *
 * Files matched by NAME, grouped by the directory they live in.
 *
 * Grep groups by file because a file holds many hits. Glob's unit already IS
 * the file, so the analogous grouping is by folder — which also answers the
 * question the tool was called to answer ("where does this live?") rather than
 * repeating the pattern back. A flat list of basenames would throw away the
 * only part of a match that is new information.
 *
 * Deliberately reuses the grep group chrome (`agw-grep-file-*`) and the tree's
 * row/footnote classes rather than minting new ones: the shapes are identical,
 * and `agent-window.css` is already large enough that a near-duplicate block
 * would cost more than the naming mismatch.
 */

import React, { useMemo } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { FileIcon, FolderIcon } from "../../../components/explorer/FileIcons";
import { baseName, type GlobData } from "./tool-result";

/** Directory portion of a workspace-relative path, `""` for a root-level file. */
function dirName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? "" : normalized.slice(0, cut);
}

export const GlobResultsView: React.FC<{ data: GlobData }> = ({ data }) => {
  const grouped = useMemo(() => {
    // Insertion order is preserved, and the tool returns newest-modified first,
    // so the folder a user has been working in naturally floats to the top.
    const map = new Map<string, string[]>();
    for (const file of data.files) {
      const dir = dirName(file);
      const list = map.get(dir) ?? [];
      list.push(file);
      map.set(dir, list);
    }
    return Array.from(map.entries());
  }, [data.files]);

  const shown = data.files.length;
  const total = data.total ?? shown;

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="search" size={11} style={{ color: "var(--agw-text-subtle)" }} />
        <span className="agw-rv-title">Found Files</span>
        {data.pattern && <span className="agw-rv-path">{data.pattern}</span>}
        <span className="agw-rv-stats">
          {/* "12 of 340" is the honest headline when the set was cut — a bare
              count reads as the complete answer. */}
          <span>
            {data.truncated && total > shown
              ? `${shown} of ${total.toLocaleString()} files`
              : `${total.toLocaleString()} ${total === 1 ? "file" : "files"}`}
          </span>
          {grouped.length > 1 && (
            <span>
              {grouped.length} {grouped.length === 1 ? "folder" : "folders"}
            </span>
          )}
        </span>
      </div>

      <div className="agw-rv-body agw-scroll">
        {shown === 0 ? (
          // An empty result is an answer, not a blank panel. The tool's own
          // note explains how to widen the search; this states the outcome.
          <div className="agw-grep-hit">
            <span className="agw-tree-name" style={{ color: "var(--agw-text-subtle)" }}>
              Nothing matched this pattern.
            </span>
          </div>
        ) : (
          grouped.map(([dir, files]) => (
            <div key={dir || "."} className="agw-grep-file">
              <div className="agw-grep-file-head">
                <FolderIcon name={baseName(dir) || "."} className="agw-file-ico" />
                <span className="agw-grep-file-name">{dir || "."}</span>
                <span className="agw-grep-file-count">{files.length}</span>
              </div>
              {files.map((file) => (
                <div key={file} className="agw-tree-row" title={file}>
                  <span className="agw-tree-caret" />
                  <FileIcon name={baseName(file)} path={file} className="agw-file-ico" />
                  <span className="agw-tree-name">{baseName(file)}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* The same sentence the model gets — if the list is partial, or empty
       *  with a hint about pattern syntax, the person reading should see it. */}
      {data.note && <p className="agw-tree-note">{data.note}</p>}
    </div>
  );
};
