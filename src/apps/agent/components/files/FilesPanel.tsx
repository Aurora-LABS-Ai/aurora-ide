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

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { FileIcon, FolderIcon } from "@/kernel/ui/FileIcons";
import {
  loadFileIndex,
  rankFiles,
  type MentionFile,
} from "@/apps/agent/adapters/file-index";
import { openInIde } from "@/apps/agent/adapters/open-in-ide";
import { writeClipboardText } from "@/kernel/lib/clipboard";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { dragJustEnded, useAgentDragStore } from "@/apps/agent/store/ui/useAgentDragStore";
import { useAgentFilesStore } from "@/apps/agent/store/files/useAgentFilesStore";
import { useAgentTerminalStore } from "@/apps/agent/store/ui/useAgentTerminalStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { openInTerminal, revealInExplorer, type FileEntry } from "@/kernel/lib/ipc/tauri";
import { RailMenu, type RailMenuItem, type RailMenuState } from "@/apps/agent/components/shell/RailMenu";

/** A right-clicked row, before it is turned into menu items. */
type RowMenuHandler = (event: React.MouseEvent, path: string, isDir: boolean) => void;

/** The directory a file lives in — where the terminal actions should land. */
function parentDirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * Make a row draggable into a composer. Files and folders both drag; what
 * differs is what the drop means (a file to read vs. a directory to look
 * inside), which travels with the drag as `isDir`.
 *
 * Press only STAGES the path — the coordinator promotes it to a real drag once
 * the pointer travels, so a press that doesn't move is still an ordinary click
 * that opens the file or toggles the folder. Callers must route their click
 * through `actOnClick`, which drops the click that trails a drag released over
 * its own row.
 */
function useRowDrag(path: string, name: string, isDir: boolean, act: () => void) {
  const isDragging = useAgentDragStore((s) => s.isDragging && s.path === path);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    useAgentDragStore.getState().prepare(path, name, e.clientX, e.clientY, isDir);
  };

  const actOnClick = () => {
    if (dragJustEnded()) return;
    act();
  };

  return { isDragging, onMouseDown, actOnClick };
}

/** The path of the file shown in the currently-active dock tab (for highlight). */
function useActiveFilePath(): string | undefined {
  return useAgentWorkspaceStore((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t?.kind === "file" ? t.path : undefined;
  });
}

