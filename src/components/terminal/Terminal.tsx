/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

/**
 * Terminal Component
 * Native PTY-based terminal using tauri-plugin-pty
 * Properly manages multiple sessions with persistent PTY connections
 * Uses CSS visibility toggling to ensure state persists across tab switches
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, Terminal as TerminalIcon, ChevronDown } from 'lucide-react';
import { useTerminalStore, type ShellProfile } from '../../store/useTerminalStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useThemeStore } from '../../store/useThemeStore';
import { isTauri } from '../../lib/tauri';
import { spawn, type IPty } from 'tauri-pty';
import { platform } from '@tauri-apps/plugin-os';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import clsx from 'clsx';

// ============================================
// Global PTY Session Manager
// Keeps PTY connections alive and stores references
// ============================================
interface PtySessionData {
  pty: IPty;
  terminal: Terminal;
  fitAddon: FitAddon;
  profile: ShellProfile;
}

const ptySessionsMap = new Map<string, PtySessionData>();

// Clean up a single session
const cleanupSession = (sessionId: string, unregisterHandler?: (id: string) => void) => {
  const session = ptySessionsMap.get(sessionId);
  if (session) {
    try {
      session.pty.kill();
    } catch (e) {
      // Ignore errors during cleanup
    }
    try {
      session.terminal.dispose();
    } catch (e) {
      // Ignore errors during cleanup
    }
    ptySessionsMap.delete(sessionId);
  }
  // Unregister the write handler if provided
  if (unregisterHandler) {
    unregisterHandler(sessionId);
  }
};

// Clean up ALL sessions (called on app close)
const cleanupAllSessions = () => {
  ptySessionsMap.forEach((_, sessionId) => {
    cleanupSession(sessionId);
  });
};

// Register cleanup on window unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', cleanupAllSessions);
}

// Get shell executable based on profile and platform
const getShellExecutable = async (profile: ShellProfile, currentPlatform: string): Promise<string> => {
  if (profile === 'bash') {
    if (currentPlatform === 'windows') {
      // Common Git Bash paths
      return 'C:\\Program Files\\Git\\bin\\bash.exe';
    }
    return '/bin/bash';
  }
  // PowerShell
  if (currentPlatform === 'windows') {
    return 'pwsh.exe';
  }
  return '/bin/bash'; // Fallback for non-windows if powershell requested
};

// ============================================
// Shell Icons
// ============================================
const ShellIcon: React.FC<{ profile: ShellProfile; className?: string }> = ({ profile, className }) => {
  if (profile === 'bash') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M21.8 14.4c-.1-.1-.2-.2-.4-.2-.1 0-.2 0-.3.1l-1.4.9c-.1.1-.2.1-.3.1-.2 0-.3-.1-.3-.3v-2c0-.2.1-.3.3-.3.1 0 .2 0 .3.1l1.4.9c.1.1.2.1.3.1.1 0 .3-.1.4-.2.1-.1.2-.3.2-.4V9c0-.2-.1-.3-.2-.4-.1-.1-.2-.2-.4-.2-.1 0-.2 0-.3.1l-1.4.9c-.1.1-.2.1-.3.1-.2 0-.3-.1-.3-.3V7c0-.2-.1-.4-.2-.5-.2-.1-.3-.2-.5-.2H5c-.2 0-.4.1-.5.2-.1.1-.2.3-.2.5v10c0 .2.1.4.2.5.1.1.3.2.5.2h13c.2 0 .4-.1.5-.2.2-.1.2-.3.2-.5v-2c0-.2.1-.3.3-.3.1 0 .2 0 .3.1l1.4.9c.1.1.2.1.3.1.1 0 .3-.1.4-.2.1-.1.2-.3.2-.4v-1c0-.1-.1-.3-.2-.4z" />
      </svg>
    );
  }
  return <TerminalIcon className={className} />;
};

// ============================================
// XTerm Terminal Session Component
// ============================================
const XTermSession: React.FC<{ sessionId: string; isVisible: boolean }> = ({ sessionId, isVisible }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(() => ptySessionsMap.has(sessionId));
  const [error, setError] = useState<string | null>(null);
  const initializingRef = useRef(false);

  const {
    sessions,
    setPtyConnected,
    setSessionRunning,
    registerSessionHandler,
    unregisterSessionHandler,
  } = useTerminalStore();
  const { rootPath } = useWorkspaceStore();
  const { themes, activeThemeId } = useThemeStore();
  const activeTheme = themes.find(t => t.id === activeThemeId) || themes[0];
  const session = sessions.find(s => s.id === sessionId);

  // Update terminal theme when active activeTheme changes
  useEffect(() => {
    const sessionData = ptySessionsMap.get(sessionId);
    if (!sessionData || !activeTheme) return;

    const t = activeTheme.colors.terminal;
    sessionData.terminal.options.theme = {
      background: t.background,
      foreground: t.foreground,
      cursor: t.cursor,
      selectionBackground: t.selection,
      black: t.black,
      red: t.red,
      green: t.green,
      yellow: t.yellow,
      blue: t.blue,
      magenta: t.magenta,
      cyan: t.cyan,
      white: t.white,
      brightBlack: t.brightBlack,
      brightRed: t.brightRed,
      brightGreen: t.brightGreen,
      brightYellow: t.brightYellow,
      brightBlue: t.brightBlue,
      brightMagenta: t.brightMagenta,
      brightCyan: t.brightCyan,
      brightWhite: t.brightWhite,
    };
  }, [activeThemeId, sessionId, activeTheme]);

  // Initialize terminal only once
  useEffect(() => {
    if (!containerRef.current || !session || !isTauri()) return;

    // Check if already initialized for this session
    if (ptySessionsMap.has(sessionId)) {
      setIsInitialized(true);
      return;
    }

    // Prevent double initialization
    if (initializingRef.current) return;
    initializingRef.current = true;

    const initNewSession = async () => {
      try {
        const currentPlatform = await platform();
        const shellExe = await getShellExecutable(session.profile, currentPlatform);

        // Create xterm.js terminal
        // Create xterm.js terminal
        const t = activeTheme.colors.terminal;
        const term = new Terminal({
          cursorBlink: true,
          cursorStyle: 'block',
          fontSize: 13,
          fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
          lineHeight: 1.2,
          convertEol: true,
          scrollback: 10000,
          theme: {
            background: t.background,
            foreground: t.foreground,
            cursor: t.cursor,
            selectionBackground: t.selection,
            black: t.black,
            red: t.red,
            green: t.green,
            yellow: t.yellow,
            blue: t.blue,
            magenta: t.magenta,
            cyan: t.cyan,
            white: t.white,
            brightBlack: t.brightBlack,
            brightRed: t.brightRed,
            brightGreen: t.brightGreen,
            brightYellow: t.brightYellow,
            brightBlue: t.brightBlue,
            brightMagenta: t.brightMagenta,
            brightCyan: t.brightCyan,
            brightWhite: t.brightWhite,
          },
          allowProposedApi: true,
        });

        // Load addons
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());

        // Open terminal in container
        if (containerRef.current) {
          term.open(containerRef.current);
        }

        // Spawn PTY
        const pty = spawn(shellExe, [], {
          cols: term.cols || 80,
          rows: term.rows || 24,
          cwd: rootPath || undefined,
        });

        // Store session data
        const sessionData: PtySessionData = {
          pty,
          terminal: term,
          fitAddon,
          profile: session.profile,
        };
        ptySessionsMap.set(sessionId, sessionData);

        // Connect PTY output to terminal
        pty.onData(data => {
          term.write(data);
        });

        // Handle PTY exit
        pty.onExit(({ exitCode }) => {
          setPtyConnected(sessionId, false);
          setSessionRunning(sessionId, false);
          term.writeln(`\r\n\x1b[33m[Process exited with code: ${exitCode}]\x1b[0m`);
        });

        // Connect terminal input to PTY
        term.onData(data => {
          pty.write(data);
        });

        // Handle terminal resize
        term.onResize(e => {
          pty.resize(e.cols, e.rows);
        });

        setPtyConnected(sessionId, true);
        setSessionRunning(sessionId, true);
        setIsInitialized(true);
        initializingRef.current = false;

        // Register handler for external writes (agent shell_execute)
        // This writes data directly to the xterm terminal display
        registerSessionHandler(sessionId, (data: string) => {
          term.write(data);
        });

        // Initial fit
        setTimeout(() => {
          try { fitAddon.fit(); } catch (e) { }
        }, 50);

      } catch (err) {
        console.error('[Terminal] Failed to initialize:', err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        setPtyConnected(sessionId, false);
        initializingRef.current = false;
      }
    };

    initNewSession();

    // Cleanup handler on unmount
    return () => {
      unregisterSessionHandler(sessionId);
    };
  }, [sessionId, session, rootPath, setPtyConnected, setSessionRunning, registerSessionHandler, unregisterSessionHandler]);

  // Handle Visibility Changes & Resizing
  // When switching tabs, the container goes from display:none to block.
  // XTerm needs to re-calculate dimensions immediately.
  useEffect(() => {
    if (!isInitialized || !isVisible) return;

    const sessionData = ptySessionsMap.get(sessionId);
    if (!sessionData) return;

    // Small delay to allow DOM layout to settle after display:block
    const timer = setTimeout(() => {
      try {
        sessionData.fitAddon.fit();
        sessionData.terminal.focus();
      } catch (e) {
        // Ignore errors if terminal disposed
      }
    }, 10);

    return () => clearTimeout(timer);
  }, [isVisible, isInitialized, sessionId]);

  // Handle Window/Panel resizing
  useEffect(() => {
    if (!containerRef.current || !isVisible) return;

    const sessionData = ptySessionsMap.get(sessionId);
    if (!sessionData) return;

    let resizeTimeout: ReturnType<typeof setTimeout>;

    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        try {
          sessionData.fitAddon.fit();
        } catch (e) { }
      }, 100);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, [sessionId, isVisible]);

  if (!session) return null;

  return (
    <div className="w-full h-full relative bg-editor">
      {!isInitialized && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-editor z-10">
          <span className="text-primary">Connecting to terminal...</span>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-editor z-10">
          <span className="text-danger">Failed to connect: {error}</span>
        </div>
      )}

      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ padding: '4px 8px' }}
      />
    </div>
  );
};

// ============================================
// Resize Handle Component
// ============================================
const ResizeHandle: React.FC<{ onResize: (delta: number) => void }> = ({ onResize }) => {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      onResize(-e.movementY);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, onResize]);

  return (
    <div
      onMouseDown={() => setIsDragging(true)}
      className={clsx(
        "h-[3px] cursor-ns-resize transition-colors",
        isDragging ? "bg-primary" : "bg-border hover:bg-primary"
      )}
    />
  );
};

// ============================================
// Main Terminal Panel Component
// ============================================
export const TerminalPanel: React.FC = () => {
  const {
    sessions,
    activeSessionId,
    isOpen,
    height,
    setHeight,
    closeTerminal,
    createSession,
    closeSession,
    setActiveSession,
  } = useTerminalStore();
  const { rootPath } = useWorkspaceStore();
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Close profile menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNewSession = (profile: ShellProfile) => {
    createSession(rootPath || undefined, profile);
    setShowProfileMenu(false);
  };

  const handlePlusClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowProfileMenu(prev => !prev);
  };

  const { unregisterSessionHandler } = useTerminalStore();

  const handleCloseSession = (sessionId: string, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    cleanupSession(sessionId, unregisterSessionHandler);
    closeSession(sessionId);
  };

  const handleResize = useCallback((delta: number) => {
    setHeight(height + delta);
  }, [height, setHeight]);

  if (!isOpen) return null;

  return (
    <div
      className="flex flex-col border-t border-border bg-editor shadow-[0_-4px_6px_-1px_var(--aurora-common-shadow)]"
      style={{ height, minHeight: 150, maxHeight: 800 }}
    >
      {/* Resize Handle */}
      <ResizeHandle onResize={handleResize} />

      {/* Toolbar / Tabs Header */}
      <div className="h-9 flex items-center justify-between bg-sidebar border-b border-border select-none">

        {/* Scrollable Tabs Container */}
        <div className="flex-1 flex items-center min-w-0 overflow-x-auto scrollbar-none px-2 gap-1 h-full">
          {sessions.map(session => {
            const isActive = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className={clsx(
                  'group relative flex items-center gap-2 px-3 h-[28px] text-[12px] rounded-t-md transition-all duration-150 border-t-2',
                  isActive
                    ? 'bg-editor text-text-primary border-primary font-medium'
                    : 'bg-transparent text-text-secondary hover:bg-input border-transparent hover:text-text-primary'
                )}
                title={session.name}
              >
                <ShellIcon profile={session.profile} className={clsx("w-3.5 h-3.5 flex-shrink-0", isActive ? "text-primary" : "opacity-70")} />
                <span className="truncate max-w-[150px]">{session.name}</span>

                {/* Status Dot */}
                {session.ptyConnected ? (
                  isActive && <div className="w-1.5 h-1.5 rounded-full bg-[#89d185] flex-shrink-0 ml-1" />
                ) : (
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0 ml-1" title="Disconnected" />
                )}

                <div
                  role="button"
                  tabIndex={0}
                  onClick={(e) => handleCloseSession(session.id, e)}
                  className={clsx(
                    "ml-1 p-0.5 rounded-sm opacity-0 group-hover:opacity-100 transition-all",
                    isActive ? "hover:bg-sidebar" : "hover:bg-sidebar"
                  )}
                >
                  <X className="w-3 h-3" />
                </div>
              </button>
            );
          })}
        </div>

        {/* Fixed Actions Area (New Session + Close Panel) */}
        <div className="flex items-center px-2 gap-1 h-full border-l border-border bg-sidebar z-20">

          {/* New Session Dropdown */}
          <div className="relative" ref={profileMenuRef}>
            <button
              onClick={handlePlusClick}
              className={clsx(
                "h-[24px] px-2 flex items-center gap-1 rounded text-text-primary transition-colors",
                showProfileMenu ? "bg-input text-white" : "hover:bg-input"
              )}
              title="New Terminal Profile"
            >
              <Plus className="w-3.5 h-3.5" />
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>

            {/* Dropdown Menu - Fixed Position to avoid clipping issues if container was overflow */}
            {showProfileMenu && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-sidebar border border-border rounded-md shadow-2xl z-[100] py-1 overflow-hidden ring-1 ring-black/20 animate-in fade-in zoom-in-95 duration-100 origin-top-right">
                <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-text-secondary tracking-wider bg-sidebar/50">
                  Select Profile
                </div>
                <button
                  onClick={() => handleNewSession('powershell')}
                  className="w-full px-3 py-2 text-left text-[13px] text-text-primary hover:bg-primary/20 hover:text-white flex items-center gap-2.5 transition-colors"
                >
                  <TerminalIcon className="w-4 h-4 text-text-primary" />
                  <span>PowerShell</span>
                </button>
                <button
                  onClick={() => handleNewSession('bash')}
                  className="w-full px-3 py-2 text-left text-[13px] text-text-primary hover:bg-primary/20 hover:text-white flex items-center gap-2.5 transition-colors"
                >
                  <ShellIcon profile="bash" className="w-4 h-4 text-[#f05033]" /> {/* Git color hint */}
                  <span>Git Bash</span>
                </button>
              </div>
            )}
          </div>

          <div className="w-[1px] h-4 bg-border mx-1" />

          <button
            onClick={closeTerminal}
            className="h-[24px] w-[24px] flex items-center justify-center text-text-secondary hover:text-text-primary rounded hover:bg-danger hover:text-white transition-colors"
            title="Close Panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Terminal Content Area */}
      <div className="flex-1 relative bg-editor overflow-hidden">
        {sessions.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-text-disabled gap-3">
            <TerminalIcon className="w-12 h-12 opacity-20" />
            <div className="text-sm">No active terminal sessions</div>
            <button
              onClick={() => handleNewSession('powershell')}
              className="px-4 py-1.5 bg-primary text-white text-xs rounded hover:bg-primary-hover transition-colors"
            >
              Start New Session
            </button>
          </div>
        )}

        {sessions.map(session => (
          <div
            key={session.id}
            className={clsx(
              "absolute inset-0",
              session.id === activeSessionId ? "z-10 visible" : "z-0 invisible pointer-events-none"
            )}
          >
            <XTermSession
              sessionId={session.id}
              isVisible={session.id === activeSessionId}
            />
          </div>
        ))}
      </div>
    </div>
  );
};