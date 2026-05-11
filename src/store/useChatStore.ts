import { create } from "zustand";

import { getAgentService } from "../services/agent-service";
import type { PickedElement } from "../services/browser-service";
import type { PromptAttachment } from "../services/prompt-assets";
import type { Message, ToolCall, ToolProposal } from "../types";

export interface DraftAttachedFile {
  path: string;
  name: string;
}

/**
 * A page element the user picked from a native browser preview window
 * via the inspector or Stagewise toolbar. Stored here (not on the
 * BrowserTab) because the chat input — which can live in a different
 * panel or even a detached window — is the consumer that renders pills
 * and serializes them into the outgoing message.
 */
export interface SelectedElementEntry {
  /** Stable id for React keys + remove targeting. */
  id: string;
  /** 1-based ordinal — the agent refers to picks as "selected 1". */
  index: number;
  /** Full payload as captured by the inspector script. */
  element: PickedElement;
}

interface ChatState {
  // Actions
  addMessage: (message: Omit<Message, 'timestamp'> & { id?: string }) => void;

  // Append content to chat input (used by browser element inspector)
  appendToInput: (content: string) => void;
  clearMessages: () => void;
  consumePendingInput: () => { content: string | null; replace: boolean };
  isLoading: boolean;
  messages: Message[];
  pendingApproval: ToolProposal | null;

  // For external components to set/append content to the chat input
  pendingInputContent: string | null;
  pendingInputNonce: number;
  // Whether pending input should replace existing content (true) or append (false)
  pendingInputReplace: boolean;
  setLoading: (loading: boolean) => void;
  // Set input content (replaces existing content)
  setInputContent: (content: string) => void;
  setPendingApproval: (proposal: ToolProposal | null) => void;
  stopGeneration: () => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  updateToolCall: (messageId: string, toolId: string, updates: Partial<ToolCall>) => void;
  updateToolStatus: (messageId: string, status: ToolProposal['status']) => void;

  // Draft state — persists input across Chat ↔ Agent layout switches
  draftInput: string;
  draftAttachedFiles: DraftAttachedFile[];
  draftAttachedPromptAssets: PromptAttachment[];
  setDraftInput: (content: string) => void;
  setDraftAttachedFiles: (files: DraftAttachedFile[]) => void;
  setDraftAttachedPromptAssets: (assets: PromptAttachment[]) => void;
  clearDraft: () => void;

  // Browser-pick state — elements picked from a native browser preview
  // window. Rendered as pills in `ChatInput`; serialized into the
  // outgoing message at submit time and then cleared.
  selectedElements: SelectedElementEntry[];
  addSelectedElement: (element: PickedElement) => void;
  removeSelectedElement: (id: string) => void;
  clearSelectedElements: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  pendingApproval: null,
  pendingInputContent: null,
  pendingInputNonce: 0,
  pendingInputReplace: false,

  // Draft state
  draftInput: "",
  draftAttachedFiles: [],
  draftAttachedPromptAssets: [],

  addMessage: (message) => set((state) => ({
    messages: [
      ...state.messages,
      {
        ...message,
        id: message.id || Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
      }
    ]
  })),

  updateMessage: (id, updates) => set((state) => ({
    messages: state.messages.map(msg =>
      msg.id === id ? { ...msg, ...updates } : msg
    )
  })),

  setLoading: (isLoading) => set({ isLoading }),

  updateToolStatus: (messageId, status) => set((state) => ({
    messages: state.messages.map(msg =>
      msg.id === messageId && msg.toolProposal
        ? { ...msg, toolProposal: { ...msg.toolProposal, status } }
        : msg
    )
  })),

  updateToolCall: (messageId, toolId, updates) => set((state) => {
    // Side effect: Sync tasks to TaskStore
    const msg = state.messages.find(m => m.id === messageId);
    if (msg && msg.tools) {
      const tool = msg.tools.find(t => t.id === toolId);
      if (tool && tool.name === 'todo_write') {
        const mergedArgs = {
          ...(typeof tool.args === 'object' && tool.args !== null ? tool.args : {}),
          ...(typeof updates.args === 'object' && updates.args !== null ? updates.args : {}),
        };
        if (mergedArgs.todos) {
          import('./useTaskStore').then(({ useTaskStore }) => {
            useTaskStore.getState().setTasks(mergedArgs.todos);
          });
        }
      }
    }

    return {
      messages: state.messages.map(msg => {
        if (msg.id === messageId && msg.tools) {
          return {
            ...msg,
            tools: msg.tools.map(tool =>
              tool.id === toolId ? { ...tool, ...updates } : tool
            )
          };
        }
        return msg;
      })
    };
  }),

  setPendingApproval: (proposal) => set({ pendingApproval: proposal }),

  clearMessages: () => set({ messages: [], pendingApproval: null }),

  stopGeneration: () => {
    const agent = getAgentService();
    agent.stop();
    set({ isLoading: false });
  },

  appendToInput: (content: string) => {
    const current = get().pendingInputContent;
    set((state) => ({
      pendingInputContent: current ? `${current}\n${content}` : content,
      pendingInputReplace: false,
      pendingInputNonce: state.pendingInputNonce + 1,
    }));
  },

  setInputContent: (content: string) => {
    set((state) => ({
      pendingInputContent: content,
      pendingInputReplace: true,
      pendingInputNonce: state.pendingInputNonce + 1,
    }));
  },

  consumePendingInput: () => {
    const content = get().pendingInputContent;
    const replace = get().pendingInputReplace;
    set({ pendingInputContent: null, pendingInputReplace: false });
    return { content, replace };
  },

  setDraftInput: (content: string) => set({ draftInput: content }),
  setDraftAttachedFiles: (files: DraftAttachedFile[]) => set({ draftAttachedFiles: files }),
  setDraftAttachedPromptAssets: (assets: PromptAttachment[]) => set({ draftAttachedPromptAssets: assets }),
  clearDraft: () => set({ draftInput: "", draftAttachedFiles: [], draftAttachedPromptAssets: [] }),

  selectedElements: [],
  addSelectedElement: (element) => set((state) => {
    // Drop exact duplicates (same selector + url) within the current
    // selection set so a stuttering listener never produces a "selected
    // 2" pill for the same DOM node the user just clicked.
    const matchKey = `${element.url || ''}|${element.selector}`;
    const exists = state.selectedElements.some(
      (entry) => `${entry.element.url || ''}|${entry.element.selector}` === matchKey,
    );
    if (exists) return {};
    const nextIndex = state.selectedElements.length + 1;
    const id = `pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      selectedElements: [
        ...state.selectedElements,
        { id, index: nextIndex, element },
      ],
    };
  }),
  removeSelectedElement: (id) => set((state) => {
    const next = state.selectedElements
      .filter((entry) => entry.id !== id)
      .map((entry, i) => ({ ...entry, index: i + 1 }));
    return { selectedElements: next };
  }),
  clearSelectedElements: () => set({ selectedElements: [] }),
}));
