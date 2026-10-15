/**
 * Agent Window — which work cards the reader opened [store].
 *
 * Transcript → Work cards folds a long quiet stretch of a reply into one card,
 * closed by default. Opening one is a choice, so it is SAVED WITH THE
 * CONVERSATION, in its `work-cards.json` (Rust: `agent_runtime/work_cards.rs`):
 * a card opened today is open when the chat is reopened next week. Cards are
 * keyed by their first tool call's id (`work-stretches.ts`).
 *
 * Probe: Documents/aurora-work-card-designs.html, 02.
 */

import { create } from "zustand";

import { getWorkCards, setWorkCard } from "@/apps/agent/services/conversation/work-cards";
import { toast } from "@/apps/agent/store/ui/useAgentToastStore";

interface WorkCardStoreState {
  /** Thread id → card id → open. Only cards the reader opened are present. */
  openByThread: Record<string, Record<string, true>>;
  /** Threads whose saved cards have been read. */
  hydrated: Record<string, true>;

  /** Read a conversation's open cards once. Safe to call from every card. */
  hydrate: (threadId: string) => Promise<void>;
  /** Open or close a card. Saved to disk in the background. */
  setOpen: (threadId: string, cardId: string, open: boolean) => void;
}

/** Reads in flight, so every card in one conversation shares one read. */
const hydrating = new Map<string, Promise<void>>();
/** Cards toggled before their conversation's saved state arrived. */
const editedBeforeHydrate = new Map<string, Set<string>>();
/** One save at a time per conversation, each sending the state current when it runs. */
const saveChains = new Map<string, Promise<void>>();

export const useAgentWorkCardStore = create<WorkCardStoreState>()((set, get) => {
  const persist = (threadId: string, cardId: string) => {
    if (!get().hydrated[threadId]) {
      const ids = editedBeforeHydrate.get(threadId) ?? new Set<string>();
      ids.add(cardId);
      editedBeforeHydrate.set(threadId, ids);
      return;
    }
    const prior = saveChains.get(threadId) ?? Promise.resolve();
    const next = prior.then(async () => {
      const open = get().openByThread[threadId]?.[cardId] === true;
      try {
        await setWorkCard(threadId, cardId, open);
      } catch (err) {
        console.warn("[work-cards] agent_work_card_set failed for", threadId, cardId, err);
        toast(`Couldn't save that card: ${String(err)}`);
      }
    });
    saveChains.set(threadId, next);
    void next.finally(() => {
      if (saveChains.get(threadId) === next) saveChains.delete(threadId);
    });
  };

  return {
    openByThread: {},
    hydrated: {},

    hydrate: (threadId) => {
      if (get().hydrated[threadId]) return Promise.resolve();
      const inFlight = hydrating.get(threadId);
      if (inFlight) return inFlight;
      const read = (async () => {
        let saved: string[] = [];
        try {
          saved = (await getWorkCards(threadId)).open ?? [];
        } catch (err) {
          // Presentation state: a failed read draws every card closed, and
          // says why in the log.
          console.warn("[work-cards] agent_work_cards_get failed for", threadId, err);
        }
        const fromDisk: Record<string, true> = {};
        for (const id of saved) fromDisk[id] = true;
        // A toggle made in the moment before the read landed wins over disk.
        const edited = editedBeforeHydrate.get(threadId);
        editedBeforeHydrate.delete(threadId);
        const local = get().openByThread[threadId] ?? {};
        const merged = { ...fromDisk };
        for (const id of edited ?? []) {
          if (local[id]) merged[id] = true;
          else delete merged[id];
        }
        set({
          openByThread: { ...get().openByThread, [threadId]: merged },
          hydrated: { ...get().hydrated, [threadId]: true },
        });
        for (const id of edited ?? []) persist(threadId, id);
      })();
      hydrating.set(threadId, read);
      void read.finally(() => hydrating.delete(threadId));
      return read;
    },

    setOpen: (threadId, cardId, open) => {
      const cards = { ...(get().openByThread[threadId] ?? {}) };
      if ((cards[cardId] === true) === open) return;
      if (open) cards[cardId] = true;
      else delete cards[cardId];
      set({ openByThread: { ...get().openByThread, [threadId]: cards } });
      persist(threadId, cardId);
    },
  };
});

/** Whether one card is open. A boolean, so a card re-renders only when it flips. */
export const selectWorkCardOpen =
  (threadId: string | null, cardId: string) =>
  (s: WorkCardStoreState): boolean =>
    threadId ? s.openByThread[threadId]?.[cardId] === true : false;
