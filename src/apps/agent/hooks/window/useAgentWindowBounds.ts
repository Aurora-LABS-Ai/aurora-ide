/**
 * Agent Window — remember the OS window size across sessions.
 *
 * The agent window used to open at a hardcoded 1200×800 every launch. This
 * hook (mounted once in `AgentWindow`) watches the native window's resize
 * events and persists the LOGICAL inner size plus the maximized flag to the
 * `app_settings` SQLite table under `agent_window_bounds`. The two launch
 * paths read it back before creating the window:
 *
 *   - JS  — `adapters/window.ts` `openAgentWindow()` (opened from the IDE)
 *   - Rust — `lib.rs` agent-only launch (`aurora --agent`)
 *
 * Saving happens on resize (debounced), not on close — a close-time write
 * races window teardown and loses the final size, and resize-time saving
 * also survives crashes. While maximized, only the flag is updated so the
 * remembered floating size is what un-maximizing (or the next launch after
 * un-maximized close) restores.
 *
 * Position is deliberately NOT persisted: the window stays `center: true`,
 * which sidesteps stale multi-monitor coordinates restoring off-screen.
 */

import { useEffect } from "react";

import { databaseService } from "@/kernel/services/database";
import { isTauri } from "@/kernel/lib/ipc/tauri";
import { AGENT_WINDOW_LABEL } from "@/apps/agent/adapters/window";

export const AGENT_WINDOW_BOUNDS_KEY = "agent_window_bounds";

/** Persisted shape — logical (DPI-independent) pixels. */
export interface AgentWindowBounds {
  width: number;
  height: number;
  maximized: boolean;
}

const SAVE_DEBOUNCE_MS = 500;

export function useAgentWindowBounds(): void {
  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    let timer: number | undefined;

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      // Only the real agent window persists bounds — never the IDE window
      // (or a dev preview) that happens to render this component tree.
      if (win.label !== AGENT_WINDOW_LABEL) return;

      const save = async () => {
        try {
          if (await win.isMaximized()) {
            // Keep the remembered floating size; only flip the flag.
            const raw = await databaseService.getSetting(AGENT_WINDOW_BOUNDS_KEY);
            const prev = raw ? (JSON.parse(raw) as Partial<AgentWindowBounds>) : {};
            await databaseService.setSetting(
              AGENT_WINDOW_BOUNDS_KEY,
              JSON.stringify({ ...prev, maximized: true }),
            );
            return;
          }
          const factor = await win.scaleFactor();
          const size = (await win.innerSize()).toLogical(factor);
          // A minimize on Windows reports a degenerate inner size — never
          // persist it or the next launch opens as a sliver.
          if (size.width < 400 || size.height < 300) return;
          const bounds: AgentWindowBounds = {
            width: Math.round(size.width),
            height: Math.round(size.height),
            maximized: false,
          };
          await databaseService.setSetting(
            AGENT_WINDOW_BOUNDS_KEY,
            JSON.stringify(bounds),
          );
        } catch {
          // Window mid-teardown or DB briefly unavailable — the next
          // resize retries; worst case the previous size is kept.
        }
      };

      unlistenResize = await win.onResized(() => {
        if (disposed) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
      });

      if (disposed) {
        unlistenResize();
        unlistenResize = undefined;
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlistenResize?.();
    };
  }, []);
}
