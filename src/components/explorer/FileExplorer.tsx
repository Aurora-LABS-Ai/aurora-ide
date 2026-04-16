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
  Plus, ChevronDown, Search, X, RefreshCw,
  Folder, FolderClosed, ChevronsDownUp, Copy
} from 'lucide-react';
import { FileTree } from './FileTree';
import { TreeNodeCreateInput } from './tree-node';
import { ContextMenu } from '../ui/ContextMenu';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useDragStore } from '../../store/useDragStore';
import { isTauri, createFile, createFolder } from '../../lib/tauri';
import { useExplorerKeyboard } from '../../hooks/useExplorerKeyboard';
import { databaseService } from '../../services/database';
import type { WorkspaceState } from '../../types/database';

export const FileExplorer: React.FC = () => {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [isCreating, setIsCreating] = useState<{ type: 'file' | 'folder'; parentId: string } | null>(null);
  const [createInputValue, setCreateInputValue] = useState('');
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceState[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
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
    setMenuPosition(null);
    if (!rootPath) return;
    setIsCreating({ type: 'file', parentId: rootPath });
    setCreateInputValue('');
  }, [rootPath]);

  // Handle new folder at root
  const handleNewFolderAtRoot = useCallback(() => {
    setMenuPosition(null);
    if (!rootPath) return;
    setIsCreating({ type: 'folder', parentId: rootPath });
    setCreateInputValue('');
  }, [rootPath]);

  // Handle close folder
  const handleCloseFolder = useCallback(() => {
    setMenuPosition(null);
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
    setMenuPosition(null);

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

  return (
    <div
      className="h-full flex flex-col"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--aurora-sidebar-background) 88%, var(--aurora-editor-background) 12%)',
        boxShadow: 'inset -1px 0 0 color-mix(in srgb, var(--aurora-common-shadow) 10%, transparent)',
      }}
    >
      {/* Explorer Title Bar */}
      <div
        className="flex h-10 items-center justify-between border-b px-3 select-none"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 68%, var(--aurora-sidebar-background) 32%)',
          borderColor: 'color-mix(in srgb, var(--aurora-common-border) 72%, transparent)',
          boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 4%, transparent)',
        }}
      >
        <span className="text-[11px] font-bold text-text-secondary uppercase tracking-widest opacity-80">
          Explorer
        </span>

        {/* Menu Button */}
        <button
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-xl border transition-all duration-200 ${menuPosition
            ? 'text-text-primary'
            : 'text-text-disabled hover:text-text-secondary hover:bg-sidebar-item-hover'
            }`}
          style={{
            backgroundColor: menuPosition
              ? 'color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-sidebar-item-selected))'
              : 'transparent',
            borderColor: menuPosition
              ? 'color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)'
              : 'transparent',
          }}
          title="More Actions"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {menuPosition && (
          <ContextMenu
            x={menuPosition.x}
            y={menuPosition.y}
            onClose={() => setMenuPosition(null)}
            items={[
              ...(hasWorkspace ? [
                { label: 'New File', icon: <FilePlus className="w-4 h-4" />, onClick: handleNewFileAtRoot },
                { label: 'New Folder', icon: <FolderPlus className="w-4 h-4" />, onClick: handleNewFolderAtRoot },
                { divider: true, label: '', onClick: () => { } }
              ] : []),
              { label: 'Open Folder...', icon: <FolderOpen className="w-4 h-4" />, onClick: handleOpenFolder },
              ...(hasWorkspace ? [
                { label: 'Close Folder', icon: <FolderClosed className="w-4 h-4" />, onClick: handleCloseFolder },
                { divider: true, label: '', onClick: () => { } },
                { label: 'Refresh', icon: <RefreshCw className="w-4 h-4" />, onClick: () => { refreshDirectory(); setMenuPosition(null); } },
                { label: 'Collapse All', icon: <ChevronsDownUp className="w-4 h-4" />, onClick: () => { handleCollapseAll(); setMenuPosition(null); } },
                { divider: true, label: '', onClick: () => { } },
                { label: 'Copy Path', icon: <Copy className="w-4 h-4" />, onClick: () => { navigator.clipboard.writeText(rootPath || ''); setMenuPosition(null); } }
              ] : [])
            ]}
          />
        )}
      </div>

      {/* Workspace Header - Folder name + Action Icons */}
      {hasWorkspace && (
        <div
          className="mx-2 mt-2 flex h-8 items-center gap-1 rounded-[14px] px-2.5"
          style={slimSurfaceStyle}
          title={rootPath || ''}
        >
          <ChevronDown className="w-3 h-3 text-text-secondary" />
          <Folder className="w-3.5 h-3.5 text-warning/80" />
          <span className="text-[11px] font-medium text-text-primary truncate flex-1 tracking-[0.01em]">
            {folderName}
          </span>

          <div className="flex items-center gap-1 rounded-[11px] px-1 py-0.5" style={slimSurfaceStyle}>
            <button
              onClick={handleNewFileAtRoot}
              className="flex h-5 w-5 items-center justify-center rounded-md text-text-disabled transition-colors hover:text-text-primary"
              title="New File"
            >
              <FilePlus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleNewFolderAtRoot}
              className="flex h-5 w-5 items-center justify-center rounded-md text-text-disabled transition-colors hover:text-text-primary"
              title="New Folder"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowSearch(!showSearch)}
              className={`flex h-5 w-5 items-center justify-center rounded-md transition-colors ${showSearch ? 'text-primary' : 'text-text-disabled hover:text-text-primary'}`}
              style={showSearch ? {
                backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)',
              } : undefined}
              title="Search"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Search bar */}
      {showSearch && hasWorkspace && (
        <div className="px-2 pb-2 pt-1 animate-in slide-in-from-top-2 duration-200">
          <div className="relative group">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled group-focus-within:text-primary transition-colors" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="w-full rounded-[14px] border px-8 py-2 text-[12px] text-text-primary placeholder:text-text-disabled transition-all focus:outline-none"
              style={slimSurfaceStyle}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-text-disabled transition-colors hover:text-text-primary hover:bg-sidebar-item-hover"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Content area - drop zone for moving files to root */}
      <div
        className={`flex-1 overflow-y-auto ${isDropTargetRoot ? 'bg-primary/10 ring-1 ring-primary/30 ring-inset' : ''}`}
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
    </div>
  );
};

// FIX: Export memoized version to prevent re-renders from parent components
export const MemoizedFileExplorer = React.memo(FileExplorer);
