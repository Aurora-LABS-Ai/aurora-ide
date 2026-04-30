/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  MoreVertical, FolderOpen, FilePlus, FolderPlus,
  Plus, ChevronRight, Search, X, RefreshCw,
  Folder, FolderClosed, ChevronsDownUp, Copy,
  Terminal as TerminalIcon, ExternalLink, FileSearch, Type
} from 'lucide-react';
import { FileTree } from './FileTree';
import { TreeNodeCreateInput } from './tree-node';
import { MenuBarMenu, type MenuBarItem } from '../layout/MenuBarMenu';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useDragStore } from '../../store/useDragStore';
import { isTauri, createFile, createFolder, openInTerminal, revealInExplorer } from '../../lib/tauri';
import { useExplorerKeyboard } from '../../hooks/useExplorerKeyboard';
import { databaseService } from '../../services/database';
import type { WorkspaceState } from '../../types/database';

export const FileExplorer: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [isCreating, setIsCreating] = useState<{ type: 'file' | 'folder'; parentId: string } | null>(null);
  const [createInputValue, setCreateInputValue] = useState('');
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceState[]>([]);
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<{ x: number; y: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const explorerContentRef = useRef<HTMLDivElement>(null);
  // FIX: Use shallow equality selector to prevent re-renders when unrelated store values change
  const setRootPath = useWorkspaceStore(state => state.setRootPath);
  const rootPath = useWorkspaceStore(state => state.rootPath);
  const files = useWorkspaceStore(state => state.files);
  const isLoading = useWorkspaceStore(state => state.isLoading);
  const selectFile = useWorkspaceStore(state => state.selectFile);
  const clearWorkspace = useWorkspaceStore(state => state.clearWorkspace);
  const collapseAll = useWorkspaceStore(state => state.collapseAll);
  const refreshDirectory = useWorkspaceStore(state => state.refreshDirectory);
  const { isDragging, dropTargetType } = useDragStore();
  const hasWorkspace = Boolean(rootPath);
  const hasExplorerEntries = files.length > 0;

  // Check if root is the current drop target
  const isDropTargetRoot = isDragging && dropTargetType === 'root';

  // Keyboard shortcuts handler
  useExplorerKeyboard({
    onRename: (nodeId) => setRenameTargetId(nodeId),
    onNewFile: (parentId) => {
      setIsCreating({ type: 'file', parentId });
      setCreateInputValue('');
    },
    onNewFolder: (parentId) => {
      setIsCreating({ type: 'folder', parentId });
      setCreateInputValue('');
    },
  });



  // Focus search input when shown
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  useEffect(() => {
    let isCancelled = false;

    const loadRecentWorkspaces = async () => {
      if (!isTauri() || hasWorkspace) {
        setRecentWorkspaces([]);
        return;
      }

      const workspaces = await databaseService.listRecentWorkspaces(3);
      if (isCancelled) return;

      setRecentWorkspaces(
        workspaces.filter((workspace): workspace is WorkspaceState & { workspace_path: string } =>
          Boolean(workspace.workspace_path)
        ),
      );
    };

    loadRecentWorkspaces();

    return () => {
      isCancelled = true;
    };
  }, [hasWorkspace]);


  // Collapse all folders
  const handleCollapseAll = useCallback(() => {
    collapseAll();
  }, [collapseAll]);

  // Handle new file at root
  const handleNewFileAtRoot = useCallback(() => {
    if (!rootPath) return;
    setIsCreating({ type: 'file', parentId: rootPath });
    setCreateInputValue('');
  }, [rootPath]);

  // Handle new folder at root
  const handleNewFolderAtRoot = useCallback(() => {
    if (!rootPath) return;
    setIsCreating({ type: 'folder', parentId: rootPath });
    setCreateInputValue('');
  }, [rootPath]);

  // Handle close folder
  const handleCloseFolder = useCallback(() => {
    clearWorkspace();
  }, [clearWorkspace]);

  // Handle create submission
  const handleCreateSubmit = useCallback(async () => {
    if (!isCreating || !createInputValue.trim()) {
      setIsCreating(null);
      setCreateInputValue('');
      return;
    }

    if (!isTauri()) {
      setIsCreating(null);
      return;
    }

    const parentPath = isCreating.parentId;
    const separator = parentPath.includes('\\') ? '\\' : '/';
    const newPath = `${parentPath}${separator}${createInputValue.trim()}`;

    try {
      if (isCreating.type === 'file') {
        await createFile(newPath);
      } else {
        await createFolder(newPath);
      }
      selectFile(newPath);
    } catch (err) {
      console.error('Failed to create:', err);
      alert(`Failed to create: ${err}`);
    }

    setIsCreating(null);
    setCreateInputValue('');
  }, [isCreating, createInputValue, selectFile]);

  // Filter files based on search query
  const filterFiles = useCallback((nodes: typeof files, query: string): typeof files => {
    if (!query.trim()) return nodes;

    const lowerQuery = query.toLowerCase();

    const filter = (items: typeof files): typeof files => {
      return items.reduce((acc, node) => {
        const nameMatches = node.name.toLowerCase().includes(lowerQuery);

        if (node.type === 'folder' && node.children) {
          const filteredChildren = filter(node.children);
          if (filteredChildren.length > 0 || nameMatches) {
            acc.push({
              ...node,
              children: filteredChildren.length > 0 ? filteredChildren : node.children,
            });
          }
        } else if (nameMatches) {
          acc.push(node);
        }

        return acc;
      }, [] as typeof files);
    };

    return filter(nodes);
  }, []);

  const filteredFiles = useMemo(
    () => filterFiles(files, searchQuery),
    [files, searchQuery, filterFiles]
  );

  const handleOpenFolder = async () => {
    if (isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Open Folder'
        });

        if (selected && typeof selected === 'string') {
          setRootPath(selected);
        }
      } catch (err) {
        console.error('Failed to open folder:', err);
      }
    } else {
      alert('Open Folder is only available in the desktop app');
    }
  };

  const handleOpenInTerminal = useCallback(async () => {
    if (!rootPath) return;
    try {
      await openInTerminal(rootPath);
    } catch (err) {
      console.error('Failed to open terminal at workspace:', err);
    }
  }, [rootPath]);

  const handleRevealInFileManager = useCallback(async () => {
    if (!rootPath) return;
    try {
      await revealInExplorer(rootPath);
    } catch (err) {
      console.error('Failed to reveal in file manager:', err);
    }
  }, [rootPath]);

  const handleCopyPath = useCallback(() => {
    if (!rootPath) return;
    void navigator.clipboard.writeText(rootPath);
  }, [rootPath]);

  const handleCopyFolderName = useCallback(() => {
    if (!rootPath) return;
    const name = rootPath.split(/[/\\]/).filter(Boolean).pop() ?? '';
    void navigator.clipboard.writeText(name);
  }, [rootPath]);

  const handleExplorerMouseDownCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    if (target.closest('input, textarea, button, [contenteditable="true"], [role="menu"]')) {
      return;
    }

    // Clear any active file/folder selection when the user clicks on the empty
    // area inside the explorer content (i.e. not on a tree row, input, button,
    // or context menu). Mirrors VS Code: clicking the void deselects.
    const clickedRow =
      target.closest('[data-file-path]') || target.closest('[data-folder-path]');
    if (!clickedRow) {
      selectFile(null);
    }

    explorerContentRef.current?.focus();
  }, [selectFile]);

  // Get folder name from path
  const folderName = rootPath ? rootPath.split(/[/\\]/).pop() : null;
  const slimSurfaceStyle: React.CSSProperties = {
    backgroundColor: 'color-mix(in srgb, var(--aurora-common-secondary) 74%, var(--aurora-sidebar-background) 26%)',
    border: '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
    boxShadow: `
      inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent),
      inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
    `,
  };

  // Slim, wrapperless icon button used inside the workspace header.
  const headerIconButtonClass =
    "flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-text-disabled transition-colors duration-100";

  const handleWorkspaceContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!hasWorkspace) return;
      e.preventDefault();
      e.stopPropagation();
      setWorkspaceContextMenu({ x: e.clientX, y: e.clientY });
    },
    [hasWorkspace],
  );

  // Right-click on the empty area inside the explorer content → open the
  // workspace context menu (so users can create files/folders, refresh,
  // etc. without targeting a specific row). TreeNode rows already call
  // `e.stopPropagation()` on their own onContextMenu, so this handler
  // only fires for clicks on the bare scroll container.
  const handleEmptyAreaContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!hasWorkspace) return;
      const target = e.target as HTMLElement;
      // Defensive guard — never fire if the click landed on a row even if
      // stopPropagation() is removed upstream.
      if (
        target.closest('[data-file-path]') ||
        target.closest('[data-folder-path]')
      ) {
        return;
      }
      e.preventDefault();
      // Clear any active selection so the user sees a clean menu against
      // an unselected canvas (matches VS Code behaviour).
      selectFile(null);
      setWorkspaceContextMenu({ x: e.clientX, y: e.clientY });
    },
    [hasWorkspace, selectFile],
  );

  const workspaceMenuItems: MenuItem[] = hasWorkspace
    ? [
        { header: "Create" },
        {
          label: "New File",
          icon: <FilePlus className="w-3.5 h-3.5" />,
          onClick: handleNewFileAtRoot,
          shortcut: "Ctrl+N",
        },
        {
          label: "New Folder",
          icon: <FolderPlus className="w-3.5 h-3.5" />,
          onClick: handleNewFolderAtRoot,
          shortcut: "Ctrl+Shift+N",
        },
        { divider: true },
        { header: "Workspace" },
        {
          label: "Open Folder…",
          icon: <FolderOpen className="w-3.5 h-3.5" />,
          onClick: () => { void handleOpenFolder(); },
        },
        {
          label: "Close Folder",
          icon: <FolderClosed className="w-3.5 h-3.5" />,
          onClick: handleCloseFolder,
        },
        { divider: true },
        { header: "View" },
        {
          label: "Refresh Explorer",
          icon: <RefreshCw className="w-3.5 h-3.5" />,
          onClick: () => { void refreshDirectory(); },
          shortcut: "F5",
        },
        {
          label: "Collapse All Folders",
          icon: <ChevronsDownUp className="w-3.5 h-3.5" />,
          onClick: handleCollapseAll,
        },
        { divider: true },
        { header: "Tools" },
        {
          label: "Open in External Terminal",
          icon: <TerminalIcon className="w-3.5 h-3.5" />,
          onClick: () => { void handleOpenInTerminal(); },
        },
        {
          label: "Reveal in File Manager",
          icon: <ExternalLink className="w-3.5 h-3.5" />,
          onClick: () => { void handleRevealInFileManager(); },
        },
        { divider: true },
        {
          label: "Copy Workspace Path",
          icon: <Copy className="w-3.5 h-3.5" />,
          onClick: handleCopyPath,
        },
        {
          label: "Copy Folder Name",
          icon: <Type className="w-3.5 h-3.5" />,
          onClick: handleCopyFolderName,
        },
      ]
    : [];

  return (
    <div
      className="h-full flex flex-col"
      data-explorer-panel
      style={{
        // Single flat sidebar fill — no editor-bg blend, no inset right shadow.
        // The result is one cohesive panel surface (matches VS Code), with the
        // EXPLORER header riding on the same color as the file tree below.
        backgroundColor: 'var(--aurora-sidebar-background)',
      }}
    >
      {/* Explorer Title Bar */}
      <div
        className="flex h-9 items-center justify-between px-3 select-none"
        style={{
          backgroundColor: 'transparent',
        }}
      >
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.14em]"
          style={{
            color: 'color-mix(in srgb, var(--aurora-sidebar-foreground) 70%, transparent)',
          }}
        >
          Explorer
        </span>

        {/* Menu Button — VS Code-style dropdown */}
        <MenuBarMenu
          label="Explorer Actions"
          title="Explorer actions"
          align="end"
          menuWidth={250}
          triggerIcon={<MoreVertical className="w-4 h-4" />}
          triggerClassName="flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary cursor-pointer"
          triggerStyle={{
            backgroundColor: 'transparent',
            transition: 'background-color 120ms ease, color 120ms ease, box-shadow 120ms ease',
          }}
          items={
            hasWorkspace
              ? ([
                  { header: 'Workspace' },
                  {
                    label: 'New File',
                    icon: <FilePlus size={13} />,
                    shortcut: 'Ctrl+N',
                    onClick: handleNewFileAtRoot,
                  },
                  {
                    label: 'New Folder',
                    icon: <FolderPlus size={13} />,
                    onClick: handleNewFolderAtRoot,
                  },
                  { divider: true },
                  {
                    label: 'Open Folder…',
                    icon: <FolderOpen size={13} />,
                    onClick: () => {
                      void handleOpenFolder();
                    },
                  },
                  {
                    label: 'Close Folder',
                    icon: <FolderClosed size={13} />,
                    onClick: handleCloseFolder,
                  },
                  { divider: true },
                  { header: 'View' },
                  {
                    label: 'Refresh Explorer',
                    icon: <RefreshCw size={13} />,
                    shortcut: 'F5',
                    onClick: () => {
                      void refreshDirectory();
                    },
                  },
                  {
                    label: 'Collapse All Folders',
                    icon: <ChevronsDownUp size={13} />,
                    onClick: handleCollapseAll,
                  },
                  { divider: true },
                  { header: 'Workspace Tools' },
                  {
                    label: 'Open in External Terminal',
                    icon: <TerminalIcon size={13} />,
                    onClick: () => {
                      void handleOpenInTerminal();
                    },
                  },
                  {
                    label: 'Reveal in File Manager',
                    icon: <ExternalLink size={13} />,
                    onClick: () => {
                      void handleRevealInFileManager();
                    },
                  },
                  { divider: true },
                  {
                    label: 'Copy Workspace Path',
                    icon: <Copy size={13} />,
                    onClick: handleCopyPath,
                  },
                  {
                    label: 'Copy Folder Name',
                    icon: <Type size={13} />,
                    onClick: handleCopyFolderName,
                  },
                ] satisfies MenuBarItem[])
              : ([
                  {
                    label: 'Open Folder…',
                    icon: <FolderOpen size={13} />,
                    onClick: () => {
                      void handleOpenFolder();
                    },
                  },
                  { divider: true },
                  {
                    label: 'No workspace open',
                    icon: <FileSearch size={13} />,
                    disabled: true,
                  },
                ] satisfies MenuBarItem[])
          }
        />
      </div>

      {/*
       * Workspace strip
       * ---------------
       * Flat single-row chrome (no nested pills) inspired by VS Code's
       * sticky folder header. Hover lifts the strip; right-click opens
       * a full workspace context menu with Create / Workspace / View /
       * Tools sections. Action icons are wrapperless until hover.
       */}
      {hasWorkspace && (
        <div
          className="group/workspace mx-1 mt-1 flex h-7 items-center gap-1.5 rounded-[5px] pl-2 pr-1 transition-colors duration-100"
          style={{
            color: 'var(--aurora-sidebar-foreground)',
            backgroundColor: 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor =
              'color-mix(in srgb, var(--aurora-sidebar-item-hover, var(--aurora-common-primary)) 35%, transparent)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
          title={rootPath || ''}
          onContextMenu={handleWorkspaceContextMenu}
        >
          <ChevronRight
            className="w-3 h-3 shrink-0"
            style={{ opacity: 0.55, transform: 'rotate(90deg)' }}
          />
          <Folder
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: 'var(--aurora-common-warning, #d29922)', opacity: 0.92 }}
          />
          <span
            className="flex-1 truncate text-[11.5px] font-medium tracking-[0.01em] uppercase"
            style={{ letterSpacing: '0.04em' }}
          >
            {folderName}
          </span>

          {/* Action cluster — opacity ramps on hover so the strip stays calm at idle */}
          <div className="flex items-center gap-0.5 opacity-70 group-hover/workspace:opacity-100 transition-opacity duration-100">
            <button
              type="button"
              onClick={handleNewFileAtRoot}
              className={headerIconButtonClass}
              title="New File"
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor =
                  'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)';
                e.currentTarget.style.color = 'var(--aurora-editor-foreground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '';
              }}
            >
              <FilePlus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNewFolderAtRoot}
              className={headerIconButtonClass}
              title="New Folder"
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor =
                  'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)';
                e.currentTarget.style.color = 'var(--aurora-editor-foreground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '';
              }}
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setShowSearch(!showSearch)}
              className={headerIconButtonClass}
              title="Search"
              style={
                showSearch
                  ? {
                      backgroundColor:
                        'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)',
                      color: 'var(--aurora-common-primary)',
                    }
                  : undefined
              }
              onMouseEnter={(e) => {
                if (showSearch) return;
                e.currentTarget.style.backgroundColor =
                  'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)';
                e.currentTarget.style.color = 'var(--aurora-editor-foreground)';
              }}
              onMouseLeave={(e) => {
                if (showSearch) return;
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '';
              }}
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/*
       * Filter bar
       * Slim, single-row text field; theme-aware focus ring driven entirely
       * by `--aurora-common-primary` and `--aurora-common-border`.
       */}
      {showSearch && hasWorkspace && (
        <div className="px-2 pb-1.5 pt-1 animate-in slide-in-from-top-2 duration-150">
          <div
            className="relative group flex items-center"
            style={{ height: 26 }}
          >
            <Search
              className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 transition-colors"
              style={{
                color: 'color-mix(in srgb, var(--aurora-editor-foreground) 50%, transparent)',
              }}
            />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter files…"
              className="w-full rounded-[5px] pl-7 pr-7 text-[12px] focus:outline-none"
              style={{
                height: 26,
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-chat-input-background, var(--aurora-sidebar-background)) 85%, transparent)',
                color: 'var(--aurora-editor-foreground)',
                border:
                  '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
                transition: 'border-color 120ms ease, box-shadow 120ms ease',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor =
                  'color-mix(in srgb, var(--aurora-common-primary) 55%, transparent)';
                e.currentTarget.style.boxShadow =
                  '0 0 0 2px color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor =
                  'color-mix(in srgb, var(--aurora-common-border) 60%, transparent)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded-[3px] transition-colors"
                style={{
                  color:
                    'color-mix(in srgb, var(--aurora-editor-foreground) 50%, transparent)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor =
                    'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)';
                  e.currentTarget.style.color = 'var(--aurora-editor-foreground)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color =
                    'color-mix(in srgb, var(--aurora-editor-foreground) 50%, transparent)';
                }}
                title="Clear filter"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Content area - drop zone for moving files to root.
          We intentionally use tabIndex=-1 + .focus() so keyboard nav inside
          the tree works, but we MUST suppress the browser's default 2px
          focus outline (otherwise an enormous rectangle frames the entire
          empty area whenever the user clicks the void). */}
      <div
        className={`flex-1 overflow-y-auto scrollbar-thin outline-none focus:outline-none focus-visible:outline-none ${isDropTargetRoot ? 'bg-primary/10 ring-1 ring-primary/30 ring-inset' : ''}`}
        ref={explorerContentRef}
        tabIndex={-1}
        style={{ outline: 'none' }}
        onMouseDownCapture={handleExplorerMouseDownCapture}
        onContextMenu={handleEmptyAreaContextMenu}
        data-explorer-content
      >
        {hasWorkspace ? (
          <div className="px-1 pb-2 pt-1">
            {hasExplorerEntries ? (
              <FileTree
                files={filteredFiles}
                renameTargetId={renameTargetId}
                onRenameComplete={() => setRenameTargetId(null)}
                onRenameStart={setRenameTargetId}
                isCreating={isCreating}
                createInputValue={createInputValue}
                onCreateInputChange={setCreateInputValue}
                onCreateSubmit={handleCreateSubmit}
                onCreateCancel={() => { setIsCreating(null); setCreateInputValue(''); }}
              />
            ) : (
              <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 text-center">
                <div
                  className="mb-4 flex h-14 w-14 items-center justify-center rounded-[20px] border"
                  style={{
                    background: 'color-mix(in srgb, var(--aurora-common-primary) 8%, var(--aurora-sidebar-background))',
                    borderColor: 'color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
                    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent)',
                  }}
                >
                  {isLoading ? (
                    <RefreshCw className="h-7 w-7 animate-spin text-primary/70" />
                  ) : (
                    <Folder className="h-7 w-7 text-warning/80" />
                  )}
                </div>
                <p className="mb-1 text-[13px] font-medium text-text-primary">
                  {isLoading ? 'Loading workspace...' : 'This workspace is empty'}
                </p>
                <p className="mb-4 max-w-[220px] text-[11px] text-text-disabled">
                  {isLoading
                    ? 'Reading files and folders from the current workspace.'
                    : 'The folder is open, but there are no files or folders yet. Create something to get started.'}
                </p>
                {!isLoading && (
                  <div className="w-full max-w-[280px]">
                    {isCreating ? (
                      <div className="rounded-[16px] border px-2 py-2" style={slimSurfaceStyle}>
                        <TreeNodeCreateInput
                          type={isCreating.type}
                          value={createInputValue}
                          level={0}
                          parentPath={rootPath || undefined}
                          onChange={setCreateInputValue}
                          onSubmit={handleCreateSubmit}
                          onCancel={() => {
                            setIsCreating(null);
                            setCreateInputValue('');
                          }}
                        />
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <button
                          onClick={handleNewFileAtRoot}
                          className="flex items-center gap-2 rounded-[14px] border px-4 py-2 text-[12px] font-medium text-primary transition-all duration-200"
                          style={{
                            background: 'color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-sidebar-background))',
                            borderColor: 'color-mix(in srgb, var(--aurora-common-primary) 24%, transparent)',
                          }}
                        >
                          <FilePlus className="h-4 w-4" />
                          New File
                        </button>
                        <button
                          onClick={handleNewFolderAtRoot}
                          className="flex items-center gap-2 rounded-[14px] border px-4 py-2 text-[12px] font-medium text-text-secondary transition-all duration-200 hover:text-text-primary"
                          style={slimSurfaceStyle}
                        >
                          <FolderPlus className="h-4 w-4" />
                          New Folder
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div
              className="mb-4 flex h-14 w-14 items-center justify-center rounded-[20px] border"
              style={{
                background: 'color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-sidebar-background))',
                borderColor: 'color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)',
                boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 6%, transparent)',
              }}
            >
              <FolderOpen className="w-8 h-8 text-primary/70" />
            </div>
            <p className="mb-1 text-[13px] font-medium text-text-primary">No folder opened</p>
            <p className="mb-4 text-[11px] text-text-disabled">Open a folder or jump back into a recent workspace</p>
            <button
              onClick={handleOpenFolder}
              className="flex items-center gap-2 rounded-[14px] border px-4 py-2 text-[12px] font-medium text-primary transition-all duration-200"
              style={{
                background: 'color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-sidebar-background))',
                borderColor: 'color-mix(in srgb, var(--aurora-common-primary) 24%, transparent)',
              }}
            >
              <Plus className="w-4 h-4" />
              Open Folder
            </button>

            {recentWorkspaces.length > 0 && (
              <div className="mt-6 w-full max-w-[260px] text-left">
                <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">
                  Recent Workspaces
                </p>
                <div className="space-y-2">
                  {recentWorkspaces.map((workspace) => {
                    const workspacePath = workspace.workspace_path ?? '';
                    const workspaceName = workspacePath.split(/[/\\]/).pop() || workspacePath;

                    return (
                      <button
                        key={workspacePath}
                        onClick={() => setRootPath(workspacePath)}
                        className="w-full rounded-[16px] border px-3 py-2 text-left transition-all duration-200 hover:border-[color-mix(in_srgb,var(--aurora-common-primary)_24%,transparent)] hover:bg-sidebar-item-hover"
                        style={slimSurfaceStyle}
                        title={workspacePath}
                      >
                        <div className="truncate text-[12px] font-medium text-text-primary">
                          {workspaceName}
                        </div>
                        <div className="mt-1 truncate text-[10px] text-text-disabled">
                          {workspacePath}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {workspaceContextMenu && (
        <ContextMenu
          x={workspaceContextMenu.x}
          y={workspaceContextMenu.y}
          items={workspaceMenuItems}
          minWidth={240}
          onClose={() => setWorkspaceContextMenu(null)}
        />
      )}
    </div>
  );
};

// FIX: Export memoized version to prevent re-renders from parent components
export const MemoizedFileExplorer = React.memo(FileExplorer);
