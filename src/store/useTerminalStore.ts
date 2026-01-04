/**
 * Terminal Store
 * Manages terminal state with native PTY support
 * Terminal rendering is handled by xterm.js
 */
import { create } from "zustand";

interface TerminalState {
  activeSessionId: string | null;
  closeSession: (sessionId: string) => void;
  closeTerminal: () => void;
  createSession: (cwd?: string, profile?: ShellProfile) => string;
  height: number;
  isOpen: boolean;

  // Actions
  openTerminal: () => void;
  registerSessionHandler: (sessionId: string, handler: (data: string) => void) => void;

  // Output handling for external tools
  sessionHandlers: Map<string, (data: string) => void>;
  sessions: TerminalSession[];
  setActiveSession: (sessionId: string) => void;
  setHeight: (height: number) => void;

  // PTY-specific actions
  setPtyConnected: (sessionId: string, connected: boolean) => void;
  setSessionRunning: (sessionId: string, isRunning: boolean) => void;
  setSessionSize: (sessionId: string, cols: number, rows: number) => void;
  toggleTerminal: () => void;
  unregisterSessionHandler: (sessionId: string) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
  writeToActiveSession: (data: string) => void;
}

export interface TerminalSession {
  cols: number;
  cwd: string;
  id: string;

  // PTY-specific fields
  isPty: boolean;
  isRunning: boolean;
  name: string;
  profile: ShellProfile;
  ptyConnected: boolean;
  rows: number;
}

export type ShellProfile = 'powershell' | 'bash';

const generateId = () => Math.random().toString(36).substr(2, 9);

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isOpen: false,
  height: 300,
  sessionHandlers: new Map(),

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

  setHeight: (height) => set({ height: Math.max(150, Math.min(800, height)) }),

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
      isRunning: false,
      profile,
      isPty: true,
      ptyConnected: false,
      cols: 80,
      rows: 24,
    };

    set((state) => ({
      sessions: [...state.sessions, newSession],
      activeSessionId: id,
    }));

    return id;
  },

  closeSession: (sessionId) => {
    set((state) => {
      const remaining = state.sessions.filter(s => s.id !== sessionId);
      let newActiveId = state.activeSessionId;
      
      // Cleanup handler
      state.sessionHandlers.delete(sessionId);
      
      if (state.activeSessionId === sessionId) {
        newActiveId = remaining.length > 0 ? remaining[0].id : null;
      }

      return {
        sessions: remaining,
        activeSessionId: newActiveId,
        isOpen: remaining.length > 0 ? state.isOpen : false,
        sessionHandlers: new Map(state.sessionHandlers),
      };
    });
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

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

  // PTY-specific actions
  setPtyConnected: (sessionId, connected) => {
    set((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, ptyConnected: connected } : s
      ),
    }));
  },

  setSessionSize: (sessionId, cols, rows) => {
    set((state) => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, cols, rows } : s
      ),
    }));
  },

  // Output handling logic
  registerSessionHandler: (sessionId, handler) => {
    set(state => {
      const newHandlers = new Map(state.sessionHandlers);
      newHandlers.set(sessionId, handler);
      return { sessionHandlers: newHandlers };
    });
  },

  unregisterSessionHandler: (sessionId) => {
    set(state => {
      const newHandlers = new Map(state.sessionHandlers);
      newHandlers.delete(sessionId);
      return { sessionHandlers: newHandlers };
    });
  },

  writeToActiveSession: (data) => {
    const { activeSessionId, sessionHandlers } = get();
    if (activeSessionId && sessionHandlers.has(activeSessionId)) {
      const handler = sessionHandlers.get(activeSessionId);
      handler?.(data);
    }
  },
}));
