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

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
} from "react";
import { X, Plus, Terminal as TerminalIcon, ChevronDown } from "lucide-react";
import {
  useTerminalStore,
  type ShellProfile,
} from "../../store/useTerminalStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useThemeStore } from "../../store/useThemeStore";
import { isTauri } from "../../lib/tauri";
import { MenuBarMenu, type MenuBarItem } from "../layout/MenuBarMenu";
import { spawn, type IPty } from "tauri-pty";
import { platform } from "@tauri-apps/plugin-os";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import clsx from "clsx";

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
const cleanupSession = (
  sessionId: string,
  unregisterHandler?: (id: string) => void,
) => {
  const session = ptySessionsMap.get(sessionId);
  if (session) {
    try {
      session.pty.kill();
    } catch {
      // Ignore errors during cleanup
    }
    try {
      session.terminal.dispose();
    } catch {
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
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", cleanupAllSessions);
}

type ShellSpawnConfig = {
  exe: string;
  args: string[];
  env?: Record<string, string | undefined>;
};

const buildPowerShellInitCommand = (): string => {
  return [
    "$global:AuroraPromptVersion='1'",
    "function global:Aurora-ShortPath([string]$p,[int]$maxLen){",
    "  if(-not $p){ return '' }",
    "  if($maxLen -lt 20){ return (Split-Path -Leaf $p) }",
    "  $drive=''",
    "  $rest=$p",
    "  if($p -match '^[A-Za-z]:'){ $drive=$p.Substring(0,2); $rest=$p.Substring(2) }",
    "  $parts = ($rest -split '[\\\\/]+') | Where-Object { $_ -ne '' }",
    "  if($parts.Count -le 3){ return ($drive + '\\' + ($parts -join '\\')).TrimEnd('\\') }",
    "  $head = $parts[0]",
    "  $tail = ($parts | Select-Object -Last 2) -join '\\'",
    "  return ($drive + '\\' + $head + '\\...\\' + $tail).TrimEnd('\\')",
    "}",
    "function global:prompt{",
    "  $w=80; try{ $w=$Host.UI.RawUI.WindowSize.Width } catch {}",
    "  if($w -lt 40){ return '> ' }",
    "  $path=(Get-Location).Path",
    "  $short=Aurora-ShortPath $path ($w-28)",
    "  $ok= if($?){'OK'} else {'ERR'}",
    "  $ver= try{ $PSVersionTable.PSVersion.Major } catch { 0 }",
    "  $useColor=$false; try{ $useColor = [bool]$Host.UI.SupportsVirtualTerminal } catch {}",
    '  if(-not $useColor){ return "$short | pwsh$ver | $ok`n> " }',
    "  $esc=[char]27",
    '  $c="$esc[36m"; $y="$esc[33m"; $g="$esc[32m"; $r="$esc[31m"; $d="$esc[90m"; $x="$esc[0m"',
    "  $sc= if($ok -eq 'OK'){ $g } else { $r }",
    '  return "${c}${short}${x} ${d}|${x} ${y}pwsh${ver}${x} ${d}|${x} ${sc}${ok}${x}`n> "',
    "}",
    "try{ Set-PSReadLineOption -BellStyle None -ErrorAction SilentlyContinue } catch {}",
  ].join("; ");
};

const buildBashEnv = (): Record<string, string | undefined> => {
  const promptCommand = [
    "__aurora_last=$?;",
    'if [ -z "$COLUMNS" ]; then __aurora_cols=80; else __aurora_cols=$COLUMNS; fi;',
    'if [ "$__aurora_cols" -lt 40 ]; then __aurora_min=1; else __aurora_min=0; fi;',
    "if command -v tput >/dev/null 2>&1; then __aurora_colors=$(tput colors 2>/dev/null || echo 0); else __aurora_colors=0; fi;",
    'if [ "$TERM" = "dumb" ] || [ -z "$TERM" ] || [ "$__aurora_colors" -lt 8 ]; then __aurora_color=0; else __aurora_color=1; fi;',
    'if [ "$__aurora_min" -eq 1 ]; then PS1="> "; else ',
    '  if [ "$__aurora_color" -eq 1 ]; then ',
    "    __a_c='\\[\\033[36m\\]'; __a_y='\\[\\033[33m\\]'; __a_g='\\[\\033[32m\\]'; __a_r='\\[\\033[31m\\]'; __a_d='\\[\\033[90m\\]'; __a_x='\\[\\033[0m\\]';",
    "  else __a_c=''; __a_y=''; __a_g=''; __a_r=''; __a_d=''; __a_x=''; fi;",
    '  if [ "$__aurora_last" -eq 0 ]; then __a_s="${__a_g}OK${__a_x}"; else __a_s="${__a_r}ERR${__a_x}"; fi;',
    '  PS1="${__a_c}\\w${__a_x} ${__a_d}|${__a_x} ${__a_y}bash${BASH_VERSINFO[0]}${__a_x} ${__a_d}|${__a_x} ${__a_s}\\n> ";',
    "fi",
  ].join(" ");

  return {
    TERM: "xterm-256color",
    PROMPT_DIRTRIM: "3",
    PROMPT_COMMAND: promptCommand,
  };
};

const getShellSpawnConfig = async (
  profile: ShellProfile,
  currentPlatform: string,
): Promise<ShellSpawnConfig> => {
  if (profile === "bash") {
    if (currentPlatform === "windows") {
      return {
        exe: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["--noprofile", "--norc", "-i"],
        env: buildBashEnv(),
      };
    }
    return {
      exe: "/bin/bash",
      args: ["--noprofile", "--norc", "-i"],
      env: buildBashEnv(),
    };
  }

  if (currentPlatform === "windows") {
    return {
      exe: "pwsh.exe",
      args: ["-NoLogo", "-NoExit", "-Command", buildPowerShellInitCommand()],
    };
  }

  return {
    exe: "/bin/bash",
    args: ["--noprofile", "--norc", "-i"],
    env: buildBashEnv(),
  };
};

// ============================================
// Shell Icons
// ============================================
const ShellIcon: React.FC<{
  profile: ShellProfile;
  className?: string;
  style?: React.CSSProperties;
}> = ({ profile, className, style }) => {
  if (profile === "bash") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        style={style}
      >
        <path d="M21.8 14.4c-.1-.1-.2-.2-.4-.2-.1 0-.2 0-.3.1l-1.4.9c-.1.1-.2.1-.3.1-.2 0-.3-.1-.3-.3v-2c0-.2.1-.3.3-.3.1 0 .2 0 .3.1l1.4.9c.1.1.2.1.3.1.1 0 .3-.1.4-.2.1-.1.2-.3.2-.4V9c0-.2-.1-.3-.2-.4-.1-.1-.2-.2-.4-.2-.1 0-.2 0-.3.1l-1.4.9c-.1.1-.2.1-.3.1-.2 0-.3-.1-.3-.3V7c0-.2-.1-.4-.2-.5-.2-.1-.3-.2-.5-.2H5c-.2 0-.4.1-.5.2-.1.1-.2.3-.2.5v10c0 .2.1.4.2.5.1.1.3.2.5.2h13c.2 0 .4-.1.5-.2.2-.1.2-.3.2-.5v-2c0-.2.1-.3.3-.3.1 0 .2 0 .3.1l1.4.9c.1.1.2.1.3.1.1 0 .3-.1.4-.2.1-.1.2-.3.2-.4v-1c0-.1-.1-.3-.2-.4z" />
      </svg>
    );
  }
  return <TerminalIcon className={className} style={style} />;
};

