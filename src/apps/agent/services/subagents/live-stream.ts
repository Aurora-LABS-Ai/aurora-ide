/**
 * The one listener that follows every running sub-agent's stream [service].
 *
 * Each child streams `agent_event`s under its own turn id; the sub-agent
 * store knows which turn id belongs to which running agent. This routes each
 * event to its agent's live reply (`useSubagentLiveStore`), for the life of
 * the window, whether or not a view of that agent is open. A view opened in
 * the middle of a long think therefore shows the whole thought with its real
 * start time, and switching tabs away and back changes nothing.
 *
 * Started once from `AgentWindow` (`useSubagentLiveStream`).
 */

import {
  AGENT_EVENT_CHANNEL,
  type AgentEventEnvelope,
} from "@/apps/agent/services/runtime/agent-runtime-client";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { useSubagentLiveStore } from "@/apps/agent/store/subagents/useSubagentLiveStore";
import { auroraListen } from "@/kernel/lib/ipc/runtime";

/** A message taken in is written to the file a moment after the event. */
const AFTER_INJECTION_MS = 150;

/** The running agent streaming under `turnId`, if any. */
function agentForTurn(turnId: string): string | undefined {
  const live = useAgentSubagentStore.getState().liveTurnByAgent;
  for (const agentId in live) {
    if (live[agentId] === turnId) return agentId;
  }
  return undefined;
}

/**
 * Route one `agent_event` payload. Events of the parent's own turns, and of
 * agents that are not running, are not ours and are ignored.
 */
export function routeSubagentEvent(
  payload: (AgentEventEnvelope & { turn_id?: string }) | undefined,
  schedule: (run: () => void, ms: number) => void = (run, ms) => {
    window.setTimeout(run, ms);
  },
): void {
  const turnId = payload?.turnId ?? payload?.turn_id;
  if (!turnId || !payload?.event) return;
  const agentId = agentForTurn(turnId);
  if (!agentId) return;
  const event = payload.event;
  const live = useSubagentLiveStore.getState();
  const reread = live.fold(agentId, event);
  if (event.type === "queued_message_injected") {
    const text = event.text.trim();
    useAgentSubagentStore.getState().settlePending(agentId, (pending) => pending.trim() === text);
  }
  if (!reread) return;
  if (event.type === "queued_message_injected") {
    schedule(() => useSubagentLiveStore.getState().requestReread(agentId), AFTER_INJECTION_MS);
  } else {
    live.requestReread(agentId);
  }
}

/**
 * Start following. Returns the stop function. Also drops an agent's live
 * reply when its run ends: the file holds everything by then.
 */
export function startSubagentLiveStream(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void auroraListen<AgentEventEnvelope>(AGENT_EVENT_CHANNEL, ({ payload }) => {
    if (!disposed) routeSubagentEvent(payload);
  })
    .then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    })
    .catch((err) => {
      // The views still re-read the file on a clock; only the live overlay
      // is lost.
      console.warn("[subagent] live stream unavailable:", err);
    });
  const unsubscribe = useAgentSubagentStore.subscribe((state, prev) => {
    for (const agentId in prev.liveTurnByAgent) {
      if (!state.liveTurnByAgent[agentId]) useSubagentLiveStore.getState().clear(agentId);
    }
  });
  return () => {
    disposed = true;
    unlisten?.();
    unsubscribe();
  };
}
