import { create } from "zustand";

import { getAgentService } from "../services/agent-service";
import type { Message, ToolCall, ToolProposal } from "../types";

interface ChatState {
  // Actions
  addMessage: (message: Omit<Message, 'timestamp'> & { id?: string }) => void;

  // Append content to chat input (used by browser element inspector)
  appendToInput: (content: string) => void;
  clearMessages: () => void;
  consumePendingInput: () => string | null;
  isLoading: boolean;
  messages: Message[];
  pendingApproval: ToolProposal | null;

  // For external components to append content to the chat input
  pendingInputContent: string | null;
  setLoading: (loading: boolean) => void;
  setPendingApproval: (proposal: ToolProposal | null) => void;
  stopGeneration: () => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  updateToolCall: (messageId: string, toolId: string, updates: Partial<ToolCall>) => void;
  updateToolStatus: (messageId: string, status: ToolProposal['status']) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  pendingApproval: null,
  pendingInputContent: null,

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
        const mergedArgs = { ...tool.args, ...((updates.args || {}) as any) };
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
    set({ pendingInputContent: current ? `${current}\n${content}` : content });
  },

  consumePendingInput: () => {
    const content = get().pendingInputContent;
    set({ pendingInputContent: null });
    return content;
  },
}));
