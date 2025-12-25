import { create } from 'zustand';
import type { Tab } from '../types';

interface EditorState {
  tabs: Tab[];
  activeTabId: string | null;
  fontSize: number;
  
  // Actions
  openFile: (fileId: string, filename: string, content: string, language?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  setFontSize: (size: number) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  fontSize: 14,

  openFile: (fileId, filename, content, language = 'typescript') => {
    const { tabs, setActiveTab } = get();
    const existingTab = tabs.find(t => t.id === fileId);
    
    if (existingTab) {
      setActiveTab(fileId);
      return;
    }

    const newTab: Tab = {
      id: fileId,
      path: fileId, // Using id as path for mock
      filename,
      content,
      isDirty: false,
      language
    };

    set({ tabs: [...tabs, newTab], activeTabId: fileId });
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const newTabs = tabs.filter(t => t.id !== tabId);
    
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
    }

    set({ tabs: newTabs, activeTabId: newActiveId });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  updateTabContent: (tabId, content) => set(state => ({
    tabs: state.tabs.map(tab => 
      tab.id === tabId 
        ? { ...tab, content, isDirty: true } 
        : tab
    )
  })),

  setFontSize: (fontSize) => set({ fontSize }),
}));