// ============================================
// XTerm Terminal Session Component
// ============================================
const XTermSession: React.FC<{
  sessionId: string;
  isVisible: boolean;
  panelHeight: number;
}> = ({ sessionId, isVisible, panelHeight }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(() =>
    ptySessionsMap.has(sessionId),
  );
  const [error, setError] = useState<string | null>(null);
  const initializingRef = useRef(false);

  const {
    sessions,
    setPtyConnected,
    setSessionRunning,
    registerSessionHandler,
    unregisterSessionHandler,
    setSessionSize,
  } = useTerminalStore();
  const { rootPath } = useWorkspaceStore();
  const { themes, activeThemeId } = useThemeStore();
  const activeTheme = themes.find((t) => t.id === activeThemeId) || themes[0];
  const session = sessions.find((s) => s.id === sessionId);
  const terminalTheme = activeTheme?.colors.terminal;

  // Update terminal theme when active terminal theme changes
  useEffect(() => {
    const sessionData = ptySessionsMap.get(sessionId);
    if (!sessionData || !terminalTheme) return;

    const t = terminalTheme;
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
  }, [activeThemeId, sessionId, terminalTheme]);

  // Initialize terminal only once
  useEffect(() => {
    if (!containerRef.current || !session || !isTauri()) return;

    const existing = ptySessionsMap.get(sessionId);
    if (existing) {
      try {
        const container = containerRef.current;
        const term = existing.terminal;

        if (container) {
          if (term.element) {
            if (term.element.parentElement !== container) {
              container.innerHTML = "";
              container.appendChild(term.element);
            }
          } else {
            term.open(container);
          }
        }

        registerSessionHandler(sessionId, (data: string) => {
          term.write(data);
        });

        setIsInitialized(true);
        setTimeout(() => {
          try {
            existing.fitAddon.fit();
            existing.terminal.focus();
          } catch {
            // Ignore transient fit errors during reattach
          }
        }, 10);
      } catch (err) {
        console.error("[Terminal] Failed to reattach session:", err);
      }

      return;
    }

    // Prevent double initialization
    if (initializingRef.current) return;
    initializingRef.current = true;

    const initNewSession = async () => {
      try {
        const currentPlatform = await platform();
        const spawnConfig = await getShellSpawnConfig(
          session.profile,
          currentPlatform,
        );

        // Create xterm.js terminal
        // Create xterm.js terminal
        const t = terminalTheme;
        const term = new Terminal({
          cursorBlink: true,
          cursorStyle: "block",
          fontSize: 13,
          fontFamily:
            '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
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
        let pty: IPty;
        try {
          pty = spawn(spawnConfig.exe, spawnConfig.args, {
            cols: term.cols || 80,
            rows: term.rows || 24,
            cwd: rootPath || undefined,
            env: spawnConfig.env,
          });
        } catch (e) {
          if (
            session.profile === "powershell" &&
            currentPlatform === "windows"
          ) {
            pty = spawn(
              "powershell.exe",
              ["-NoLogo", "-NoExit", "-Command", buildPowerShellInitCommand()],
              {
                cols: term.cols || 80,
                rows: term.rows || 24,
                cwd: rootPath || undefined,
              },
            );
          } else {
            throw e;
          }
        }

        // Store session data
        const sessionData: PtySessionData = {
          pty,
          terminal: term,
          fitAddon,
          profile: session.profile,
        };
        ptySessionsMap.set(sessionId, sessionData);

        // Connect PTY output to terminal
        pty.onData((data) => {
          term.write(data);
        });

        // Handle PTY exit
        pty.onExit(({ exitCode }) => {
          setPtyConnected(sessionId, false);
          setSessionRunning(sessionId, false);
          term.writeln(
            `\r\n\x1b[33m[Process exited with code: ${exitCode}]\x1b[0m`,
          );
        });

        // Connect terminal input to PTY
        term.onData((data) => {
          pty.write(data);
        });

        // Handle terminal resize
        term.onResize((e) => {
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
          try {
            fitAddon.fit();
          } catch (e) {
            void e;
          }
        }, 50);
      } catch (err) {
        console.error("[Terminal] Failed to initialize:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        setPtyConnected(sessionId, false);
        initializingRef.current = false;
      }
    };

    initNewSession();
  }, [
    sessionId,
    session,
    rootPath,
    terminalTheme,
    setPtyConnected,
    setSessionRunning,
    registerSessionHandler,
    unregisterSessionHandler,
  ]);

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
      } catch {
        // Ignore errors if terminal disposed
      }
    }, 10);

    return () => clearTimeout(timer);
  }, [isVisible, isInitialized, sessionId]);

  const refitTerminal = useCallback(() => {
    const sessionData = ptySessionsMap.get(sessionId);
    if (!sessionData) return;

    try {
      sessionData.fitAddon.fit();
      setSessionSize(
        sessionId,
        sessionData.terminal.cols,
        sessionData.terminal.rows,
      );
    } catch (e) {
      void e;
    }
  }, [sessionId, setSessionSize]);

  // Handle Window/Panel resizing
  useEffect(() => {
    if (!containerRef.current || !isVisible) return;

    let resizeTimeout: ReturnType<typeof setTimeout>;

    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        refitTerminal();
      }, 16);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);
    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
      clearTimeout(resizeTimeout);
    };
  }, [isVisible, refitTerminal]);

  // Refit immediately when the terminal panel height changes.
  // Using layout effect + nested RAFs ensures xterm measures after the panel DOM has settled.
  useLayoutEffect(() => {
    if (!isVisible) return;

    let raf1 = 0;
    let raf2 = 0;

    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        refitTerminal();
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [isVisible, panelHeight, refitTerminal]);

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
        style={{ padding: "4px 8px" }}
      />
    </div>
  );
};

