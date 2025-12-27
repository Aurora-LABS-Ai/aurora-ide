import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  MoreVertical, FolderOpen, FilePlus, FolderPlus,
  Plus, ChevronDown, Search, X, RefreshCw,
  Folder, FolderClosed, ChevronsDownUp, Copy
} from 'lucide-react';
import { FileTree } from './FileTree';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useDragStore } from '../../store/useDragStore';
import { isTauri, createFile, createFolder } from '../../lib/tauri';
import { useExplorerKeyboard } from '../../hooks/useExplorerKeyboard';


export const FileExplorer: React.FC = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [isCreating, setIsCreating] = useState<{ type: 'file' | 'folder'; parentId: string } | null>(null);
  const [createInputValue, setCreateInputValue] = useState('');
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { setRootPath, rootPath, files, refreshDirectory, selectFile, clearWorkspace } = useWorkspaceStore();
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

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    setMenuOpen(false);
    if (!rootPath) return;
    setIsCreating({ type: 'file', parentId: rootPath });
    setCreateInputValue('');
  }, [rootPath]);

  // Handle new folder at root
  const handleNewFolderAtRoot = useCallback(() => {
    setMenuOpen(false);
    if (!rootPath) return;
    setIsCreating({ type: 'folder', parentId: rootPath });
    setCreateInputValue('');
  }, [rootPath]);

  // Handle close folder
  const handleCloseFolder = useCallback(() => {
    setMenuOpen(false);
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
    setMenuOpen(false);

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
      {/* Explorer Title Bar */}
      <div className="h-[22px] px-3 flex items-center justify-between">
        <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider">
          Explorer
        </span>

        {/* Menu Button */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className={`p-0.5 rounded transition-colors ${menuOpen
              ? 'text-text-primary'
              : 'text-text-disabled hover:text-text-secondary'
              }`}
            title="More Actions"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {/* Dropdown Menu */}
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-[#252526] border border-border/60 rounded-md shadow-xl shadow-black/40 z-50 py-1">
              {/* File Actions */}
              {hasFolder && (
                <>
                  <button
                    onClick={() => { setMenuOpen(false); handleNewFileAtRoot(); }}
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/10 flex items-center gap-2 transition-colors"
                  >
                    <FilePlus className="w-4 h-4 text-text-secondary" />
                    New File
                  </button>
                  <button
                    onClick={() => { setMenuOpen(false); handleNewFolderAtRoot(); }}
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/10 flex items-center gap-2 transition-colors"
                  >
                    <FolderPlus className="w-4 h-4 text-text-secondary" />
                    New Folder
                  </button>
                  <div className="h-px bg-border/40 my-1 mx-2" />
                </>
              )}

              {/* Workspace Actions */}
              <button
                onClick={handleOpenFolder}
                className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/10 flex items-center gap-2 transition-colors"
              >
                <FolderOpen className="w-4 h-4 text-text-secondary" />
                Open Folder...
              </button>
              {hasFolder && (
                <>
                  <button
                    onClick={handleCloseFolder}
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/10 flex items-center gap-2 transition-colors"
                  >
                    <FolderClosed className="w-4 h-4 text-text-secondary" />
                    Close Folder
                  </button>
                  <div className="h-px bg-border/40 my-1 mx-2" />
                  <button
                    onClick={() => { setMenuOpen(false); refreshDirectory(); }}
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/10 flex items-center gap-2 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4 text-text-secondary" />
                    Refresh
                  </button>
                  <button
                    onClick={() => { setMenuOpen(false); handleCollapseAll(); }}
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/10 flex items-center gap-2 transition-colors"
                  >
                    <ChevronsDownUp className="w-4 h-4 text-text-secondary" />
                    Collapse All
                  </button>
                  <div className="h-px bg-border/40 my-1 mx-2" />
                  <button
                    onClick={() => { setMenuOpen(false); navigator.clipboard.writeText(rootPath || ''); }}
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/10 flex items-center gap-2 transition-colors"
                  >
                    <Copy className="w-4 h-4 text-text-secondary" />
                    Copy Path
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Workspace Header - Folder name + Action Icons */}
      {hasFolder && (
        <div
          className="h-[22px] px-2 flex items-center gap-1"
          title={rootPath || ''}
        >
          <ChevronDown className="w-3 h-3 text-text-secondary" />
          <Folder className="w-3.5 h-3.5 text-amber-500/80" />
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
        <div className="px-2 py-2 border-b border-border/60 bg-sidebar/80">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="w-full pl-8 pr-8 py-1.5 text-[12px] bg-[#1e1e1e] border border-border/80 rounded-md focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20 text-text-primary placeholder:text-text-disabled transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-disabled hover:text-text-primary transition-colors"
              >
                <X className="w-3.5 h-3.5" />
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
