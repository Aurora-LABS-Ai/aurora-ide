/**
 * Agent Window — background processes the agent has started [state].
 *
 * One entry per `shell_spawn`, grouped by thread for provenance. Entries
 * survive after the process stops: the log is usually the reason you stopped
 * it, so the card stays readable until dismissed.
 *
 * The store holds no output. Output lives in the file Rust is already writing
 * (`outputFile`), and the card reads it on demand — so a process that printed
 * a hundred megabytes costs this store nothing.
 *
 * ## This store is a cache, not the truth
 *
 * The truth is Rust's `ACTIVE_COMMAND_STREAMS` ledger, which is process-global
 * and knows nothing about threads or projects. This store used to be built
 * ONLY from `shell_spawn` tool results and read ONLY under the current thread
 * key, which orphaned live processes twice over:
 *
 * - switch project → the dock looks up a different thread key, finds nothing,
 *   and a running dev server has no stop button anywhere in the UI
 * - reload the window → the whole store is empty while the processes run on
 *
 * [`reconcile`] fixes both by folding Rust's ledger back in: anything running
 * that this store never saw gets adopted, and anything this store still calls
 * "running" that the ledger no longer lists is settled. A running process is a
 * machine-level fact, so the dock shows every one of them regardless of which
 * chat started it — see `runningEverywhere`.
 */

import { create } from "zustand";

export type BackgroundStatus = "running" | "stopped" | "exited";

export interface BackgroundProcess {
  /** Id accepted by shell_kill and by the stream-cancel command. */
  processId: string;
  /**
   * Underlying stream id. Rust names the output event `shell-stream-{requestId}`,
   * and its `done` marker is how a card learns the process ended **on its own** —
   * without it a finished process would sit on the dock claiming to be running.
   */
  requestId?: string;
  /** One-line title the model supplied, shown on the card. */
  title: string;
  command: string;
  cwd?: string;
  /** File Rust mirrors the process's combined output into. */
  outputFile?: string;
  status: BackgroundStatus;
  /** Reported by the `done` marker; absent when the process was stopped. */
  exitCode?: number | null;
  startedAtMs: number;
}

interface BackgroundState {
  byThread: Record<string, BackgroundProcess[]>;

  /** Record a newly spawned process (idempotent on processId). */
  track: (threadId: string, process: BackgroundProcess) => void;
  /**
   * Mark a process no longer running, wherever it lives.
   *
   * Deliberately NOT thread-scoped. A process id is globally unique and the
   * dock shows running processes from every thread, so requiring the caller to
   * already know the owning thread made stopping a process from another
   * project silently do nothing.
   */
  settle: (
    processId: string,
    status: Exclude<BackgroundStatus, "running">,
    exitCode?: number | null,
  ) => void;
  /** Remove a card the user dismissed, wherever it lives. */
  dismiss: (processId: string) => void;
  clearThread: (threadId: string) => void;
  /**
   * Fold Rust's live ledger back in. `adoptInto` is the thread that inherits
   * any running process this store has never seen — one started before a
   * reload, or under a chat that no longer exists.
   */
  reconcile: (adoptInto: string, live: BackgroundProcess[]) => void;
}

/**
 * Every process still marked running, across all threads.
 *
 * The dock unions this with the current thread's own rows: a running process
 * is a fact about the machine, not about a conversation, so it must stay
 * reachable — and stoppable — from whichever project you happen to be in.
 * Finished rows stay scoped to their thread, where they are just history.
 */
export const runningEverywhere = (
  byThread: Record<string, BackgroundProcess[]>,
): BackgroundProcess[] =>
  Object.values(byThread)
    .flat()
    .filter((entry) => entry.status === "running");

/**
 * Every process the user should be able to see and stop right now: this
 * thread's own rows (running or finished) plus anything still running anywhere
 * else, deduped.
 *
 * Lives here rather than in a component because two surfaces need the SAME
 * list — the process panel and the composer rail's chip count. Two copies of
 * the union rule is how the counter and the list start disagreeing.
 */
export const visibleProcesses = (
  byThread: Record<string, BackgroundProcess[]>,
  threadId: string | null,
): BackgroundProcess[] => {
  const mine = threadId ? (byThread[threadId] ?? []) : [];
  const seen = new Set(mine.map((entry) => entry.processId));
  return [
    ...mine,
    ...runningEverywhere(byThread).filter((entry) => !seen.has(entry.processId)),
  ];
};

