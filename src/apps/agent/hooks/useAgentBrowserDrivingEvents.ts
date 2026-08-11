/**
 * Agent Window — listen for the agent driving the Browser panel (inbound).
 *
 * The other half of `src-tauri/src/tools/browser/halo.rs`: every browser tool
 * is wrapped so it emits `aurora:agent-browser-activity` with `{ tool, active }`
 * around its call. This subscribes once and feeds
 * [`useAgentBrowserDriving`], which the Browser panel and its dock tab read.
 *
 * Mount once in the always-on shell, next to `useAgentBrowserOpen` — the cue on
 * the dock tab has to work while the user is looking at a DIFFERENT tab, so
 * this cannot live inside `BrowserPanel`.
 */

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import { useAgentBrowserDriving } from "@/apps/agent/store/workspace/useAgentBrowserDriving";

interface BrowserActivityPayload {
  tool?: string;
  active?: boolean;
}

export function useAgentBrowserDrivingEvents(): void {
  useEffect(() => {
    if (!isAuroraRuntimeAvailable()) return;

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void listen<BrowserActivityPayload>("aurora:agent-browser-activity", (event) => {
      if (cancelled) return;
      const tool = event.payload?.tool;
      if (!tool) return;
      const store = useAgentBrowserDriving.getState();
      if (event.payload?.active) store.begin(tool);
      else store.end(tool);
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch((err) => {
        console.warn("[agent-window] browser-activity subscribe failed:", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
      // Losing the listener means losing every future `false`, so drop the cue
      // rather than leave it frozen on whatever it last said.
      useAgentBrowserDriving.getState().reset();
    };
  }, []);
}
