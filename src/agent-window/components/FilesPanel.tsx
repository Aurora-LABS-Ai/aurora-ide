/**
 * Agent Window — Files tab [view].
 *
 * A self-contained, robust workspace file browser for the right dock. Built for
 * the agent window from scratch — it does NOT reuse the IDE explorer; it reads
 * the disk straight through the Rust `read_directory` backend and keeps a lazy
 * tree (`useAgentFilesStore`) that the OS watcher refreshes live.
 *
 * Two browse modes:
 *  - Tree (default): folders expand on click, files are leaves. Material icons.
 *  - Filter: typing fuzzy-matches the whole repo (flat ranked list, Ctrl+P feel).
 *
 * Selecting a file opens it as its OWN tab pill in the dock (Codex §12.7) via
 * `openFileTab`; editing is handed off to the IDE. Themed with `--agw-*`.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "../shared/AgentIcon";
import { FileIcon, FolderIcon } from "../../components/explorer/FileIcons";
import {
  loadFileIndex,
  rankFiles,
  type MentionFile,
} from "../adapters/file-index";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentFilesStore } from "../store/useAgentFilesStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";
import type { FileEntry } from "../../lib/tauri";

/** The path of the file shown in the currently-active dock tab (for highlight). */
function useActiveFilePath(): string | undefined {
  return useAgentWorkspaceStore((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t?.kind === "file" ? t.path : undefined;
  });
}

/** One tree row — a folder (toggles) or a file (opens a tab). Recurses for kids. */
const TreeNode: React.FC<{ entry: FileEntry; depth: number; activeFile?: string }> = ({
  entry,
  depth,
  activeFile,
}) => {
  const expanded = useAgentFilesStore((s) => !!s.expanded[entry.path]);
  const kids = useAgentFilesStore((s) => s.childrenByDir[entry.path]);
  const loading = useAgentFilesStore((s) => !!s.loading[entry.path]);
  const failed = useAgentFilesStore((s) => !!s.failed[entry.path]);
  const toggleDir = useAgentFilesStore((s) => s.toggleDir);
  const openFileTab = useAgentWorkspaceStore((s) => s.openFileTab);

  const pad = 8 + depth * 13;

  if (entry.is_dir) {
    return (
      <>
        <button
          type="button"
          className="agw-tree-row"
          style={{ paddingLeft: pad }}
          onClick={() => toggleDir(entry.path)}
          aria-expanded={expanded}
          title={entry.name}
        >
          <span
            className="agw-tree-caret"
            style={{ transform: expanded ? "none" : "rotate(-90deg)" }}
          >
            <AgentIcon name="chevron-down" size={12} />
          </span>
          <FolderIcon name={entry.name} open={expanded} className="agw-file-ico" />
          <span className="agw-tree-name">{entry.name}</span>
        </button>
        {expanded && (
          <>
            {loading && !kids && (
              <div className="agw-tree-hint" style={{ paddingLeft: pad + 25 }}>
                <span className="agw-fv-spinner agw-tree-spin" />
              </div>
            )}
            {failed && (
              <div className="agw-tree-hint" style={{ paddingLeft: pad + 25, color: "var(--agw-removed)" }}>
                Can't read folder
              </div>
            )}
            {kids && kids.length === 0 && (
              <div className="agw-tree-hint" style={{ paddingLeft: pad + 25 }}>
                Empty
              </div>
            )}
            {kids?.map((child) => (
              <TreeNode key={child.path} entry={child} depth={depth + 1} activeFile={activeFile} />
            ))}
          </>
        )}
      </>
    );
  }

  return (
    <button
      type="button"
      className="agw-tree-row"
      data-selected={entry.path === activeFile || undefined}
      style={{ paddingLeft: pad + 16 }}
      onClick={() => openFileTab(entry.path)}
      title={entry.name}
    >
      <FileIcon name={entry.name} path={entry.path} className="agw-file-ico" />
      <span className="agw-tree-name">{entry.name}</span>
    </button>
  );
};