/** One tree row — a folder (toggles) or a file (opens a tab). Recurses for kids. */
const TreeNode: React.FC<{
  entry: FileEntry;
  depth: number;
  activeFile?: string;
  onMenu: RowMenuHandler;
}> = ({ entry, depth, activeFile, onMenu }) => {
  const expanded = useAgentFilesStore((s) => !!s.expanded[entry.path]);
  const kids = useAgentFilesStore((s) => s.childrenByDir[entry.path]);
  const loading = useAgentFilesStore((s) => !!s.loading[entry.path]);
  const failed = useAgentFilesStore((s) => !!s.failed[entry.path]);
  const toggleDir = useAgentFilesStore((s) => s.toggleDir);
  const openFileTab = useAgentWorkspaceStore((s) => s.openFileTab);
  // One hook for both row kinds: a folder drags as a directory mention, and its
  // click still toggles the branch.
  const drag = useRowDrag(entry.path, entry.name, entry.is_dir, () =>
    entry.is_dir ? toggleDir(entry.path) : openFileTab(entry.path),
  );

  const pad = 8 + depth * 13;

  if (entry.is_dir) {
    return (
      <>
        <button
          type="button"
          className="agw-tree-row"
          data-dragging={drag.isDragging || undefined}
          style={{ paddingLeft: pad }}
          onMouseDown={drag.onMouseDown}
          onClick={drag.actOnClick}
          onContextMenu={(e) => onMenu(e, entry.path, true)}
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
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                activeFile={activeFile}
                onMenu={onMenu}
              />
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
      data-dragging={drag.isDragging || undefined}
      style={{ paddingLeft: pad + 16 }}
      onMouseDown={drag.onMouseDown}
      onClick={drag.actOnClick}
      onContextMenu={(e) => onMenu(e, entry.path, false)}
      title={entry.name}
    >
      <FileIcon name={entry.name} path={entry.path} className="agw-file-ico" />
      <span className="agw-tree-name">{entry.name}</span>
    </button>
  );
};

/** One fuzzy-filter result. Same open + drag contract as a tree leaf. */
const FilterRow: React.FC<{
  file: MentionFile;
  activeFile?: string;
  onMenu: RowMenuHandler;
}> = ({ file, activeFile, onMenu }) => {
  const openFileTab = useAgentWorkspaceStore((s) => s.openFileTab);
  // The fuzzy index lists files only, never directories.
  const drag = useRowDrag(file.path, file.name, false, () => openFileTab(file.path));

  return (
    <button
      type="button"
      className="agw-tree-row"
      data-selected={file.path === activeFile || undefined}
      data-dragging={drag.isDragging || undefined}
      style={{ paddingLeft: 10 }}
      onMouseDown={drag.onMouseDown}
      onClick={drag.actOnClick}
      onContextMenu={(e) => onMenu(e, file.path, false)}
      title={file.rel}
    >
      <FileIcon name={file.name} path={file.path} className="agw-file-ico" />
      <span className="agw-files-result">
        <span className="agw-files-result-name">{file.name}</span>
        {file.rel !== file.name && (
          <span className="agw-files-result-dir">
            {file.rel.slice(0, file.rel.length - file.name.length)}
          </span>
        )}
      </span>
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
  const activeFile = useActiveFilePath();

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<MentionFile[] | null>(null);
  const indexLoading = useRef(false);
  const [menu, setMenu] = useState<RailMenuState | null>(null);

  // Right-click on any row — the same menu surface as the left rail
  // (`RailMenu`), with the hand-off actions this view-only window supports:
  // the IDE for editing (files), the OS for everything else.
  const openRowMenu: RowMenuHandler = (event, path, isDir) => {
    event.preventDefault();
    event.stopPropagation();
    // Read synchronously: React clears `currentTarget` once dispatch ends.
    const anchor = event.currentTarget as HTMLElement;
    const items: RailMenuItem[] = [
      ...(!isDir
        ? [
            {
              icon: "external",
              label: "Open in IDE",
              onSelect: () => void openInIde(path),
            } as RailMenuItem,
          ]
        : []),
      {
        icon: "files",
        label: "Open in File Explorer",
        separatorBefore: !isDir,
        onSelect: () => {
          // A file path REVEALS the file (Explorer opens on its folder with
          // the file selected); a folder opens as the folder itself.
          revealInExplorer(path).catch((err) =>
            console.error("[files-panel] reveal in explorer failed:", err),
          );
        },
      },
      {
        icon: "terminal",
        label: "Open in integrated terminal",
        onSelect: () => {
          // Session first, then the tab: with a session already present the
          // Terminal panel's "open one shell on first show" effect stays
          // quiet, so the dock reveals exactly the shell just created.
          useAgentTerminalStore
            .getState()
            .createSession("pwsh", isDir ? path : parentDirOf(path));
          useAgentWorkspaceStore.getState().openTab("terminal");
        },
      },
      {
        icon: "terminal",
        label: "Open in external terminal",
        onSelect: () => {
          openInTerminal(isDir ? path : parentDirOf(path)).catch((err) =>
            console.error("[files-panel] open external terminal failed:", err),
          );
        },
      },
      {
        icon: "copy",
        label: isDir ? "Copy folder path" : "Copy path",
        separatorBefore: true,
        onSelect: () => void writeClipboardText(path),
      },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items, anchor });
  };

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
        <div style={{ fontSize: "var(--agw-fs-ui)", color: "var(--agw-text-muted)", fontWeight: "var(--agw-fw-medium)" }}>No project open</div>
        <div style={{ fontSize: "var(--agw-fs-label)", color: "var(--agw-text-subtle)", maxWidth: 240 }}>
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
              <FilterRow key={m.path} file={m} activeFile={activeFile} onMenu={openRowMenu} />
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
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              activeFile={activeFile}
              onMenu={openRowMenu}
            />
          ))
        )}
      </div>

      {/* Row context menu (file / folder). */}
      {menu && <RailMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
};
