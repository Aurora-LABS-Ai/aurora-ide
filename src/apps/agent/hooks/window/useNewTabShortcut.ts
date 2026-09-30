/**
 * Agent Window — Ctrl+T (⌘T) opens a New tab in the right panel.
 *
 * Mounted in the always-on shell rather than in the dock, so the shortcut also
 * works while the panel is closed: it opens the panel on a New tab, the same
 * as pressing `+`.
 *
 * A key pressed inside a browser page never reaches here — the native page has
 * its own keyboard — so Ctrl+T there is the page's business.
 */

import { useEffect } from "react";

import { matchesCommandShortcut } from "@/apps/agent/lib/command/command-shortcut";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

export const NEW_TAB_SHORTCUT = "Mod+T";

export function useNewTabShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesCommandShortcut(event, NEW_TAB_SHORTCUT)) return;
      event.preventDefault();
      useAgentWorkspaceStore.getState().openNewTab();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
