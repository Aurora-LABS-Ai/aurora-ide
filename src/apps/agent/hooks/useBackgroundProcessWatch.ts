/**
 * Window-level watch on every background process, however it got there.
 *
 * Rust announces an ending once, on one app-wide `shell-process-ended` event.
 * That listener used to live inside the process dock — which `RailChip` mounts
 * "only while open (so its polling stays off until then)". So the announcement
 * was heard only while a popover happened to be open, and any surface that
 * needs to know a process ended could not rely on it. A card that says
 * "Running in the background" over a finished build is worse than one that
 * never claimed to know.
 *
 * Mounted once, from `AgentWindow`, for the life of the window:
 *
 * - **The ending is heard always.** One listener, not one per row and not one
 *   per open panel.
 * - **The ledger is re-read slowly.** `shell-process-ended` is fire-and-forget:
 *   if the window is mid-reload when it fires, nothing hears it. The dock keeps
 *   its own faster poll for the panel the user is actually looking at; this one
 *   only has to stop a row lying for minutes at a time.
 */

import { useEffect } from "react";

import { auroraInvoke, auroraListen } from "@/kernel/lib/ipc/runtime";
import { isSubagentId } from "@/apps/agent/services/subagents/commands";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  processById,
  useAgentBackgroundStore,
  type BackgroundProcess,
} from "@/apps/agent/store/conversation/useAgentBackgroundStore";

/**
 * The safety net for a missed `shell-process-ended`, not the surface anyone is
 * watching — but a row that lies says "running" over a finished command, and a
 * minute of that is a long time to stare at. One IPC round-trip per tick.
 */
const LEDGER_POLL_MS = 20_000;

/** One live row from Rust's `shell_background_processes` ledger. */
interface LedgerRow {
  processId: string;
  requestId?: string;
  name?: string | null;
  command: string;
  cwd?: string | null;
  outputFile?: string;
  startedAtMs: number;
}

interface ProcessEnded {
  processId?: string;
  exitCode?: number | null;
  outcome?: "exited" | "stopped";
  /** The conversation whose `shell_spawn` started it, when known. */
  threadId?: string;
  /** The agent's `shell_notify` choice; absent when it never made one. */
  wake?: boolean;
}

/**
 * How long after a turn ends an UNDECIDED ending still wakes the agent.
 *
 * Inside it, the agent's last words are probably about this process ("I'll
 * open the installer when the build finishes") and the person is probably
 * still here. After it, they have moved on, and starting a turn would be
 * Aurora talking to itself; the ending rides in with the next message instead.
 * The agent can override either way with `shell_notify`.
 */
export const WAKE_WINDOW_MS = 5 * 60 * 1000;

/**
 * What an ending that lands while the conversation is idle does: start a turn
 * (`wake`), or wait for the next message (`ride`). Pure, so the rule is tested
 * on its own.
 *
 * - The agent chose (`shell_notify`): its choice, whatever the clock says.
 * - Undecided: wake only within {@link WAKE_WINDOW_MS} of the turn ending. A
 *   turn end this window never saw (the app was restarted since) is treated as
 *   long ago.
 */
export function idleDelivery(
  wake: boolean | undefined,
  endedAtMs: number,
  turnEndedAtMs: number | undefined,
): "wake" | "ride" {
  if (wake === true) return "wake";
  if (wake === false) return "ride";
  if (turnEndedAtMs === undefined) return "ride";
  return endedAtMs - turnEndedAtMs <= WAKE_WINDOW_MS ? "wake" : "ride";
}

/** When each conversation's last turn ended, as this window saw it. */
const turnEndedAt = new Map<string, number>();

/** Test seam: pretend a turn ended at `atMs`. */
export const noteTurnEnded = (threadId: string, atMs: number): void => {
  turnEndedAt.set(threadId, atMs);
};

/**
 * Endings queued into a running turn, by the text the model would read, with
 * the agent's choice. If the turn ends before reading one, Rust hands it back
 * (`agent_process_report_leftover`) and this says whether it wakes or rides.
 */
const queuedWake = new Map<string, boolean | undefined>();

