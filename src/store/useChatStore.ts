import { create } from "zustand";

import { getAgentService } from "../services/agent-service";
import type { PromptAttachment } from "../services/prompt-assets";
import type { Message, ToolCall, ToolProposal } from "../types";

export interface DraftAttachedFile {
  path: string;
  name: string;
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
}));
