/**
 * The Terminal panel's pseudo terminals — calls into Rust, nothing else.
 *
 * Rust (`commands::terminal_pty`) owns every decision: which shell runs and
 * with what arguments and prompt, the job object that holds everything the
 * shell starts, closing it, and what is still running. This file only carries
 * keystrokes in and output out. It replaced `tauri-pty`, whose `pid` was a
 * session counter, so closing a tab never reached the processes it ran.
 */

import { Channel } from "@tauri-apps/api/core";

import { auroraInvoke, auroraListen, isDesktopRuntime } from "@/kernel/lib/ipc/runtime";
import type { ShellProfile } from "@/apps/agent/adapters/shell-config";
import type { RunningChild } from "@/apps/agent/services/terminal/terminal-sessions";

type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number };

export interface OpenedPty {
  /** Aurora's handle for the session. */
  id: number;
  /** The shell's real process id. */
  pid: number | null;
  /** The executable that was started, for the "exited immediately" notice. */
  exe: string;
}

export interface OpenPtyOptions {
  profile: ShellProfile;
  cwd?: string;
  /** The tab's name, which the agent's terminal list shows. */
  title: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number) => void;
}

function stream(onData: (data: string) => void, onExit: (code: number) => void) {
  const onEvent = new Channel<PtyEvent>();
  onEvent.onmessage = (event) => {
    if (event.kind === "data") onData(event.data);
    else onExit(event.code);
  };
  return onEvent;
}

/**
 * A browser has no Tauri `Channel`: the session's output arrives as the
 * `terminal-pty-<id>` event instead (`commands::terminal_pty`), which the web
 * host forwards. Listening starts before the attach, whose replay of what was
 * printed so far is sent as the same events.
 */
async function attachByEvents(
  id: number,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): Promise<void> {
  const stop = await auroraListen<PtyEvent>(`terminal-pty-${id}`, ({ payload }) => {
    if (payload.kind === "data") onData(payload.data);
    else {
      stop();
      onExit(payload.code);
    }
  });
  try {
    await auroraInvoke("terminal_pty_attach_events", { id });
  } catch (error) {
    stop();
    throw error;
  }
}

/** Start a shell. Rejects with Rust's sentence when no such shell is set up. */
export async function openPty(options: OpenPtyOptions): Promise<OpenedPty> {
  const args = {
    profile: options.profile,
    cwd: options.cwd ?? null,
    title: options.title,
    cols: options.cols,
    rows: options.rows,
  };
  if (!isDesktopRuntime()) {
    const opened = await auroraInvoke<OpenedPty>("terminal_pty_open_events", args);
    await attachByEvents(opened.id, options.onData, options.onExit);
    return opened;
  }
  return auroraInvoke<OpenedPty>("terminal_pty_open", {
    ...args,
    onEvent: stream(options.onData, options.onExit),
  });
}

/** Show a session that already runs (one the agent opened): what it printed so
 *  far, then live output. */
export function attachPty(
  id: number,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): Promise<void> {
  if (!isDesktopRuntime()) return attachByEvents(id, onData, onExit);
  return auroraInvoke("terminal_pty_attach", { id, onEvent: stream(onData, onExit) });
}

export function writePty(id: number, data: string): Promise<void> {
  return auroraInvoke("terminal_pty_write", { id, data });
}

export function resizePty(id: number, cols: number, rows: number): Promise<void> {
  return auroraInvoke("terminal_pty_resize", { id, cols, rows });
}

/** End the session's shell and everything it started. */
export function killPty(id: number): Promise<void> {
  return auroraInvoke("terminal_pty_kill", { id });
}

/** What the session's shell still has running. */
export function runningInPty(id: number): Promise<RunningChild[]> {
  return auroraInvoke<RunningChild[]>("terminal_pty_running", { id });
}
