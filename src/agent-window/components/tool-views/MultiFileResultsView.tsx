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
import { ToolCode } from "./ToolCode";

export const MultiFileResultsView: React.FC<{ files: MultiFileEntry[] }> = ({ files }) => {
  const hasContent = files.some((file) => file.content !== undefined);

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="diff" size={11} style={{ color: "var(--agw-text-subtle)" }} />
        <span className="agw-rv-title">Files Read</span>
        <span className="agw-rv-stats">
          <span>
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </span>
      </div>
      {hasContent ? (
        <div className="agw-multi-diff agw-multi-read">
          {files.map((file, index) => (
            <div className="agw-multi-diff-file" key={`${file.path}-${index}`}>
              <div className="agw-multi-diff-head">
                <FileIcon
                  name={baseName(file.path)}
                  path={file.path}
                  className="agw-file-ico"
                />
                <span>{baseName(file.path)}</span>
                {typeof file.lines === "number" && (
                  <span className="agw-tree-meta">{file.lines.toLocaleString()} L</span>
                )}
              </div>
              {file.content !== undefined ? (
                <ToolCode code={file.content} path={file.fullPath ?? file.path} />
              ) : (
                <div className="agw-multi-read-error">
                  {file.error || "This file could not be read."}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="agw-rv-body agw-scroll">
          {files.map((file, index) => (
            <div
              key={`${file.path}-${index}`}
              className="agw-tree-row"
              data-ok={file.success ? "true" : "false"}
            >
              <span className="agw-tree-caret">
                <AgentIcon
                  name={file.success ? "check" : "close"}
                  size={10}
                  strokeWidth={2.6}
                  style={{
                    color: file.success ? "var(--agw-added)" : "var(--agw-removed)",
                  }}
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
      )}
    </div>
  );
};
