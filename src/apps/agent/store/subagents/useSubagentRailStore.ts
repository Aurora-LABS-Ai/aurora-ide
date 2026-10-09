/**
 * Agent Window — which sub-agent cards are out beside the icon rail [store].
 *
 * Probe: Documents/aurora-subagent-rail-designs.html. A click on an agent's
 * rail cell opens its card; a double-click (or the card's pin button) pins it.
 *
 * - One card open without a pin, at most. Opening another replaces it; a click
 *   anywhere else, Escape, or opening a different conversation closes it. It
 *   is a glance, so it is not saved.
 * - Up to `MAX_PINNED_CARDS` pinned per conversation, and which cards are
 *   grown with "Show more". Both are SAVED WITH THE CONVERSATION, in its
 *   `subagent-rail.json` (Rust: `agent_runtime/subagents/rail_state.rs`), so
 *   reopening it days later puts the same cards back the same way. They also
 *   stay through page changes (Settings, Providers…): the rail never unmounts.
 *
 * The cap is a frame budget, not a layout one: each card is a live tail of a
 * streaming agent, and four live tails at once is what was measured and made
 * smooth on 2026-10-09 (`SubagentTail`, `event_batch.rs`). Rust holds the same
 * cap, so a hand-edited file cannot ask for more.
 */

import { create } from "zustand";

import { MAX_PINNED_CARDS } from "@/apps/agent/lib/subagents/rail-layout";
import {
  getSubagentRail,
  setSubagentRail,
  type SubagentRailState,
} from "@/apps/agent/services/subagents/commands";
import { toast } from "@/apps/agent/store/ui/useAgentToastStore";

interface OpenCard {
  parentThreadId: string;
  agentId: string;
}

interface SubagentRailStoreState {
  /** The one card open without a pin. */
  open: OpenCard | null;
  /** Pinned cards by parent thread, in the order they were pinned. */
  pinnedByParent: Record<string, string[]>;
  /** Grown cards by parent thread. */
  expandedByParent: Record<string, string[]>;
  /** Parent threads whose saved state has been read. */
  hydrated: Record<string, true>;

  /** Read a conversation's saved pins once. Safe to call on every open. */
  hydrate: (parentThreadId: string) => Promise<void>;
  /** Click on a cell: open its card, or close it when it is the open one. */
  toggleOpen: (parentThreadId: string, agentId: string) => void;
  /** Open a card (from the "+N" list), replacing any unpinned one. */
  openCard: (parentThreadId: string, agentId: string) => void;
  /** Close the unpinned card, if any. */
  closeOpen: () => void;
  /**
   * Pin a card. Returns `false`, changing nothing, when the conversation
   * already has `MAX_PINNED_CARDS` pinned.
   */
  pin: (parentThreadId: string, agentId: string) => boolean;
  unpin: (parentThreadId: string, agentId: string) => void;
  /** Double-click on a cell. Returns `false` when a pin was refused. */
  togglePin: (parentThreadId: string, agentId: string) => boolean;
  /** "Show more" / "Show less" on a card. */
  setExpanded: (parentThreadId: string, agentId: string, expanded: boolean) => void;
}

const NONE: string[] = [];

/** Reads in flight, so two opens of one conversation share one read. */
const hydrating = new Map<string, Promise<void>>();
/** Conversations changed locally before their saved state arrived. */
const editedBeforeHydrate = new Set<string>();
/** One save at a time per conversation, each sending the state current when it runs. */
const saveChains = new Map<string, Promise<void>>();

const unique = (ids: string[]): string[] => ids.filter((id, i) => ids.indexOf(id) === i);

