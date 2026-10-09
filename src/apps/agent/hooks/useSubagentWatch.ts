/**
 * Window-level watch on sub-agents, however their parent is reached.
 *
 * Rust announces each child's lifecycle once, on the app-wide `agent_subagent`
 * channel. Mounted once from `AgentWindow`, for the life of the window, this:
 *
 * - keeps the sub-agent store current (`started` / `finished` / `report`), so
 *   the Agents panel, the tab glyphs, the report cards and the idle-report
 *   drain all read one copy;
 * - re-reads the open conversation's agents AND Rust's wake outbox on a clock
 *   while anything can change, so a report reaches its parent within one
 *   poll even when the event that announced it is delivered late. On
 *   2026-10-08 four `report` events were emitted on time and processed 58 s
 *   later; the parent sat silent the whole time. Rust's list is the truth,
 *   events only make it arrive sooner;
 * - logs each event's delivery lag, from the `emittedAtMs` Rust stamps on it.
 *
 * `useIdleSubagentReport` starts a turn with the oldest wake when its
 * conversation is open and idle, and claims it from Rust once the turn opens.
 */

import { useEffect } from "react";

import { listenSubagentEvents } from "@/apps/agent/services/subagents/events";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";

/**
 * How often the open conversation's list and wakes are re-read from Rust
 * while anything about it can change: an agent of its is running, its own
 * turn is (a spawn may be about to happen), or a report is waiting to wake
 * it. Rust's list merges the live records with the sidecars, so this is the
 * backend's answer, not the window's guess; the events above only make it
 * arrive sooner.
 */
export const SUBAGENT_REFRESH_MS = 2_000;

/**
 * Delivery lag above which an event's log line is a warning. The channel is
 * one main-thread script evaluation per emit; a lag this long means it is
 * backed up behind streamed tokens, and the poll is what delivers.
 */
export const SLOW_EVENT_MS = 2_000;

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
      const lagMs =
        typeof event.emittedAtMs === "number" ? Math.max(0, Date.now() - event.emittedAtMs) : null;
      const lag = lagMs === null ? "" : ` (lag ${lagMs} ms)`;
      void auroraInvoke("logs_report", {
        level: !shaped ? "error" : lagMs !== null && lagMs > SLOW_EVENT_MS ? "warn" : "info",
        component: "subagents.events",
        message: shaped
          ? `received ${event.type} for ${event.agentId}${lag}`
          : `received ${String(event.type)} with missing keys: ${JSON.stringify(event).slice(0, 300)}`,
      }).catch(() => {});
      if (!shaped) return;
      // A `report` joins the window's copy of Rust's outbox here; the
      // conversation it belongs to starts a turn with it when it is idle
      // (`useIdleSubagentReport`). It is never pushed into a turn the window
      // still shows as live: Rust decided the parent was idle when it sent
      // this, and the end-of-turn sweep sends its reports BEFORE the turn's
      // own completion event.
      useAgentSubagentStore.getState().applyEvent(event);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Without the listener the Agents panel still lists from disk on
        // open and the poll below still finds reports; only live updates
        // are lost.
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
  // count, the Agents tab, the tab glyphs and the idle-report drain all read
  // this one store.
  useEffect(() => {
    if (!currentThreadId) return;
    const tick = () => {
      const subagents = useAgentSubagentStore.getState();
      const list = subagents.byParent[currentThreadId] ?? [];
      const anyRunning = list.some((agent) => agent.status === "running");
      const anyWaiting = (subagents.wakesByParent[currentThreadId]?.length ?? 0) > 0;
      const parentLive = !!useAgentChatStore.getState().liveTurns[currentThreadId];
      if (anyRunning || anyWaiting || parentLive) void subagents.load(currentThreadId);
    };
    const timer = window.setInterval(tick, SUBAGENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [currentThreadId]);
};
