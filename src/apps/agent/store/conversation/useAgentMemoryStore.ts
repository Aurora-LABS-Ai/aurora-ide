/**
 * Agent Window — what Aurora remembers about you [store].
 *
 * Backs the Memory page in Aurora Chat's dock. The facts themselves live in
 * `chats.db` on the Rust side; this holds only the view state — the loaded
 * list, which row is being edited, and whether a write is in flight.
 *
 * Deliberately NOT part of `useAgentChatStore`. That store owns conversations,
 * and a fact outlives the conversation that taught it — mixing them would put
 * two different lifetimes in one place.
 */

import { create } from "zustand";

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { isTauri } from "@/kernel/lib/ipc/tauri";

export interface MemoryFact {
  id: string;
  text: string;
  pinned: boolean;
  sourceChatId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStats {
  indexedChats: number;
  facts: number;
}

interface MemoryState {
  facts: MemoryFact[];
  stats: MemoryStats | null;
  loading: boolean;
  /** Set when a read or write failed, so the page can say so rather than looking empty. */
  error: string | null;
  /** Which fact's text is open for editing, if any. */
  editingId: string | null;
  /** True while a rebuild is running — it walks every conversation folder. */
  rebuilding: boolean;

  load: () => Promise<void>;
  add: (text: string) => Promise<void>;
  update: (id: string, text: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  forget: (id: string) => Promise<void>;
  beginEdit: (id: string | null) => void;
  rebuildIndex: () => Promise<void>;
}

export const useAgentMemoryStore = create<MemoryState>((set, get) => ({
  facts: [],
  stats: null,
  loading: false,
  error: null,
  editingId: null,
  rebuilding: false,

  load: async () => {
    if (!isTauri()) return;
    set({ loading: true, error: null });
    try {
      const [facts, stats] = await Promise.all([
        auroraInvoke<MemoryFact[]>("chat_memory_list_facts"),
        auroraInvoke<MemoryStats>("chat_memory_stats"),
      ]);
      set({ facts, stats, loading: false });
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },

  add: async (text) => {
    const trimmed = text.trim();
    if (!trimmed || !isTauri()) return;
    try {
      await auroraInvoke("chat_memory_add_fact", { text: trimmed });
      // Reload rather than splice the returned row in. Adding a fact that
      // already exists UPDATES the existing one on the Rust side, so a local
      // append would show a duplicate that is not really there.
      await get().load();
    } catch (err) {
      set({ error: String(err) });
    }
  },

  update: async (id, text) => {
    const trimmed = text.trim();
    if (!trimmed || !isTauri()) return;
    // Optimistic: the row is already on screen and the write is a single
    // UPDATE by primary key. A reload here would make every keystroke-then-save
    // flash the whole list.
    const previous = get().facts;
    set({
      facts: previous.map((fact) =>
        fact.id === id ? { ...fact, text: trimmed } : fact,
      ),
      editingId: null,
    });
    try {
      await auroraInvoke("chat_memory_update_fact", { id, text: trimmed });
    } catch (err) {
      set({ facts: previous, error: String(err) });
    }
  },

  setPinned: async (id, pinned) => {
    if (!isTauri()) return;
    const previous = get().facts;
    // Re-sorted locally to match the server's order (pinned first, then
    // newest), so a pinned row moves to the top under the cursor exactly as it
    // will on the next load. Without this the row stays put and the pin looks
    // like it did nothing until you reopen the page.
    const next = previous
      .map((fact) => (fact.id === id ? { ...fact, pinned } : fact))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.createdAt.localeCompare(a.createdAt);
      });
    set({ facts: next });
    try {
      await auroraInvoke("chat_memory_set_fact_pinned", { id, pinned });
    } catch (err) {
      set({ facts: previous, error: String(err) });
    }
  },

  forget: async (id) => {
    if (!isTauri()) return;
    const previous = get().facts;
    set({
      facts: previous.filter((fact) => fact.id !== id),
      stats: get().stats
        ? { ...get().stats!, facts: Math.max(0, get().stats!.facts - 1) }
        : null,
    });
    try {
      await auroraInvoke("chat_memory_forget_fact", { id });
    } catch (err) {
      set({ facts: previous, error: String(err) });
      await get().load();
    }
  },

  beginEdit: (id) => set({ editingId: id }),

  rebuildIndex: async () => {
    if (!isTauri()) return;
    set({ rebuilding: true, error: null });
    try {
      await auroraInvoke<number>("chat_memory_rebuild_index");
      await get().load();
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ rebuilding: false });
    }
  },
}));
