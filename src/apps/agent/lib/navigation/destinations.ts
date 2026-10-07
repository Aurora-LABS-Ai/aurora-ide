/**
 * Agent Window — app-level destinations.
 *
 * The icon rail on the window's left edge lists places that are not chats:
 * Images (make pictures without a conversation), Library (everything
 * generated, pasted or uploaded, across every chat) and Plugins (MCP servers
 * and skills). Home is the chat list and the conversation. Each destination is
 * described ONCE here — glyph, label, what it does — and both the rail and the
 * command palette read this list, so the two can never disagree about what
 * exists or where it goes.
 *
 * `litRailCell` is the one rule for which rail cell is highlighted. It lives
 * beside the destinations rather than in the rail so it can be tested without
 * rendering anything, and so a future surface that wants to know "where am I"
 * asks the same question the rail does.
 */

import type { AgentIconName } from "@/apps/agent/shared/AgentIcon";
import {
  useAgentUiStore,
  type AgentView,
  type SettingsSection,
} from "@/apps/agent/store/ui/useAgentUiStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import type { DockSingletonKind } from "@/apps/agent/types";

export type AgentDestination = "home" | "images" | "library" | "plugins";

/** Every cell the rail can light: the destinations plus the three at its foot. */
export type RailCell = AgentDestination | "providers" | "settings" | "account";

export interface DestinationSpec {
  id: AgentDestination;
  label: string;
  icon: AgentIconName;
  /** One line for the tooltip and the palette's subtitle. */
  hint: string;
  /** Extra words the palette matches on. */
  keywords: string;
}

export const DESTINATIONS: readonly DestinationSpec[] = [
  {
    id: "home",
    label: "Home",
    icon: "home",
    hint: "Your chats and projects",
    keywords: "home chats conversations projects",
  },
  {
    id: "images",
    label: "Images",
    icon: "images",
    hint: "Make pictures without starting a chat",
    keywords: "images pictures generate draw render art",
  },
  {
    id: "library",
    label: "Library",
    icon: "library",
    hint: "Everything generated, pasted or uploaded",
    keywords: "library gallery files media pictures videos attachments",
  },
  {
    id: "plugins",
    label: "Plugins",
    icon: "puzzle",
    hint: "MCP servers and skills",
    keywords: "plugins mcp servers skills tools integrations",
  },
];

/**
 * Which rail cell the window's current view belongs to. Settings on the
 * profile page lights Account, because that is the cell that opens it; every
 * other settings section lights Settings.
 */
export function litRailCell(view: AgentView, section: SettingsSection): RailCell {
  switch (view) {
    case "chat":
      return "home";
    case "images":
      return "images";
    case "library":
      return "library";
    case "plugins":
      return "plugins";
    case "providers":
      return "providers";
    case "settings":
      return section === "profile" ? "account" : "settings";
  }
}

export interface OpenDestinationOptions {
  /**
   * Home pressed while already home folds or unfolds the chat list, the way a
   * sidebar button does. The palette passes nothing: "go home" from a palette
   * should only ever go home.
   */
  toggleChatList?: boolean;
}

/** Go to a destination. The one implementation both the rail and the palette call. */
export function openDestination(id: AgentDestination, options: OpenDestinationOptions = {}): void {
  const ui = useAgentUiStore.getState();
  switch (id) {
    case "home":
      if (ui.view === "chat") {
        if (options.toggleChatList) useAgentWorkspaceStore.getState().toggleRail();
        return;
      }
      ui.goHome();
      return;
    case "images":
      ui.openView("images");
      return;
    case "library":
      ui.openView("library");
      return;
    case "plugins":
      ui.openView("plugins");
      return;
  }
}

/**
 * Open one of the right dock's surfaces (Memory, Files…). The dock only
 * exists on the Home view, so this walks there first: pressing Memory from the
 * Images page must show it, not silently open a tab behind a page that
 * cannot display it.
 */
export function openDockSurface(kind: DockSingletonKind): void {
  const ui = useAgentUiStore.getState();
  if (ui.view !== "chat") ui.goHome();
  useAgentWorkspaceStore.getState().openTab(kind);
}
