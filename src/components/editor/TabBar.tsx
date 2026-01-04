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
import { X, Globe, Plus } from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import clsx from 'clsx';
import { FileIcon } from '../explorer/FileIcons';

export const TabBar: React.FC = () => {
  const { tabs, activeTabId, setActiveTab, closeTab, openBrowserTab } = useEditorStore();

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-[28px] bg-tabs overflow-x-auto overflow-y-hidden scrollbar-none">
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={clsx(
            "flex items-center gap-1.5 px-2.5 cursor-pointer select-none group border-r border-border shrink-0",
            activeTabId === tab.id
              ? "bg-tabs-active text-text-primary"
              : "bg-tabs text-text-secondary hover:text-text-primary"
          )}
          onClick={() => setActiveTab(tab.id)}
        >
          {tab.type === 'browser' ? (
            <Globe className="w-3 h-3 text-blue-400" />
          ) : (
            <FileIcon name={tab.filename} className="w-3 h-3" />
          )}
          <span className="text-[12px] truncate max-w-[120px]">
            {tab.filename}
          </span>
          {tab.isDirty && <div className="w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:hidden" />}
          <button
            className={clsx(
              "p-0.5 rounded hover:bg-border opacity-0 group-hover:opacity-100 transition-opacity",
              tab.isDirty && "group-hover:block"
            )}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
            }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      
      {/* New Browser Tab Button */}
      <button
        onClick={() => openBrowserTab()}
        className="flex items-center justify-center w-7 h-full hover:bg-tabs-active transition-colors shrink-0"
        title="Open Browser Tab (Preview localhost)"
      >
        <Plus className="w-3.5 h-3.5 text-text-secondary hover:text-text-primary" />
      </button>
    </div>
  );
};
