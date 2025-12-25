import { create } from 'zustand';
import type { ToolProposal } from '../types';

interface UiState {
  theme: 'dark' | 'light';
  isSettingsOpen: boolean;
  isAuditOpen: boolean;
  isChatOpen: boolean;
  toolApprovalState: {
    isOpen: boolean;
    proposal: ToolProposal | null;
  };
  
  // Actions
  toggleTheme: () => void;
  setSettingsOpen: (isOpen: boolean) => void;
  setAuditOpen: (isOpen: boolean) => void;
  toggleChat: () => void;
  setChatOpen: (isOpen: boolean) => void;
  openToolApproval: (proposal: ToolProposal) => void;
  closeToolApproval: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: 'dark',
  isSettingsOpen: false,
  isAuditOpen: false,
  isChatOpen: true,
  toolApprovalState: {
    isOpen: false,
    proposal: null,
  },

  toggleTheme: () => set((state) => {
    const newTheme = state.theme === 'dark' ? 'light' : 'dark';
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    return { theme: newTheme };
  }),

  setSettingsOpen: (isOpen) => set({ isSettingsOpen: isOpen }),
  setAuditOpen: (isOpen) => set({ isAuditOpen: isOpen }),
  toggleChat: () => set((state) => ({ isChatOpen: !state.isChatOpen })),
  setChatOpen: (isOpen) => set({ isChatOpen: isOpen }),
  
  openToolApproval: (proposal) => set({ toolApprovalState: { isOpen: true, proposal } }),
  closeToolApproval: () => set({ toolApprovalState: { isOpen: false, proposal: null } }),
}));
