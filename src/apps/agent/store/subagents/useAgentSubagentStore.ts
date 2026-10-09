/**
 * Agent Window — the sub-agents each conversation has started [store].
 *
 * One list per parent thread, read from disk (`agent_subagent_list`) when a
 * conversation is opened and kept current by the `agent_subagent` lifecycle
 * events while the window is up. Rust owns the truth (the child's files and
 * its live record); this is the window's copy for the Agents panel, the tab
 * glyphs and the report cards.
 *
 * It also remembers which turn id each running child streams under, so a
 * panel showing that child can follow its `agent_event`s.
 */

import { create } from "zustand";

import {
  claimSubagentWake,
  killSubagent,
  listSubagents,
  pendingSubagentWakes,
  type PendingWake,
  type SubagentSnapshot,
} from "@/apps/agent/services/subagents/commands";
import type { SubagentEvent } from "@/apps/agent/services/subagents/events";

interface AgentSubagentState {
  /** Agents by parent thread id, oldest first. */
  byParent: Record<string, SubagentSnapshot[]>;
  /** Parent threads whose list has been read from disk at least once. */
  loaded: Record<string, true>;
  /**
   * Reports waiting to wake an idle parent, oldest first: the window's copy
   * of Rust's outbox. Filled by the `report` event and by every `load`, so a
   * late event costs a poll's worth of lag and a lost one costs nothing.
   * `useIdleSubagentReport` starts a turn with the first one and claims it.
   */
  wakesByParent: Record<string, PendingWake[]>;
  /**
   * A turn carrying this wake has opened: drop it here and tell Rust.
   * Resolves to whether Rust still had it (a second claimant gets `false`).
   */
  claimWake: (parentThreadId: string, wakeId: number) => Promise<boolean>;
  /** The turn id a RUNNING child currently streams under. */
  liveTurnByAgent: Record<string, string>;
  /**
   * Messages the parent sent a running child that the child has not taken
   * in yet: it reads them at its next step. Shown at once in the agent's
   * views, so a message never seems to vanish while it waits.
   */
  pendingByAgent: Record<string, PendingParentMessage[]>;
  /** Drop the pending messages the transcript now holds. */
  settlePending: (agentId: string, seen: (text: string) => boolean) => void;

  /** Read a conversation's agents from disk. Idempotent; re-reading is cheap. */
  load: (parentThreadId: string) => Promise<void>;
  /** Fold one lifecycle event in. */
  applyEvent: (event: SubagentEvent) => void;
  /** Stop a running agent. */
  kill: (agentId: string) => Promise<boolean>;
  /** Forget a conversation's agents (the conversation was deleted). */
  forget: (parentThreadId: string) => void;
}

export interface PendingParentMessage {
  id: string;
  text: string;
  queuedAtMs: number;
}

const EMPTY: SubagentSnapshot[] = [];
const NO_PENDING: PendingParentMessage[] = [];
const NO_WAKES: PendingWake[] = [];
let pendingSeq = 0;

/** `wakes` with `wake` in place of its twin by id, or inserted in id order. */
function upsertWake(wakes: PendingWake[], wake: PendingWake): PendingWake[] {
  const index = wakes.findIndex((row) => row.id === wake.id);
  if (index >= 0) {
    const copy = wakes.slice();
    copy[index] = wake;
    return copy;
  }
  return [...wakes, wake].sort((a, b) => a.id - b.id);
}

