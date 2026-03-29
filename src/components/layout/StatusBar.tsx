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

import React from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useTerminalStore } from '../../store/useTerminalStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUiStore } from '../../store/useUiStore';
import { Terminal, Sparkles, FolderOpen, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

export const StatusBar: React.FC = () => {
  const { tabs, activeTabId } = useEditorStore();
  const { toggleTerminal, isOpen: isTerminalOpen, sessions } = useTerminalStore();
  const getLLMConfig = useSettingsStore((s) => s.getLLMConfig);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const activeTab = tabs.find(t => t.id === activeTabId);
  
  const hasRunningProcess = sessions.some(s => s.isRunning);
  const llmConfig = getLLMConfig();
  const providerReady = llmConfig !== null;
  const workspaceName = rootPath ? rootPath.split(/[/\\]/).pop() : null;

  return (
    <div className="h-[22px] bg-statusbar border-t border-border flex items-center justify-between px-2 text-[11px] text-text-secondary select-none">
      <div className="flex items-center gap-3">
        {/* Provider status */}
        <button
          onClick={() => !providerReady && setSettingsOpen(true)}
          className={clsx(
            "flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors",
            providerReady
              ? "text-text-secondary"
              : "text-warning hover:bg-input cursor-pointer"
          )}
          title={providerReady ? `Provider: ${llmConfig.name} (${llmConfig.model})` : "No AI provider configured — click to set up"}
        >
          {providerReady ? (
            <>
              <Sparkles className="w-2.5 h-2.5 text-primary" />
              <span className="truncate max-w-[120px]">{llmConfig.name}</span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-2.5 h-2.5" />
              <span>No Provider</span>
            </>
          )}
        </button>

        <span className="text-border">|</span>

        {/* Workspace status */}
        <div className="flex items-center gap-1.5" title={rootPath || 'No workspace open'}>
          <FolderOpen className="w-2.5 h-2.5" />
          <span className="truncate max-w-[120px]">{workspaceName || 'No Workspace'}</span>
        </div>

        <span className="text-border">|</span>

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
