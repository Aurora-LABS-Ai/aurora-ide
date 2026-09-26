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

import { lazy, Suspense, useEffect } from "react";

// The router is the one file that legitimately knows about both products, and
// it now knows about them LAZILY. Importing both statically put the whole IDE
// and the whole agent app in one chunk, so each window downloaded and parsed
// the other product before showing anything. Two dynamic imports make the
// pathname branch below a real fork: one surface loads, the other never does.
//
// `@/apps/agent` is the barrel deliberately — behind a dynamic import that is
// the point, because the chunk it drags in IS the agent window.
const IdeSurface = lazy(() => import("./surfaces/IdeSurface"));
const AgentWindow = lazy(() =>
  import("@/apps/agent").then((m) => ({ default: m.AgentWindow })),
);

import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { useThemeStore } from "@/apps/ide/store/useThemeStore";
import { useWindowClose } from "@/bridge/useWindowClose";
import { initializeSystemInfo } from "@/apps/agent/services/runtime/context-builder";
import { installAgentIdeListeners } from "@/bridge/agent-ide-events";
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
  const initializeSettings = useSettingsStore((state) => state.initializeFromDatabase);
  const isAgentWindow =
    typeof window !== "undefined" && window.location.pathname === "/agent-window";

  // Everything below this line runs in BOTH windows. Anything that belongs to
  // one product lives in that product's surface component — see
  // `surfaces/IdeSurface.tsx` for what moved and why.

  // Save the editor's explorer and workspace state on window close (VS Code
  // pattern). The Tauri close listener only registers in the `main` window.
  useWindowClose();

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

  // One surface or the other, never both.
  //
  // The fallback paints the window's own background and nothing else. These
  // chunks come off local disk in a Tauri bundle, so a spinner here would
  // flash for a few frames and read as a stutter; each surface shows its own
  // "Initializing Aurora" state once it mounts, which is the honest one to
  // show because it waits on settings rather than on a download.
  return (
    <Suspense
      fallback={
        <div
          style={{
            height: "100%",
            width: "100%",
            background: "var(--aurora-editor-background, #0d0d0d)",
          }}
        />
      }
    >
      {isAgentWindow ? <AgentWindow /> : <IdeSurface />}
    </Suspense>
  );
}

export default App;
