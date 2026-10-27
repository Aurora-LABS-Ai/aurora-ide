/**
 * Keep this window in step with conversations changed by another client.
 *
 * The desktop window and browser tabs (`AURORA_WEB=1`) share one backend and
 * can show the same project. Only the client that started a turn follows its
 * stream, so the others hear about the change from the backend instead:
 * `agent_thread_changed` (a user message landed, a turn ended, a rename),
 * `thread-created` and `thread-deleted`. On any of them the chat list is
 * re-read; when the changed chat is the one open here and this client is not
 * the one running its turn, the chat is reloaded from disk.
 *
 * A turn another client starts ("turn_start", or already running when this
 * client opens) is followed live (`send/followed-turns.ts`): spinner in the
 * rail, the stream in the open chat.
 *
 * Re-reads are batched: one turn sends several events in quick succession.
 */

import { useEffect } from "react";

import {
  followActiveTurns,
  followTurn,
} from "@/apps/agent/hooks/conversation/send/followed-turns";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { auroraListen } from "@/kernel/lib/ipc/runtime";

interface ThreadChanged {
  threadId?: string;
  workspaceRoot?: string | null;
  reason?: string;
  turnId?: string;
  userMessage?: string;
}

const BATCH_MS = 150;

export function useCrossClientThreadSync(): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reloadOpen = false;
    const offs: (() => void)[] = [];

    const flush = () => {
      timer = null;
      const store = useAgentChatStore.getState();
      void store.refreshThreads();
      if (reloadOpen) {
        reloadOpen = false;
        // A followed turn may have opened on it since; its live copy is newer.
        const open = store.currentThreadId;
        if (open && !store.liveTurns[open]) void store.reloadCurrentThread();
      }
    };
    const schedule = (change?: ThreadChanged) => {
      if (change?.reason === "turn_start" && change.threadId && change.turnId) {
        void followTurn({
          threadId: change.threadId,
          turnId: change.turnId,
          workspaceRoot: change.workspaceRoot ?? null,
          userMessage: change.userMessage ?? null,
        });
      }
      const store = useAgentChatStore.getState();
      const open = store.currentThreadId;
      if (
        change?.threadId &&
        change.threadId === open &&
        change.reason !== "renamed" &&
        // The follower draws a started turn as it runs.
        change.reason !== "turn_start" &&
        // This client is running that turn: its own stream is the newer copy.
        !store.liveTurns[change.threadId]
      ) {
        reloadOpen = true;
      }
      if (timer === null) timer = setTimeout(flush, BATCH_MS);
    };

    for (const name of ["agent_thread_changed", "thread-created", "thread-deleted"]) {
      void auroraListen<ThreadChanged>(name, (event) => schedule(event.payload))
        .then((off) => {
          if (cancelled) off();
          else offs.push(off);
        })
        .catch((error: unknown) => {
          console.warn(`[agent-window] could not follow ${name}`, error);
        });
    }
    // Turns another client started before this one opened.
    void followActiveTurns().catch((error: unknown) => {
      console.warn("[agent-window] could not read the running turns", error);
    });

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, []);
}
