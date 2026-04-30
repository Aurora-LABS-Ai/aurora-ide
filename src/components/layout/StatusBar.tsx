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
import { SquareTerminal, Bot, FolderTree, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { AppIcon } from '../ui/AppIcon';

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

  const StatusDivider: React.FC = () => (
    <span
      aria-hidden
      className="block h-[12px] w-[1px]"
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
      }}
    />
  );

  const statusButtonClass =
    'flex items-center gap-1.5 px-2 h-[18px] rounded-[4px] transition-colors';

  return (
    <div
      className="h-[24px] flex items-center justify-between px-2 text-[11px] text-text-secondary select-none"
      style={{
        backgroundColor: 'var(--aurora-statusBar-background, var(--aurora-title-bar-background))',
        borderTop:
          '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
      }}
    >
      <div className="flex items-center gap-2">
        {/* Provider status */}
        <button
          onClick={() => !providerReady && setSettingsOpen(true)}
          className={clsx(
            statusButtonClass,
            providerReady
              ? 'text-text-secondary hover:text-text-primary hover:bg-input/40'
              : 'text-warning hover:bg-input cursor-pointer',
          )}
          title={
            providerReady
              ? `Provider: ${llmConfig.name} (${llmConfig.model})`
              : 'No AI provider configured — click to set up'
          }
        >
          {providerReady ? (
            <>
              <AppIcon icon={Bot} size={10} className="text-primary" />
              <span className="truncate max-w-[120px]">{llmConfig.name}</span>
            </>
          ) : (
            <>
              <AppIcon icon={AlertTriangle} size={10} />
              <span>No Provider</span>
            </>
          )}
        </button>

        <StatusDivider />

        {/* Workspace status */}
        <div
          className={clsx(statusButtonClass, 'text-text-secondary')}
          title={rootPath || 'No workspace open'}
        >
          <AppIcon icon={FolderTree} size={10} />
          <span className="truncate max-w-[140px]">
            {workspaceName || 'No Workspace'}
          </span>
        </div>

        <StatusDivider />

        {/* Terminal Toggle */}
        <button
          onClick={toggleTerminal}
          className={clsx(
            statusButtonClass,
            isTerminalOpen
              ? 'bg-primary/15 text-primary'
              : 'hover:bg-input/40 text-text-secondary hover:text-text-primary',
          )}
          title="Toggle Terminal (Ctrl+`)"
        >
          <AppIcon icon={SquareTerminal} size={11} />
          <span>Terminal</span>
          {hasRunningProcess && (
            <div className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
          )}
        </button>
      </div>

      <div className="flex items-center gap-2">
        {activeTab && (
          <>
            <span className={clsx(statusButtonClass, 'cursor-default')}>
              Ln 1, Col 1
            </span>
            <StatusDivider />
            <span className={clsx(statusButtonClass, 'cursor-default')}>
              Spaces: 2
            </span>
            <StatusDivider />
            <span className={clsx(statusButtonClass, 'cursor-default')}>UTF-8</span>
            <StatusDivider />
            <span
              className={clsx(statusButtonClass, 'cursor-default text-text-primary')}
            >
              {activeTab.language === 'typescript'
                ? 'TypeScript'
                : activeTab.language === 'javascript'
                  ? 'JavaScript'
                  : activeTab.language === 'typescriptreact'
                    ? 'TSX'
                    : activeTab.language === 'javascriptreact'
                      ? 'JSX'
                      : activeTab.language}
            </span>
          </>
        )}
      </div>
    </div>
  );
};
