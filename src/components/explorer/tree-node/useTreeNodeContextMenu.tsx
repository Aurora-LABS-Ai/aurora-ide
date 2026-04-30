/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 *
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * See: DOCS/theme-dev.md for full token reference
 */

/**
 * useTreeNodeContextMenu Hook
 * Returns context menu items for files and folders in the explorer.
 *
 * Item shape mirrors the shared `MenuItem` interface so consumers can render
 * via `<ContextMenu />`. We expose section headers + dividers for IDE-style
 * grouping (Create / Edit / Clipboard / Workspace / Danger).
 */

import React from "react";
import {
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  Terminal,
  FolderOpen,
  FileText,
  Clipboard,
} from "lucide-react";

export interface ContextMenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  header?: string;
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

const ICON_CLASS = "w-3.5 h-3.5";

export const useTreeNodeContextMenu = (
  options: UseTreeNodeContextMenuOptions,
): ContextMenuItem[] => {
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

  if (isFolder) {
    return [
      { header: "Create" },
      {
        label: "New File",
        icon: <FilePlus className={ICON_CLASS} />,
        onClick: onNewFile,
        shortcut: "Ctrl+N",
      },
      {
        label: "New Folder",
        icon: <FolderPlus className={ICON_CLASS} />,
        onClick: onNewFolder,
        shortcut: "Ctrl+Shift+N",
      },
      { divider: true },
      { header: "Edit" },
      {
        label: "Rename",
        icon: <Pencil className={ICON_CLASS} />,
        onClick: onRename,
        shortcut: "F2",
      },
      { divider: true },
      { header: "Clipboard" },
      {
        label: "Copy Path",
        icon: <Copy className={ICON_CLASS} />,
        onClick: onCopyPath,
      },
      {
        label: "Copy Relative Path",
        icon: <Clipboard className={ICON_CLASS} />,
        onClick: onCopyRelativePath,
      },
      {
        label: "Copy Name",
        icon: <FileText className={ICON_CLASS} />,
        onClick: onCopyName,
      },
      { divider: true },
      { header: "Workspace" },
      {
        label: "Reveal in File Explorer",
        icon: <FolderOpen className={ICON_CLASS} />,
        onClick: onRevealInExplorer,
      },
      {
        label: "Open in Terminal",
        icon: <Terminal className={ICON_CLASS} />,
        onClick: onOpenInTerminal,
      },
      { divider: true },
      {
        label: "Delete",
        icon: <Trash2 className={ICON_CLASS} />,
        onClick: onDelete,
        danger: true,
        shortcut: "Del",
      },
    ];
  }

  return [
    { header: "Edit" },
    {
      label: "Rename",
      icon: <Pencil className={ICON_CLASS} />,
      onClick: onRename,
      shortcut: "F2",
    },
    { divider: true },
    { header: "Clipboard" },
    {
      label: "Copy Path",
      icon: <Copy className={ICON_CLASS} />,
      onClick: onCopyPath,
    },
    {
      label: "Copy Relative Path",
      icon: <Clipboard className={ICON_CLASS} />,
      onClick: onCopyRelativePath,
    },
    {
      label: "Copy Name",
      icon: <FileText className={ICON_CLASS} />,
      onClick: onCopyName,
    },
    { divider: true },
    { header: "Workspace" },
    {
      label: "Reveal in File Explorer",
      icon: <FolderOpen className={ICON_CLASS} />,
      onClick: onRevealInExplorer,
    },
    { divider: true },
    {
      label: "Delete",
      icon: <Trash2 className={ICON_CLASS} />,
      onClick: onDelete,
      danger: true,
      shortcut: "Del",
    },
  ];
};
