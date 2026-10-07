/**
 * Agent Window — OS window launcher (adapter / outbound channel).
 *
 * Opens the agent workspace in its OWN native WebView window; `App.tsx`
 * renders `<AgentWindow/>` for the `/agent-window` route.
 * There is exactly one agent window (fixed label); concurrent opens coalesce.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { isTauri } from "@/kernel/lib/ipc/tauri";
import { databaseService } from "@/kernel/services/database";

export const AGENT_WINDOW_LABEL = "agent-window";
const AGENT_WINDOW_URL = "/agent-window";

/** Defaults + floor for the restored window size (logical px). */
const DEFAULT_SIZE = { width: 1200, height: 800 };
const MIN_SIZE = { width: 820, height: 560 };

/**
 * `app_settings` key holding the project the AGENT WINDOW was last working in.
 *
 * Deliberately separate from the IDE's `workspace_state` table. The standalone
 * launcher used to fall back to that table, so an agent window opened from the
 * icon reopened wherever the IDE was last pointed — and for anyone who has
 * stopped opening the IDE, that row never changes again. Written by
 * `useAgentChatStore` as the project is used; read by both launch paths.
 */
export const AGENT_LAST_WORKSPACE_KEY = "agent_last_workspace";

let openInFlight: Promise<void> | null = null;

/**
 * Read the size the user last resized the agent window to (persisted by
 * `useAgentWindowBounds` under `agent_window_bounds`). Falls back to the
 * default on first launch or corrupt data, clamps to the window minimum,
 * and caps to the current monitor's work area so a size remembered on a
 * bigger screen never opens larger than the screen it lands on.
 */
async function readSavedBounds(): Promise<{
  width: number;
  height: number;
  maximized: boolean;
}> {
  let width = DEFAULT_SIZE.width;
  let height = DEFAULT_SIZE.height;
  let maximized = false;
  try {
    const raw = await databaseService.getSetting("agent_window_bounds");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{
        width: number;
        height: number;
        maximized: boolean;
      }>;
      if (Number.isFinite(parsed.width)) width = Math.round(parsed.width as number);
      if (Number.isFinite(parsed.height)) height = Math.round(parsed.height as number);
      maximized = parsed.maximized === true;
    }
  } catch {
    // First launch / unreadable state — defaults are fine.
  }
  width = Math.max(MIN_SIZE.width, width);
  height = Math.max(MIN_SIZE.height, height);
  try {
    const { currentMonitor } = await import("@tauri-apps/api/window");
    const monitor = await currentMonitor();
    if (monitor) {
      const logicalW = monitor.size.width / monitor.scaleFactor;
      const logicalH = monitor.size.height / monitor.scaleFactor;
      width = Math.min(width, Math.floor(logicalW));
      height = Math.min(height, Math.floor(logicalH));
    }
  } catch {
    // Monitor probing is best-effort; the OS clamps the rest.
  }
  return { width, height, maximized };
}

/**
 * Build the agent-window route, carrying the project the window should be
 * scoped to as a `?ws=` query param. The window reads this on boot so its
 * chat list and "New chat" stay inside that one project.
 */
function agentWindowUrl(workspaceRoot?: string | null): string {
  if (!workspaceRoot) return AGENT_WINDOW_URL;
  return `${AGENT_WINDOW_URL}?ws=${encodeURIComponent(workspaceRoot)}`;
}

/** The project the agent window itself was last used on, or null. */
async function readRememberedWorkspace(): Promise<string | null> {
  try {
    const raw = await databaseService.getSetting(AGENT_LAST_WORKSPACE_KEY);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Open (or focus) the single agent window. Idempotent and race-safe.
 *
 * The window is created from JS (`new WebviewWindow`) — building it inside a
 * Rust command with `WebviewWindowBuilder::build()` deadlocks the Windows UI
 * thread (white window that won't even close). The WebView microphone
 * auto-grant handler is instead installed via the (non-blocking)
 * `install_agent_media_permission_handler` command as soon as the window
 * exists, plus again on the window's own boot — both dispatch to the WebView UI
 * thread and return immediately, so they never block the event loop.
 *
 * `workspaceRoot` binds the window to a project (its conversations are scoped
 * to that path). Pass the IDE's current workspace root.
 */
export async function openAgentWindow(workspaceRoot?: string | null): Promise<void> {
  if (!isTauri()) {
    console.warn("[agent-window] openAgentWindow requires the Aurora runtime");
    return;
  }

  if (openInFlight) return openInFlight;

  openInFlight = (async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

      const existing = await WebviewWindow.getByLabel(AGENT_WINDOW_LABEL);
      if (existing) {
        try {
          await existing.setFocus();
        } catch {
          // window may be mid-teardown; ignore
        }
        return;
      }

      // Reopen at the size the user last set (persisted on resize by
      // `useAgentWindowBounds`) instead of a hardcoded default.
      const bounds = await readSavedBounds();

      // Launching FROM the IDE scopes to whatever the IDE has open — that is
      // the point of opening it there. Only when the IDE has no project does
      // this fall back to the agent window's own last project, so both launch
      // paths agree instead of one of them opening unscoped.
      const scopedRoot = workspaceRoot || (await readRememberedWorkspace());

      const agentWindow = new WebviewWindow(AGENT_WINDOW_LABEL, {
        url: agentWindowUrl(scopedRoot),
        title: "Aurora Agent",
        width: bounds.width,
        height: bounds.height,
        minWidth: MIN_SIZE.width,
        minHeight: MIN_SIZE.height,
        center: true,
        resizable: true,
        focus: true,
        // Explicit, not inherited: this is what registers the OS drop target on
        // the webview, and it is the difference between a file dragged from
        // Windows Explorer reaching the composer and vanishing. The main window
        // states it in tauri.conf.json; a window created from JS must say it too
        // rather than rely on the serde default surviving the config round-trip.
        dragDropEnabled: true,
        // Frameless — the window renders its own themed titlebar
        // (AgentTitlebar); keep in sync with the Rust agent-mode launch path.
        decorations: false,
        maximized: bounds.maximized,
      });

      await new Promise<void>((resolve) => {
        agentWindow.once("tauri://created", () => resolve());
        agentWindow.once("tauri://error", () => resolve());
      });

      // Register the mic auto-grant handler the moment the window exists, from
      // the IDE side, so it's in place long before the user's first mic click.
      // Non-blocking: `with_webview` dispatches to the WebView UI thread and
      // returns immediately (unlike building the window in Rust, which blocks).
      try {
        await auroraInvoke("install_agent_media_permission_handler");
      } catch (err) {
        console.warn("[agent-window] mic permission handler install failed:", err);
      }
    } finally {
      openInFlight = null;
    }
  })();

  return openInFlight;
}

/** Focus the agent window if it's open. */
export async function focusAgentWindow(): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(AGENT_WINDOW_LABEL);
  if (existing) {
    try {
      await existing.setFocus();
    } catch {
      // ignore
    }
  }
}

/** Close the agent window if it's open. */
export async function closeAgentWindow(): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(AGENT_WINDOW_LABEL);
  if (existing) {
    try {
      await existing.close();
    } catch {
      // ignore
    }
  }
}
