/**
 * Telling other processes that this window is here, and what it is doing.
 *
 * `aurora mcp` runs in a different process. It can ask the operating system
 * whether an Aurora is alive, but not whether the *Agent Window* is open, not
 * whether the user has allowed outside agents to send work, and not what is on
 * screen. Only this window knows those, so this window publishes them.
 *
 * Rust writes the file and fills in everything it can establish for itself —
 * the process id, the timestamp, and the fact that a window exists at all,
 * which is proven by this command being reachable. See
 * `cli_delegate::bridge`.
 *
 * ## It publishes on change, not on a timer
 *
 * A heartbeat would write this file a few times a second forever to describe
 * something that changes a few times an hour. The snapshot is small and
 * comparable, so a shallow compare against the last published one is enough:
 * flipping the switch, switching project, opening a chat, and a turn starting
 * or ending each write once.
 *
 * A stale file left by a crash is not this hook's problem to solve. The reader
 * pairs it with an OS-held presence guard that the kernel releases on process
 * death, and Rust clears the file on window destroy and on app start.
 */

import { useEffect, useRef } from "react";

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { pinnedThreadModel } from "@/apps/agent/lib/thread/thread-model";

/** Exactly what Rust's `BridgePublish` expects. */
interface BridgeSnapshot {
  enabled: boolean;
  workspace: string | null;
  threadId: string | null;
  threadTitle: string | null;
  model: string | null;
  busy: boolean;
}

/** Whether two snapshots say the same thing. */
function same(a: BridgeSnapshot | null, b: BridgeSnapshot): boolean {
  return (
    a !== null &&
    a.enabled === b.enabled &&
    a.workspace === b.workspace &&
    a.threadId === b.threadId &&
    a.threadTitle === b.threadTitle &&
    a.model === b.model &&
    a.busy === b.busy
  );
}

/** Read the current state out of the stores. */
function snapshot(): BridgeSnapshot {
  const chat = useAgentChatStore.getState();
  const { mcpBridgeEnabled } = useAgentSettingsStore.getState();

  const threadId = chat.currentThreadId;
  const row =
    chat.threads.find((t) => t.id === threadId) ??
    chat.allThreads.find((t) => t.id === threadId) ??
    null;

  return {
    enabled: mcpBridgeEnabled,
    workspace: chat.projectRoot,
    threadId,
    threadTitle: row?.title ?? null,
    model: pinnedThreadModel(chat, threadId),
    // Any thread with a live transcript is a turn in flight. Reported so a
    // caller can see that work it sends now queues behind something, rather
    // than discovering it from a task that sits still for ten minutes.
    busy: Object.keys(chat.liveTurns).length > 0,
  };
}

/**
 * Keep the published state current for as long as the Agent Window is open.
 *
 * Mount it once, at the window root. Mounting it twice would be harmless (both
 * copies publish the same thing) but pointless.
 */
export function useAuroraBridge(): void {
  const published = useRef<BridgeSnapshot | null>(null);

  useEffect(() => {
    let disposed = false;
    let coalesce: number | null = null;

    const publishNow = () => {
      coalesce = null;
      if (disposed) return;
      const next = snapshot();
      if (same(published.current, next)) return;
      published.current = next;
      void auroraInvoke("aurora_bridge_publish", { state: next }).catch(() => {
        // Publishing is best-effort. A failure costs an outside agent a stale
        // reading for a few seconds; it must never interrupt the window, and
        // there is nothing the person using Aurora could do about it. Forget
        // what was sent so the next change retries, rather than comparing
        // against a state that never reached disk.
        published.current = null;
      });
    };

    // Both stores notify on every change, and the chat store changes on every
    // streamed token. Rebuilding and comparing a snapshot that often would put
    // real work on the streaming path to discover, almost always, that nothing
    // publishable moved. A short trailing window caps it at one check per
    // burst and still lands well inside the time it takes anyone to read the
    // answer.
    const schedule = () => {
      if (disposed || coalesce !== null) return;
      coalesce = window.setTimeout(publishNow, 150);
    };

    publishNow();
    const stopChat = useAgentChatStore.subscribe(schedule);
    const stopSettings = useAgentSettingsStore.subscribe(schedule);

    // A reload destroys nothing, so Rust's window handler never fires for it.
    // Without this, refreshing the window would leave the file claiming an open
    // window for as long as the reload takes.
    const onUnload = () => {
      void auroraInvoke("aurora_bridge_clear");
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      disposed = true;
      if (coalesce !== null) window.clearTimeout(coalesce);
      stopChat();
      stopSettings();
      window.removeEventListener("beforeunload", onUnload);
      void auroraInvoke("aurora_bridge_clear");
    };
  }, []);
}
