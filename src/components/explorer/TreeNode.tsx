import React, { useState, useRef, useEffect } from 'react';
import { 
  ChevronRight, ChevronDown, File, Folder, FolderOpen, 
  FileJson, FileCode, FileText, FilePlus, FolderPlus, 
  Pencil, Trash2, Copy 
} from 'lucide-react';
import type { FileNode } from '../../types';
import clsx from 'clsx';
import { useWorkspaceStore, loadFileContent } from '../../store/useWorkspaceStore';
import { useEditorStore } from '../../store/useEditorStore';
import { ContextMenu } from '../ui/ContextMenu';
import { createFile, createFolder, deletePath, renamePath, isTauri } from '../../lib/tauri';

interface TreeNodeProps {
  node: FileNode;
  level: number;
}

const getLanguageFromExtension = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'json': 'json',
    'css': 'css',
    'scss': 'scss',
    'html': 'html',
    'md': 'markdown',
    'rs': 'rust',
    'toml': 'toml',
  };
  return langMap[ext || ''] || 'plaintext';
};

const getFileIcon = (name: string) => {
  if (name.endsWith('.tsx') || name.endsWith('.ts')) return <FileCode className="w-4 h-4 text-[#519aba]" />;
  if (name.endsWith('.jsx') || name.endsWith('.js')) return <FileCode className="w-4 h-4 text-[#f7df1e]" />;
  if (name.endsWith('.css') || name.endsWith('.scss')) return <FileCode className="w-4 h-4 text-[#563d7c]" />;
  if (name.endsWith('.json')) return <FileJson className="w-4 h-4 text-warning" />;
  if (name.endsWith('.md')) return <FileText className="w-4 h-4 text-[#519aba]" />;
  if (name.endsWith('.rs')) return <FileCode className="w-4 h-4 text-[#dea584]" />;
  if (name.endsWith('.toml')) return <FileCode className="w-4 h-4 text-[#9c4221]" />;
  if (name.endsWith('.html')) return <FileCode className="w-4 h-4 text-[#e34c26]" />;
  return <File className="w-4 h-4 text-text-secondary" />;
};

