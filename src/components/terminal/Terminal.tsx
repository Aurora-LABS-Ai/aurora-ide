/**
 * Terminal Component
 * Native-like integrated terminal with PowerShell and Git Bash support
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, Terminal as TerminalIcon, ChevronDown, Trash2 } from 'lucide-react';
import { useTerminalStore, type TerminalLine, type ShellProfile } from '../../store/useTerminalStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { executeCommand, isTauri } from '../../lib/tauri';
import clsx from 'clsx';

// Shell profile icons
const ShellIcon: React.FC<{ profile: ShellProfile; className?: string }> = ({ profile, className }) => {
  if (profile === 'bash') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M21.8 14.4c-.1-.1-.2-.2-.4-.2-.1 0-.2 0-.3.1l-1.4.9c-.1.1-.2.1-.3.1-.2 0-.3-.1-.3-.3v-2c0-.2.1-.3.3-.3.1 0 .2 0 .3.1l1.4.9c.1.1.2.1.3.1.1 0 .3-.1.4-.2.1-.1.2-.3.2-.4V9c0-.2-.1-.3-.2-.4-.1-.1-.2-.2-.4-.2-.1 0-.2 0-.3.1l-1.4.9c-.1.1-.2.1-.3.1-.2 0-.3-.1-.3-.3V7c0-.2-.1-.4-.2-.5-.2-.1-.3-.2-.5-.2H5c-.2 0-.4.1-.5.2-.1.1-.2.3-.2.5v10c0 .2.1.4.2.5.1.1.3.2.5.2h13c.2 0 .4-.1.5-.2.2-.1.2-.3.2-.5v-2c0-.2.1-.3.3-.3.1 0 .2 0 .3.1l1.4.9c.1.1.2.1.3.1.1 0 .3-.1.4-.2.1-.1.2-.3.2-.4v-1c0-.1-.1-.3-.2-.4z"/>
      </svg>
    );
  }
  return <TerminalIcon className={className} />;
};

// Terminal Line Component - selectable text
const TerminalLineItem: React.FC<{ line: TerminalLine; cwd: string; profile: ShellProfile }> = ({ line, cwd, profile }) => {
  const getPromptSymbol = () => {
    return profile === 'bash' ? '$' : '>';
  };

  // For input lines, show with prompt
  if (line.type === 'input') {
    return (
      <div className="whitespace-pre-wrap break-all leading-relaxed select-text">
        <span className="text-[#569cd6]">{cwd}</span>
        <span className="text-[#dcdcaa]"> {getPromptSymbol()}</span>
        <span className="text-[#d4d4d4]"> {line.content}</span>
      </div>
    );
  }

  // For error lines
  if (line.type === 'error') {
    return (
      <div className="text-[#f14c4c] whitespace-pre-wrap break-all leading-relaxed select-text">
        {line.content}
      </div>
    );
  }

  // For output lines
  return (
    <div className="text-[#cccccc] whitespace-pre-wrap break-all leading-relaxed select-text">
      {line.content}
    </div>
  );
};

// Terminal Session Component
const TerminalSession: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const [inputValue, setInputValue] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { sessions, addLine, setSessionRunning, updateSessionCwd } = useTerminalStore();
  const { rootPath } = useWorkspaceStore();
  const session = sessions.find(s => s.id === sessionId);

  // Auto-scroll to bottom when new lines are added
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [session?.lines]);

  // Focus input when session is first created or becomes active
  useEffect(() => {
    // Small delay to ensure the component is rendered
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [sessionId]);

  const executeShellCommand = useCallback(async (command: string) => {
    if (!command.trim() || !session) return;

    // Add command to history
    setCommandHistory(prev => [...prev, command]);
    setHistoryIndex(-1);

    const cwd = session.cwd || rootPath || '';
    
    // Add input line (shows the command with prompt)
    addLine(sessionId, { type: 'input', content: command });
    setSessionRunning(sessionId, true);

    try {
      // Handle built-in commands
      if (command.trim().toLowerCase() === 'clear' || command.trim().toLowerCase() === 'cls') {
        useTerminalStore.getState().clearSession(sessionId);
        setSessionRunning(sessionId, false);
        return;
      }

      // Handle cd command
      if (command.trim().toLowerCase().startsWith('cd ')) {
        const newPath = command.trim().slice(3).trim();
        if (isTauri()) {
          const result = await executeCommand(
            session.profile === 'bash' ? `cd "${newPath}" && pwd` : `cd "${newPath}"; Get-Location | Select-Object -ExpandProperty Path`,
            cwd || undefined,
            session.profile
          );
          if (result.success && result.stdout) {
            const newCwd = result.stdout.trim();
            updateSessionCwd(sessionId, newCwd);
          } else if (result.stderr) {
            addLine(sessionId, { type: 'error', content: result.stderr.trimEnd() });
          }
        }
        setSessionRunning(sessionId, false);
        return;
      }

      if (!isTauri()) {
        addLine(sessionId, { type: 'error', content: 'Terminal requires desktop app' });
        setSessionRunning(sessionId, false);
        return;
      }

      const result = await executeCommand(command, cwd || undefined, session.profile);

      if (result.stdout) {
        addLine(sessionId, { type: 'output', content: result.stdout.trimEnd() });
      }
      if (result.stderr) {
        addLine(sessionId, { type: 'error', content: result.stderr.trimEnd() });
      }
      if (!result.success && !result.stderr && !result.stdout) {
        addLine(sessionId, { type: 'error', content: `Command failed with exit code: ${result.exit_code}` });
      }
    } catch (error) {
      addLine(sessionId, {
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSessionRunning(sessionId, false);
    }
  }, [session, sessionId, addLine, setSessionRunning, updateSessionCwd, rootPath]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      executeShellCommand(inputValue);
      setInputValue('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '');
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInputValue('');
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      if (session?.isRunning) {
        setSessionRunning(sessionId, false);
      } else {
        setInputValue('');
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      useTerminalStore.getState().clearSession(sessionId);
    }
  };

  if (!session) return null;

  const cwd = session.cwd || rootPath || '';
  const promptSymbol = session.profile === 'bash' ? '$' : '>';

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden p-3"
      style={{ 
        backgroundColor: '#1e1e1e',
        fontFamily: '"Cascadia Code", "Cascadia Mono", "Consolas", "Courier New", monospace',
        fontSize: '13px',
        lineHeight: '1.5',
      }}
    >
      {/* Previous commands and output - fully selectable */}
      <div className="select-text">
        {session.lines.map(line => (
          <TerminalLineItem 
            key={line.id} 
            line={line} 
            cwd={cwd}
            profile={session.profile}
          />
        ))}
      </div>

      {/* Current input prompt - always at the bottom */}
      <div className="flex items-start whitespace-pre-wrap">
        <span className="text-[#569cd6] select-none">{cwd}</span>
        <span className="text-[#dcdcaa] select-none"> {promptSymbol}</span>
        <div className="flex-1 ml-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={session.isRunning}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent text-[#d4d4d4] outline-none caret-[#aeafad]"
            style={{ 
              fontFamily: 'inherit',
              fontSize: 'inherit',
              lineHeight: 'inherit',
            }}
          />
          {session.isRunning && (
            <span className="absolute right-0 top-0 text-[#569cd6] animate-pulse select-none">...</span>
          )}
        </div>
      </div>
    </div>
  );
};

