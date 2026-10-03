/**
 * Agent Window — top-level UI view state.
 *
 * The window has two full-surface views: the conversation workspace ("chat")
 * and the settings page ("settings"). This store is the single switch between
 * them plus which settings section is active, so the 3-dot entry, the settings
 * left-nav, and the Back-to-app affordance all read/write one place.
 *
 * Only the last settings section and the Appearance page's category are
 * persisted. Full-surface/center views stay transient so a window still opens
 * on the conversation.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The window's full-surface views. `chat` is Home (the chat list and the
 * conversation); `images` and `library` are destinations the icon rail opens;
 * `settings` has its own opener because it also carries a section.
 */
export type AgentView = "chat" | "settings" | "images" | "library" | "plugins" | "providers";

/** The views the rail opens directly, without a section. */
export type AgentPageView = Exclude<AgentView, "settings">;

/** The two panes of the Plugins page. */
export type PluginsTab = "mcp" | "skills";

/**
 * Settings sections that moved out to pages of their own: MCP and Skills to
 * the Plugins page, Providers to its own page (it carries its own list on the
 * left, and inside Settings that made two sidebars). They stay in the settings
 * catalog so both searches still find them, but every door that names one —
 * the nav, a search result, the command palette, an old persisted section —
 * lands on the page through `openSettings`. One thing, one home; the redirect
 * lives in the store because the store is the one place every door already
 * goes through.
 */
const SECTION_HOMES: Partial<Record<SettingsSection, AgentPageView>> = {
  mcp: "plugins",
  skills: "plugins",
  providers: "providers",
};
const PAGE_SECTIONS: Partial<Record<SettingsSection, PluginsTab>> = {
  mcp: "mcp",
  skills: "skills",
};

/** The page a settings section now lives on, or null when it is still a settings page. */
export const sectionHome = (section: SettingsSection): AgentPageView | null =>
  SECTION_HOMES[section] ?? null;

/** The Plugins pane a settings section now lives on, or null. */
export const sectionPluginsTab = (section: SettingsSection): PluginsTab | null =>
  PAGE_SECTIONS[section] ?? null;

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

/** Category tabs on the Appearance page. */
export type AppearanceTab = "theme" | "layout" | "text" | "colours" | "advanced";

/**
 * Category tabs on the Preferences page.
 *
 * Three, not five: Preferences holds ten blocks against Appearance's twenty-odd
 * token groups, and splitting them finer would leave tabs holding one section
 * each — a row of buttons that costs a click and saves no scrolling.
 */
export type PreferencesTab = "general" | "composer" | "chat";

export type AgentSettingsTab = "general" | "code-index";

interface AgentUiState {
  view: AgentView;
  settingsSection: SettingsSection;
  /**
   * Which Appearance category was open last.
   *
   * Persisted alongside the section for the same reason: someone adjusting a
   * theme comes back to that page repeatedly, and landing on Theme every time
   * means re-navigating to the tab they were actually working in. Kept here
   * rather than in the page so it survives the unmount that leaving settings
   * causes.
   */
  appearanceTab: AppearanceTab;
  /** Which Preferences category was open last, persisted for the same reason. */
  preferencesTab: PreferencesTab;
  agentSettingsTab: AgentSettingsTab;
  /** Which pane the Plugins page was on last; persisted like the tabs above. */
  pluginsTab: PluginsTab;
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
  /** Show a rail destination (Images, Library) or Home. */
  openView: (view: AgentPageView) => void;
  /** Back to the chat list and the conversation, from any view. */
  goHome: () => void;
  setSection: (section: SettingsSection) => void;
  setSettingsQuery: (query: string) => void;
  setAppearanceTab: (tab: AppearanceTab) => void;
  setPreferencesTab: (tab: PreferencesTab) => void;
  setAgentSettingsTab: (tab: AgentSettingsTab) => void;
  setPluginsTab: (tab: PluginsTab) => void;
}

export const useAgentUiStore = create<AgentUiState>()(
  persist(
    (set) => ({
      view: "chat",
      settingsSection: "preferences",
      settingsQuery: "",
      appearanceTab: "theme",
      preferencesTab: "general",
      agentSettingsTab: "general",
      pluginsTab: "mcp",
      openSettings: (section, query) =>
        set((s) => {
          // "Reopen where I was" never means a section that moved to its own
          // page. A persisted `providers` (saved before Providers left
          // Settings) made the Settings rail cell open the Providers page, so
          // from Providers the click looked dead.
          const target =
            section ?? (sectionHome(s.settingsSection) ? "preferences" : s.settingsSection);
          const home = sectionHome(target);
          // A section that lives on a page of its own opens that page. The
          // search query does not travel: those pages have no results view.
          if (home) {
            const pluginsTab = sectionPluginsTab(target);
            return pluginsTab
              ? { view: home, pluginsTab, settingsQuery: "" }
              : { view: home, settingsQuery: "" };
          }
          return { view: "settings", settingsSection: target, settingsQuery: query ?? "" };
        }),
      closeSettings: () => set({ view: "chat", settingsQuery: "" }),
      // Leaving settings by any door ends its search, for the same reason
      // closeSettings does: a search is a moment, not a place to come back to.
      openView: (view) => set({ view, settingsQuery: "" }),
      goHome: () => set({ view: "chat", settingsQuery: "" }),
      // Choosing a section is choosing to look at that page, so it ends the
      // search. Without this the nav would appear dead while results are up:
      // the click lands, and the content area still shows the old results.
      setSection: (section) => set({ settingsSection: section, settingsQuery: "" }),
      setSettingsQuery: (query) => set({ settingsQuery: query }),
      setAppearanceTab: (tab) => set({ appearanceTab: tab }),
      setPreferencesTab: (tab) => set({ preferencesTab: tab }),
      setAgentSettingsTab: (tab) => set({ agentSettingsTab: tab }),
      setPluginsTab: (tab) => set({ pluginsTab: tab }),
    }),
    {
      name: "aurora-agent-window-ui",
      partialize: (state) => ({
        settingsSection: state.settingsSection,
        appearanceTab: state.appearanceTab,
        preferencesTab: state.preferencesTab,
        agentSettingsTab: state.agentSettingsTab,
        pluginsTab: state.pluginsTab,
      }),
    },
  ),
);
