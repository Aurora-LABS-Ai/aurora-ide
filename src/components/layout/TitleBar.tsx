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

import React, { useCallback, useEffect, useState } from "react";
import {
  Minus,
  Square,
  X,
  History,
  ExternalLink,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
  Settings as SettingsIcon,
  FolderOpen,
  Save,
  FileText,
  FolderX,
  LogOut,
  Palette,
  Keyboard,
  Info,
  Clock,
  Folder,
  ChevronDown,
} from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { useDetachedChatWindow } from "../../hooks/useDetachedChatWindow";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useEditorStore } from "../../store/useEditorStore";
import { databaseService } from "../../services/database";
import { isTauri } from "../../lib/tauri";
import { AppIcon } from "../ui/AppIcon";
import { MenuBarMenu, type MenuBarItem } from "./MenuBarMenu";
import { TitleBarBrowserButton } from "./TitleBarBrowserButton";

const MAX_RECENT_WORKSPACES = 6;

const folderNameFromPath = (path: string): string => {
  if (!path) return path;
  const trimmed = path.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
};

export const TitleBar: React.FC = () => {
  const {
    openSettings,
    setAuditOpen,
    isChatOpen,
    toggleChat,
    isSidebarOpen,
    toggleSidebar,
  } = useUiStore();
  const { isDetached, createDetachedWindow, focusDetachedWindow } =
    useDetachedChatWindow();
  const setRootPath = useWorkspaceStore((s) => s.setRootPath);
  const clearWorkspace = useWorkspaceStore((s) => s.clearWorkspace);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const saveTabToDisk = useEditorStore((s) => s.saveTabToDisk);
  const tabs = useEditorStore((s) => s.tabs);
  const closeTab = useEditorStore((s) => s.closeTab);

  const [recentWorkspaces, setRecentWorkspaces] = useState<
    { path: string; name: string }[]
  >([]);

  const refreshRecentWorkspaces = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const items = await databaseService.listRecentWorkspaces(
        MAX_RECENT_WORKSPACES + 1,
      );
      const filtered = items
        .map((item) => item.workspace_path)
        .filter((p): p is string => Boolean(p) && p !== rootPath)
        .slice(0, MAX_RECENT_WORKSPACES)
        .map((path) => ({ path, name: folderNameFromPath(path) }));
      setRecentWorkspaces(filtered);
    } catch (err) {
      console.warn("[TitleBar] Failed to load recent workspaces:", err);
    }
  }, [rootPath]);

  useEffect(() => {
    refreshRecentWorkspaces();
  }, [refreshRecentWorkspaces]);

  const handleMinimize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error("Failed to minimize:", err);
    }
  }, []);

  const handleMaximize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error("Failed to maximize:", err);
    }
  }, []);

  const handleClose = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (err) {
      console.error("Failed to close:", err);
    }
  }, []);

  // Handle window dragging via mouse events (fallback for programmatic dragging)
  const handleMouseDown = useCallback(
    async (e: React.MouseEvent) => {
      // Only start drag if clicking on the drag region itself (not buttons)
      const target = e.target as HTMLElement;
      if (target.closest("button") || target.closest("[data-no-drag]")) return;

      if (e.buttons === 1) {
        // Left mouse button
        // Handle double-click to maximize
        if (e.detail === 2) {
          handleMaximize();
          return;
        }

        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().startDragging();
        } catch (err) {
          console.error("Failed to start dragging:", err);
        }
      }
    },
    [handleMaximize],
  );

  const handleDetachChat = useCallback(async () => {
    if (isDetached) {
      // If already detached, focus the detached window
      focusDetachedWindow();
    } else {
      // Create new detached window
      await createDetachedWindow();
    }
  }, [isDetached, createDetachedWindow, focusDetachedWindow]);

  const handleOpenFolder = useCallback(async () => {
    if (!isTauri()) {
      alert("Open Folder is only available in the desktop app.");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open Folder",
      });
      if (selected && typeof selected === "string") {
        setRootPath(selected);
      }
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  }, [setRootPath]);

  const handleSaveActive = useCallback(async () => {
    if (!activeTabId) return;
    await saveTabToDisk(activeTabId);
  }, [activeTabId, saveTabToDisk]);

  const handleSaveAll = useCallback(async () => {
    const dirty = tabs.filter((t) => t.isDirty && t.path);
    for (const tab of dirty) {
      await saveTabToDisk(tab.id);
    }
  }, [tabs, saveTabToDisk]);

  const handleCloseAllTabs = useCallback(() => {
    const ids = tabs.map((t) => t.id);
    ids.forEach((id) => closeTab(id));
  }, [tabs, closeTab]);

  const chromeButtonStyle: React.CSSProperties = {
    backgroundColor:
      "color-mix(in srgb, var(--aurora-common-secondary) 72%, var(--aurora-title-bar-background) 28%)",
    border:
      "1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)",
    boxShadow: `
      inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 4%, transparent),
      inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
    `,
  };

  const menuTriggerClassName =
    "h-7 px-2.5 inline-flex items-center gap-1.5 rounded-[6px] text-text-secondary hover:text-text-primary select-none cursor-pointer";

  // Wrapperless at idle: no bg, no border, no shadow. Only the hover/open
  // states (rendered via box-shadow inset by MenuBarMenu) provide chrome.
  const menuTriggerStyle: React.CSSProperties = {
    backgroundColor: "transparent",
    transition: "background-color 120ms ease, color 120ms ease, box-shadow 120ms ease",
  };

  const fileMenuItems: MenuBarItem[] = [
    {
      label: "Open Folder…",
      icon: <FolderOpen size={13} />,
      shortcut: "Ctrl+K Ctrl+O",
      onClick: () => {
        void handleOpenFolder();
      },
    },
    {
      label: "Open Recent",
      header: "Open Recent",
    },
    ...(recentWorkspaces.length > 0
      ? recentWorkspaces.map<MenuBarItem>((ws) => ({
          label: ws.name,
          icon: <Folder size={13} />,
          onClick: () => {
            setRootPath(ws.path);
          },
        }))
      : [
          {
            label: "No recent workspaces",
            disabled: true,
          } as MenuBarItem,
        ]),
    { divider: true },
    {
      label: "Save",
      icon: <Save size={13} />,
      shortcut: "Ctrl+S",
      disabled: !activeTabId,
      onClick: () => {
        void handleSaveActive();
      },
    },
    {
      label: "Save All",
      icon: <FileText size={13} />,
      shortcut: "Ctrl+K S",
      disabled: tabs.every((t) => !t.isDirty),
      onClick: () => {
        void handleSaveAll();
      },
    },
    { divider: true },
    {
      label: "Close All Editors",
      shortcut: "Ctrl+K W",
      disabled: tabs.length === 0,
      onClick: handleCloseAllTabs,
    },
    {
      label: "Close Folder",
      icon: <FolderX size={13} />,
      disabled: !rootPath,
      onClick: clearWorkspace,
    },
    { divider: true },
    {
      label: "Exit",
      icon: <LogOut size={13} />,
      shortcut: "Alt+F4",
      onClick: () => {
        void handleClose();
      },
    },
  ];

  const settingsMenuItems: MenuBarItem[] = [
    {
      label: "Settings",
      icon: <SettingsIcon size={13} />,
      shortcut: "Ctrl+,",
      onClick: () => openSettings(),
    },
    {
      label: "Theme & Appearance",
      icon: <Palette size={13} />,
      onClick: () => openSettings("themes"),
    },
    {
      label: "Keyboard Shortcuts",
      icon: <Keyboard size={13} />,
      shortcut: "Ctrl+K Ctrl+S",
      disabled: true,
    },
    { divider: true },
    {
      label: "Audit Timeline",
      icon: <Clock size={13} />,
      onClick: () => setAuditOpen(true),
    },
    { divider: true },
    {
      label: "About Aurora",
      icon: <Info size={13} />,
      onClick: () => openSettings("about"),
    },
  ];

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 items-center justify-between border-b select-none"
      style={{
        background:
          "color-mix(in srgb, var(--aurora-title-bar-background) 84%, var(--aurora-editor-background) 16%)",
        borderColor:
          "color-mix(in srgb, var(--aurora-common-border) 72%, transparent)",
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Left side - App branding + menu bar */}
      <div data-tauri-drag-region className="flex items-center h-full flex-1">
        <div
          data-tauri-drag-region
          className="flex items-center h-full pl-3 pr-2 gap-2"
        >
          <button
            onClick={toggleSidebar}
            className={`flex h-7 w-7 items-center justify-center rounded-[6px] transition-colors ${
              isSidebarOpen
                ? "text-primary bg-primary/10"
                : "text-text-secondary hover:text-text-primary hover:bg-input/50"
            }`}
            style={chromeButtonStyle}
            title={
              isSidebarOpen ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"
            }
          >
            <AppIcon icon={PanelLeft} size={16} />
          </button>

          <div className="mx-1 h-4 w-[1px] bg-border" />

          <img
            src="/aurora.png"
            alt="Aurora"
            className="h-4 w-4 shrink-0 object-contain"
          />
        </div>

        {/* Menu bar (VS Code-style) */}
        <div data-no-drag className="flex items-center h-full gap-px">
          <MenuBarMenu
            label="File"
            title="File menu"
            items={fileMenuItems}
            menuWidth={280}
            triggerClassName={menuTriggerClassName}
            triggerStyle={menuTriggerStyle}
          />
        </div>
      </div>

      {/* Center - workspace breadcrumb */}
      <div
        data-tauri-drag-region
        className="hidden md:flex items-center justify-center px-4 absolute left-1/2 -translate-x-1/2 pointer-events-none"
      >
        <span
          className="text-[12px] font-medium tracking-[0.01em]"
          style={{
            color: "color-mix(in srgb, var(--aurora-editor-foreground) 72%, transparent)",
          }}
        >
          {rootPath ? folderNameFromPath(rootPath) : "Aurora"}
        </span>
      </div>

      {/* Right side - Actions + Window controls */}
      <div className="flex items-center h-full" data-no-drag>
        {/* Action buttons */}
        <div className="flex items-center gap-1 px-2">
          <TitleBarBrowserButton chromeButtonStyle={chromeButtonStyle} />

          <button
            onClick={() => setAuditOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary transition-colors hover:text-text-primary hover:bg-input/50"
            style={chromeButtonStyle}
            title="Audit Timeline"
          >
            <AppIcon icon={History} size={14} />
          </button>

          <MenuBarMenu
            label="Settings"
            title="Settings menu"
            align="end"
            menuWidth={250}
            items={settingsMenuItems}
            triggerIcon={
              <span className="flex items-center gap-1">
                <AppIcon icon={SettingsIcon} size={14} />
                <ChevronDown size={10} style={{ opacity: 0.6 }} />
              </span>
            }
            triggerClassName="h-7 px-2 inline-flex items-center justify-center rounded-[6px] text-text-secondary hover:text-text-primary transition-colors"
            triggerStyle={chromeButtonStyle}
          />
          <div className="w-[1px] h-4 bg-border mx-1" />
          <button
            onClick={toggleChat}
            disabled={isDetached}
            className={`flex h-7 w-7 items-center justify-center rounded-[6px] transition-colors ${
              isDetached
                ? "text-text-disabled cursor-not-allowed"
                : isChatOpen
                  ? "text-primary bg-primary/10"
                  : "text-text-secondary hover:text-text-primary hover:bg-input/50"
            }`}
            style={chromeButtonStyle}
            title={
              isDetached
                ? "Chat is detached"
                : isChatOpen
                  ? "Hide AI Assistant"
                  : "Show AI Assistant"
            }
          >
            <AppIcon
              icon={isChatOpen ? PanelRightClose : PanelRightOpen}
              size={14}
            />
          </button>
          <button
            onClick={handleDetachChat}
            className={`flex h-7 w-7 items-center justify-center rounded-[6px] transition-colors ${
              isDetached
                ? "text-primary bg-primary/10"
                : "text-text-secondary hover:text-text-primary hover:bg-input/50"
            }`}
            style={chromeButtonStyle}
            title={
              isDetached
                ? "Focus detached chat window"
                : "Detach chat to separate window"
            }
          >
            <AppIcon icon={ExternalLink} size={14} />
          </button>
        </div>

        {/* Window controls */}
        <div className="ml-2 flex items-center h-full border-l border-border">
          <button
            onClick={handleMinimize}
            className="flex h-full w-11 items-center justify-center transition-colors hover:bg-text-secondary/20"
            title="Minimize"
          >
            <AppIcon icon={Minus} size={16} className="text-text-secondary" />
          </button>
          <button
            onClick={handleMaximize}
            className="flex h-full w-11 items-center justify-center transition-colors hover:bg-text-secondary/20"
            title="Maximize"
          >
            <AppIcon icon={Square} size={12} className="text-text-secondary" />
          </button>
          <button
            onClick={handleClose}
            className="group flex h-full w-11 items-center justify-center transition-colors hover:bg-danger"
            title="Close"
          >
            <AppIcon
              icon={X}
              size={16}
              className="text-text-secondary group-hover:text-danger-foreground"
            />
          </button>
        </div>
      </div>
    </div>
  );
};
