/**
 * The live xterm views of terminal sessions.
 *
 * A session's shell, screen and history live in Rust (`pty_sessions`); what
 * lives here is the xterm that draws it, which is non-serializable and must
 * survive tab switches without re-attaching, so it sits in a module map rather
 * than a store. `useAgentTerminalStore` holds only the metadata React renders
 * (id, title, cwd, running).
 *
 * Reading a terminal is Rust's job too: the agent's `terminal` tool reads the
 * vt100 screen Rust keeps, so nothing here answers for the agent any more.
 */

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import { killPty } from "@/apps/agent/services/terminal/terminal-pty";
import { useAgentTerminalStore } from "@/apps/agent/store/ui/useAgentTerminalStore";

export interface PtyRuntime {
  /** Rust's session id; absent until the shell started or the view attached. */
  ptyId?: number;
  term: Terminal;
  fit: FitAddon;
}

/** Live xterm per tab id — persists across tab/session switches. */
export const terminalRuntime = new Map<string, PtyRuntime>();

/**
 * A process a shell has left running, as reported by
 * `terminal_pty_running`. Mirrors the Rust `RunningChild`.
 */
export interface RunningChild {
  pid: number;
  /** Executable name only (`electron.exe`) — never a command line, which can
   *  carry tokens and paths a dialog has no business showing. */
  name: string;
}

/**
 * End a session's shell and everything it started, dispose the xterm, and drop
 * it from the registry.
 *
 * Rust ends the session's job object, which holds every process the shell
 * started however it was started. Closing a tab running `pnpm dev` used to
 * leave the server up: the old plugin's `pid` was a session counter, so the
 * tree kill aimed at a system process and the server was never touched.
 *
 * `ptyId` is passed for a tab whose view never attached (an agent's terminal
 * opened while the panel was closed): it has no runtime entry yet, but its
 * shell is real and closing the tab must end it.
 *
 * Fire-and-forget on purpose — this is called from `beforeunload` as well as
 * from the close button, and neither can await. A failure is logged, never
 * swallowed: a shell that would not die is something the user needs told,
 * since the alternative is a stray process they cannot see. Rust's job has
 * kill-on-close too, so the processes also end when Aurora itself exits.
 */
export function disposeTerminalSession(id: string, ptyId?: number): void {
  const rt = terminalRuntime.get(id);
  const target = rt?.ptyId ?? ptyId;
  if (target !== undefined) {
    void killPty(target).catch((error) => {
      console.error(`[agent-terminal] could not stop terminal ${target}:`, error);
    });
  }
  if (rt) {
    try { rt.term.dispose(); } catch { /* already disposed */ }
    terminalRuntime.delete(id);
  }
}

export interface TerminalSessionSummary {
  /**
   * Rust's session id as text: what an `@terminal:<id>` mention carries, and
   * the `id` the agent's `terminal` tool reads. A tab whose shell has not
   * started yet falls back to its tab id.
   */
  id: string;
  title: string;
  shell: string;
  cwd: string | null;
  running: boolean;
}

/** Every open terminal tab, for the composer's `@` picker. */
export function listTerminalSessions(): TerminalSessionSummary[] {
  return useAgentTerminalStore.getState().sessions.map((session) => {
    const ptyId = terminalRuntime.get(session.id)?.ptyId ?? session.ptyId;
    return {
      id: ptyId === undefined ? session.id : String(ptyId),
      title: session.title,
      shell: session.profile,
      cwd: session.cwd ?? null,
      running: session.running,
    };
  });
}

// Reap every live shell when the window unloads.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const id of Array.from(terminalRuntime.keys())) disposeTerminalSession(id);
  });
}
