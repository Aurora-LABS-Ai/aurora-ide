import React, { useState, useRef, useEffect } from 'react';
import { MoreHorizontal, FolderOpen, RefreshCw, FilePlus, FolderPlus, Plus, Save, Check } from 'lucide-react';
import { FileTree } from './FileTree';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { isTauri } from '../../lib/tauri';

export const FileExplorer: React.FC = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoSaveMenuOpen, setAutoSaveMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { setRootPath, rootPath, files, loadDirectory } = useWorkspaceStore();
  const { autoSave, setAutoSave } = useSettingsStore();

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
              
              {/* Autosave Section */}
              <div className="h-[1px] bg-border my-1" />
              <div 
                className="relative group"
                onMouseEnter={() => setAutoSaveMenuOpen(true)}
                onMouseLeave={() => setAutoSaveMenuOpen(false)}
              >
                <button
                  onClick={() => setAutoSaveMenuOpen(!autoSaveMenuOpen)}
                  className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/20 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Save className="w-4 h-4" />
                    Auto Save
                  </span>
                  <span className="text-text-secondary text-[10px]">
                    {autoSave === 'off' ? 'Off' : 
                     autoSave === 'afterDelay' ? 'After Delay' :
                     autoSave === 'onFocusChange' ? 'Focus Change' : 'Window Change'}
                  </span>
                </button>
                
                {autoSaveMenuOpen && (
                  <>
                    {/* Invisible bridge to prevent hover gap */}
                    <div className="absolute left-full top-0 w-2 h-full" />
                    <div 
                      className="absolute left-full top-0 ml-1 w-44 bg-input border border-border rounded-md shadow-lg z-50 py-1"
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); setAutoSave('off'); setMenuOpen(false); setAutoSaveMenuOpen(false); }}
                        className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/20 flex items-center justify-between"
                      >
                        <span>Off</span>
                        {autoSave === 'off' && <Check className="w-3 h-3 text-primary" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setAutoSave('afterDelay'); setMenuOpen(false); setAutoSaveMenuOpen(false); }}
                        className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/20 flex items-center justify-between"
                      >
                        <span>After Delay (1s)</span>
                        {autoSave === 'afterDelay' && <Check className="w-3 h-3 text-primary" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setAutoSave('onFocusChange'); setMenuOpen(false); setAutoSaveMenuOpen(false); }}
                        className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/20 flex items-center justify-between"
                      >
                        <span>On Focus Change</span>
                        {autoSave === 'onFocusChange' && <Check className="w-3 h-3 text-primary" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setAutoSave('onWindowChange'); setMenuOpen(false); setAutoSaveMenuOpen(false); }}
                        className="w-full px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/20 flex items-center justify-between"
                      >
                        <span>On Window Change</span>
                        {autoSave === 'onWindowChange' && <Check className="w-3 h-3 text-primary" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
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
