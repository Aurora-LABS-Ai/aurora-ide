/**
 * Agent Window — what each running sub-agent is streaming right now [store].
 *
 * One live reply per agent (`lib/subagents/live-transcript.ts`), folded from
 * its `agent_event` stream by one window-wide listener
 * (`services/subagents/live-stream.ts`). The agent's tab and its preview in
 * the Agents tab both read it.
 *
 * It used to live inside the view. The dock mounts only the active tab, so
 * switching away threw the live reply out, and coming back started a new one
 * from the next delta: a thought five seconds old showed again from 0s with
 * its beginning missing until the model finished and the file caught up.
 * Kept here, a view mounts onto the reply as it stands.
 */

import { create } from "zustand";

import {
  applyLiveEvent,
  EMPTY_LIVE,
  settleWithRead,
  type LiveTranscript,
} from "@/apps/agent/lib/subagents/live-transcript";
import type { AgentEventEnvelope } from "@/apps/agent/services/runtime/agent-runtime-client";

type AssistantEvent = AgentEventEnvelope["event"];

interface SubagentLiveState {
  /** The live reply of each running agent, by agent id. */
  byAgent: Record<string, LiveTranscript>;
  /**
   * Bumped when the stream says something just landed in the agent's file
   * (a model call starting or ending, a message taken in). Views re-read the
   * file when it moves.
   */
  rereadTick: Record<string, number>;
  /** Fold one streamed event in. Returns whether the file should be re-read. */
  fold: (agentId: string, event: AssistantEvent, now?: number) => boolean;
  /** Number a re-read of the agent's file about to be issued. */
  beginRead: (agentId: string) => number;
  /** A re-read came back holding `count` messages. */
  settle: (agentId: string, seq: number, count: number) => void;
  /** Ask every view of the agent to re-read its file. */
  requestReread: (agentId: string) => void;
  /** The run is over: the file has everything. */
  clear: (agentId: string) => void;
}

/**
 * Re-reads issued per agent, across every view of it. Not state: nothing
 * renders it, and a live reply learns its base from a read numbered after it
 * began, whichever view issued that read.
 */
const readSeq = new Map<string, number>();

export const useSubagentLiveStore = create<SubagentLiveState>()((set, get) => ({
  byAgent: {},
  rereadTick: {},

  fold: (agentId, event, now = Date.now()) => {
    const prev = get().byAgent[agentId] ?? EMPTY_LIVE;
    const step = applyLiveEvent(prev, event, readSeq.get(agentId) ?? 0, now);
    if (step.state !== prev) {
      set((s) => ({ byAgent: { ...s.byAgent, [agentId]: step.state } }));
    }
    return step.reread;
  },

  beginRead: (agentId) => {
    const next = (readSeq.get(agentId) ?? 0) + 1;
    readSeq.set(agentId, next);
    return next;
  },

  settle: (agentId, seq, count) => {
    const prev = get().byAgent[agentId];
    if (!prev) return;
    const next = settleWithRead(prev, seq, count);
    if (next !== prev) set((s) => ({ byAgent: { ...s.byAgent, [agentId]: next } }));
  },

  requestReread: (agentId) =>
    set((s) => ({ rereadTick: { ...s.rereadTick, [agentId]: (s.rereadTick[agentId] ?? 0) + 1 } })),

  clear: (agentId) => {
    if (!(agentId in get().byAgent)) return;
    set((s) => {
      const byAgent = { ...s.byAgent };
      delete byAgent[agentId];
      return { byAgent };
    });
  },
}));

/** One agent's live reply. Stable empty value. */
export const selectLiveFor =
  (agentId: string) =>
  (s: SubagentLiveState): LiveTranscript =>
    s.byAgent[agentId] ?? EMPTY_LIVE;

/** Test seam. */
export const resetSubagentLive = (): void => {
  readSeq.clear();
  useSubagentLiveStore.setState({ byAgent: {}, rereadTick: {} });
};
