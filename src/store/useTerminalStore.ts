/**
 * Terminal Store
 * Manages terminal state including command history and output
 * Supports multiple shell profiles (PowerShell, Bash)
 */

import { create } from 'zustand';

export type ShellProfile = 'powershell' | 'bash';

export interface TerminalLine {
  id: string;
  type: 'input' | 'output' | 'error';
  content: string;
  timestamp: number;
}

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  lines: TerminalLine[];
  isRunning: boolean;
  profile: ShellProfile;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  isOpen: boolean;
  height: number;

  // Actions
  openTerminal: () => void;
  closeTerminal: () => void;
  toggleTerminal: () => void;
  setHeight: (height: number) => void;
  createSession: (cwd?: string, profile?: ShellProfile) => string;
  closeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  addLine: (sessionId: string, line: Omit<TerminalLine, 'id' | 'timestamp'>) => void;
  clearSession: (sessionId: string) => void;
  setSessionRunning: (sessionId: string, isRunning: boolean) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
}

const generateId = () => Math.random().toString(36).substr(2, 9);

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isOpen: false,
  height: 250,

  openTerminal: () => {
    const state = get();
    if (state.sessions.length === 0) {
      const sessionId = get().createSession();
      set({ isOpen: true, activeSessionId: sessionId });
    } else {
      set({ isOpen: true });
    }
  },

  closeTerminal: () => set({ isOpen: false }),

  toggleTerminal: () => {
    const state = get();
    if (state.isOpen) {
      state.closeTerminal();
    } else {
      state.openTerminal();
    }
  },

  setHeight: (height) => set({ height: Math.max(100, Math.min(600, height)) }),

  createSession: (cwd, profile = 'powershell') => {
    const id = generateId();
    const sessionNumber = get().sessions.filter(s => s.profile === profile).length + 1;
    
    const profileNames: Record<ShellProfile, string> = {
      powershell: 'pwsh',
      bash: 'bash',
    };

    const newSession: TerminalSession = {
      id,
      name: `${profileNames[profile]} ${sessionNumber}`,
      cwd: cwd || '',
      lines: [], // Start with empty lines - no "session started" message
      isRunning: false,
      profile,
    };

    set((state) => ({
      sessions: [...state.sessions, newSession],
      activeSessionId: id, // Always switch to newly created session
    }));

    return id;
  },

  closeSession: (sessionId) => {
    set((state) => {
      const remaining = state.sessions.filter(s => s.id !== sessionId);
      let newActiveId = state.activeSessionId;
      
      if (state.activeSessionId === sessionId) {
        newActiveId = remaining.length > 0 ? remaining[0].id : null;
      }

      return {
        sessions: remaining,
        activeSessionId: newActiveId,
        isOpen: remaining.length > 0 ? state.isOpen : false,
      };
    });
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  addLine: (sessionId, line) => {
    const newLine: TerminalLine = {
      ...line,
      id: generateId(),
      timestamp: Date.now(),
    };

    set((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? { ...s, lines: [...s.lines, newLine] }
          : s
      ),
    }));
  },

  clearSession: (sessionId) => {
    // Just clear - no message
    set((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, lines: [] } : s
      ),
    }));
  },

  setSessionRunning: (sessionId, isRunning) => {
    set((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, isRunning } : s
      ),
    }));
  },

  updateSessionCwd: (sessionId, cwd) => {
    set((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, cwd } : s
      ),
    }));
  },
}));
