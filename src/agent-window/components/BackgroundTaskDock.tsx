/**
 * Agent Window — background process card [view].
 *
 * The same docked card as the checklist above it (`AgentTaskPanel`): one
 * collapsible panel, a header that stays useful while collapsed, and one row
 * per item using the checklist's own status glyphs. A running process is a
 * task the agent started and has not finished with.
 *
 * The one thing a checklist item does not have is output, so a row unfolds:
 *
 *  - **Click a row** to read what the process has printed. The text comes from
 *    the log file Rust is already mirroring into, so nothing is buffered in
 *    the renderer and a server that has printed megabytes costs nothing until
 *    someone opens it. The tail is what gets shown — the newest lines are the
 *    interesting ones.
 *  - **Stop** ends the process. Rust closes its log with a line saying so, so
 *    the agent reading that file afterwards learns what happened.
 *  - A process that ends on its own settles the row from the stream's `done`
 *    marker; without that a finished run would sit here claiming to be live.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import { auroraInvoke, auroraListen } from "../../lib/runtime";
import { cancelCommandStream } from "../../lib/tauri";
import { useAgentChatStore } from "../store/useAgentChatStore";
import {
  useAgentBackgroundStore,
  visibleProcesses,
  type BackgroundProcess,
  type BackgroundSettle,
} from "../store/useAgentBackgroundStore";
import { hasAnsi, parseAnsi } from "./tool-views/ansi";

/** How often an open row re-reads its log while the process runs. */
const POLL_MS = 1_000;
/** Tail rendered. A live server's log grows without bound. */
const MAX_LOG_CHARS = 60_000;

/**
 * Read the log directly rather than through `readFileContent`, whose cache is
 * mtime-validated — a file being appended to several times a second can return
 * a stale body from within the same clock tick.
 */
const readLog = async (path: string): Promise<string> => {
  const text = await auroraInvoke<string>("read_file_content", { path });
  return text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
};

/**
 * What the badge reports — state, and for a finished run whether it succeeded.
 *
 * A non-zero exit is the case worth naming: the process is gone either way,
 * but "Failed · 1" is the difference between a build that ended and a build
 * that ended badly.
 */
const stateLabel = (process: BackgroundProcess): string => {
  if (process.status === "running") return "Running";
  if (process.status === "stopped") return "Stopped";
  if (process.exitCode === 0) return "Finished";
  if (typeof process.exitCode === "number") return `Failed · ${process.exitCode}`;
  return "Ended";
};

/**
 * The checklist's own glyphs, so a process row reads as a task row.
 *
 * Red is reserved for a non-zero exit. A process you stopped on purpose is not
 * a failure, and dressing it in the same alarm colour as a crash makes a
 * deliberate action look like something went wrong.
 */