/** Rust's `agent_process_report_leftover` (`host::ProcessReportLeftover`). */
export const PROCESS_REPORT_LEFTOVER_EVENT = "agent_process_report_leftover";
interface ProcessReportLeftover {
  threadId: string;
  summary: string;
  detail: string;
}

/** The thread a process is filed under, which is where its ending belongs. */
const threadOwning = (
  byThread: Record<string, BackgroundProcess[]>,
  processId: string,
): string | null => {
  for (const [threadId, entries] of Object.entries(byThread)) {
    if (entries.some((entry) => entry.processId === processId)) return threadId;
  }
  return null;
};

/**
 * Tell the conversation that a background process ended.
 *
 * Two copies, and they are different on purpose. The transcript gets the beat's
 * "verb subject" line, which is all a reader needs mid-turn. The model gets the
 * id and the log path, because the useful next move is `shell_read_output` and
 * it cannot make that call from prose.
 *
 * Two delivery paths, because a conversation is either working or it is not:
 *
 * - **Mid-turn** — queue it. The runtime folds it into the next tool result,
 *   which is where a fact that arrived during the work belongs.
 * - **Idle** — START a turn with it ({@link pendingIdleReport}). Queuing into an
 *   idle thread does not work: the slot only drains at a tool-result boundary,
 *   so with nothing running the note sits there until some later, unrelated
 *   turn picks it up and arrives without the context that made it mean
 *   anything. Dropping it does not work either — that is what left the agent
 *   certain a build was still running twenty minutes after it failed.
 */
const reportEnding = (row: BackgroundProcess | null, ended: ProcessEnded) => {
  const processId = ended.processId;
  if (!processId) return;
  // No row means this was never a background process. EVERY foreground
  // `shell_execute` is in Rust's ledger — that is how it gets a live stream and
  // a stop button — so every one of them announces its ending on this same
  // channel. Reporting those turned two ordinary `Run Command` calls into
  // "Finished a background process · exit 0" in the transcript, and sent the
  // model a note about a process it had just watched finish. Only what the
  // process list actually holds is a background process: a `shell_spawn`, or
  // something a person pressed "Run in background" on.
  //
  // A sub-agent's `shell_spawn` is the exception, because the ending names
  // its owner: it is told to THAT agent, never to the conversation on screen
  // (which never started it), and it needs no row in the parent's dock to be
  // a background process — only a spawn is tagged with an owner.
  const ownedByAgent = !!ended.threadId && isSubagentId(ended.threadId);
  if (!row && !ownedByAgent) return;
  const chat = useAgentChatStore.getState();
  const threadId = ownedByAgent
    ? ended.threadId!
    : (threadOwning(useAgentBackgroundStore.getState().byThread, processId) ??
      chat.currentThreadId);
  if (!threadId) return;

  // The row is what named it — a spawn's required title, or the command line a
  // hand-off carried. There is no anonymous case left to invent a name for.
  const name = row?.title?.trim() || row?.command?.trim() || "a background process";
  const exit = ended.exitCode;
  // "Failed" and "Finished" are not the same event, and the exit code is the
  // only thing that knows which one happened.
  const verb = typeof exit === "number" && exit !== 0 ? "Failed" : "Finished";
  const code = typeof exit === "number" ? ` · exit ${exit}` : "";
  const summary = `${verb} ${name}${code}`.trim();
  const detail =
    `The background process "${name}" (id ${processId}) has ended` +
    (typeof exit === "number" ? ` with exit code ${exit}` : "") +
    `. Nothing more will arrive from it.` +
    (row?.outputFile
      ? ` Everything it printed is in ${row.outputFile}; read it with shell_read_output.`
      : "");

  // A sub-agent has no window turn: Rust's queue for it is read at its next
  // step, or — if it has finished — when the parent gives it more work.
  if (ownedByAgent || chat.liveTurns[threadId]) {
    if (!ownedByAgent) queuedWake.set(detail, ended.wake);
    void chat
      .enqueueMessage(threadId, summary, { origin: "process", modelText: detail })
      .catch(() => {
        // The row is already settled and the log is already on disk. A failed
        // report costs the agent a notification, not the record.
      });
    return;
  }

  const endedAtMs = Date.now();
  const report = { summary, detail, endedAtMs, watched: ended.wake === true };
  if (idleDelivery(ended.wake, endedAtMs, turnEndedAt.get(threadId)) === "wake") {
    parkIdleReport(threadId, report);
  } else {
    parkRideAlong(threadId, report);
  }
};