export const FilesPanel: React.FC = () => {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const rootKids = useAgentFilesStore((s) => (s.root ? s.childrenByDir[s.root] : undefined));
  const rootLoading = useAgentFilesStore((s) => (s.root ? !!s.loading[s.root] : false));
  const setRoot = useAgentFilesStore((s) => s.setRoot);
  const collapseAll = useAgentFilesStore((s) => s.collapseAll);
  const refresh = useAgentFilesStore((s) => s.refresh);
  const openFileTab = useAgentWorkspaceStore((s) => s.openFileTab);
  const activeFile = useActiveFilePath();

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<MentionFile[] | null>(null);
  const indexLoading = useRef(false);

  // Bind the tree to the window's project.
  useEffect(() => {
    setRoot(projectRoot);
  }, [projectRoot, setRoot]);

  // Lazily load the flat index the first time the user filters.
  useEffect(() => {
    if (!query.trim() || index || indexLoading.current || !projectRoot) return;
    indexLoading.current = true;
    void loadFileIndex(projectRoot).then((files) => {
      setIndex(files);
      indexLoading.current = false;
    });
  }, [query, index, projectRoot]);

  const matches = useMemo(
    () => (query.trim() && index ? rankFiles(index, query, 50) : []),
    [query, index],
  );

  if (!projectRoot) {
    return (
      <div className="agw-files-empty">
        <AgentIcon name="files" size={22} style={{ color: "var(--agw-text-subtle)" }} />
        <div style={{ fontSize: 13, color: "var(--agw-text-muted)", fontWeight: 600 }}>No project open</div>
        <div style={{ fontSize: 12, color: "var(--agw-text-subtle)", maxWidth: 240 }}>
          Pick a project for this chat to browse its files here.
        </div>
      </div>
    );
  }

  const filtering = query.trim().length > 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Toolbar: fuzzy filter + collapse-all + refresh */}
      <div className="agw-files-bar">
        <div className="agw-files-search">
          <AgentIcon name="search" size={13} style={{ color: "var(--agw-text-subtle)" }} />
          <input
            className="agw-files-input"
            placeholder="Filter files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query && (
            <button
              type="button"
              className="agw-files-clear"
              onClick={() => setQuery("")}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <AgentIcon name="close" size={12} />
            </button>
          )}
        </div>
        {!filtering && (
          <>
            <button type="button" className="agw-files-tool" onClick={collapseAll} title="Collapse all folders">
              <AgentIcon name="chevrons-left" size={14} style={{ transform: "rotate(90deg)" }} />
            </button>
            <button type="button" className="agw-files-tool" onClick={refresh} title="Refresh">
              <AgentIcon name="retry" size={14} />
            </button>
          </>
        )}
      </div>

      {/* Body */}
      <div className="agw-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
        {filtering ? (
          index === null ? (
            <div className="agw-tree-hint" style={{ padding: "14px 12px" }}>
              <span className="agw-fv-spinner agw-tree-spin" /> Indexing…
            </div>
          ) : matches.length === 0 ? (
            <div className="agw-tree-hint" style={{ padding: "14px 12px" }}>
              No files match “{query.trim()}”
            </div>
          ) : (
            matches.map((m) => (
              <button
                key={m.path}
                type="button"
                className="agw-tree-row"
                data-selected={m.path === activeFile || undefined}
                style={{ paddingLeft: 10 }}
                onClick={() => openFileTab(m.path)}
                title={m.rel}
              >
                <FileIcon name={m.name} path={m.path} className="agw-file-ico" />
                <span className="agw-files-result">
                  <span className="agw-files-result-name">{m.name}</span>
                  {m.rel !== m.name && (
                    <span className="agw-files-result-dir">{m.rel.slice(0, m.rel.length - m.name.length)}</span>
                  )}
                </span>
              </button>
            ))
          )
        ) : rootKids === undefined ? (
          <div className="agw-tree-hint" style={{ padding: "14px 12px" }}>
            {rootLoading ? (
              <>
                <span className="agw-fv-spinner agw-tree-spin" /> Loading…
              </>
            ) : (
              "—"
            )}
          </div>
        ) : rootKids.length === 0 ? (
          <div className="agw-tree-hint" style={{ padding: "14px 12px" }}>This folder is empty</div>
        ) : (
          rootKids.map((entry) => (
            <TreeNode key={entry.path} entry={entry} depth={0} activeFile={activeFile} />
          ))
        )}
      </div>
    </div>
  );
};
