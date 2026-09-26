/**
 * Agent Window — custom titlebar (frameless OS window) [view].
 *
 * The agent window ships `decorations: false` (both launch paths), so this
 * strip replaces the native Windows caption bar: a frame-tier drag region with
 * the name of the product currently open on the left — Aurora Chat or Aurora
 * Build, the same words the switcher uses — and minimize / maximize-restore /
 * close on the right. It also keeps the OS window title in step, since that is
 * what the taskbar and Alt-Tab show. Every colour reads `--agw-*`, so Appearance retheming recolors it
 * exactly like the rail and gutters it sits flush with. Double-click-to-
 * maximize and window dragging come from `data-tauri-drag-region` (buttons are
 * excluded globally in index.css).
 */

import React, { useCallback, useEffect, useState } from "react";
import { isTauri } from "@/kernel/lib/ipc/tauri";
import { auroraSurfaceName } from "@/apps/agent/services/runtime/agent-execution-mode";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";

/** Windows-style caption glyphs — tiny strokes so they stay crisp at 1px. */
const GLYPHS = {
  minimize: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <line x1="0.5" y1="5.5" x2="9.5" y2="5.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  maximize: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  restore: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M 2.5 2.5 V 0.5 H 9.5 V 7.5 H 7.5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  close: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
      <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
} as const;

export const AgentTitlebar: React.FC = () => {
  const [maximized, setMaximized] = useState(false);
  // The window is titled with the product it is showing, not with the window's
  // own name. One window hosts both, and "Aurora Agent" over Aurora Chat named
  // something the user could not see anywhere else in the interface.
  const title = auroraSurfaceName(useAgentSettingsStore((s) => s.auroraSurface));

  // The OS title follows the strip.
  //
  // It is a different surface with the same job: the taskbar button, Alt-Tab
  // and the window list all read it, and Aurora is a product people leave open
  // beside their editor. Leaving it on the launch-time name would mean the
  // window says one thing on screen and another everywhere the OS shows it.
  useEffect(() => {
    if (!isTauri()) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(title);
      } catch {
        // Window mid-teardown, or no OS window to title — the strip above is
        // the one the user is looking at, and it is already right.
      }
    })();
  }, [title]);

  // Track maximize state so the middle button swaps its glyph (and the strip
  // stays correct when the OS toggles it — snap, double-click, Win+Up).
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const sync = async () => {
          try {
            const value = await win.isMaximized();
            if (!disposed) setMaximized(value);
          } catch {
            // window mid-teardown — leave the last known state
          }
        };
        await sync();
        const off = await win.onResized(() => void sync());
        if (disposed) off();
        else unlisten = off;
      } catch {
        // non-Tauri or API unavailable — controls just no-op
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const run = useCallback(
    (action: "minimize" | "toggleMaximize" | "close") => async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow()[action]();
      } catch (err) {
        console.error(`[agent-titlebar] ${action} failed:`, err);
      }
    },
    [],
  );

  // In a plain browser tab (frontend-only dev) there is no OS window to
  // control and the browser provides its own chrome — render nothing.
  if (!isTauri()) return null;

  return (
    <header className="agw-titlebar" data-tauri-drag-region>
      <span className="agw-titlebar-title" data-tauri-drag-region>
        {title}
      </span>
      <div className="agw-titlebar-controls">
        <button
          type="button"
          className="agw-titlebar-btn"
          onClick={run("minimize")}
          aria-label="Minimize"
          title="Minimize"
        >
          {GLYPHS.minimize}
        </button>
        <button
          type="button"
          className="agw-titlebar-btn"
          onClick={run("toggleMaximize")}
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? GLYPHS.restore : GLYPHS.maximize}
        </button>
        <button
          type="button"
          className="agw-titlebar-btn agw-titlebar-btn-close"
          onClick={run("close")}
          aria-label="Close"
          title="Close"
        >
          {GLYPHS.close}
        </button>
      </div>
    </header>
  );
};