export const TreeNode: React.FC<TreeNodeProps> = ({ node, level }) => {
  const { expandedFolders, toggleFolder, expandFolder, selectedFileId, selectFile, refreshDirectory } = useWorkspaceStore();
  const { openFile } = useEditorStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isCreating, setIsCreating] = useState<'file' | 'folder' | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  
  const isExpanded = expandedFolders.has(node.id);
  const isSelected = selectedFileId === node.id;
  const isFolder = node.type === 'folder';

  useEffect(() => {
    if ((isCreating || isRenaming) && inputRef.current) {
      inputRef.current.focus();
      if (isRenaming) {
        const lastDot = node.name.lastIndexOf('.');
        if (lastDot > 0 && !isFolder) {
          inputRef.current.setSelectionRange(0, lastDot);
        } else {
          inputRef.current.select();
        }
      }
    }
  }, [isCreating, isRenaming, node.name, isFolder]);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFolder) {
      toggleFolder(node.id);
    } else {
      selectFile(node.id);
      const content = node.content || await loadFileContent(node.path || node.id);
      openFile(node.id, node.name, content, node.language);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selectFile(node.id);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const getNodePath = () => node.path || node.id;

  const handleNewFile = () => {
    // Ensure folder is expanded
    if (!isExpanded) {
      expandFolder(node.id);
    }
    setIsCreating('file');
    setInputValue('');
  };

  const handleNewFolder = () => {
    if (!isExpanded) {
      expandFolder(node.id);
    }
    setIsCreating('folder');
    setInputValue('');
  };

  const handleRename = () => {
    setIsRenaming(true);
    setInputValue(node.name);
  };

  const handleDelete = async () => {
    if (!isTauri()) {
      console.log('Delete not available in web mode');
      return;
    }
    
    const confirmed = window.confirm(`Are you sure you want to delete "${node.name}"?`);
    if (!confirmed) return;
    
    try {
      await deletePath(getNodePath());
      await refreshDirectory();
    } catch (err) {
      console.error('Failed to delete:', err);
      alert(`Failed to delete: ${err}`);
    }
  };

  const handleCopyPath = async () => {
    const path = getNodePath();
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      console.error('Failed to copy path');
    }
  };

  const handleCreateSubmit = async () => {
    if (!inputValue.trim()) {
      setIsCreating(null);
      return;
    }

    if (!isTauri()) {
      console.log('Create not available in web mode');
      setIsCreating(null);
      return;
    }

    const parentPath = getNodePath();
    const separator = parentPath.includes('\\') ? '\\' : '/';
    const newPath = `${parentPath}${separator}${inputValue.trim()}`;
    const creatingFile = isCreating === 'file';

    try {
      if (creatingFile) {
        await createFile(newPath);
      } else {
        await createFolder(newPath);
      }
      
      // Ensure parent folder stays expanded
      expandFolder(node.id);
      
      // Refresh directory tree
      await refreshDirectory();
      
      // If we created a file, open it in the editor
      if (creatingFile) {
        const language = getLanguageFromExtension(inputValue.trim());
        selectFile(newPath);
        openFile(newPath, inputValue.trim(), '', language);
      }
    } catch (err) {
      console.error('Failed to create:', err);
      alert(`Failed to create: ${err}`);
    }

    setIsCreating(null);
    setInputValue('');
  };

  const handleRenameSubmit = async () => {
    if (!inputValue.trim() || inputValue === node.name) {
      setIsRenaming(false);
      return;
    }

    if (!isTauri()) {
      console.log('Rename not available in web mode');
      setIsRenaming(false);
      return;
    }

    const currentPath = getNodePath();
    const separator = currentPath.includes('\\') ? '\\' : '/';
    const parentPath = currentPath.substring(0, currentPath.lastIndexOf(separator));
    const newPath = `${parentPath}${separator}${inputValue.trim()}`;

    try {
      await renamePath(currentPath, newPath);
      await refreshDirectory();
    } catch (err) {
      console.error('Failed to rename:', err);
      alert(`Failed to rename: ${err}`);
    }

    setIsRenaming(false);
    setInputValue('');
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isCreating) {
        handleCreateSubmit();
      } else if (isRenaming) {
        handleRenameSubmit();
      }
    } else if (e.key === 'Escape') {
      setIsCreating(null);
      setIsRenaming(false);
      setInputValue('');
    }
  };

  const handleInputBlur = () => {
    if (isCreating) {
      handleCreateSubmit();
    } else if (isRenaming) {
      handleRenameSubmit();
    }
  };

  const folderMenuItems = [
    {
      label: 'New File',
      icon: <FilePlus className="w-4 h-4" />,
      onClick: handleNewFile,
    },
    {
      label: 'New Folder',
      icon: <FolderPlus className="w-4 h-4" />,
      onClick: handleNewFolder,
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: 'Rename',
      icon: <Pencil className="w-4 h-4" />,
      onClick: handleRename,
    },
    {
      label: 'Copy Path',
      icon: <Copy className="w-4 h-4" />,
      onClick: handleCopyPath,
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: 'Delete',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: handleDelete,
      danger: true,
    },
  ];

  const fileMenuItems = [
    {
      label: 'Rename',
      icon: <Pencil className="w-4 h-4" />,
      onClick: handleRename,
    },
    {
      label: 'Copy Path',
      icon: <Copy className="w-4 h-4" />,
      onClick: handleCopyPath,
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: 'Delete',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: handleDelete,
      danger: true,
    },
  ];

  return (
    <div>
      {isRenaming ? (
        <div 
          className="flex items-center gap-1 py-[2px] px-2"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          <span className="text-text-secondary">
            {isFolder && <ChevronRight className="w-4 h-4" />}
            {!isFolder && <div className="w-4" />}
          </span>
          {isFolder ? (
            <Folder className="w-4 h-4 text-[#dcb67a]" />
          ) : (
            getFileIcon(node.name)
          )}
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={handleInputBlur}
            className="flex-1 bg-input border border-primary rounded px-1.5 py-0.5 text-[13px] text-text-primary outline-none"
          />
        </div>
      ) : (
        <div 
          className={clsx(
            "flex items-center gap-1 py-[2px] px-2 cursor-pointer select-none hover:bg-input/50 transition-colors",
            isSelected && "bg-input"
          )}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        >
          <span className="text-text-secondary">
            {isFolder && (
              isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
            )}
            {!isFolder && <div className="w-4" />} 
          </span>
          
          {isFolder ? (
            isExpanded ? <FolderOpen className="w-4 h-4 text-[#dcb67a]" /> : <Folder className="w-4 h-4 text-[#dcb67a]" />
          ) : (
            getFileIcon(node.name)
          )}
          
          <span className="text-[13px] truncate text-text-primary">{node.name}</span>
        </div>
      )}
      
      {isFolder && isExpanded && (
        <>
          {isCreating && (
            <div 
              className="flex items-center gap-1 py-[2px] px-2"
              style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }}
            >
              <span className="text-text-secondary">
                <div className="w-4" />
              </span>
              {isCreating === 'folder' ? (
                <Folder className="w-4 h-4 text-[#dcb67a]" />
              ) : (
                <File className="w-4 h-4 text-text-secondary" />
              )}
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleInputKeyDown}
                onBlur={handleInputBlur}
                placeholder={isCreating === 'file' ? 'filename.ext' : 'folder name'}
                className="flex-1 bg-input border border-primary rounded px-1.5 py-0.5 text-[13px] text-text-primary outline-none placeholder:text-text-disabled"
              />
            </div>
          )}
          {node.children?.map(child => (
            <TreeNode key={child.id} node={child} level={level + 1} />
          ))}
        </>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={isFolder ? folderMenuItems : fileMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
