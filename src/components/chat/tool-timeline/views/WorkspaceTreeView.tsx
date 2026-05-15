import React, { useMemo, useState } from "react";
import { Folder, LayoutGrid } from "lucide-react";
import { cn } from "../helpers";
import { ExplorerFileAssetIcon } from "../ExplorerFileAssetIcon";
import type { WorkspaceTreeNode, WorkspaceTreeStats } from "../types";

interface WorkspaceTreeViewProps {
  rootPath?: string;
  tree: WorkspaceTreeNode[];
  stats?: WorkspaceTreeStats;
}

const WorkspaceTreeRow: React.FC<{
  node: WorkspaceTreeNode;
  depth: number;
}> = ({ node, depth }) => {
  // Directories default to expanded for the first two levels so a
  // typical "show me the project" tool call shows useful structure
  // without forcing the user to click.
  const [open, setOpen] = useState(depth < 2);
  const isDir = node.type === "directory";
  const hasChildren = !!node.children && node.children.length > 0;

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors",
          isDir
            ? "hover:bg-sidebar-item-hover cursor-pointer"
            : "hover:bg-sidebar-item-hover/60",
        )}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => {
          if (isDir && hasChildren) setOpen((p) => !p);
        }}
        role={isDir ? "button" : undefined}
      >
        {isDir ? (
          <span className="inline-flex h-3 w-3 items-center justify-center text-text-disabled">
            {hasChildren ? (open ? "▾" : "▸") : ""}
          </span>
        ) : (
          <span className="inline-block h-3 w-3" />
        )}
        {isDir ? (
          <Folder size={11} className="text-info/80 fill-info/10 flex-shrink-0" />
        ) : (
          <ExplorerFileAssetIcon
            fileName={node.name}
            path={node.path}
            className="w-3 h-3 flex-shrink-0"
          />
        )}
        <span
          className={cn(
            "truncate text-[10.5px]",
            isDir ? "text-text-primary font-medium" : "text-text-secondary",
          )}
        >
          {node.name}
        </span>
        {!isDir && typeof node.lineCount === "number" && (
          <span className="ml-auto text-[9px] text-text-disabled font-mono">
            {node.lineCount.toLocaleString()} L
            {node.largeFile && (
              <span className="ml-1 text-warning/80">⚠</span>
            )}
          </span>
        )}
      </div>
      {isDir && open && hasChildren && (
        <>
          {node.children!.map((child, idx) => (
            <WorkspaceTreeRow
              key={`${child.path ?? child.name}-${idx}`}
              node={child}
              depth={depth + 1}
            />
          ))}
        </>
      )}
    </>
  );
};

/**
 * Recursive tree view for `workspace_tree`. Renders per-node
 * expand/collapse with depth-aware indentation. Capped via the
 * scrolling container so a workspace_tree on a giant repo stays
 * inside the fixed-height dropdown.
 */
export const WorkspaceTreeView: React.FC<WorkspaceTreeViewProps> = ({
  rootPath,
  tree,
  stats,
}) => {
  const totalNodes = useMemo(() => {
    let n = 0;
    const walk = (arr: WorkspaceTreeNode[]) => {
      for (const item of arr) {
        n += 1;
        if (item.children) walk(item.children);
      }
    };
    walk(tree);
    return n;
  }, [tree]);

  return (
    <div className="mt-1 rounded-md border border-border/50 bg-code-block">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <LayoutGrid size={11} className="text-text-secondary" />
        <span className="text-[10px] text-text-secondary uppercase tracking-wider">
          Workspace Tree
        </span>
        {rootPath && (
          <span className="truncate text-[10px] text-text-disabled font-mono">
            {rootPath.split(/[/\\]/).slice(-3).join("/")}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[9px] text-text-disabled font-mono">
          <span>{totalNodes} nodes</span>
          {stats?.filesRead !== undefined && stats.filesRead > 0 && (
            <span>{stats.filesRead} sized</span>
          )}
          {stats?.filesSkipped !== undefined && stats.filesSkipped > 0 && (
            <span className="text-warning/80">{stats.filesSkipped} skipped</span>
          )}
        </span>
      </div>
      <div className="max-h-[280px] overflow-y-auto overflow-x-auto py-1 scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent">
        {tree.map((node, idx) => (
          <WorkspaceTreeRow
            key={`${node.path ?? node.name}-${idx}`}
            node={node}
            depth={0}
          />
        ))}
      </div>
    </div>
  );
};
