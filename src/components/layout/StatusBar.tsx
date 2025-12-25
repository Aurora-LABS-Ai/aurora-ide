import React from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useTerminalStore } from '../../store/useTerminalStore';
import { Circle, Terminal } from 'lucide-react';
import clsx from 'clsx';

export const StatusBar: React.FC = () => {
  const { tabs, activeTabId } = useEditorStore();
  const { toggleTerminal, isOpen: isTerminalOpen, sessions } = useTerminalStore();
  const activeTab = tabs.find(t => t.id === activeTabId);
  
  // Check if any session is running
  const hasRunningProcess = sessions.some(s => s.isRunning);

  return (
    <div className="h-[22px] bg-statusbar border-t border-border flex items-center justify-between px-2 text-[11px] text-text-secondary select-none">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Circle className="w-2 h-2 fill-success text-success" />
          <span>Ready</span>
        </div>

        {/* Terminal Toggle */}
        <button
          onClick={toggleTerminal}
          className={clsx(
            "flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors",
            isTerminalOpen
              ? "bg-primary/20 text-primary"
              : "hover:bg-input text-text-secondary hover:text-text-primary"
          )}
          title="Toggle Terminal (Ctrl+`)"
        >
          <Terminal className="w-3 h-3" />
          <span>Terminal</span>
          {hasRunningProcess && (
            <div className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
          )}
        </button>
      </div>
      
      <div className="flex items-center gap-3">
        {activeTab && (
          <>
            <span>Ln 1, Col 1</span>
            <span>UTF-8</span>
            <span>{activeTab.language === 'typescript' ? 'TypeScript' : activeTab.language}</span>
          </>
        )}
      </div>
    </div>
  );
};