// ============================================
// Resize Handle Component
// ============================================
//
// Slim 1px theme-aware splitter with a 6px hit-target. The splitter line
// itself stays calm (border tint at idle) and lifts to the primary tint
// only while hovered or actively dragged — no bulky 3px chrome.
const ResizeHandle: React.FC<{ onResize: (delta: number) => void }> = ({
  onResize,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      onResize(-e.movementY);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, onResize]);

  const lineColor =
    isDragging
      ? "var(--aurora-common-primary)"
      : isHovered
        ? "color-mix(in srgb, var(--aurora-common-primary) 70%, transparent)"
        : "color-mix(in srgb, var(--aurora-common-border) 70%, transparent)";

  return (
    <div
      onMouseDown={() => setIsDragging(true)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative cursor-ns-resize"
      style={{
        height: 6,
        marginTop: -3,
        marginBottom: -3,
        zIndex: 30,
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 3,
          height: 1,
          backgroundColor: lineColor,
          transition: "background-color 120ms ease",
        }}
      />
    </div>
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

  const handleNewSession = useCallback(
    (profile: ShellProfile) => {
      createSession(rootPath || undefined, profile);
    },
    [createSession, rootPath],
  );

  const { unregisterSessionHandler } = useTerminalStore();

  const handleCloseSession = (
    sessionId: string,
    e: React.MouseEvent | React.KeyboardEvent,
  ) => {
    e.stopPropagation();
    cleanupSession(sessionId, unregisterSessionHandler);
    closeSession(sessionId);
  };

  const handleResize = useCallback(
    (delta: number) => {
      setHeight(height + delta);
    },
    [height, setHeight],
  );

  // Profile dropdown items shared by header trigger + empty-state action.
  const profileMenuItems: MenuBarItem[] = [
    { header: "Shell" },
    {
      label: "PowerShell",
      icon: <TerminalIcon className="w-3.5 h-3.5" />,
      onClick: () => handleNewSession("powershell"),
    },
    {
      label: "Git Bash",
      icon: <ShellIcon profile="bash" className="w-3.5 h-3.5" />,
      onClick: () => handleNewSession("bash"),
    },
  ];

  if (!isOpen) return null;

  // Wrapperless icon button used in the actions cluster.
  const actionButtonClass =
    "flex h-[22px] w-[22px] items-center justify-center rounded-[4px] transition-colors duration-100";

  return (
    <div
      className="flex flex-col bg-editor"
      style={{
        height,
        minHeight: 150,
        maxHeight: 800,
        borderTop:
          "1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
        boxShadow:
          "0 -4px 12px color-mix(in srgb, var(--aurora-common-shadow) 30%, transparent)",
      }}
    >
      {/* Resize Handle */}
      <ResizeHandle onResize={handleResize} />

      {/*
       * Toolbar / Tabs Header
       * ---------------------
       * Slim 30px strip. Tabs use a top-edge primary accent on the active
       * session and theme-aware fills throughout. The actions cluster on
       * the right is wrapperless until hover and uses MenuBarMenu for the
       * profile dropdown so the visual language matches the rest of the
       * IDE.
       */}
      <div
        className="flex items-center justify-between select-none"
        style={{
          height: 30,
          backgroundColor: "var(--aurora-sidebar-background)",
          borderBottom:
            "1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
        }}
      >
        {/* Scrollable Tabs Container */}
        <div className="flex-1 flex items-stretch min-w-0 overflow-x-auto scrollbar-none h-full">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className="group relative flex items-center gap-1.5 px-2.5 text-[11.5px] transition-colors duration-100"
                style={{
                  height: 30,
                  minWidth: 0,
                  backgroundColor: isActive
                    ? "var(--aurora-editor-background)"
                    : "transparent",
                  color: isActive
                    ? "var(--aurora-editor-foreground)"
                    : "color-mix(in srgb, var(--aurora-editor-foreground) 70%, transparent)",
                  fontWeight: isActive ? 500 : 400,
                  borderRight:
                    "1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)",
                }}
                onMouseEnter={(e) => {
                  if (isActive) return;
                  e.currentTarget.style.backgroundColor =
                    "color-mix(in srgb, var(--aurora-editor-background) 55%, transparent)";
                  e.currentTarget.style.color =
                    "var(--aurora-editor-foreground)";
                }}
                onMouseLeave={(e) => {
                  if (isActive) return;
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color =
                    "color-mix(in srgb, var(--aurora-editor-foreground) 70%, transparent)";
                }}
                title={session.name}
              >
                {/* Active tab top accent — full-width 2px primary bar */}
                {isActive && (
                  <div
                    aria-hidden
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 2,
                      backgroundColor: "var(--aurora-common-primary)",
                    }}
                  />
                )}

                <ShellIcon
                  profile={session.profile}
                  className="w-3.5 h-3.5 flex-shrink-0"
                  style={{
                    color: isActive
                      ? "var(--aurora-common-primary)"
                      : undefined,
                    opacity: isActive ? 1 : 0.7,
                  }}
                />
                <span className="truncate max-w-[150px]">{session.name}</span>

                {/* Connection status dot — green when connected, red when disconnected */}
                <div
                  className="ml-1 flex-shrink-0 rounded-full"
                  style={{
                    width: 5,
                    height: 5,
                    backgroundColor: session.ptyConnected
                      ? "var(--aurora-common-success, #28a745)"
                      : "var(--aurora-common-error)",
                    opacity: session.ptyConnected ? (isActive ? 1 : 0.6) : 1,
                  }}
                  title={session.ptyConnected ? "Connected" : "Disconnected"}
                />

                {/* Close button — appears on hover, stays visible on active tab */}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => handleCloseSession(session.id, e)}
                  className={clsx(
                    "ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-[3px] transition-opacity duration-100",
                    isActive ? "opacity-70" : "opacity-0",
                    "group-hover:opacity-90",
                  )}
                  style={{
                    color: "var(--aurora-editor-foreground)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.opacity = "1";
                    e.currentTarget.style.backgroundColor =
                      "color-mix(in srgb, var(--aurora-common-error) 18%, transparent)";
                    e.currentTarget.style.color = "var(--aurora-common-error)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color =
                      "var(--aurora-editor-foreground)";
                    e.currentTarget.style.opacity = isActive ? "0.7" : "0";
                  }}
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            );
          })}
        </div>

        {/* Actions cluster — New Session dropdown + Close Panel */}
        <div
          className="flex items-center gap-0.5 h-full px-1.5"
          style={{
            borderLeft:
              "1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)",
          }}
        >
          <MenuBarMenu
            label="New Terminal"
            title="New Terminal Profile"
            items={profileMenuItems}
            menuWidth={200}
            align="end"
            triggerIcon={
              <span className="flex items-center gap-0.5">
                <Plus className="w-3.5 h-3.5" />
                <ChevronDown className="w-2.5 h-2.5 opacity-70" />
              </span>
            }
            triggerClassName={`${actionButtonClass} px-1.5`}
            triggerStyle={{
              width: "auto",
              height: 22,
              color: "var(--aurora-editor-foreground)",
            }}
          />

          <button
            type="button"
            onClick={closeTerminal}
            className={actionButtonClass}
            style={{
              color:
                "color-mix(in srgb, var(--aurora-editor-foreground) 70%, transparent)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor =
                "color-mix(in srgb, var(--aurora-common-error) 16%, transparent)";
              e.currentTarget.style.color = "var(--aurora-common-error)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color =
                "color-mix(in srgb, var(--aurora-editor-foreground) 70%, transparent)";
            }}
            title="Close Panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Content Area */}
      <div className="flex-1 relative bg-editor overflow-hidden">
        {sessions.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <TerminalIcon
              className="w-10 h-10"
              style={{
                color:
                  "color-mix(in srgb, var(--aurora-editor-foreground) 22%, transparent)",
              }}
            />
            <div
              className="text-[12px]"
              style={{
                color:
                  "color-mix(in srgb, var(--aurora-editor-foreground) 60%, transparent)",
              }}
            >
              No active terminal sessions
            </div>
            <button
              type="button"
              onClick={() => handleNewSession("powershell")}
              className="px-3 py-1 text-[11.5px] rounded-[5px] transition-colors duration-100"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)",
                color: "var(--aurora-common-primary)",
                border:
                  "1px solid color-mix(in srgb, var(--aurora-common-primary) 28%, transparent)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor =
                  "color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor =
                  "color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)";
              }}
            >
              Start New Session
            </button>
          </div>
        )}

        {sessions.map((session) => (
          <div
            key={session.id}
            className={clsx(
              "absolute inset-0",
              session.id === activeSessionId
                ? "z-10 visible"
                : "z-0 invisible pointer-events-none",
            )}
          >
            <XTermSession
              sessionId={session.id}
              isVisible={session.id === activeSessionId}
              panelHeight={height}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
