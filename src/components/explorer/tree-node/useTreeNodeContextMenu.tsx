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

/**
 * useTreeNodeContextMenu Hook
 * Returns context menu items for files and folders
 */

import React from 'react';
import {
    FilePlus, FolderPlus, Pencil, Trash2, Copy,
    Terminal, FolderOpen, FileText, Clipboard
} from 'lucide-react';

export interface ContextMenuItem {
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    shortcut?: string;
    danger?: boolean;
    divider?: boolean;
}

interface UseTreeNodeContextMenuOptions {
    isFolder: boolean;
    onNewFile: () => void;
    onNewFolder: () => void;
    onRename: () => void;
    onDelete: () => void;
    onCopyPath: () => void;
    onCopyRelativePath: () => void;
    onCopyName: () => void;
    onRevealInExplorer: () => void;
    onOpenInTerminal: () => void;
}

export const useTreeNodeContextMenu = (options: UseTreeNodeContextMenuOptions): ContextMenuItem[] => {
    const {
        isFolder,
        onNewFile,
        onNewFolder,
        onRename,
        onDelete,
        onCopyPath,
        onCopyRelativePath,
        onCopyName,
        onRevealInExplorer,
        onOpenInTerminal,
    } = options;

    const folderItems: ContextMenuItem[] = [
        {
            label: 'New File',
            icon: <FilePlus className="w-4 h-4" />,
      onClick: onNewFile,
            shortcut: 'Ctrl+N',
        },
        {
            label: 'New Folder',
            icon: <FolderPlus className="w-4 h-4" />,
      onClick: onNewFolder,
            shortcut: 'Ctrl+Shift+N',
        },
        { divider: true, label: '', onClick: () => { } },
        {
            label: 'Rename',
            icon: <Pencil className="w-4 h-4" />,
      onClick: onRename,
            shortcut: 'F2',
        },
        { divider: true, label: '', onClick: () => { } },
        {
            label: 'Copy Path',
            icon: <Copy className="w-4 h-4" />,
      onClick: onCopyPath,
        },
        {
            label: 'Copy Relative Path',
            icon: <Clipboard className="w-4 h-4" />,
      onClick: onCopyRelativePath,
        },
        {
            label: 'Copy Name',
            icon: <FileText className="w-4 h-4" />,
      onClick: onCopyName,
        },
        { divider: true, label: '', onClick: () => { } },
        {
            label: 'Reveal in File Explorer',
            icon: <FolderOpen className="w-4 h-4" />,
      onClick: onRevealInExplorer,
        },
        {
            label: 'Open in Terminal',
            icon: <Terminal className="w-4 h-4" />,
      onClick: onOpenInTerminal,
        },
        { divider: true, label: '', onClick: () => { } },
        {
            label: 'Delete',
            icon: <Trash2 className="w-4 h-4" />,
      onClick: onDelete,
            danger: true,
            shortcut: 'Del',
        },
    ];

    const fileItems: ContextMenuItem[] = [
        {
            label: 'Rename',
            icon: <Pencil className="w-4 h-4" />,
      onClick: onRename,
            shortcut: 'F2',
        },
        { divider: true, label: '', onClick: () => { } },
        {
            label: 'Copy Path',
            icon: <Copy className="w-4 h-4" />,
      onClick: onCopyPath,
        },
        {
            label: 'Copy Relative Path',
            icon: <Clipboard className="w-4 h-4" />,
      onClick: onCopyRelativePath,
        },
        {
            label: 'Copy Name',
            icon: <FileText className="w-4 h-4" />,
      onClick: onCopyName,
        },
        { divider: true, label: '', onClick: () => { } },
        {
            label: 'Reveal in File Explorer',
            icon: <FolderOpen className="w-4 h-4" />,
      onClick: onRevealInExplorer,
        },
        { divider: true, label: '', onClick: () => { } },
        {
            label: 'Delete',
            icon: <Trash2 className="w-4 h-4" />,
      onClick: onDelete,
            danger: true,
            shortcut: 'Del',
        },
    ];

    return isFolder ? folderItems : fileItems;
};
