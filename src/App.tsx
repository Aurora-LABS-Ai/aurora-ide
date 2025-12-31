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

import { useEffect, useState } from "react";
import { MainLayout } from "./components/layout/MainLayout";
import { DetachedChatWindow } from "./components/chat/DetachedChatWindow";

import { useWorkspaceBootstrap } from "./hooks/useWorkspaceBootstrap";
import { useEditorStore } from "./store/useEditorStore";
import { useThemeStore } from "./store/useThemeStore";
import { useAutoSave } from "./hooks/useAutoSave";
import { useTauriDragDrop } from "./hooks/useTauriDragDrop";
import { useInternalDrag } from "./hooks/useInternalDrag";
import { useWindowClose } from "./hooks/useWindowClose";
import { DragPreview } from "./components/ui/DragPreview";
import { OnboardingModal } from "./components/modals/OnboardingModal";
import { QuickOpenModal } from "./components/modals/QuickOpenModal";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { initializeSystemInfo } from "./services/context-builder";

function App() {
  const { initializeFromDatabase } = useThemeStore();
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const [isDetachedWindow, setIsDetachedWindow] = useState(false);
  const restoreWorkspace = useEditorStore((state) => state.restoreWorkspace);
  useWorkspaceBootstrap();

  // Initialize auto-save functionality
  useAutoSave();

  // Save all state on window close (VS Code pattern)
  useWindowClose();

  // Handle external file drops from OS via Tauri
  useTauriDragDrop();

  // Handle internal drag-drop via mouse events
  useInternalDrag();

  useEffect(() => {
    // Check if this is the detached chat window based on URL path
    const path = window.location.pathname;
    setIsDetachedWindow(path === "/chat-detached");
  }, []);

  // Restore workspace state from database on app startup
  useEffect(() => {
    if (!isDetachedWindow) {
      restoreWorkspace();
    }
  }, [isDetachedWindow, restoreWorkspace]);

  useEffect(() => {
    initializeFromDatabase();
    // Initialize system info cache for context builder
    initializeSystemInfo();
  }, [initializeFromDatabase]);

  // Disable default context menu globally
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Allow context menu in input/textarea elements
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        return;
      }
      e.preventDefault();
    };

    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // Handle global shortcuts - MUST be called before any conditional returns (React hooks rule)
  useGlobalShortcuts(() => setIsQuickOpenOpen(prev => !prev));

  // Render detached chat window if on that route
  if (isDetachedWindow) {
    return <DetachedChatWindow />;
  }

  return (
    <>
      <MainLayout />
      <DragPreview />
      <OnboardingModal />
      <QuickOpenModal isOpen={isQuickOpenOpen} onClose={() => setIsQuickOpenOpen(false)} />
    </>
  );
}

export default App;
