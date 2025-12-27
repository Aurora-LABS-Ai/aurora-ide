import { create } from 'zustand';

/**
 * Audit Store
 * Tracks tool execution history for the audit timeline
 */

export interface AuditEntry {
  id: string;
  timestamp: number;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'executing' | 'executed' | 'rejected' | 'failed';
  result?: string;
  error?: string;
  riskLevel: 'low' | 'medium' | 'high';
  duration?: number; // ms
  threadId?: string;
}

interface AuditState {
  entries: AuditEntry[];
  maxEntries: number;

  // Actions
  addEntry: (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => string;
  updateEntry: (id: string, updates: Partial<AuditEntry>) => void;
  getEntriesByThread: (threadId: string) => AuditEntry[];
  getRecentEntries: (limit?: number) => AuditEntry[];
  clearEntries: () => void;
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
