/**
 * Agent Window — workspace_tree view [tool result].
 *
 * Recursive, expandable file tree for `workspace_tree`, re-themed with `--agw-*`
 * and `AgentIcon` (no lucide, no IDE import). Top two levels open by default so a
 * "show me the project" call is useful without clicking; deep trees stay inside a
 * fixed-height scroll area.
 */

import React, { useMemo, useState } from "react";

import { AgentIcon } from "../../shared/AgentIcon";
import { FileIcon, FolderIcon } from "../../../components/explorer/FileIcons";
import type { WorkspaceTreeData, WorkspaceTreeNode } from "./tool-result";

const TreeRow: React.FC<{ node: WorkspaceTreeNode; depth: number }> = ({
  node,
  depth,
}) => {
  const [open, setOpen] = useState(depth < 2);
  const isDir = node.type === "directory";
  const hasChildren = !!node.children && node.children.length > 0;

  return (
    <>
      <div
        className="agw-tree-row"
        data-dir={isDir ? "true" : undefined}
        style={{ paddingLeft: 8 + depth * 13 }}
        role={isDir && hasChildren ? "button" : undefined}
        onClick={() => {
          if (isDir && hasChildren) setOpen((p) => !p);
        }}
      >
        <span className="agw-tree-caret">
          {isDir && hasChildren ? (
            <AgentIcon
              name="chevron-down"
              size={11}
              style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .12s ease" }}
            />
          ) : null}
        </span>
        {isDir ? (
          <FolderIcon name={node.name} open={open && hasChildren} className="agw-file-ico" />
        ) : (
          <FileIcon name={node.name} path={node.path} className="agw-file-ico" />
        )}
        <span className={isDir ? "agw-tree-name agw-tree-name-dir" : "agw-tree-name"}>
          {node.name}
        </span>
        {node.artifact ? (
          <span className="agw-tree-meta" title="Build/dependency folder — contents not scanned">
            artifacts
          </span>
        ) : !isDir && typeof node.lineCount === "number" ? (
          <span className="agw-tree-meta">
            {node.lineCount.toLocaleString()} L{node.largeFile ? " ⚠" : ""}
          </span>
        ) : null}
      </div>
      {isDir && open && hasChildren
        ? node.children!.map((child, idx) => (
            <TreeRow key={`${child.path ?? child.name}-${idx}`} node={child} depth={depth + 1} />
          ))
        : null}
    </>
  );
};

export const WorkspaceTreeView: React.FC<{ data: WorkspaceTreeData }> = ({ data }) => {
  const totalNodes = useMemo(() => {
    let n = 0;
    const walk = (arr: WorkspaceTreeNode[]) => {
      for (const item of arr) {
        n += 1;
        if (item.children) walk(item.children);
      }
    };
    walk(data.tree);
    return n;
  }, [data.tree]);

  return (
    <div className="agw-rv">
      <div className="agw-rv-head">
        <AgentIcon name="files" size={11} style={{ color: "var(--agw-text-subtle)" }} />
        <span className="agw-rv-title">Workspace Tree</span>
        {data.rootPath && (
          <span className="agw-rv-path">{data.rootPath.split(/[/\\]/).slice(-3).join("/")}</span>
        )}
        <span className="agw-rv-stats">
          <span>{totalNodes} nodes</span>
          {data.stats?.filesSkipped ? <span className="agw-rv-warn">{data.stats.filesSkipped} skipped</span> : null}
        </span>
      </div>
      <div className="agw-rv-body agw-scroll">
        {data.tree.map((node, idx) => (
          <TreeRow key={`${node.path ?? node.name}-${idx}`} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
};
