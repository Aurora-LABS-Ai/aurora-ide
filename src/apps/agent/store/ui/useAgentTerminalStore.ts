/**
 * Agent Window — terminal session store (feature state).
 *
 * Multi-session PTY terminal for the dock's Terminal tab. Built standalone for
 * the agent window: it owns its own session list and does NOT touch the IDE's
 * `useTerminalStore`. The shells themselves run in Rust
 * (`commands::terminal_pty`), reached through `services/terminal/terminal-pty`.
 *
 * Only lightweight session METADATA lives here; the live `IPty` + xterm
 * instances are held in a module map in TerminalView (non-serializable, must
 * survive tab switches without re-spawning).
 */

import { create } from "zustand";

/**
 * Re-exported from the adapter that resolves it, so the store and the spawner
 * can never disagree about which shells exist. This file used to declare its
 * own `"powershell" | "bash"`, which is what capped the terminal at two shells
 * while the registry knew about five.
 */
export type { ShellProfile } from "@/apps/agent/adapters/shell-config";

import type { ShellProfile } from "@/apps/agent/adapters/shell-config";

export interface TermSession {
  id: string;
  title: string;
  profile: ShellProfile;
  /**
   * Working directory the shell starts in. Absent means the chat's project
   * root — the default for a terminal opened from the tab bar. Set when the
   * session was opened AT a folder ("Open in integrated terminal"), and shown
   * in the pill title so two shells in different folders stay tellable apart.
   */
  cwd?: string;
  /** False once the shell process exits. */
  running: boolean;
  /**
   * Rust's session id when the shell already runs before the tab draws it —
   * a terminal the agent started. The view attaches to it instead of starting
   * a new shell.
   */
  ptyId?: number;
  /** The agent's `terminal` tool started it. */
  startedByAgent?: boolean;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `agw-term-${seq}`;
}

function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

interface AgentTerminalState {
  sessions: TermSession[];
  activeId: string | null;

  /** Create a session and make it active; returns its id. */
  createSession: (profile?: ShellProfile, cwd?: string) => string;
  /**
   * Add a tab for a terminal the agent started in Rust, make it active, and
   * return the tab id. Idempotent per `ptyId`.
   */
  adoptAgentSession: (input: {
    ptyId: number;
    title: string;
    profile: ShellProfile;
    cwd?: string;
  }) => string;
  /** Remove a session's metadata (TerminalView disposes the live PTY/term). */
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  setRunning: (id: string, running: boolean) => void;
  /** Mark the tab showing Rust session `ptyId` as exited. */
  setPtyExited: (ptyId: number) => void;
}

export const useAgentTerminalStore = create<AgentTerminalState>((set, get) => ({
  sessions: [],
  activeId: null,

  // `pwsh` — PowerShell 7 — not `powershell`, which is Windows PowerShell 5.1.
  // Rust substitutes the other one when only it is installed
  // (`related_kinds`), so this asks for the better shell and still works on a
  // machine that has only the older one.
  createSession: (profile = "pwsh", cwd) => {
    const id = nextId();
    // The kind IS the name — "pwsh 2", "zsh · api". Deriving it from a
    // two-value guess is what let a session labelled `pwsh` be 5.1.
    const shell = profile;
    const folder = cwd ? folderName(cwd) : "";
    // A directory-pinned session is named by WHERE it is ("pwsh · api"), a
    // plain one by which shell it is ("pwsh 2") — the folder is the fact that
    // distinguishes it.
    const title = folder
      ? `${shell} · ${folder}`
      : `${shell} ${get().sessions.filter((s) => s.profile === profile).length + 1}`;
    set((s) => ({
      sessions: [...s.sessions, { id, title, profile, cwd, running: true }],
      activeId: id,
    }));
    return id;
  },

  adoptAgentSession: ({ ptyId, title, profile, cwd }) => {
    const existing = get().sessions.find((s) => s.ptyId === ptyId);
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }
    const id = nextId();
    set((s) => ({
      sessions: [
        ...s.sessions,
        { id, title, profile, cwd, running: true, ptyId, startedByAgent: true },
      ],
      activeId: id,
    }));
    return id;
  },

  removeSession: (id) =>
    set((s) => {
      const idx = s.sessions.findIndex((x) => x.id === id);
      if (idx < 0) return s;
      const sessions = s.sessions.filter((x) => x.id !== id);
      let activeId = s.activeId;
      if (s.activeId === id) activeId = (sessions[idx] ?? sessions[idx - 1])?.id ?? null;
      return { sessions, activeId };
    }),

  setActive: (id) => set({ activeId: id }),
  setRunning: (id, running) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, running } : x)),
    })),
  setPtyExited: (ptyId) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.ptyId === ptyId ? { ...x, running: false } : x)),
    })),
}));
