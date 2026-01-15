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

import React, { useCallback, useState, useEffect } from "react";
import { X, Minus, Pin, PinOff, ArrowLeftToLine } from "lucide-react";
import { ChatPanel } from "./ChatPanel";
import { useUiStore } from "../../store/useUiStore";
import { useThemeStore } from "../../store/useThemeStore";
import { useRustChatSync } from "../../hooks/useRustChatSync";
import { useMemo } from "react";

const CHAT_WINDOW_LABEL = "chat-detached";

export const DetachedChatWindow: React.FC = () => {
  const { reattachChat } = useUiStore();
  const { activeThemeId, themes } = useThemeStore();

  const themeMode = useMemo(() => {
    const activeTheme = themes.find(t => t.id === activeThemeId);
    return activeTheme?.type || 'dark';
  }, [activeThemeId, themes]);

  const [isPinned, setIsPinned] = useState(false);
  const [isReady, setIsReady] = useState(false);

  // Initialize Rust-based cross-window state sync (bulletproof)
  useRustChatSync();

  // Wait briefly for state sync to complete
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsReady(true);
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  const handleMinimize = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error("Failed to minimize:", err);
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

  const handleReattach = useCallback(async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      reattachChat();
      const chatWindow = await WebviewWindow.getByLabel(CHAT_WINDOW_LABEL);
      if (chatWindow) {
        await chatWindow.close();
      }
    } catch (err) {
      console.error("Failed to reattach:", err);
      reattachChat();
    }
  }, [reattachChat]);

  const handleTogglePin = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const newPinned = !isPinned;
      await getCurrentWindow().setAlwaysOnTop(newPinned);
      setIsPinned(newPinned);
    } catch (err) {
      console.error("Failed to toggle pin:", err);
    }
  }, [isPinned]);

  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("[data-no-drag]")) return;

    if (e.buttons === 1) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().startDragging();
      } catch (err) {
        console.error("Failed to start dragging:", err);
      }
    }
  }, []);

  return (
    <div
      className={`h-screen flex flex-col bg-sidebar text-text-primary overflow-hidden ${themeMode === "dark" ? "dark" : ""}`}
      style={{ colorScheme: themeMode }}
    >
      {/* Custom Title Bar for Detached Window */}
      <div
        data-tauri-drag-region
        className="h-8 bg-titlebar flex items-center justify-between border-b border-border select-none shrink-0"
        onMouseDown={handleMouseDown}
      >
        {/* Left side - Title */}
        <div data-tauri-drag-region className="flex items-center h-full flex-1">
          <div
            data-tauri-drag-region
            className="flex items-center gap-2 px-3 h-full"
          >
            <img
              src="/app-icon.svg"
              alt="Aurora"
              className="w-5 h-5 shrink-0"
            />
            <span
              data-tauri-drag-region
              className="text-[12px] text-text-secondary"
            >
              Aurora Chat
            </span>
          </div>
        </div>

        {/* Right side - Actions + Window controls */}
        <div className="flex items-center h-full" data-no-drag>
          {/* Action buttons */}
          <div className="flex items-center gap-0.5 px-2">
            <button
              onClick={handleReattach}
              className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-input/50 rounded transition-colors"
              title="Reattach to main window"
            >
              <ArrowLeftToLine className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleTogglePin}
              className={`p-1.5 rounded transition-colors ${isPinned ? "text-primary bg-primary/10" : "text-text-secondary hover:text-text-primary hover:bg-input/50"}`}
              title={isPinned ? "Unpin window" : "Pin window on top"}
            >
              {isPinned ? (
                <PinOff className="w-3.5 h-3.5" />
              ) : (
                <Pin className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          {/* Window controls */}
          <div className="flex items-center h-full ml-2">
            <button
              onClick={handleMinimize}
              className="w-10 h-full hover:bg-text-secondary/20 transition-colors flex items-center justify-center"
              title="Minimize"
            >
              <Minus className="w-4 h-4 text-text-secondary" />
            </button>
            <button
              onClick={handleClose}
              className="w-10 h-full hover:bg-danger transition-colors flex items-center justify-center group"
              title="Close"
            >
              <X className="w-4 h-4 text-text-secondary group-hover:text-white" />
            </button>
          </div>
        </div>
      </div>

      {/* Chat Content - Uses the same ChatPanel */}
      <div className="flex-1 overflow-hidden">
        {isReady ? (
          <ChatPanel isDetached />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <img
                src="/app-icon.svg"
                alt="Aurora"
                className="w-8 h-8 animate-pulse"
              />
              <span className="text-xs text-text-secondary">Syncing...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
