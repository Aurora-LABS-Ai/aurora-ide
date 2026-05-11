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
import { useSettingsStore } from "./store/useSettingsStore";
import { useThemeStore } from "./store/useThemeStore";
import { useAutoSave } from "./hooks/useAutoSave";
import { useTauriDragDrop } from "./hooks/useTauriDragDrop";
import { useInternalDrag } from "./hooks/useInternalDrag";
import { useWindowClose } from "./hooks/useWindowClose";
import { useCliOpen } from "./hooks/useCliOpen";
import { DragPreview } from "./components/ui/DragPreview";
import { OnboardingModal } from "./components/modals/OnboardingModal";
import { QuickOpenModal } from "./components/modals/QuickOpenModal";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { initializeSystemInfo } from "./services/context-builder";
import { installAgentIdeListeners } from "./services/agent-ide-events";
import { useLocalProviderDetection } from "./hooks/useLocalProviderDetection";

// Global handler to suppress Tauri stream cancellation errors
// These are expected when user clicks stop during AI streaming
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason;
    // Suppress Tauri cancellation errors - these are expected behavior
    if (error && typeof error === 'object' && 'type' in error) {
      if ((error as { type: string }).type === 'cancelation') {
        event.preventDefault();
        return;
      }
    }
    // Also suppress "Request cancelled" errors
    if (error instanceof Error && (
      error.message === 'Request cancelled' ||
      error.message.includes('aborted') ||
      error.name === 'AbortError'
    )) {
      event.preventDefault();
      return;
    }
  });
}

function App() {
  const { initializeFromDatabase } = useThemeStore();
  const settingsInitialized = useSettingsStore((state) => state.isInitialized);
  const hasSeenOnboarding = useSettingsStore((state) => state.hasSeenOnboarding);
  const initializeSettings = useSettingsStore((state) => state.initializeFromDatabase);
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

  // Handle CLI open requests (aurora . command)
  useCliOpen();

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
    initializeSettings();
    initializeFromDatabase();
    // Initialize system info cache for context builder
    initializeSystemInfo();
  }, [initializeFromDatabase, initializeSettings]);

  // Subscribe to the Rust agent's IDE-event bus once the app mounts.
  // These listeners wire `agent_editor_open` → Monaco, `agent_todo_write`
  // → task store, and `agent_read_lints` → debug log. Without them the
  // Rust `editor_open_file` / `todo_write` tools are no-ops in the UI.
  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void installAgentIdeListeners().then((cleanup) => {
      if (cancelled) cleanup();
      else dispose = cleanup;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // Disable default context menu globally (except for text-selectable areas)
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Allow context menu in input/textarea elements
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        return;
      }

      // Allow context menu in elements with select-text class or markdown-content
      // This enables right-click copy on chat messages and code blocks
      if (target.closest('.select-text') || target.closest('.markdown-content')) {
        return;
      }

      e.preventDefault();
    };

    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // Background-probe for local AI servers (Ollama, LM Studio)
  useLocalProviderDetection();

  // Handle global shortcuts - MUST be called before any conditional returns (React hooks rule)
  useGlobalShortcuts(() => setIsQuickOpenOpen(prev => !prev));

  // Render detached chat window if on that route
  if (isDetachedWindow) {
    return <DetachedChatWindow />;
  }

  // Hold initial render until settings are initialized, preventing
  // first-frame UI flash behind onboarding.
  if (!settingsInitialized) {
    return (
      <div className="h-full w-full bg-editor text-text-primary flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse">
            <div className="h-3 w-3 rounded-full bg-primary" />
          </div>
          <p className="text-xs text-text-secondary uppercase tracking-wider">Initializing Aurora</p>
        </div>
      </div>
    );
  }

  // First-run onboarding is a full-screen takeover. The IDE mounts only after completion.
  if (!hasSeenOnboarding) {
    return <OnboardingModal />;
  }

  return (
    <>
      <MainLayout />
      <DragPreview />
      <QuickOpenModal isOpen={isQuickOpenOpen} onClose={() => setIsQuickOpenOpen(false)} />
    </>
  );
}

export default App;
