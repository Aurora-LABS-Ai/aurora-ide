/**
 * Agent Window — top-level UI view state.
 *
 * The window has two full-surface views: the conversation workspace ("chat")
 * and the settings page ("settings"). This store is the single switch between
 * them plus which settings section is active, so the 3-dot entry, the settings
 * left-nav, and the Back-to-app affordance all read/write one place.
 *
 * Only the last settings section is persisted. Full-surface/center views stay
 * transient so a window still opens on the conversation.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AgentView = "chat" | "settings";

/** Settings sections that were moved into the agent window. */
export type SettingsSection =
  | "profile"
  | "providers"
  | "tools"
  | "mcp"
  | "execution"
  | "team"
  | "skills"
  | "appearance"
  | "preferences"
  | "diagnostics";
// NB: "team" already reserved here; the Team settings tab renders `TeamSettings`.

interface AgentUiState {
  view: AgentView;
  settingsSection: SettingsSection;
  /**
   * What the settings page is currently searched for. Lives here rather than
   * inside the page so the command center can hand a query over on the way in —
   * asking for "chapters" there lands on the Chapters switch, not on the page
   * that happens to contain it.
   *
   * Never persisted: a search is a moment, and reopening settings tomorrow
   * inside yesterday's search would look like a broken page.
   */
  settingsQuery: string;
  /**
   * Open the settings page, optionally jumping straight to a section and
   * arriving with a search already applied.
   */
  openSettings: (section?: SettingsSection, query?: string) => void;
  /** Return to the conversation workspace. */
  closeSettings: () => void;
  setSection: (section: SettingsSection) => void;
  setSettingsQuery: (query: string) => void;
}

export const useAgentUiStore = create<AgentUiState>()(
  persist(
    (set) => ({
      view: "chat",
      settingsSection: "preferences",
      settingsQuery: "",
      openSettings: (section, query) =>
        set((s) => ({
          view: "settings",
          settingsSection: section ?? s.settingsSection,
          settingsQuery: query ?? "",
        })),
      closeSettings: () => set({ view: "chat", settingsQuery: "" }),
      // Choosing a section is choosing to look at that page, so it ends the
      // search. Without this the nav would appear dead while results are up:
      // the click lands, and the content area still shows the old results.
      setSection: (section) => set({ settingsSection: section, settingsQuery: "" }),
      setSettingsQuery: (query) => set({ settingsQuery: query }),
    }),
    {
      name: "aurora-agent-window-ui",
      partialize: (state) => ({ settingsSection: state.settingsSection }),
    },
  ),
);