export const useSubagentRailStore = create<SubagentRailStoreState>()((set, get) => {
  /** Write the conversation's pins and grown cards through to Rust. */
  const persist = (parentThreadId: string) => {
    if (!get().hydrated[parentThreadId]) editedBeforeHydrate.add(parentThreadId);
    const prior = saveChains.get(parentThreadId) ?? Promise.resolve();
    const next = prior.then(async () => {
      const state: SubagentRailState = {
        pinned: get().pinnedByParent[parentThreadId] ?? NONE,
        expanded: get().expandedByParent[parentThreadId] ?? NONE,
      };
      try {
        await setSubagentRail(parentThreadId, state);
      } catch (err) {
        console.warn("[subagents] agent_subagent_rail_set failed for", parentThreadId, err);
        toast(`Couldn't save the pinned agents: ${String(err)}`);
      }
    });
    saveChains.set(parentThreadId, next);
    void next.finally(() => {
      if (saveChains.get(parentThreadId) === next) saveChains.delete(parentThreadId);
    });
  };

  const setList = (
    key: "pinnedByParent" | "expandedByParent",
    parentThreadId: string,
    ids: string[],
  ) => {
    const map = { ...get()[key] };
    if (ids.length > 0) map[parentThreadId] = ids;
    else delete map[parentThreadId];
    set({ [key]: map } as Pick<SubagentRailStoreState, typeof key>);
  };

  return {
    open: null,
    pinnedByParent: {},
    expandedByParent: {},
    hydrated: {},

    hydrate: (parentThreadId) => {
      if (get().hydrated[parentThreadId]) return Promise.resolve();
      const inFlight = hydrating.get(parentThreadId);
      if (inFlight) return inFlight;
      const read = (async () => {
        let saved: SubagentRailState = { pinned: NONE, expanded: NONE };
        try {
          saved = await getSubagentRail(parentThreadId);
        } catch (err) {
          // Presentation state: a failed read opens the conversation with no
          // cards out, and says why in the log.
          console.warn("[subagents] agent_subagent_rail_get failed for", parentThreadId, err);
        }
        const edited = editedBeforeHydrate.delete(parentThreadId);
        const localPinned = get().pinnedByParent[parentThreadId] ?? NONE;
        const localExpanded = get().expandedByParent[parentThreadId] ?? NONE;
        // A pin made in the moment before the read landed is kept alongside
        // the saved ones, never instead of them.
        setList(
          "pinnedByParent",
          parentThreadId,
          unique([...saved.pinned, ...localPinned]).slice(0, MAX_PINNED_CARDS),
        );
        setList("expandedByParent", parentThreadId, unique([...saved.expanded, ...localExpanded]));
        set({ hydrated: { ...get().hydrated, [parentThreadId]: true } });
        if (edited) persist(parentThreadId);
      })();
      hydrating.set(parentThreadId, read);
      void read.finally(() => hydrating.delete(parentThreadId));
      return read;
    },

    toggleOpen: (parentThreadId, agentId) => {
      const { open, pinnedByParent } = get();
      // A pinned card is already out; its cell has nothing to toggle.
      if ((pinnedByParent[parentThreadId] ?? NONE).includes(agentId)) return;
      if (open && open.parentThreadId === parentThreadId && open.agentId === agentId) {
        set({ open: null });
        return;
      }
      set({ open: { parentThreadId, agentId } });
    },

    openCard: (parentThreadId, agentId) => {
      if ((get().pinnedByParent[parentThreadId] ?? NONE).includes(agentId)) return;
      set({ open: { parentThreadId, agentId } });
    },

    closeOpen: () => {
      if (get().open) set({ open: null });
    },

    pin: (parentThreadId, agentId) => {
      const pinned = get().pinnedByParent[parentThreadId] ?? NONE;
      if (pinned.includes(agentId)) return true;
      if (pinned.length >= MAX_PINNED_CARDS) return false;
      const { open } = get();
      setList("pinnedByParent", parentThreadId, [...pinned, agentId]);
      // The open card becomes the pinned one rather than a second copy.
      if (open && open.parentThreadId === parentThreadId && open.agentId === agentId) {
        set({ open: null });
      }
      persist(parentThreadId);
      return true;
    },

    unpin: (parentThreadId, agentId) => {
      const pinned = get().pinnedByParent[parentThreadId] ?? NONE;
      if (!pinned.includes(agentId)) return;
      setList(
        "pinnedByParent",
        parentThreadId,
        pinned.filter((id) => id !== agentId),
      );
      persist(parentThreadId);
    },

    togglePin: (parentThreadId, agentId) => {
      const pinned = get().pinnedByParent[parentThreadId] ?? NONE;
      if (pinned.includes(agentId)) {
        get().unpin(parentThreadId, agentId);
        return true;
      }
      return get().pin(parentThreadId, agentId);
    },

    setExpanded: (parentThreadId, agentId, expanded) => {
      const list = get().expandedByParent[parentThreadId] ?? NONE;
      if (list.includes(agentId) === expanded) return;
      setList(
        "expandedByParent",
        parentThreadId,
        expanded ? [...list, agentId] : list.filter((id) => id !== agentId),
      );
      persist(parentThreadId);
    },
  };
});

/** Pinned agent ids of one conversation. Stable empty array. */
export const selectPinned =
  (parentThreadId: string | null) =>
  (s: SubagentRailStoreState): string[] =>
    parentThreadId ? (s.pinnedByParent[parentThreadId] ?? NONE) : NONE;

/** The unpinned open card's agent id, when it belongs to this conversation. */
export const selectOpenAgent =
  (parentThreadId: string | null) =>
  (s: SubagentRailStoreState): string | null =>
    s.open && s.open.parentThreadId === parentThreadId ? s.open.agentId : null;

/** Whether one agent's card is grown. A boolean, so a card re-renders only when it flips. */
export const selectExpanded =
  (parentThreadId: string, agentId: string) =>
  (s: SubagentRailStoreState): boolean =>
    (s.expandedByParent[parentThreadId] ?? NONE).includes(agentId);
