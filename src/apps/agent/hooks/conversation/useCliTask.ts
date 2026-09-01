/**
 * Running a task dispatched from a terminal.
 *
 * `aurora agent "..."` writes a request to disk, Rust claims it and emits it
 * here, and this hook turns it into an ordinary turn: it opens or continues a
 * thread, pins the model, and sends the prompt through the same path a typed
 * message takes. From that point the work is indistinguishable from anything
 * else in the window — it streams, it can be steered, it can be stopped.
 *
 * ## Two ways a task arrives, because events are not buffered
 *
 * A task claimed while this window was still booting was emitted to nobody.
 * So:
 *
 *  - `cli_task_pending` is pulled once on mount, for anything already waiting.
 *  - the `cli-task` event covers everything dispatched while we are running.
 *
 * Both funnel through {@link run}, which claims before acting — so a task that
 * arrives by both routes is executed once.
 */

import { useEffect, useRef } from "react";

import { auroraInvoke, auroraListen } from "@/kernel/lib/ipc/runtime";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import type { AgentWindowSend } from "./useAgentWindowSend";

/** Wire shape of a dispatched task. Mirrors Rust's `TaskRequest`. */
interface CliTaskRequest {
  id: string;
  prompt: string;
  workspacePath: string;
  threadId?: string | null;
  providerId?: string | null;
  model?: string | null;
  mode?: "agent" | "plan";
  outPath?: string | null;
}

/** Channel Rust emits a claimed task on. Must match `watcher::CLI_TASK_EVENT`. */
const CLI_TASK_EVENT = "cli-task";

/**
 * How long to let the store settle after switching project or thread.
 *
 * Selecting a thread is asynchronous all the way down — it loads the
 * transcript, repoints the rail, and rehydrates per-thread state. Sending
 * into it before that lands opens the turn on a thread the store has not
 * finished pointing at, and the message renders in the wrong conversation.
 */
const SETTLE_MS = 120;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useCliTask(send: AgentWindowSend["send"]): void {
  /**
   * Tasks this window has already started.
   *
   * The claim in Rust is the real guard against two windows running one task;
   * this is the guard against *one* window running it twice, which the
   * pull-on-mount and the live event together make possible. A ref, not
   * state — it must not trigger a render, and it must survive one.
   */
  const started = useRef(new Set<string>());

  /**
   * The latest `send`, so the listener below is registered once rather than
   * re-registered on every render. A stale closure here would send through a
   * pipeline bound to a thread that is no longer open.
   */
  const sendRef = useRef(send);
  // Updated in an effect, not during render: a ref written while rendering is
  // a mutation React cannot see, and it tears under concurrent rendering
  // where a render can be started and thrown away.
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    let cancelled = false;

    const run = async (task: CliTaskRequest) => {
      if (cancelled || started.current.has(task.id)) return;
      started.current.add(task.id);

      try {
        const store = useAgentChatStore.getState();

        // Scope the window to the task's project first: threads are
        // project-keyed, so creating one before this would file it under
        // whatever project happened to be open.
        if (store.projectRoot !== task.workspacePath) {
          await store.setProject(task.workspacePath);
          await sleep(SETTLE_MS);
        }

        if (task.threadId) {
          await useAgentChatStore
            .getState()
            .selectThread(task.threadId, task.workspacePath);
        } else {
          useAgentChatStore.getState().newChat();
        }
        await sleep(SETTLE_MS);

        // The thread has to EXIST before its model can be pinned, and
        // `newChat()` only clears the selection — the row is created lazily on
        // first send. Creating it here is safe because `ensureThreadForSend`
        // returns the open thread when there is one, so the send below reuses
        // this exact thread rather than making a second.
        //
        // Without this, `--model` was silently dropped on every new
        // conversation: there was no thread id to pin it to yet.
        const threadId = await useAgentChatStore
          .getState()
          .ensureThreadForSend(task.prompt);

        // Pin the model the dispatch named, when it named one. Skipped
        // otherwise, so the thread keeps whatever it already runs on — which
        // is what "use the window's selection" means.
        const pin =
          task.providerId && task.model ? `${task.providerId}:${task.model}` : null;
        if (pin && threadId) {
          await useAgentChatStore.getState().setThreadModel(threadId, pin);
        }

        await sendRef.current(task.prompt, undefined, {
          cliTaskId: task.id,
          // `--plan` means read-only, and it has to be enforced for the turn
          // rather than merely written into the request file. Reading this
          // field and not applying it is exactly how a `--plan` dispatch
          // deleted a file it was promised it could not touch.
          executionMode: task.mode === "plan" ? "plan" : "agent",
        });
      } catch (error) {
        // Tell the terminal, rather than leaving it to time out on a file
        // nothing is going to write. A dispatch that Aurora accepted and could
        // not run must say so — "not picked up" would be a lie.
        started.current.delete(task.id);
        await auroraInvoke("cli_task_fail", {
          taskId: task.id,
          turnId: `${task.id}-failed`,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {
          /* The transcript is already unreachable; nothing further to try. */
        });
      }
    };

    // Anything dispatched while this window was booting. Claimed explicitly,
    // because these were never delivered through the event — Rust hands them
    // over only when someone asks.
    const drainPending = async () => {
      try {
        const pending = await auroraInvoke<CliTaskRequest[]>("cli_task_pending");
        for (const task of pending) {
          if (cancelled) return;
          const claimed = await auroraInvoke<CliTaskRequest | null>(
            "cli_task_claim",
            { taskId: task.id },
          );
          // `null` means another window won the claim — the mechanism working.
          if (claimed) await run(claimed);
        }
      } catch {
        /* No inbox yet, or it could not be read. Nothing was dispatched. */
      }
    };

    let unlisten: (() => void) | null = null;
    void (async () => {
      // Listen BEFORE draining, so a task dispatched during the drain is not
      // dropped in the gap between the two.
      unlisten = await auroraListen<CliTaskRequest>(CLI_TASK_EVENT, ({ payload }) => {
        void run(payload);
      });
      await drainPending();
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
