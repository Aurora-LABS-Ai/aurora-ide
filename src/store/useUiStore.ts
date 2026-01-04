import { create } from "zustand";

import type { ToolProposal } from "../types";

interface DetachedWindowState {
  isDetached: boolean;
  position: { x: number; y: number } | null;
  size: { width: number; height: number } | null;
  windowLabel: string | null;
}

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
  updateDetachedPosition: (position: { x: number; y: number }) => void;
  updateDetachedSize: (size: { width: number; height: number }) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: "dark",
  isSettingsOpen: false,
  isAuditOpen: false,
  isChatOpen: true,
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