/**
 * Endings that do not start a turn: they go into the next turn that starts in
 * that conversation (normally the person's next message), queued the moment it
 * opens so the agent reads them at its first tool boundary.
 */
const rideAlong = new Map<string, IdleReport[]>();

export const parkRideAlong = (threadId: string, report: IdleReport): void => {
  rideAlong.set(threadId, [...(rideAlong.get(threadId) ?? []), report]);
};

export const peekRideAlong = (threadId: string): IdleReport[] => rideAlong.get(threadId) ?? [];

/** A turn opened on `threadId`: queue everything riding along into it. */
const sendRideAlong = (threadId: string): void => {
  const reports = rideAlong.get(threadId);
  if (!reports?.length) return;
  rideAlong.delete(threadId);
  const chat = useAgentChatStore.getState();
  for (const report of reports) {
    // If this turn also ends before a tool boundary, the leftover comes back
    // and rides again rather than waking anyone.
    queuedWake.set(report.detail, false);
    void chat
      .enqueueMessage(threadId, report.summary, { origin: "process", modelText: report.detail })
      .catch((error: unknown) => {
        console.error("[background] could not attach a process ending to the turn:", error);
        parkRideAlong(threadId, report);
      });
  }
};

/**
 * Endings that arrived with nothing running, waiting for something to start a
 * turn with them.
 *
 * Module-level rather than store state because it is not something any surface
 * renders — the dock already shows the row, and the transcript will show the
 * beat once the turn begins. One per thread: a second ending while the first is
 * still parked appends to it, so two processes finishing together produce one
 * turn rather than two.
 */
export interface IdleReport {
  summary: string;
  detail: string;
  endedAtMs: number;
  /** The agent asked to be woken (`shell_notify`): no age limit applies. */
  watched?: boolean;
}
const idleReports = new Map<string, IdleReport>();
const idleReportChanged = new Set<() => void>();

const parkIdleReport = (threadId: string, report: IdleReport): void => {
  const existing = idleReports.get(threadId);
  idleReports.set(
    threadId,
    existing
      ? {
          // Both endings, in the order they happened, as one turn.
          summary: `${existing.summary} · ${report.summary}`,
          detail: `${existing.detail}\n\n${report.detail}`,
          endedAtMs: existing.endedAtMs,
          watched: existing.watched || report.watched,
        }
      : report,
  );
  idleReportChanged.forEach((listener) => listener());
};

export const takeIdleReport = (threadId: string): IdleReport | null => {
  const report = idleReports.get(threadId) ?? null;
  if (report) idleReports.delete(threadId);
  return report;
};

/**
 * Put a taken report back, ahead of anything parked since: the send that
 * took it did not open a turn (another turn got there first), so it is
 * still news nobody has read.
 */
export const requeueIdleReport = (threadId: string, report: IdleReport): void => {
  const existing = idleReports.get(threadId);
  idleReports.set(
    threadId,
    existing
      ? {
          summary: `${report.summary} · ${existing.summary}`,
          detail: `${report.detail}\n\n${existing.detail}`,
          endedAtMs: report.endedAtMs,
          watched: report.watched || existing.watched,
        }
      : report,
  );
  idleReportChanged.forEach((listener) => listener());
};

export const peekIdleReport = (threadId: string): IdleReport | null =>
  idleReports.get(threadId) ?? null;

export const subscribeToIdleReports = (listener: () => void): (() => void) => {
  idleReportChanged.add(listener);
  return () => idleReportChanged.delete(listener);
};

/** Test seam. */
export const clearIdleReports = (): void => {
  idleReports.clear();
  rideAlong.clear();
  turnEndedAt.clear();
  queuedWake.clear();
};

