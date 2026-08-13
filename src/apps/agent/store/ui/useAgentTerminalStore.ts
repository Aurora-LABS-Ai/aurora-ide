/**
 * Agent Window — terminal session store (feature state).
 *
 * Multi-session PTY terminal for the dock's Terminal tab. Built standalone for
 * the agent window: it owns its own session list and does NOT touch the IDE's
 * `useTerminalStore`. The PTY backend (`tauri-plugin-pty`, granted to
 * `agent-window`) is shared infrastructure — we drive it via the `tauri-pty` JS
 * API directly.
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
  /** Remove a session's metadata (TerminalView disposes the live PTY/term). */
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  setRunning: (id: string, running: boolean) => void;
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
}));
