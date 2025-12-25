import React, { useState, useRef, useEffect } from 'react';
import { MoreHorizontal, FolderOpen, RefreshCw, FilePlus, FolderPlus, Plus } from 'lucide-react';
import { FileTree } from './FileTree';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { isTauri } from '../../lib/tauri';

export const FileExplorer: React.FC = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { setRootPath, rootPath, files, loadDirectory } = useWorkspaceStore();

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

  const handleRefresh = () => {
    setMenuOpen(false);
    if (rootPath) {
      loadDirectory(rootPath);
    }
  };

  // Get folder name from path
  const folderName = rootPath ? rootPath.split(/[/\\]/).pop() : null;
  const hasFolder = files.length > 0;

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Header with menu */}
      <div className="h-8 px-2 flex items-center justify-between border-b border-border">
        <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider truncate">
          {folderName || 'NO FOLDER OPEN'}
        </span>
        
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1 text-text-secondary hover:text-text-primary hover:bg-input/50 rounded transition-colors"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-input border border-border rounded-md shadow-lg z-50 py-1">
              <button
                onClick={handleOpenFolder}
                className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/20 flex items-center gap-2"
              >
                <FolderOpen className="w-4 h-4" />
                Open Folder...
              </button>
              {hasFolder && (
                <>
                  <button
                    onClick={handleRefresh}
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/20 flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Refresh
                  </button>
                  <div className="h-[1px] bg-border my-1" />
                  <button
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-disabled cursor-not-allowed flex items-center gap-2"
                    disabled
                  >
                    <FilePlus className="w-4 h-4" />
                    New File
                  </button>
                  <button
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-disabled cursor-not-allowed flex items-center gap-2"
                    disabled
                  >
                    <FolderPlus className="w-4 h-4" />
                    New Folder
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {hasFolder ? (
          <div className="pt-1">
            <FileTree />
          </div>
        ) : (
          // Empty state - show open folder prompt
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <button
              onClick={handleOpenFolder}
              className="w-12 h-12 rounded-lg bg-input hover:bg-input-border border border-border hover:border-primary/50 flex items-center justify-center transition-all group mb-3"
              title="Open Folder"
            >
              <Plus className="w-6 h-6 text-text-secondary group-hover:text-primary transition-colors" />
            </button>
            <p className="text-[12px] text-text-secondary mb-1">No folder opened</p>
            <button
              onClick={handleOpenFolder}
              className="text-[11px] text-primary hover:underline"
            >
              Open a folder to start
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