/** A parent's list with `next` in place of the matching row, or appended. */
function upsert(list: SubagentSnapshot[], next: SubagentSnapshot): SubagentSnapshot[] {
  const index = list.findIndex((row) => row.agentId === next.agentId);
  if (index < 0) return [...list, next];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

export const useAgentSubagentStore = create<AgentSubagentState>()((set, get) => ({
  byParent: {},
  loaded: {},
  wakesByParent: {},
  liveTurnByAgent: {},
  pendingByAgent: {},

  claimWake: async (parentThreadId, wakeId) => {
    // Local copy first, so the drain that claimed it never sees it again
    // whatever the IPC does; Rust's answer is the truth about who carried it.
    set((s) => {
      const left = (s.wakesByParent[parentThreadId] ?? NO_WAKES).filter((w) => w.id !== wakeId);
      const wakesByParent = { ...s.wakesByParent };
      if (left.length > 0) wakesByParent[parentThreadId] = left;
      else delete wakesByParent[parentThreadId];
      return { wakesByParent };
    });
    try {
      return await claimSubagentWake(parentThreadId, wakeId);
    } catch (err) {
      console.warn("[subagents] agent_subagent_claim failed for", wakeId, err);
      return false;
    }
  },

  settlePending: (agentId, seen) => {
    const list = get().pendingByAgent[agentId];
    if (!list || list.length === 0) return;
    const left = list.filter((m) => !seen(m.text));
    if (left.length === list.length) return;
    set((s) => {
      const pendingByAgent = { ...s.pendingByAgent };
      if (left.length > 0) pendingByAgent[agentId] = left;
      else delete pendingByAgent[agentId];
      return { pendingByAgent };
    });
  },

  load: async (parentThreadId) => {
    // The list and the outbox in one go: the poll that notices an agent has
    // finished is the poll that finds its report, whether or not the `report`
    // event has been processed yet. A failed outbox read keeps the last copy;
    // a failed list read keeps everything.
    let rows: SubagentSnapshot[];
    let wakes: PendingWake[] | null;
    try {
      [rows, wakes] = await Promise.all([
        listSubagents(parentThreadId),
        pendingSubagentWakes(parentThreadId).catch((err: unknown) => {
          console.warn("[subagents] agent_subagent_pending failed for", parentThreadId, err);
          return null;
        }),
      ]);
    } catch (err) {
      console.warn("[subagents] agent_subagent_list failed for", parentThreadId, err);
      return;
    }
    set((s) => {
      // Rust's list is the truth about who is running. A live turn id kept for
      // an agent the list says has ended would keep its tab glyph working
      // forever if the `finished` event never arrived.
      const liveTurnByAgent = { ...s.liveTurnByAgent };
      for (const row of rows) {
        if (row.status !== "running") delete liveTurnByAgent[row.agentId];
      }
      let wakesByParent = s.wakesByParent;
      if (wakes) {
        // Rust's outbox is the truth here too: a wake it no longer holds was
        // claimed (by this window or another path) and must not be sent.
        wakesByParent = { ...s.wakesByParent };
        if (wakes.length > 0) wakesByParent[parentThreadId] = wakes.slice().sort((a, b) => a.id - b.id);
        else delete wakesByParent[parentThreadId];
      }
      return {
        byParent: { ...s.byParent, [parentThreadId]: rows },
        loaded: { ...s.loaded, [parentThreadId]: true },
        liveTurnByAgent,
        wakesByParent,
      };
    });
  },

  applyEvent: (event) => {
    const { byParent, liveTurnByAgent } = get();
    const list = byParent[event.parentThreadId] ?? EMPTY;
    switch (event.type) {
      case "started": {
        const prior = list.find((row) => row.agentId === event.agentId);
        const next: SubagentSnapshot = {
          agentId: event.agentId,
          parentThreadId: event.parentThreadId,
          agentType: event.agentType,
          name: event.name,
          description: event.description,
          status: "running",
          background: event.background,
          startedAtMs: prior?.startedAtMs ?? Date.now(),
          endedAtMs: undefined,
          result: prior?.result,
          error: undefined,
          usage: prior?.usage ?? {
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: 0,
            iterations: 0,
            durationMs: 0,
          },
          notified: false,
          runs: event.resumed ? (prior?.runs ?? 1) + 1 : 1,
        };
        set({
          byParent: { ...byParent, [event.parentThreadId]: upsert(list, next) },
          liveTurnByAgent: { ...liveTurnByAgent, [event.agentId]: event.turnId },
        });
        return;
      }
      case "finished": {
        const prior = list.find((row) => row.agentId === event.agentId);
        if (!prior) return;
        const next: SubagentSnapshot = {
          ...prior,
          status: event.status,
          endedAtMs: Date.now(),
          result: event.result.trim() ? event.result : prior.result,
          error: event.error,
          usage: {
            inputTokens: prior.usage.inputTokens + event.usage.inputTokens,
            outputTokens: prior.usage.outputTokens + event.usage.outputTokens,
            toolCalls: prior.usage.toolCalls + event.usage.toolCalls,
            iterations: prior.usage.iterations + event.usage.iterations,
            durationMs: prior.usage.durationMs + event.usage.durationMs,
          },
          notified: event.reportedToParent || prior.notified,
        };
        const live = { ...liveTurnByAgent };
        delete live[event.agentId];
        // A run that ended has read everything it was going to read.
        const pendingByAgent = { ...get().pendingByAgent };
        delete pendingByAgent[event.agentId];
        set({
          byParent: { ...byParent, [event.parentThreadId]: upsert(list, next) },
          liveTurnByAgent: live,
          pendingByAgent,
        });
        return;
      }
      case "message": {
        if (!event.text.trim()) return;
        if (event.delivered) {
          // A question waiting in `message_parent` took the parent's answer
          // straight away. It never reaches the agent's transcript as a
          // message of its own, so settle it here: the answer may join
          // several messages, so match by containment.
          get().settlePending(event.agentId, (text) => event.text.includes(text.trim()));
          return;
        }
        const pending = get().pendingByAgent;
        pendingSeq += 1;
        set({
          pendingByAgent: {
            ...pending,
            [event.agentId]: [
              ...(pending[event.agentId] ?? NO_PENDING),
              { id: `pending-${pendingSeq}`, text: event.text, queuedAtMs: Date.now() },
            ],
          },
        });
        return;
      }
      case "report": {
        // Does not change what the list shows. The wake joins the window's
        // copy of the outbox; the conversation it belongs to starts a turn
        // with it when it is open and idle (`useIdleSubagentReport`).
        const wakes = get().wakesByParent[event.parentThreadId] ?? NO_WAKES;
        set({
          wakesByParent: {
            ...get().wakesByParent,
            [event.parentThreadId]: upsertWake(wakes, {
              id: event.wakeId,
              parentThreadId: event.parentThreadId,
              agent: event.agent,
              summary: event.summary,
              detail: event.detail,
              queuedAtMs: event.emittedAtMs ?? Date.now(),
            }),
          },
        });
        return;
      }
      default:
        return;
    }
  },

  kill: async (agentId) => {
    try {
      return await killSubagent(agentId);
    } catch (err) {
      console.warn("[subagents] agent_subagent_kill failed for", agentId, err);
      return false;
    }
  },

  forget: (parentThreadId) =>
    set((s) => {
      const byParent = { ...s.byParent };
      const loaded = { ...s.loaded };
      const wakesByParent = { ...s.wakesByParent };
      delete byParent[parentThreadId];
      delete loaded[parentThreadId];
      delete wakesByParent[parentThreadId];
      return { byParent, loaded, wakesByParent };
    }),
}));

/** Reports waiting to wake one conversation, oldest first. Stable empty array. */
export const selectWakesFor =
  (parentThreadId: string | null) =>
  (s: AgentSubagentState): PendingWake[] =>
    parentThreadId ? (s.wakesByParent[parentThreadId] ?? NO_WAKES) : NO_WAKES;

/** Messages waiting for an agent to take them in. Stable empty array. */
export const selectPendingFor =
  (agentId: string) =>
  (s: AgentSubagentState): PendingParentMessage[] =>
    s.pendingByAgent[agentId] ?? NO_PENDING;

/** The agents of one conversation, oldest first. Stable empty array. */
export const selectSubagents =
  (parentThreadId: string | null) =>
  (s: AgentSubagentState): SubagentSnapshot[] =>
    parentThreadId ? (s.byParent[parentThreadId] ?? EMPTY) : EMPTY;

/** Running first, then by start time (newest first), for the Agents panel. */
export function orderForPanel(list: SubagentSnapshot[]): SubagentSnapshot[] {
  return list
    .slice()
    .sort((a, b) => {
      const ra = a.status === "running" ? 0 : 1;
      const rb = b.status === "running" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.startedAtMs - a.startedAtMs;
    });
}
