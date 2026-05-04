import { create } from "zustand";

import type { ToolProposal } from "../types";

interface DetachedWindowState {
  isDetached: boolean;
  position: { x: number; y: number } | null;
  size: { width: number; height: number } | null;
  windowLabel: string | null;
}

export type SettingsTabId =
  | "providers"
  | "local"
  | "fireworks"
  | "tools"
  | "general"
  | "themes"
  | "speech"
  | "mcp"
  | "skills"
  | "about";

interface UiState {
  closeToolApproval: () => void;
  detachChat: (windowLabel: string) => void;
  detachedChat: DetachedWindowState;
  isAuditOpen: boolean;
  isChatOpen: boolean;
  isSettingsOpen: boolean;
  isSidebarOpen: boolean;
  openToolApproval: (proposal: ToolProposal) => void;
  reattachChat: () => void;
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

  // Agent Mode - full-screen chat interface with file changes panel
  isAgentMode: boolean;
  setAgentMode: (isActive: boolean) => void;
  toggleAgentMode: () => void;

  // Actions
  toggleTheme: () => void;
  toolApprovalState: {
    isOpen: boolean;
    proposal: ToolProposal | null;
  };
  updateDetachedPosition: (position: { x: number; y: number }) => void;
  updateDetachedSize: (size: { width: number; height: number }) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: "dark",
  isSettingsOpen: false,
  settingsInitialTab: null,
  isAuditOpen: false,
  isChatOpen: true,
  isAgentMode: false,
  toolApprovalState: {
    isOpen: false,
    proposal: null,
  },
  detachedChat: {
    isDetached: false,
    windowLabel: null,
    position: null,
    size: null,
  },

  // Agent Mode actions
  setAgentMode: (isActive) => set({ isAgentMode: isActive }),
  toggleAgentMode: () => set((state) => ({ isAgentMode: !state.isAgentMode })),

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

  detachChat: (windowLabel) =>
    set((state) => ({
      detachedChat: {
        ...state.detachedChat,
        isDetached: true,
        windowLabel,
      },
      isChatOpen: false,
    })),

  reattachChat: () =>
    set({
      detachedChat: {
        isDetached: false,
        windowLabel: null,
        position: null,
        size: null,
      },
      isChatOpen: true,
    }),

  updateDetachedPosition: (position) =>
    set((state) => ({
      detachedChat: {
        ...state.detachedChat,
        position,
      },
    })),

  updateDetachedSize: (size) =>
    set((state) => ({
      detachedChat: {
        ...state.detachedChat,
        size,
      },
    })),
}));
