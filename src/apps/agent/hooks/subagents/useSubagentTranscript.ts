/**
 * One sub-agent's transcript, live [hook].
 *
 * Shared by the agent's own tab and its preview in the Agents tab, so the two
 * can never show different things. Two sources, one result:
 *
 * - **The file** (`subagent_thread_load`): the truth, read on mount, whenever
 *   the stream says something just landed (a model call starting or ending, a
 *   message taken in), and on a slow clock while the agent runs in case an
 *   event was missed.
 * - **The stream**: every thinking and text delta and tool call as it
 *   happens, folded into one live reply laid over the file. This is what
 *   makes a three-minute think visible while it happens. The reply is kept
 *   for the window, not the view (`useSubagentLiveStore`, fed by
 *   `services/subagents/live-stream.ts`): the dock mounts only the active
 *   tab, and a reply kept in the view restarted from 0s on every switch.
 *
 * Messages the parent sent that the agent has not taken in yet come back as
 * `pending`, so a view can show them at once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  recallTranscript,
  rememberTranscript,
  subagentMemoryKey,
} from "@/apps/agent/components/panels/subagent-memory";
import { EMPTY_LIVE, mergeLive } from "@/apps/agent/lib/subagents/live-transcript";
import { loadSubagentThread, type SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import type { DbMessage, DbThread } from "@/apps/agent/services/threads/thread-service";
import {
  selectPendingFor,
  useAgentSubagentStore,
  type PendingParentMessage,
} from "@/apps/agent/store/subagents/useAgentSubagentStore";
import {
  selectLiveFor,
  useSubagentLiveStore,
} from "@/apps/agent/store/subagents/useSubagentLiveStore";

/** Fallback re-read while the agent runs. The stream is the fast path. */
const POLL_MS = 3_000;

export interface SubagentTranscript {
  agent: SubagentSnapshot | undefined;
  running: boolean;
  /** The file's messages with the live reply laid over them. */
  messages: DbMessage[];
  loading: boolean;
  missing: boolean;
  pending: PendingParentMessage[];
}

/**
 * Read an agent's transcript ahead of showing it (the pointer is on its row).
 * The hook starts from the remembered copy, so a tail opened after this has
 * its content on the first frame instead of landing mid-animation. Once per
 * agent; a failure is left for the hook's own read to report.
 */
const prefetched = new Set<string>();
export function prefetchSubagentTranscript(parentThreadId: string, agentId: string): void {
  const key = subagentMemoryKey(parentThreadId, agentId);
  if (prefetched.has(key) || recallTranscript(key)) return;
  prefetched.add(key);
  void loadSubagentThread(parentThreadId, agentId)
    .then((loaded) => {
      if (loaded) rememberTranscript(key, loaded);
    })
    .catch(() => {
      prefetched.delete(key);
    });
}

/** Whether `text` appears anywhere in the transcript a message renders. */
function transcriptHolds(messages: DbMessage[], text: string): boolean {
  const needle = text.trim();
  if (!needle) return true;
  const escaped = JSON.stringify(needle).slice(1, -1);
  return messages.some(
    (m) =>
      (typeof m.content === "string" && m.content.includes(needle)) ||
      (m.timeline !== undefined && JSON.stringify(m.timeline).includes(escaped)),
  );
}

export function useSubagentTranscript(parentThreadId: string, agentId: string): SubagentTranscript {
  const agent = useAgentSubagentStore((s) =>
    s.byParent[parentThreadId]?.find((row) => row.agentId === agentId),
  );
  const listLoaded = useAgentSubagentStore((s) => !!s.loaded[parentThreadId]);
  const liveTurn = useAgentSubagentStore((s) => s.liveTurnByAgent[agentId]);
  const loadAgents = useAgentSubagentStore((s) => s.load);
  const settlePending = useAgentSubagentStore((s) => s.settlePending);
  const pending = useAgentSubagentStore(selectPendingFor(agentId));
  const running = !!liveTurn || agent?.status === "running";

  // One record stamped with the agent it describes, so a view reused for
  // another agent reads as "loading" instead of showing the previous one.
  const key = subagentMemoryKey(parentThreadId, agentId);
  const [record, setRecord] = useState<{ key: string; thread: DbThread | null; missing: boolean } | null>(
    () => {
      const cached = recallTranscript(key);
      return cached ? { key, thread: cached, missing: false } : null;
    },
  );
  // The live reply, kept for the window and keyed by agent, so a view reused
  // for another agent reads that agent's and a remounted view resumes.
  const live = useSubagentLiveStore(selectLiveFor(agentId));
  const rereadTick = useSubagentLiveStore((s) => s.rereadTick[agentId] ?? 0);
  const aliveRef = useRef(true);

  const current = record?.key === key ? record : null;

  const pull = useCallback(() => {
    const liveStore = useSubagentLiveStore.getState();
    const seq = liveStore.beginRead(agentId);
    void loadSubagentThread(parentThreadId, agentId)
      .then((loaded) => {
        // The live reply is the window's, so its base is learned whether or
        // not this view is still mounted.
        if (loaded) useSubagentLiveStore.getState().settle(agentId, seq, loaded.messages.length);
        if (!aliveRef.current) return;
        if (loaded) rememberTranscript(key, loaded);
        setRecord({ key, thread: loaded ?? null, missing: !loaded });
        if (loaded) settlePending(agentId, (text) => transcriptHolds(loaded.messages, text));
      })
      .catch((err) => {
        if (!aliveRef.current) return;
        console.error(`[subagent] failed to load ${agentId}:`, err);
        // A failed re-read must not blank a transcript already on screen.
        setRecord((prev) =>
          prev?.key === key && prev.thread ? prev : { key, thread: null, missing: true },
        );
      });
  }, [parentThreadId, agentId, key, settlePending]);

  useEffect(() => {
    aliveRef.current = true;
    pull();
    return () => {
      aliveRef.current = false;
    };
  }, [pull]);

  // The footer and the list need the agent's row even when its parent is not
  // the open conversation (a restored tab).
  useEffect(() => {
    if (parentThreadId && !listLoaded) void loadAgents(parentThreadId);
  }, [parentThreadId, listLoaded, loadAgents]);

  // The stream says something just landed in the file: read it. The first
  // render's tick is covered by the mount read above.
  const seenTick = useRef(rereadTick);
  useEffect(() => {
    if (rereadTick === seenTick.current) return;
    seenTick.current = rereadTick;
    pull();
  }, [rereadTick, pull]);

  // The slow clock: a missed event costs seconds, never a wrong state. The
  // list is re-read too, so a missed `finished` cannot leave "working" up.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      pull();
      if (parentThreadId) void loadAgents(parentThreadId);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, pull, parentThreadId, loadAgents]);

  // Once more when it stops, so the last lines written are shown. The live
  // overlay stops being drawn then: the file has everything. A later run
  // starts its own reply on its first event.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) pull();
    wasRunning.current = running;
  }, [running, pull]);

  const thread = current?.thread ?? null;
  const liveState = running ? live : EMPTY_LIVE;
  const messages = useMemo(
    () => mergeLive(thread?.messages ?? [], liveState),
    [thread, liveState],
  );

  return {
    agent,
    running,
    messages,
    loading: current === null,
    missing: current?.missing ?? false,
    pending,
  };
}
