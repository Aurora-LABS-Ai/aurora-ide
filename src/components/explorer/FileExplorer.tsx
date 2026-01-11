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

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  MoreVertical, FolderOpen, FilePlus, FolderPlus,
  Plus, ChevronDown, Search, X, RefreshCw,
  Folder, FolderClosed, ChevronsDownUp, Copy
} from 'lucide-react';
import { FileTree } from './FileTree';
import { ContextMenu } from '../ui/ContextMenu';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useDragStore } from '../../store/useDragStore';
import { isTauri, createFile, createFolder } from '../../lib/tauri';
import { useExplorerKeyboard } from '../../hooks/useExplorerKeyboard';

export const FileExplorer: React.FC = () => {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [isCreating, setIsCreating] = useState<{ type: 'file' | 'folder'; parentId: string } | null>(null);
  const [createInputValue, setCreateInputValue] = useState('');
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // FIX: Use shallow equality selector to prevent re-renders when unrelated store values change
  const setRootPath = useWorkspaceStore(state => state.setRootPath);
  const rootPath = useWorkspaceStore(state => state.rootPath);
  const files = useWorkspaceStore(state => state.files);
  const refreshDirectory = useWorkspaceStore(state => state.refreshDirectory);
  const selectFile = useWorkspaceStore(state => state.selectFile);
  const clearWorkspace = useWorkspaceStore(state => state.clearWorkspace);
  const { isDragging, dropTargetType } = useDragStore();
  const hasFolder = files.length > 0;

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


  // Collapse all folders
  const handleCollapseAll = useCallback(() => {
    const store = useWorkspaceStore.getState();
    store.expandedFolders.clear();
    useWorkspaceStore.setState({ expandedFolders: new Set() });
    store.saveExplorer();
  }, []);

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
      await refreshDirectory();
      selectFile(newPath);
    } catch (err) {
      console.error('Failed to create:', err);
      alert(`Failed to create: ${err}`);
    }

    setIsCreating(null);
    setCreateInputValue('');
  }, [isCreating, createInputValue, refreshDirectory, selectFile]);

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

  const filteredFiles = filterFiles(files, searchQuery);

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

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Explorer Title Bar - Premium Header */}
      <div className="h-9 px-4 flex items-center justify-between border-b border-white/5 bg-sidebar/50 backdrop-blur-sm select-none">
        <span className="text-[11px] font-bold text-text-secondary uppercase tracking-widest opacity-80">
          Explorer
        </span>

        {/* Menu Button */}
        <button
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
          }}
          className={`p-1 rounded-md transition-all duration-200 ${menuPosition
            ? 'text-text-primary'
            : 'text-text-disabled hover:text-text-secondary hover:bg-white/5'
            }`}
          style={{
            backgroundColor: menuPosition ? 'var(--aurora-sidebar-itemSelected)' : undefined
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
              ...(hasFolder ? [
                { label: 'New File', icon: <FilePlus className="w-4 h-4" />, onClick: handleNewFileAtRoot },
                { label: 'New Folder', icon: <FolderPlus className="w-4 h-4" />, onClick: handleNewFolderAtRoot },
                { divider: true, label: '', onClick: () => { } }
              ] : []),
              { label: 'Open Folder...', icon: <FolderOpen className="w-4 h-4" />, onClick: handleOpenFolder },
              ...(hasFolder ? [
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
      {hasFolder && (
        <div
          className="h-[22px] px-2 flex items-center gap-1"
          title={rootPath || ''}
        >
          <ChevronDown className="w-3 h-3 text-text-secondary" />
          <Folder className="w-3.5 h-3.5 text-warning/80" />
          <span className="text-[11px] font-medium text-text-primary truncate flex-1">
            {folderName}
          </span>

          {/* Action icons - always visible, flat/embedded style */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleNewFileAtRoot}
              className="p-0.5 text-text-disabled hover:text-text-primary transition-colors"
              title="New File"
            >
              <FilePlus className="w-4 h-4" />
            </button>
            <button
              onClick={handleNewFolderAtRoot}
              className="p-0.5 text-text-disabled hover:text-text-primary transition-colors"
              title="New Folder"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowSearch(!showSearch)}
              className={`p-0.5 transition-colors ${showSearch ? 'text-primary' : 'text-text-disabled hover:text-text-primary'}`}
              title="Search"
            >
              <Search className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Search bar */}
      {showSearch && hasFolder && (
        <div className="px-3 py-2 border-b border-border/40 bg-sidebar/80 backdrop-blur-sm animate-in slide-in-from-top-2 duration-200">
          <div className="relative group">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled group-focus-within:text-primary transition-colors" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="w-full pl-8 pr-8 py-1.5 text-[12px] bg-input/50 hover:bg-input border border-border/50 rounded-md focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20 text-text-primary placeholder:text-text-disabled transition-all shadow-sm"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-disabled hover:text-text-primary transition-colors hover:bg-white/10 rounded-full p-0.5"
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
        {hasFolder ? (
          <div className="pt-1">
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
          </div>
        ) : (
          // Empty state - show open folder prompt
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center mb-4 shadow-lg shadow-primary/5">
              <FolderOpen className="w-8 h-8 text-primary/70" />
            </div>
            <p className="text-[13px] font-medium text-text-primary mb-1">No folder opened</p>
            <p className="text-[11px] text-text-disabled mb-4">Open a folder to start exploring</p>
            <button
              onClick={handleOpenFolder}
              className="px-4 py-2 text-[12px] font-medium text-primary bg-primary/10 hover:bg-primary/20 border border-primary/30 rounded-lg transition-all duration-200 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Open Folder
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// FIX: Export memoized version to prevent re-renders from parent components
export const MemoizedFileExplorer = React.memo(FileExplorer);
