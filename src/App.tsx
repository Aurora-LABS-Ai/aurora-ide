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
 * See: src/kernel/types/theme.ts for TypeScript interfaces
 * See: src/apps/ide/services/theme-service.ts for theme utilities
 */

import { useEffect, useState } from "react";
// The router is the one file that legitimately knows about both products.
import { MainLayout } from "@/apps/ide/app/MainLayout";
import { AgentWindow } from "@/apps/agent";

import { useWorkspaceBootstrap } from "@/apps/ide/hooks/useWorkspaceBootstrap";
import { useEditorStore } from "@/kernel/store/useEditorStore";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { useThemeStore } from "@/apps/ide/store/useThemeStore";
import { useAutoSave } from "@/apps/ide/hooks/useAutoSave";
import { useTauriDragDrop } from "@/apps/ide/hooks/useTauriDragDrop";
import { useInternalDrag } from "@/apps/ide/hooks/useInternalDrag";
import { useWindowClose } from "@/bridge/useWindowClose";
import { useCliOpen } from "@/apps/ide/hooks/useCliOpen";
import { DragPreview } from "@/apps/ide/ui/DragPreview";
import { OnboardingModal } from "@/apps/ide/features/settings/OnboardingModal";
import { QuickOpenModal } from "@/apps/ide/features/settings/QuickOpenModal";
import { useGlobalShortcuts } from "@/apps/ide/hooks/useGlobalShortcuts";
import { initializeSystemInfo } from "@/apps/agent/services/runtime/context-builder";
import {
  installAgentIdeListeners,
  handleOpenInIde,
} from "@/bridge/agent-ide-events";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useLocalProviderDetection } from "@/apps/ide/hooks/useLocalProviderDetection";
import { useMcpStore } from "@/apps/agent/store/tools/useMcpStore";

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
  const isAgentWindow =
    typeof window !== "undefined" && window.location.pathname === "/agent-window";
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

  // Restore workspace state from database on app startup
  useEffect(() => {
    if (!isAgentWindow) {
      restoreWorkspace();
    }
  }, [isAgentWindow, restoreWorkspace]);

  useEffect(() => {
    initializeSettings();
    initializeFromDatabase();
    // Initialize system info cache for context builder
    initializeSystemInfo();
  }, [initializeFromDatabase, initializeSettings]);

  // Boot MCP servers at the app-shell level so the `autoStart` toggle
  // is honoured regardless of which view the user lands on first —
  // settings tab, agent mode, or chat. The store guards itself against
  // duplicate calls (`initialized` flag), so this is safe even though
  // ChatPanel also calls `loadServers` defensively.
  // Skipped for the agent window (it is scoped to its own workspace).
  useEffect(() => {
    if (isAgentWindow) return;
    void useMcpStore.getState().loadServers();
  }, [isAgentWindow]);

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

  // Main-window startup: if the agent window asked to open a file while the IDE
  // was CLOSED, the backend re-created this window and queued the file. Drain it
  // now and open it (gated by pathname, not the async window-type state, so a
  // secondary window can never grab the queue first).
  useEffect(() => {
    const path = window.location.pathname;
    const isSecondary = path === "/agent-window";
    if (isSecondary) return;
    let cancelled = false;
    void auroraInvoke<{ path: string; line?: number } | null>("take_pending_ide_open")
      .then((pending) => {
        if (!cancelled && pending?.path) void handleOpenInIde(pending);
      })
      .catch(() => {
        // No pending open / not in the Tauri runtime — nothing to do.
      });
    return () => {
      cancelled = true;
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

      // ...and in rich editors. The agent-window composer is a contenteditable
      // div, not a textarea, so the tagName check above missed it and right
      // click → Select all / Copy / Paste was dead in the one field users type
      // their prompt into.
      if (target.isContentEditable) {
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

  // Render the standalone agent window if on that route
  if (isAgentWindow) {
    return <AgentWindow />;
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
