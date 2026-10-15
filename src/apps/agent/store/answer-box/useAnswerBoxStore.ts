/**
 * Agent Window — what the reader set in each answer box [store].
 *
 * Probe: Documents/aurora-chat-interactive-answer-designs.html (03, one quiet
 * box). Change a box's stepper to 9 and it stays 9: through a page change,
 * a window restart, and reopening the conversation next week. Saved WITH THE
 * CONVERSATION, in its `answer-boxes.json` (Rust:
 * `agent_runtime/answer_boxes.rs`), keyed by a hash of the box's text
 * (`lib/answer-box/split.ts::boxKey`).
 *
 * Only values that differ from what the model wrote are stored. Putting a box
 * back ("Back to 6") removes its entry, and a conversation whose boxes are all
 * at their defaults has no file at all.
 */

import { create } from "zustand";

import {
  getAnswerBoxes,
  setAnswerBox,
  type AnswerBoxValues,
} from "@/apps/agent/services/answer-box/commands";
import { toast } from "@/apps/agent/store/ui/useAgentToastStore";

interface AnswerBoxStoreState {
  /** Thread id → box key → the values the reader changed. */
  byThread: Record<string, Record<string, AnswerBoxValues>>;
  /** Threads whose saved values have been read. */
  hydrated: Record<string, true>;

  /** Read a conversation's saved values once. Safe to call from every box. */
  hydrate: (threadId: string) => Promise<void>;
  /**
   * Record a box's changed values, or `null` when every input is back at the
   * model's default. Saved to disk in the background.
   */
  setBox: (threadId: string, key: string, values: AnswerBoxValues | null) => void;
}

/** Reads in flight, so every box in one conversation shares one read. */
const hydrating = new Map<string, Promise<void>>();
/** Boxes changed before their conversation's saved values arrived. */
const editedBeforeHydrate = new Map<string, Set<string>>();
/** One save at a time per conversation. */
const saveChains = new Map<string, Promise<void>>();
/** Boxes with a save queued; a second change rides the queued save. */
const queued = new Set<string>();

export const useAnswerBoxStore = create<AnswerBoxStoreState>()((set, get) => {
  const persist = (threadId: string, key: string) => {
    if (!get().hydrated[threadId]) {
      const keys = editedBeforeHydrate.get(threadId) ?? new Set<string>();
      keys.add(key);
      editedBeforeHydrate.set(threadId, keys);
      return;
    }
    const slot = `${threadId}\u0000${key}`;
    // Ten clicks on + are one save of the last value, not ten writes.
    if (queued.has(slot)) return;
    queued.add(slot);
    const prior = saveChains.get(threadId) ?? Promise.resolve();
    const next = prior.then(async () => {
      queued.delete(slot);
      const values = get().byThread[threadId]?.[key] ?? {};
      try {
        await setAnswerBox(threadId, key, values);
      } catch (err) {
        console.warn("[answer-box] agent_answer_box_set failed for", threadId, key, err);
        toast(`Couldn't save the answer box: ${String(err)}`);
      }
    });
    saveChains.set(threadId, next);
    void next.finally(() => {
      if (saveChains.get(threadId) === next) saveChains.delete(threadId);
    });
  };

  return {
    byThread: {},
    hydrated: {},

    hydrate: (threadId) => {
      if (get().hydrated[threadId]) return Promise.resolve();
      const inFlight = hydrating.get(threadId);
      if (inFlight) return inFlight;
      const read = (async () => {
        let saved: Record<string, AnswerBoxValues> = {};
        try {
          saved = (await getAnswerBoxes(threadId)).boxes ?? {};
        } catch (err) {
          // Presentation state: a failed read shows every box at the model's
          // defaults, and says why in the log.
          console.warn("[answer-box] agent_answer_boxes_get failed for", threadId, err);
        }
        // A change made in the moment before the read landed wins over disk.
        const local = get().byThread[threadId] ?? {};
        set({
          byThread: { ...get().byThread, [threadId]: { ...saved, ...local } },
          hydrated: { ...get().hydrated, [threadId]: true },
        });
        const edited = editedBeforeHydrate.get(threadId);
        editedBeforeHydrate.delete(threadId);
        for (const key of edited ?? []) persist(threadId, key);
      })();
      hydrating.set(threadId, read);
      void read.finally(() => hydrating.delete(threadId));
      return read;
    },

    setBox: (threadId, key, values) => {
      const boxes = { ...(get().byThread[threadId] ?? {}) };
      if (values && Object.keys(values).length > 0) boxes[key] = values;
      else delete boxes[key];
      set({ byThread: { ...get().byThread, [threadId]: boxes } });
      persist(threadId, key);
    },
  };
});

/** One box's saved values, or undefined when it is at the model's defaults. */
export const selectBoxValues =
  (threadId: string | null, key: string) =>
  (s: AnswerBoxStoreState): AnswerBoxValues | undefined =>
    threadId ? s.byThread[threadId]?.[key] : undefined;
