import { create } from "zustand";

interface AuditState {
  // Actions
  addEntry: (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => string;
  clearEntries: () => void;
  entries: AuditEntry[];
  getEntriesByThread: (threadId: string) => AuditEntry[];
  getRecentEntries: (limit?: number) => AuditEntry[];
  maxEntries: number;
  updateEntry: (id: string, updates: Partial<AuditEntry>) => void;
}

/**
 * Audit Store
 * Tracks tool execution history for the audit timeline
 */
export interface AuditEntry {
  args: Record<string, unknown>;
  duration?: number; // ms
  error?: string;
  id: string;
  result?: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'pending' | 'executing' | 'executed' | 'rejected' | 'failed';
  threadId?: string;
  timestamp: number;
  toolName: string;
}

const generateId = () => `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const useAuditStore = create<AuditState>((set, get) => ({
  entries: [],
  maxEntries: 500, // Keep last 500 entries

  addEntry: (entry) => {
    const id = generateId();
    const newEntry: AuditEntry = {
      ...entry,
      id,
      timestamp: Date.now(),
    };

    set((state) => {
      const entries = [newEntry, ...state.entries];
      // Trim to max entries
      if (entries.length > state.maxEntries) {
        entries.length = state.maxEntries;
      }
      return { entries };
    });

    return id;
  },

  updateEntry: (id, updates) => {
    set((state) => ({
      entries: state.entries.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    }));
  },

  getEntriesByThread: (threadId) => {
    return get().entries.filter((e) => e.threadId === threadId);
  },

  getRecentEntries: (limit = 50) => {
    return get().entries.slice(0, limit);
  },

  clearEntries: () => set({ entries: [] }),
}));

// DEBUG: Expose to window for console testing
if (typeof window !== 'undefined') {
  (window as any).auditStore = useAuditStore;
}