/**
 * One process by id, wherever it lives, or `null`.
 *
 * A tool card looks itself up with this: a detached `shell_execute` is
 * registered under its own tool call id, so the card that ran the command can
 * ask what became of it without knowing which thread adopted the row. Returns
 * the stored object itself — entries are replaced rather than mutated, so a
 * selector built on this re-renders exactly when the process changes.
 */
export const processById = (
  byThread: Record<string, BackgroundProcess[]>,
  processId: string | null | undefined,
): BackgroundProcess | null => {
  if (!processId) return null;
  for (const entries of Object.values(byThread)) {
    const found = entries.find((entry) => entry.processId === processId);
    if (found) return found;
  }
  return null;
};

/** Signature of `settle`, for components that take it as a dependency. */
export type BackgroundSettle = BackgroundState["settle"];

export const useAgentBackgroundStore = create<BackgroundState>((set) => ({
  byThread: {},

  track: (threadId, process) =>
    set((state) => {
      const existing = state.byThread[threadId] ?? [];
      // A re-run of the same id updates in place rather than stacking.
      const next = existing.some((entry) => entry.processId === process.processId)
        ? existing.map((entry) => (entry.processId === process.processId ? process : entry))
        : [...existing, process];
      return { byThread: { ...state.byThread, [threadId]: next } };
    }),

  settle: (processId, status, exitCode) =>
    set((state) => {
      // First settle wins. A user stop is immediately followed by the stream's
      // own `done` marker, and the stop is the truer account of what happened.
      const isRunning = Object.values(state.byThread)
        .flat()
        .some((entry) => entry.processId === processId && entry.status === "running");
      if (!isRunning) return state;

      const byThread: Record<string, BackgroundProcess[]> = {};
      for (const [key, entries] of Object.entries(state.byThread)) {
        byThread[key] = entries.map((entry) =>
          entry.processId === processId ? { ...entry, status, exitCode } : entry,
        );
      }
      return { byThread };
    }),

  dismiss: (processId) =>
    set((state) => {
      const byThread: Record<string, BackgroundProcess[]> = {};
      for (const [key, entries] of Object.entries(state.byThread)) {
        byThread[key] = entries.filter((entry) => entry.processId !== processId);
      }
      return { byThread };
    }),

  clearThread: (threadId) =>
    set((state) => {
      const rest = { ...state.byThread };
      delete rest[threadId];
      return { byThread: rest };
    }),

  reconcile: (adoptInto, live) =>
    set((state) => {
      const liveIds = new Set(live.map((entry) => entry.processId));
      const known = new Set(
        Object.values(state.byThread).flat().map((entry) => entry.processId),
      );

      const byThread: Record<string, BackgroundProcess[]> = {};
      for (const [threadId, entries] of Object.entries(state.byThread)) {
        byThread[threadId] = entries.map((entry) => {
          // Still running here but gone from Rust's ledger: it ended while
          // nothing was listening (window reloaded, or the `shell-process-ended`
          // event was missed). Settling it beats a row that claims "Running"
          // over a dead process and offers a stop button that does nothing.
          if (entry.status === "running" && !liveIds.has(entry.processId)) {
            return { ...entry, status: "exited" as const, exitCode: entry.exitCode ?? null };
          }
          return entry;
        });
      }

      // Anything Rust is running that this store has never seen. Adopted into
      // the current thread purely so it has a home — the dock shows running
      // processes from every thread anyway, so the key does not gate access.
      const adopted = live.filter((entry) => !known.has(entry.processId));
      if (adopted.length > 0) {
        byThread[adoptInto] = [...(byThread[adoptInto] ?? []), ...adopted];
      }

      return { byThread };
    }),
}));

/**
 * Pull a spawned process out of a `shell_spawn` tool result.
 *
 * Returns `null` for anything that is not a live background process — a
 * command that finished immediately (`completed: true`) has nothing to show or
 * stop, and a failed spawn never started.
 */
export const parseSpawnResult = (raw: string): BackgroundProcess | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;

  const processId = typeof value.processId === "string" ? value.processId : null;
  if (!processId || value.success !== true || value.completed === true) return null;

  const command = typeof value.command === "string" ? value.command : "";
  const title =
    typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : command || "Background process";

  return {
    processId,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    title,
    command,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    outputFile: typeof value.outputFile === "string" ? value.outputFile : undefined,
    status: "running",
    startedAtMs: Date.now(),
  };
};

/** The process id a `shell_kill` call targeted, so the card can settle. */
export const parseKillResult = (raw: string): string | null => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.success !== true) return null;
    return typeof parsed.processId === "string" ? parsed.processId : null;
  } catch {
    return null;
  }
};