// Resize Handle Component
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
        "h-[3px] cursor-ns-resize transition-colors flex-shrink-0",
        isDragging ? "bg-[#007acc]" : "bg-[#3c3c3c] hover:bg-[#007acc]"
      )}
    />
  );
};

// Main Terminal Panel Component
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

  const handleResize = useCallback((delta: number) => {
    setHeight(height + delta);
  }, [height, setHeight]);

  if (!isOpen) return null;

  return (
    <div className="flex flex-col border-t border-[#3c3c3c]" style={{ height }}>
      {/* Resize Handle */}
      <ResizeHandle onResize={handleResize} />

      {/* Tab Bar */}
      <div className="h-[35px] flex items-center justify-between px-2 bg-[#252526] border-b border-[#3c3c3c] flex-shrink-0">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {/* Terminal tabs */}
          <div className="flex items-center gap-1 min-w-0">
            {sessions.map(session => (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className={clsx(
                  'group flex items-center gap-1.5 px-3 py-1 text-[12px] rounded-sm transition-colors whitespace-nowrap',
                  session.id === activeSessionId
                    ? 'bg-[#1e1e1e] text-[#cccccc]'
                    : 'text-[#969696] hover:bg-[#2a2a2a] hover:text-[#cccccc]'
                )}
              >
                <ShellIcon profile={session.profile} className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{session.name}</span>
                {session.isRunning && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[#007acc] animate-pulse flex-shrink-0" />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(session.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 ml-1 p-0.5 hover:bg-[#3c3c3c] rounded transition-opacity flex-shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </button>
            ))}
          </div>

          {/* New Session Button with Dropdown */}
          <div className="relative flex-shrink-0" ref={profileMenuRef}>
            <button
              onClick={handlePlusClick}
              className="p-1.5 text-[#969696] hover:text-[#cccccc] hover:bg-[#2a2a2a] rounded transition-colors flex items-center gap-0.5"
              title="New Terminal"
            >
              <Plus className="w-4 h-4" />
              <ChevronDown className="w-3 h-3" />
            </button>

            {showProfileMenu && (
              <div className="absolute top-full left-0 mt-1 w-40 bg-[#252526] border border-[#3c3c3c] rounded shadow-xl z-[100] py-1">
                <button
                  onClick={() => handleNewSession('powershell')}
                  className="w-full px-3 py-1.5 text-left text-[12px] text-[#cccccc] hover:bg-[#094771] flex items-center gap-2"
                >
                  <TerminalIcon className="w-4 h-4" />
                  <span>PowerShell</span>
                </button>
                <button
                  onClick={() => handleNewSession('bash')}
                  className="w-full px-3 py-1.5 text-left text-[12px] text-[#cccccc] hover:bg-[#094771] flex items-center gap-2"
                >
                  <ShellIcon profile="bash" className="w-4 h-4" />
                  <span>Git Bash</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right side actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {activeSessionId && (
            <button
              onClick={() => useTerminalStore.getState().clearSession(activeSessionId)}
              className="p-1.5 text-[#969696] hover:text-[#cccccc] rounded hover:bg-[#2a2a2a] transition-colors"
              title="Clear (Ctrl+L)"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={closeTerminal}
            className="p-1.5 text-[#969696] hover:text-[#cccccc] rounded hover:bg-[#2a2a2a] transition-colors"
            title="Hide Terminal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Terminal Content */}
      {activeSessionId ? (
        <TerminalSession sessionId={activeSessionId} />
      ) : (
        <div 
          className="flex-1 flex items-center justify-center text-[#969696] text-[12px]"
          style={{ backgroundColor: '#1e1e1e' }}
        >
          No terminal session. Click + to create one.
        </div>
      )}
    </div>
  );
};
