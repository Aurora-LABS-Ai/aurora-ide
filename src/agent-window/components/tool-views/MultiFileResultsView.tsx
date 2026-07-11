/**
 * Agent Window — multi_file_read view [tool result].
 *
 * One row per file: a status glyph (read / failed), a file icon, the name, and a
 * line count or error. Re-themed with `--agw-*` + `AgentIcon`; no editor-open
 * wiring yet (the agent window has no Monaco), so rows are non-interactive.
 */

import React from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { FileIcon } from "../../../components/explorer/FileIcons";
import { baseName, type MultiFileEntry } from "./tool-result";

export const MultiFileResultsView: React.FC<{ files: MultiFileEntry[] }> = ({ files }) => (
  <div className="agw-rv">
    <div className="agw-rv-head">
      <AgentIcon name="diff" size={11} style={{ color: "var(--agw-text-subtle)" }} />
      <span className="agw-rv-title">Files Read</span>
      <span className="agw-rv-stats">
        <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
      </span>
    </div>
    <div className="agw-rv-body agw-scroll">
      {files.map((file, idx) => (
        <div key={`${file.path}-${idx}`} className="agw-tree-row" data-ok={file.success ? "true" : "false"}>
          <span className="agw-tree-caret">
            <AgentIcon
              name={file.success ? "check" : "close"}
              size={10}
              strokeWidth={2.6}
              style={{ color: file.success ? "var(--agw-added)" : "var(--agw-removed)" }}
            />
          </span>
          <FileIcon name={baseName(file.path)} path={file.path} className="agw-file-ico" />
          <span className="agw-tree-name">{baseName(file.path)}</span>
          <span className="agw-tree-meta">
            {file.success
              ? typeof file.lines === "number"
                ? `${file.lines.toLocaleString()} L`
                : ""
              : (file.error || "failed").slice(0, 40)}
          </span>
        </div>
      ))}
    </div>
  </div>
);
