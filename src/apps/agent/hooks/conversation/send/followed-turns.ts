/**
 * Agent Window — turns another client sent, followed live here.
 *
 * The desktop window and browser tabs share one backend. A turn runs in the
 * client whose user sent the message; every other client hears
 * `agent_thread_changed` "turn_start" (or finds the turn in
 * `agent_active_turns` when it opens mid-turn) and follows it: a live turn
 * in `useAgentChatStore` like its own, so the rail shows the spinner and the
 * open chat streams, written by the same `createTurnWriter` the sender uses.
 *
 * Only the stream is followed. Tool approvals, `ask_question` and MCP calls
 * are answered by the sending client. Stop works from here: it cancels the
 * turn in the runtime.
 */

import { AgentRuntimeClient, type FollowedTurn } from "@/apps/agent/services/runtime/agent-runtime-client";
import { threadService } from "@/apps/agent/services/threads/thread-service";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { createTurnWriter } from "./turn-writer";
import { genId, nowIso, runningAgents } from "./turn-registry";

/** A turn another client started, as the backend announces or lists it. */
export interface ForeignTurn {
  threadId: string;
  turnId: string;
  /** The project it runs in; `null` for Aurora Chat, `undefined` when unknown. */
  workspaceRoot?: string | null;
  /** What the person sent, when a person's message opened the turn. */
  userMessage?: string | null;
  /** Found running when this client opened, so the start was missed. */
  joinedLate?: boolean;
}

/** Thread id → the followed turn, from the moment it is claimed. */
const followed = new Map<string, FollowedTurn | null>();

/** Whether this client is following a turn on `threadId`. */
export function isFollowingTurn(threadId: string): boolean {
  return followed.has(threadId);
}

/** Cancel a followed turn in the runtime. False when none is followed here. */
export function stopFollowedTurn(threadId: string): boolean {
  const turn = followed.get(threadId);
  if (!turn) return false;
  void turn.stop();
  return true;
}

/**
 * Follow `turn` until it ends. A turn this client is running itself, or one
 * it already follows, is left alone.
 */
export async function followTurn(turn: ForeignTurn): Promise<void> {
  const { threadId, turnId } = turn;
  if (followed.has(threadId) || runningAgents.has(threadId)) return;
  if (useAgentChatStore.getState().liveTurns[threadId]) return;
  followed.set(threadId, null);
  try {
    await run(turn);
  } catch (error) {
    console.warn(`[agent-window] could not follow turn ${turnId} on ${threadId}`, error);
    useAgentChatStore.getState().endTurn(threadId);
  } finally {
    followed.delete(threadId);
  }
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  workspaceRoot: string | null;
}

const activeTurns = () => auroraInvoke<ActiveTurn[]>("agent_active_turns");

/** Follow every conversation turn already running (for a client that just opened). */
export async function followActiveTurns(): Promise<void> {
  const active = await activeTurns();
  await Promise.all(active.map((turn) => followTurn({ ...turn, joinedLate: true })));
}

async function run(turn: ForeignTurn): Promise<void> {
  const { threadId, turnId } = turn;
  // The open chat seeds itself (`beginTurn` prefers the open view); any other
  // chat is read from disk, or opening it mid-turn would show only the part
  // streamed since.
  const open = useAgentChatStore.getState().currentThreadId === threadId;
  const seed = open ? undefined : ((await threadService.loadThread(threadId)) ?? undefined);
  // The sender may have finished, or this client started a turn here, while
  // the chat was read.
  if (runningAgents.has(threadId) || useAgentChatStore.getState().liveTurns[threadId]) return;

  const store = useAgentChatStore.getState();
  store.beginTurn(threadId, seed, turn.workspaceRoot);
  const typed = turn.userMessage?.trim();
  if (typed) {
    // The journal may not hold the message yet, so it is drawn from the
    // notice, unless the seed already ends on it.
    const last = useAgentChatStore.getState().liveTurns[threadId]?.messages.at(-1);
    if (!(last?.role === "user" && last.content.trim() === typed)) {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "user",
        content: turn.userMessage ?? "",
        timestamp: nowIso(),
      });
    }
  }
  const assistantId = genId();
  store.appendTurnMessage(threadId, {
    id: assistantId,
    role: "assistant",
    content: "",
    timestamp: nowIso(),
    tool_calls: [],
    timeline: [],
  });

  const writer = createTurnWriter(threadId, assistantId);
  const handle = await AgentRuntimeClient.follow(turnId, {
    ...writer.callbacks,
    onUsage: (usage) => writer.addUsage(usage),
  });
  followed.set(threadId, handle);

  // A turn that ended before the listeners were attached never sends its end
  // here; ask whether it still runs.
  const active = await activeTurns().catch((error: unknown) => {
    console.warn("[agent-window] could not read the running turns", error);
    return null;
  });
  const missedEnd = active === null || !active.some((t) => t.turnId === turnId);
  if (active && missedEnd) handle.dispose();

  const outcome = await handle.done;
  writer.settle();
  const after = useAgentChatStore.getState();
  after.flushTurnPatches();
  // Same order as the sender: the persisted row is in the rail before the
  // live one goes, so the chat never blinks out of it.
  await after.refreshThreads();
  after.endTurn(threadId);
  if (outcome === "complete") after.noteTurnComplete(threadId);
  // The followed stream is only what arrived here. A turn joined late, or one
  // whose end came before the listeners, is read back from disk.
  if ((turn.joinedLate || missedEnd) && useAgentChatStore.getState().currentThreadId === threadId) {
    await useAgentChatStore.getState().reloadCurrentThread();
  }
}
