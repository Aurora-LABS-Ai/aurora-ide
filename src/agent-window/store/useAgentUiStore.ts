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
  | "preferences";
// NB: "team" already reserved here; the Team settings tab renders `TeamSettings`.

/**
 * What the CENTER column shows inside the shell (rail + dock stay put): the
 * normal conversation, or the team screen (a takeover of the center, opened from
 * the left-rail "Team" entry). Distinct from `view`, which swaps the WHOLE
 * surface for full-window Settings.
 */
export type CenterView = "chat" | "team";

interface AgentUiState {
  view: AgentView;
  settingsSection: SettingsSection;
  centerView: CenterView;
  /** Open the settings page, optionally jumping straight to a section. */
  openSettings: (section?: SettingsSection) => void;
  /** Return to the conversation workspace. */
  closeSettings: () => void;
  setSection: (section: SettingsSection) => void;
  /** Swap the center column to the team screen. */
  openTeam: () => void;
  /** Return the center column to the conversation. */
  closeTeam: () => void;
}

export const useAgentUiStore = create<AgentUiState>()(
  persist(
    (set) => ({
      view: "chat",
      settingsSection: "preferences",
      centerView: "chat",
      openSettings: (section) =>
        set((s) => ({
          view: "settings",
          settingsSection: section ?? s.settingsSection,
        })),
      closeSettings: () => set({ view: "chat" }),
      setSection: (section) => set({ settingsSection: section }),
      openTeam: () => set({ centerView: "team", view: "chat" }),
      closeTeam: () => set({ centerView: "chat" }),
    }),
    {
      name: "aurora-agent-window-ui",
      partialize: (state) => ({ settingsSection: state.settingsSection }),
    },
  ),
);
