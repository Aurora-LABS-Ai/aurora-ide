/**
 * Agent Window — simple file list view [tool result].
 *
 * Flat list of files (e.g. a grep that returned filenames only, or a workspace
 * file listing). Re-themed with `--agw-*` + `AgentIcon`.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { FileIcon } from "@/kernel/ui/FileIcons";
import type { FileEntry } from "@/apps/agent/components/tool-views/tool-result";

export const FileListView: React.FC<{ files: FileEntry[] }> = ({ files }) => (
  <div className="agw-rv">
    <div className="agw-rv-head">
      <AgentIcon name="files" size={11} style={{ color: "var(--agw-text-subtle)" }} />
      <span className="agw-rv-title">Files</span>
      <span className="agw-rv-stats">
        <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
      </span>
    </div>
    <div className="agw-rv-body agw-scroll">
      {files.map((file, idx) => (
        <div key={`${file.path}-${idx}`} className="agw-tree-row">
          <span className="agw-tree-caret" />
          <FileIcon name={file.name} path={file.path} className="agw-file-ico" />
          <span className="agw-tree-name">{file.name}</span>
        </div>
      ))}
    </div>
  </div>
);
