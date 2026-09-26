/**
 * Agent Window — auto-open the right-rail Browser for browser_* tools (inbound).
 *
 * The agent's browser tools are Rust-native and drive the embedded webview in
 * the right dock's Browser panel (`browser-agentwin`). That webview is built by
 * `BrowserPanel` only while its tab is visible, and Rust can't create it
 * directly (it needs the host window's live bounds). So when a browser tool
 * runs and the panel isn't open, the Rust side emits `aurora:agent-open-browser`
 * and polls for the webview; this hook is the other half — it reveals the
 * Browser dock tab so `BrowserPanel` mounts and builds the webview.
 *
 * Mount once in the always-on shell (next to `useAgentFsWatch`).
 */

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

export function useAgentBrowserOpen(): void {
  useEffect(() => {
    if (!isAuroraRuntimeAvailable()) return;

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void listen("aurora:agent-open-browser", () => {
      if (cancelled) return;
      // Reveal (or refocus) the Browser panel — mounting it builds the
      // embedded webview the waiting Rust tool will then drive.
      // Rust also sends this when the webview EXISTS but is hidden because the
      // user was on another tab: `openTab` makes Browser the active tab, its
      // panel mounts, and that alone shows the page. If a menu or modal is
      // open over the panel it stays hidden until that closes — the agent's
      // tools handle a hidden page (they note the frame may be stale).
      useAgentWorkspaceStore.getState().openTab("browser");
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch((err) => {
        console.warn("[agent-window] agent-open-browser subscribe failed:", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