/**
 * How stale a parked ending may be before it stops starting a turn.
 *
 * A process that finished two hours ago is not worth waking a conversation
 * for, unless the agent asked (`watched`). It is not dropped either: it rides
 * in with the next message, so the agent still learns how the run ended.
 */
export const IDLE_REPORT_MAX_AGE_MS = 30 * 60 * 1000;

export const useBackgroundProcessWatch = (threadId: string | null) => {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void auroraListen<ProcessEnded>("shell-process-ended", (event) => {
      const ended = event?.payload;
      if (disposed || !ended?.processId) return;
      const store = useAgentBackgroundStore.getState();
      // Read the row BEFORE settling it: the report needs the command's name,
      // and `settle` is the moment it stops being a running process.
      const row = processById(store.byThread, ended.processId);
      // `settle` is deliberately not thread-scoped — a process id is globally
      // unique and a run started under another chat still has to stop lying.
      store.settle(
        ended.processId,
        ended.outcome === "stopped" ? "stopped" : "exited",
        ended.exitCode ?? null,
      );
      // A process the user stopped is already reported by the hand that stopped
      // it, with the detail only that path has. Reporting it twice would put
      // the same ending in the transcript from two directions.
      if (ended.outcome === "stopped") return;
      reportEnding(row, ended);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Without the listener a row settles on the next reconcile instead of
        // instantly. Degraded, and still not wrong.
      });

    // An ending queued into a turn that then ended without another tool
    // boundary: the model never read it. Rust hands it back at turn end and it
    // is parked like any idle ending, so the next idle moment starts a turn
    // with it (Claude Code's rule: what a turn did not consume runs next).
    let unlistenLeftover: (() => void) | null = null;
    void auroraListen<ProcessReportLeftover>(PROCESS_REPORT_LEFTOVER_EVENT, (event) => {
      const leftover = event?.payload;
      if (disposed || !leftover?.threadId || !leftover.detail) return;
      const wake = queuedWake.get(leftover.detail);
      queuedWake.delete(leftover.detail);
      const report = {
        summary: leftover.summary || leftover.detail,
        detail: leftover.detail,
        endedAtMs: Date.now(),
        watched: wake === true,
      };
      // It ended while the turn was still running, so the clock is inside the
      // window by definition; only the agent's own "do not wake me" (or a note
      // that was already riding along) keeps it waiting for the next message.
      if (wake === false) parkRideAlong(leftover.threadId, report);
      else parkIdleReport(leftover.threadId, report);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlistenLeftover = dispose;
      })
      .catch((error: unknown) => {
        console.error("[background] could not listen for late process reports:", error);
      });

    // Turn boundaries, for every conversation: an ending starts the
    // wake-window clock, a start carries whatever is riding along.
    let live = new Set(Object.keys(useAgentChatStore.getState().liveTurns));
    const unsubscribeTurns = useAgentChatStore.subscribe((state) => {
      const now = new Set(Object.keys(state.liveTurns).filter((id) => state.liveTurns[id]));
      for (const id of live) if (!now.has(id)) turnEndedAt.set(id, Date.now());
      for (const id of now) if (!live.has(id)) sendRideAlong(id);
      live = now;
    });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenLeftover?.();
      unsubscribeTurns();
    };
  }, []);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;

    const sync = async () => {
      try {
        const rows = await auroraInvoke<LedgerRow[]>("shell_background_processes");
        if (cancelled || !Array.isArray(rows)) return;
        useAgentBackgroundStore.getState().reconcile(
          threadId,
          rows.map((row) => ({
            processId: row.processId,
            requestId: row.requestId,
            title: row.name?.trim() || row.command || "Background process",
            command: row.command ?? "",
            cwd: row.cwd ?? undefined,
            outputFile: row.outputFile,
            status: "running" as const,
            startedAtMs: row.startedAtMs,
          })),
        );
      } catch {
        // An unavailable ledger leaves the cache as-is: a possibly stale row
        // with a stop button beats a blank list with none.
      }
    };

    void sync();
    const timer = window.setInterval(() => void sync(), LEDGER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId]);
};
