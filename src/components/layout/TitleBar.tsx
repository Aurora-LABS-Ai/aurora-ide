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

import React, { useCallback } from "react";
import {
  Minus,
  Square,
  X,
  Settings,
  History,
  MessageSquare,
  ExternalLink,
  PanelLeft,
} from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { useDetachedChatWindow } from "../../hooks/useDetachedChatWindow";

export const TitleBar: React.FC = () => {
  const {
    setSettingsOpen,
    setAuditOpen,
    isChatOpen,
    toggleChat,
    isSidebarOpen,
    toggleSidebar,
  } = useUiStore();
  const { isDetached, createDetachedWindow, focusDetachedWindow } =
    useDetachedChatWindow();

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

  return (
    <div
      data-tauri-drag-region
      className="h-8 bg-titlebar flex items-center justify-between border-b border-border select-none"
      onMouseDown={handleMouseDown}
    >
      {/* Left side - App branding */}
      <div data-tauri-drag-region className="flex items-center h-full flex-1">
        <div data-tauri-drag-region className="flex items-center gap-2 px-3 h-full">
          <button
            onClick={toggleSidebar}
            className={`p-1 rounded transition-colors ${isSidebarOpen
              ? "text-primary bg-primary/10"
              : "text-text-secondary hover:text-text-primary hover:bg-input/50"
              }`}
            title={isSidebarOpen ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-border mx-1" />

          <img
            src="/aurora_icon.png"
            alt="Aurora"
            className="w-5 h-5 shrink-0"
          />
          <span
            data-tauri-drag-region
            className="text-[12px] text-text-secondary"
          >
            Aurora
          </span>
        </div>
      </div>

      {/* Right side - Actions + Window controls */}
      <div className="flex items-center h-full" data-no-drag>
        {/* Action buttons */}
        <div className="flex items-center gap-0.5 px-2">
          <button
            onClick={() => setAuditOpen(true)}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-input/50 rounded transition-colors"
            title="Audit Timeline"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-input/50 rounded transition-colors"
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          <div className="w-[1px] h-4 bg-border mx-1" />
          <button
            onClick={toggleChat}
            disabled={isDetached}
            className={`p-1.5 rounded transition-colors ${isDetached
              ? "text-text-disabled cursor-not-allowed"
              : isChatOpen
                ? "text-primary bg-primary/10"
                : "text-text-secondary hover:text-text-primary hover:bg-input/50"
              }`}
            title={
              isDetached
                ? "Chat is detached"
                : isChatOpen
                  ? "Hide AI Assistant"
                  : "Show AI Assistant"
            }
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDetachChat}
            className={`p-1.5 rounded transition-colors ${isDetached
              ? "text-primary bg-primary/10"
              : "text-text-secondary hover:text-text-primary hover:bg-input/50"
              }`}
            title={
              isDetached
                ? "Focus detached chat window"
                : "Detach chat to separate window"
            }
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Window controls */}
        <div className="flex items-center h-full ml-2">
          <button
            onClick={handleMinimize}
            className="w-12 h-full hover:bg-text-secondary/20 transition-colors flex items-center justify-center"
            title="Minimize"
          >
            <Minus className="w-4 h-4 text-text-secondary" />
          </button>
          <button
            onClick={handleMaximize}
            className="w-12 h-full hover:bg-text-secondary/20 transition-colors flex items-center justify-center"
            title="Maximize"
          >
            <Square className="w-3 h-3 text-text-secondary" />
          </button>
          <button
            onClick={handleClose}
            className="w-12 h-full hover:bg-danger transition-colors flex items-center justify-center group"
            title="Close"
          >
            <X className="w-4 h-4 text-text-secondary group-hover:text-danger-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
};