const ProcessGlyph: React.FC<{ process: BackgroundProcess }> = ({ process }) => {
  if (process.status === "running") {
    return <span className="agw-rail-spin agw-task-spin" aria-hidden />;
  }
  if (process.exitCode === 0) {
    return (
      <span className="agw-task-ico agw-task-ico-done">
        <AgentIcon name="check" size={11} strokeWidth={3} />
      </span>
    );
  }
  if (typeof process.exitCode === "number") {
    return (
      <span className="agw-task-ico agw-task-ico-cancel">
        <AgentIcon name="close" size={10} strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span className="agw-task-ico agw-task-ico-stopped">
      <AgentIcon name="stop" size={8} />
    </span>
  );
};

/**
 * Settle rows when their process ends.
 *
 * A background process usually stops without anyone stopping it — it finishes,
 * or it dies, and nothing in the window was watching for that: `shell_kill`
 * covered only a deliberate kill, so a finished run sat on the dock reporting
 * "Running" over a log that had already closed.
 *
 * Rust announces the ending on one app-wide event carrying the `bg-…` id the
 * dock keys its rows by. Listening for the output stream's `done` marker
 * instead meant matching a *request* id to a *process* id across a tool
 * result — a coupling that fails silently, which is exactly how it failed.
 *
 * One listener for the whole dock, not one per row.
 */
const useProcessEndings = (threadId: string | null, settle: BackgroundSettle) => {
  useEffect(() => {
    if (!threadId) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void auroraListen<{
      processId?: string;
      exitCode?: number | null;
      outcome?: "exited" | "stopped";
    }>("shell-process-ended", (event) => {
      const ended = event?.payload;
      if (disposed || !ended?.processId) return;
      settle(
        ended.processId,
        ended.outcome === "stopped" ? "stopped" : "exited",
        ended.exitCode ?? null,
      );
    })
      .then((dispose) => {
        // A process can end while the listener is still registering.
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Without the listener a row cannot settle itself, but the log file
        // still records how the run ended — degraded, not wrong.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [threadId, settle]);
};

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

/**
 * Keep the dock honest against Rust's ledger.
 *
 * The store is a cache built from `shell_spawn` results; the ledger is what is
 * actually running. They drift in both directions — a process started before a
 * window reload is missing from the cache, and a process that ended while the
 * window was on another project is still marked running in it. Reconciling on
 * mount and whenever the thread changes covers the project switch, which is the
 * case that left a dev server running with no stop button anywhere in the UI.
 *
 * Polled slowly as well, because `shell-process-ended` is a fire-and-forget
 * event: if the window is mid-reload when it fires, nothing hears it, and only
 * a later reconcile settles the row.
 */
const LEDGER_POLL_MS = 15_000;

const useLedgerReconcile = (threadId: string | null) => {
  const reconcile = useAgentBackgroundStore((s) => s.reconcile);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;

    const sync = async () => {
      try {
        const rows = await auroraInvoke<LedgerRow[]>("shell_background_processes");
        if (cancelled || !Array.isArray(rows)) return;
        reconcile(
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
        // An unavailable ledger leaves the cache as-is. Showing a possibly
        // stale row beats blanking the dock and losing the stop button.
      }
    };

    void sync();
    const timer = window.setInterval(() => void sync(), LEDGER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId, reconcile]);
};

const LogBody: React.FC<{ process: BackgroundProcess }> = ({ process }) => {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const path = process.outputFile;
    if (!path) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const next = await readLog(path);
        if (!cancelled) {
          setText(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    void tick();

    if (process.status !== "running") {
      // Rust closes the log with a line naming how the run ended, and it
      // writes that line just after the stop lands — a single read at settle
      // time can miss it by a few hundred milliseconds and leave the row
      // showing output that simply stops. Two short follow-ups catch the
      // closing line without leaving a timer running.
      const timers = [400, 1_200].map((delay) =>
        window.setTimeout(() => void tick(), delay),
      );
      return () => {
        cancelled = true;
        timers.forEach((id) => window.clearTimeout(id));
      };
    }

    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [process.outputFile, process.status]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && followRef.current) body.scrollTop = body.scrollHeight;
  }, [text]);

  if (!process.outputFile) {
    return <p className="agw-bgtask-note">This process is not recording output to a file.</p>;
  }
  if (error) {
    return <p className="agw-bgtask-note">Could not read the output: {error}</p>;
  }
  if (text === null) {
    return <p className="agw-bgtask-note">Reading output…</p>;
  }
  if (text.length === 0) {
    return <p className="agw-bgtask-note">No output yet.</p>;
  }

  const spans = hasAnsi(text) ? parseAnsi(text) : null;
  return (
    <div
      ref={bodyRef}
      className="agw-bgtask-log agw-scroll"
      onScroll={() => {
        const body = bodyRef.current;
        if (!body) return;
        followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 40;
      }}
    >
      <pre className="agw-shell-out">
        {spans
          ? spans.map((span, index) => (
              <span
                key={index}
                style={{
                  color: span.color,
                  fontWeight: span.bold ? 600 : undefined,
                  opacity: span.dim ? 0.65 : undefined,
                  fontStyle: span.italic ? "italic" : undefined,
                  textDecoration: span.underline ? "underline" : undefined,
                }}
              >
                {span.text}
              </span>
            ))
          : text}
      </pre>
    </div>
  );
};

const ProcessRow: React.FC<{
  process: BackgroundProcess;
  threadId: string;
}> = ({ process, threadId }) => {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const settle = useAgentBackgroundStore((s) => s.settle);
  const dismiss = useAgentBackgroundStore((s) => s.dismiss);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await cancelCommandStream(process.processId, "user");
    } catch {
      // Already gone is the same outcome the user asked for.
    }
    settle(process.processId, "stopped");
    setStopping(false);

    // The stop is already recorded where it belongs: Rust closes the log file
    // with a line naming it, so an agent that reads that file afterwards
    // learns what happened without being told. Interrupting the conversation
    // is only worth it while a turn is actually running.
    //
    // Enqueuing to an idle thread is worse than saying nothing. The queued
    // slot drains at a tool-result boundary, so with no live turn the note
    // sits until some unrelated turn picks it up, arriving without the
    // context that made it meaningful.
    const chat = useAgentChatStore.getState();
    if (!chat.liveTurns[threadId]) return;

    await chat
      .enqueueMessage(
        threadId,
        `The user stopped the background process "${process.title}" ` +
          `(id ${process.processId}, \`${process.command}\`). It is no longer running` +
          (process.outputFile
            ? `; its log ends with a line recording the stop: ${process.outputFile}`
            : "") +
          ".",
      )
      .catch(() => undefined);
  }, [process, threadId, settle]);

  const running = process.status === "running";

  return (
    <li className="agw-bgtask-item" data-status={process.status}>
      <div className="agw-task-row">
        <button
          type="button"
          className="agw-bgtask-open"
          aria-expanded={open}
          title={process.command}
          onClick={() => setOpen((value) => !value)}
        >
          <ProcessGlyph process={process} />
          <span className="agw-task-label">{process.title}</span>
        </button>
        <span
          className="agw-bgtask-state"
          data-fail={
            (typeof process.exitCode === "number" && process.exitCode !== 0) || undefined
          }
        >
          {stateLabel(process)}
        </span>
        {running ? (
          <button
            type="button"
            className="agw-bgtask-stop"
            disabled={stopping}
            title={`Stop ${process.title}`}
            aria-label={`Stop ${process.title}`}
            onClick={() => void stop()}
          >
            <AgentIcon name="stop" size={12} />
          </button>
        ) : (
          <button
            type="button"
            className="agw-bgtask-x"
            title={`Dismiss ${process.title}`}
            aria-label={`Dismiss ${process.title}`}
            onClick={() => dismiss(process.processId)}
          >
            <AgentIcon name="close" size={12} />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="agw-bgtask-body">
              <LogBody process={process} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
};

export const BackgroundTaskDock: React.FC<{
  /**
   * `dock` — the collapsible card above the composer. `popover` — body only,
   * always expanded: the composer rail's chip owns open/closed and paints the
   * surface, so the collapse control would be a lid on a closed box.
   */
  variant?: "dock" | "popover";
  /** The conversation whose processes this lists. Omit for the open chat. */
  threadId?: string | null;
}> = ({ variant = "dock", threadId: boundThreadId }) => {
  const inPopover = variant === "popover";
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const threadId = boundThreadId === undefined ? openThreadId : boundThreadId;
  const byThread = useAgentBackgroundStore((s) => s.byThread);
  const dismiss = useAgentBackgroundStore((s) => s.dismiss);
  const settle = useAgentBackgroundStore((s) => s.settle);
  const [collapsed, setCollapsed] = useState(false);

  useProcessEndings(threadId, settle);
  useLedgerReconcile(threadId);

  /**
   * This thread's own rows, plus every running process from any thread — see
   * `visibleProcesses`, which the composer rail's chip count shares so the
   * badge can never disagree with the list it opens.
   */
  const processes = useMemo(
    () => visibleProcesses(byThread, threadId),
    [byThread, threadId],
  );

  const { running, active } = useMemo(
    () => ({
      running: processes.filter((entry) => entry.status === "running").length,
      active: processes.find((entry) => entry.status === "running"),
    }),
    [processes],
  );

  if (!threadId || processes.length === 0) return null;

  const rows = (
    <ul className="agw-tasks-list">
      {processes.map((process) => (
        <ProcessRow
          key={process.processId}
          process={process}
          threadId={threadId}
        />
      ))}
    </ul>
  );

  return (
    <div className={inPopover ? "agw-crail-panel" : "agw-dock-card agw-tasks"}>
      <div className="agw-tasks-head">
        {inPopover ? (
          <span className="agw-tasks-toggle" data-static>
            <span className="agw-tasks-title">Background processes</span>
            <span className="agw-tasks-count">
              {running}/{processes.length}
            </span>
          </span>
        ) : (
          <button
            type="button"
            className="agw-tasks-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {/* The running process's name earns the header only while the rows
                are hidden. With the list open it would just repeat the row
                directly beneath it. */}
            <span className="agw-tasks-title">
              {collapsed && active ? active.title : "Background processes"}
            </span>
            <span className="agw-tasks-count">
              {running}/{processes.length}
            </span>
            <span
              className="agw-tasks-chev"
              data-collapsed={collapsed || undefined}
              aria-hidden
            >
              <AgentIcon name="chevron-down" size={14} />
            </span>
          </button>
        )}
        {/* Clears the finished rows and leaves anything still running — a
            dismiss that silently orphaned a live process would be a way to
            lose one. */}
        <button
          type="button"
          className="agw-tasks-x"
          title="Clear finished processes"
          aria-label="Clear finished processes"
          onClick={() =>
            processes
              .filter((entry) => entry.status !== "running")
              .forEach((entry) => dismiss(entry.processId))
          }
        >
          <AgentIcon name="close" size={13} />
        </button>
      </div>

      {inPopover ? (
        <div className="agw-crail-panel-body agw-scroll">{rows}</div>
      ) : (
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ overflow: "hidden" }}
            >
              {rows}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
};
