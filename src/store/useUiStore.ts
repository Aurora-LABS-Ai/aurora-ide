import { create } from "zustand";

import type { ToolProposal } from "../types";

export type SettingsTabId =
  | "providers"
  | "local"
  | "fireworks"
  | "agent"
  // `tools` and `mcp` are kept for backward-compatible deep-links; the panel
  // redirects them to the unified Agent page's matching sub-section.
  | "tools"
  | "general"
  | "themes"
  | "speech"
  | "mcp"
  | "skills"
  | "about";

interface UiState {
  closeToolApproval: () => void;
  isAuditOpen: boolean;
  isChatOpen: boolean;
  isSettingsOpen: boolean;
  isSidebarOpen: boolean;
  openToolApproval: (proposal: ToolProposal) => void;
  setAuditOpen: (isOpen: boolean) => void;
  setChatOpen: (isOpen: boolean) => void;
  setSettingsOpen: (isOpen: boolean) => void;
  /** Open settings panel and optionally jump to a specific tab. */
  openSettings: (tab?: SettingsTabId) => void;
  /** Tab to open the settings panel on (consumed by SettingsPanel). */
  settingsInitialTab: SettingsTabId | null;
  /** Clear the initial-tab hint after the panel has consumed it. */
  consumeSettingsInitialTab: () => void;
  setSidebarOpen: (isOpen: boolean) => void;
  theme: "dark" | "light";
  toggleChat: () => void;
  toggleSidebar: () => void;

  // Actions
  toggleTheme: () => void;
  toolApprovalState: {
    isOpen: boolean;
    proposal: ToolProposal | null;
  };
}

export const useUiStore = create<UiState>((set) => ({
  theme: "dark",
  isSettingsOpen: false,
  settingsInitialTab: null,
  isAuditOpen: false,
  // The chat rail starts hidden — the IDE opens to the editor, and the user
  // reveals chat on demand via the title-bar toggle.
  isChatOpen: false,
  toolApprovalState: {
    isOpen: false,
    proposal: null,
  },

  toggleTheme: () =>
    set((state) => {
      const newTheme = state.theme === "dark" ? "light" : "dark";
      if (newTheme === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      return { theme: newTheme };
    }),

  setSettingsOpen: (isOpen) => set({ isSettingsOpen: isOpen }),
  openSettings: (tab) =>
    set({
      isSettingsOpen: true,
      settingsInitialTab: tab ?? null,
    }),
  consumeSettingsInitialTab: () => set({ settingsInitialTab: null }),
  setAuditOpen: (isOpen) => set({ isAuditOpen: isOpen }),
  toggleChat: () => set((state) => ({ isChatOpen: !state.isChatOpen })),
  setChatOpen: (isOpen) => set({ isChatOpen: isOpen }),

  // Sidebar
  isSidebarOpen: true,
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),

  openToolApproval: (proposal) =>
    set({ toolApprovalState: { isOpen: true, proposal } }),
  closeToolApproval: () =>
    set({ toolApprovalState: { isOpen: false, proposal: null } }),
}));
