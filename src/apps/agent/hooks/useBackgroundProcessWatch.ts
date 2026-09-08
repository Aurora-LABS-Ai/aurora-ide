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
  if (!row) return;
  const chat = useAgentChatStore.getState();
  const threadId =
    threadOwning(useAgentBackgroundStore.getState().byThread, processId) ??
    chat.currentThreadId;
  if (!threadId) return;

  // The row is what named it — a spawn's required title, or the command line a
  // hand-off carried. There is no anonymous case left to invent a name for.
  const name = row.title?.trim() || row.command?.trim() || "a background process";
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

  if (chat.liveTurns[threadId]) {
    void chat
      .enqueueMessage(threadId, summary, { origin: "process", modelText: detail })
      .catch(() => {
        // The row is already settled and the log is already on disk. A failed
        // report costs the agent a notification, not the record.
      });
    return;
  }

  parkIdleReport(threadId, { summary, detail, endedAtMs: Date.now() });
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
interface IdleReport {
  summary: string;
  detail: string;
  endedAtMs: number;
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

export const peekIdleReport = (threadId: string): IdleReport | null =>
  idleReports.get(threadId) ?? null;

export const subscribeToIdleReports = (listener: () => void): (() => void) => {
  idleReportChanged.add(listener);
  return () => idleReportChanged.delete(listener);
};

/** Test seam. */
export const clearIdleReports = (): void => {
  idleReports.clear();
};

/**
 * How stale an ending may be before it is dropped rather than announced.
 *
 * A process that finished two hours ago is not news, and waking a conversation
 * to say so would be Aurora talking about its own housekeeping. The log is
 * still on disk and the dock row still says what happened, so nothing is lost
 * by staying quiet — only by shouting late.
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

    return () => {
      disposed = true;
      unlisten?.();
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
