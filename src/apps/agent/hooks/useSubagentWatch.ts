/**
 * Window-level watch on sub-agents, however their parent is reached.
 *
 * Rust announces each child's lifecycle once, on the app-wide `agent_subagent`
 * channel. Mounted once from `AgentWindow`, for the life of the window, this:
 *
 * - keeps the sub-agent store current (`started` / `finished`), so the Agents
 *   panel, the tab glyphs and the report cards all read one copy;
 * - parks a `report` — a background child finished while its parent was idle
 *   — for the conversation it belongs to. `useIdleSubagentReport` starts a
 *   turn with it when that conversation is open and idle, exactly as a
 *   process ending is announced. A report for a conversation nobody is
 *   looking at waits; it is never dropped and never sent out of sight.
 * - reads the open conversation's agents from disk when it changes, so a
 *   conversation reopened days later lists what it delegated.
 */

import { useEffect } from "react";

import {
  listenSubagentEvents,
  type AgentReportMeta,
  type SubagentReportEvent,
} from "@/apps/agent/services/subagents/events";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";

/**
 * How often the open conversation's list is re-read from Rust while anything
 * about it can change: an agent of its is running, or its own turn is (a
 * spawn may be about to happen). Rust's list merges the live records with
 * the sidecars, so this is the backend's answer, not the window's guess; the
 * events above only make it arrive sooner.
 */
export const SUBAGENT_REFRESH_MS = 2_000;

export interface ParkedSubagentReport {
  agent: AgentReportMeta;
  summary: string;
  detail: string;
  arrivedAtMs: number;
}

/**
 * Reports waiting for their conversation to be open and idle. Module-level,
 * like the process reports: no surface renders the queue itself, the card
 * appears once the turn starts. Several for one conversation queue in order.
 */
const parked = new Map<string, ParkedSubagentReport[]>();
const listeners = new Set<() => void>();

const park = (event: SubagentReportEvent): void => {
  const list = parked.get(event.parentThreadId) ?? [];
  list.push({
    agent: event.agent,
    summary: event.summary,
    detail: event.detail,
    arrivedAtMs: Date.now(),
  });
  parked.set(event.parentThreadId, list);
  listeners.forEach((listener) => listener());
};

/** The oldest parked report for a conversation, removed. */
export const takeSubagentReport = (threadId: string): ParkedSubagentReport | null => {
  const list = parked.get(threadId);
  if (!list || list.length === 0) return null;
  const report = list.shift() ?? null;
  if (list.length === 0) parked.delete(threadId);
  return report;
};

export const peekSubagentReport = (threadId: string): ParkedSubagentReport | null =>
  parked.get(threadId)?.[0] ?? null;

export const subscribeToSubagentReports = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Test seam. */
export const clearSubagentReports = (): void => {
  parked.clear();
};

export const useSubagentWatch = (currentThreadId: string | null): void => {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenSubagentEvents((event) => {
      if (disposed) return;
      // The other half of the line Rust writes when it emits; together they
      // say whether a stale list is a delivery problem or a display one. An
      // event without its keys is a wire-shape bug (it happened: snake_case
      // fields), and is reported as such rather than quietly dropped.
      const shaped = !!event.agentId && !!event.parentThreadId;
      void auroraInvoke("logs_report", {
        level: shaped ? "info" : "error",
        component: "subagents.events",
        message: shaped
          ? `received ${event.type} for ${event.agentId}`
          : `received ${String(event.type)} with missing keys: ${JSON.stringify(event).slice(0, 300)}`,
      }).catch(() => {});
      if (!shaped) return;
      const store = useAgentSubagentStore.getState();
      store.applyEvent(event);
      if (event.type !== "report") return;
      // Rust sends a report only when no turn is running on the parent, so it
      // always waits for the conversation to be open and idle and then starts
      // a turn (`useIdleSubagentReport`). It is never pushed into a turn the
      // window still shows as live: the end-of-turn sweep sends its report
      // BEFORE the turn's own completion event, so "live" here meant a turn
      // Rust had already finished, and the report sat in a queue nobody
      // would read until some later turn happened to call a tool.
      park(event);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Without the listener the Agents panel still lists from disk on
        // open; only live updates are lost.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!currentThreadId) return;
    void useAgentSubagentStore.getState().load(currentThreadId);
  }, [currentThreadId]);

  // Re-read from Rust on a clock while the list can change. A missed event
  // then costs a couple of seconds of lag, never a wrong state: the header
  // count, the Agents tab and the tab glyphs all read this one list.
  useEffect(() => {
    if (!currentThreadId) return;
    const tick = () => {
      const subagents = useAgentSubagentStore.getState();
      const list = subagents.byParent[currentThreadId] ?? [];
      const anyRunning = list.some((agent) => agent.status === "running");
      const parentLive = !!useAgentChatStore.getState().liveTurns[currentThreadId];
      if (anyRunning || parentLive) void subagents.load(currentThreadId);
    };
    const timer = window.setInterval(tick, SUBAGENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [currentThreadId]);
};
