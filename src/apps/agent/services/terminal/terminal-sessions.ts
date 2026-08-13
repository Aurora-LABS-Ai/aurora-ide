/**
 * The live terminal sessions — the registry, and reading out of them.
 *
 * A session is a PTY plus the xterm that renders it. Both are
 * non-serializable and must survive tab switches without re-spawning, so they
 * live here in a module map rather than in a store. `useAgentTerminalStore`
 * holds only the metadata React renders (id, title, cwd, running).
 *
 * This module exists separately from `TerminalPanel` because it is no longer
 * only the view that needs it: the agent's `terminal_list` / `terminal_read`
 * tools read these buffers, and a tool module importing a React component to
 * reach a Map is the wrong shape — it drags xterm, the panel and its children
 * into anything that touches tools.
 *
 * ## Reading the output
 *
 * The text comes from xterm's own buffer, which is already decoded: escape
 * codes have been consumed as they arrived, so `translateToString` returns
 * exactly the characters on screen with no ANSI left to strip. The buffer
 * keeps 10,000 lines of scrollback (see the Terminal options), which is the
 * whole history worth having.
 */

import type { IPty } from "tauri-pty";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import { useAgentTerminalStore } from "@/apps/agent/store/ui/useAgentTerminalStore";

export interface PtyRuntime {
  pty: IPty;
  term: Terminal;
  fit: FitAddon;
  /**
   * Buffer line the user's most recent command started printing at, recorded
   * when they press Enter.
   *
   * This is what makes "the last command" answerable without shell
   * integration. Aurora owns the PTY, so it sees the keystroke — no prompt
   * parsing, no marker injected into the user's shell.
   */
  lastCommandLine?: number;
}

/** Live PTY + xterm per session id — persists across tab/session switches. */
export const terminalRuntime = new Map<string, PtyRuntime>();

/** Kill a session's shell + xterm and drop it from the registry. */
export function disposeTerminalSession(id: string): void {
  const rt = terminalRuntime.get(id);
  if (!rt) return;
  try { rt.pty?.kill(); } catch { /* already dead */ }
  try { rt.term.dispose(); } catch { /* already disposed */ }
  terminalRuntime.delete(id);
}

// Reap every live shell when the window unloads.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const id of Array.from(terminalRuntime.keys())) disposeTerminalSession(id);
  });
}

export interface TerminalSessionSummary {
  id: string;
  title: string;
  shell: string;
  cwd: string | null;
  running: boolean;
  lines: number;
  /** False when the session has a tab but no live buffer (failed to start). */
  attached: boolean;
}

/** Every terminal the user currently has open in the right rail. */
export function listTerminalSessions(): TerminalSessionSummary[] {
  const { sessions } = useAgentTerminalStore.getState();
  return sessions.map((session) => {
    const rt = terminalRuntime.get(session.id);
    return {
      id: session.id,
      title: session.title,
      shell: session.profile,
      cwd: session.cwd ?? null,
      running: session.running,
      lines: rt ? countUsedLines(rt.term) : 0,
      attached: Boolean(rt),
    };
  });
}

/** Trailing blank lines are padding, not history. */
function countUsedLines(term: Terminal): number {
  const buffer = term.buffer.active;
  let last = buffer.length - 1;
  while (last >= 0 && (buffer.getLine(last)?.translateToString(true) ?? "") === "") {
    last -= 1;
  }
  return last + 1;
}

export interface ReadTerminalOptions {
  /** `last_command` starts at the most recent Enter; `all` is full scrollback. */
  scope?: "last_command" | "all";
  headLines?: number;
  tailLines?: number;
  maxBytes?: number;
}

export interface TerminalReadResult {
  id: string;
  title: string;
  shell: string;
  cwd: string | null;
  running: boolean;
  scope: "last_command" | "all";
  totalLines: number;
  hiddenLines: number;
  text: string;
}

const DEFAULT_HEAD = 40;
const DEFAULT_TAIL = 40;
const DEFAULT_MAX_BYTES = 8000;

/**
 * Read a session's output.
 *
 * Head AND tail, because a long command's first lines and its last lines are
 * both load-bearing and the middle rarely is: a compiler puts the real error
 * at the top and "could not compile" at the bottom; a test runner names the
 * failing test at the top and the counts at the bottom. Taking only the tail
 * would routinely deliver the summary without the cause.
 *
 * The elision is stated in the text. Two fragments pasted together without a
 * marker read as one continuous log, and anything reasoning over it will
 * happily connect a line to one it never actually preceded.
 */
export function readTerminalSession(
  id: string,
  options: ReadTerminalOptions = {},
): TerminalReadResult | null {
  const session = useAgentTerminalStore.getState().sessions.find((s) => s.id === id);
  const rt = terminalRuntime.get(id);
  if (!session || !rt) return null;

  const scope = options.scope ?? "last_command";
  const head = Math.max(0, options.headLines ?? DEFAULT_HEAD);
  const tail = Math.max(0, options.tailLines ?? DEFAULT_TAIL);
  const maxBytes = Math.max(500, options.maxBytes ?? DEFAULT_MAX_BYTES);

  const buffer = rt.term.buffer.active;
  const end = countUsedLines(rt.term);
  // `lastCommandLine` is absent until the user has pressed Enter once, which
  // is also exactly when "the last command" has no answer — fall back to the
  // whole buffer rather than returning nothing.
  const start =
    scope === "last_command" && rt.lastCommandLine !== undefined
      ? Math.min(rt.lastCommandLine, Math.max(0, end - 1))
      : 0;

  const lines: string[] = [];
  for (let i = start; i < end; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  // Leading blank lines are the gap between the prompt and the output.
  while (lines.length > 0 && lines[0] === "") lines.shift();

  let hidden = 0;
  let kept = lines;
  if (lines.length > head + tail) {
    hidden = lines.length - head - tail;
    kept = [
      ...lines.slice(0, head),
      `… ${hidden} lines hidden …`,
      ...lines.slice(lines.length - tail),
    ];
  }

  let text = kept.join("\n");
  if (text.length > maxBytes) {
    // Keep the END when the cap bites: it holds the outcome.
    const cut = text.length - maxBytes;
    text = `… ${cut} characters hidden …\n${text.slice(cut)}`;
    hidden += 1;
  }

  return {
    id: session.id,
    title: session.title,
    shell: session.profile,
    cwd: session.cwd ?? null,
    running: session.running,
    scope,
    totalLines: lines.length,
    hiddenLines: hidden,
    text,
  };
}
