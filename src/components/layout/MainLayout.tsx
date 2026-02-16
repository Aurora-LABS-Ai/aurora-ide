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

import React, { useState, useCallback, useMemo } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TitleBar } from "./TitleBar";
import { StatusBar } from "./StatusBar";
import { ActivityBar, type SidebarPanel } from "./ActivityBar";
import { MemoizedFileExplorer as FileExplorer } from "../explorer/FileExplorer";
import { GitPanel } from "../git/GitPanel";
import { SearchPanel } from "../search/SearchPanel";
import { EditorPanel } from "../editor/EditorPanel";
import { ChatPanel } from "../chat/ChatPanel";
import { SettingsPanel } from "../modals/SettingsPanel";
import { ToolApprovalModal } from "../modals/ToolApprovalModal";
import { AuditTimeline } from "../modals/AuditTimeline";
import { TerminalPanel } from "../terminal/Terminal";
import { ThemePanel } from "../theme/ThemePanel";
import { AgentModeLayout } from "../agent";
import { useUiStore } from "../../store/useUiStore";
import { useRustChatSync } from "../../hooks/useRustChatSync";
import { useTerminalStore } from "../../store/useTerminalStore";
import { useGitStore } from "../../store/useGitStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";

export const MainLayout: React.FC = () => {
  const { isChatOpen, detachedChat, setSettingsOpen, isSidebarOpen, toggleSidebar, isAgentMode } = useUiStore();
  const { isOpen: isTerminalOpen } = useTerminalStore();
  const status = useGitStore((state) => state.status);
  const initializeGit = useGitStore((state) => state.initialize);
  const resetGit = useGitStore((state) => state.reset);
  const rootPath = useWorkspaceStore((state) => state.rootPath);

  // Sidebar panel state
  const [activePanel, setActivePanel] = useState<SidebarPanel>('explorer');

  // Initialize Rust-based cross-window state sync (bulletproof)
  useRustChatSync();

  // Global Shortcut for Sidebar Toggle
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  // Initialize git state as soon as a workspace is available.
  // This keeps source-control status in sync before the Git panel is opened.
  React.useEffect(() => {
    if (rootPath) {
      void initializeGit(rootPath);
      return;
    }

    resetGit();
  }, [rootPath, initializeGit, resetGit]);

  // Show chat panel only if it's open AND not detached
  const showChatPanel = isChatOpen && !detachedChat.isDetached;

  // Calculate git badge count (staged + unstaged + untracked)
  const gitBadgeCount = status
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : undefined;

  const handleSettingsClick = useCallback(() => {
    setSettingsOpen(true);
  }, [setSettingsOpen]);

  // Calculate center panel size based on sidebar and chat visibility
  const centerPanelDefaultSize = useMemo(() => {
    if (isAgentMode) return 82;
    if (!showChatPanel) return 100; // No chat panel, center panel gets full width
    // With chat panel shown, calculate center panel size
    // Chat panel always stays at 25%, center panel gets the rest
    // When sidebar is open (18%): center panel = 100% - 18% - 25% = 57%
    // When sidebar is closed (0%): center panel = 100% - 0% - 25% = 75%
    return isSidebarOpen ? 57 : 75;
  }, [isAgentMode, showChatPanel, isSidebarOpen]);

  return (
    <div className="h-full flex flex-col bg-editor text-text-primary overflow-hidden">
      <TitleBar />

      {/* Main horizontal layout */}
      <div className="flex-1 flex min-h-0">
        {/* Activity Bar (VS Code-style icon strip) - Always visible */}
        <ActivityBar
          activePanel={activePanel}
          onPanelChange={setActivePanel}
          onSettingsClick={handleSettingsClick}
          gitBadgeCount={gitBadgeCount}
        />

        <PanelGroup direction="horizontal" id="main-panel-group">
          {/* Sidebar Content (Explorer / Git / Search) - Always visible when open */}
          {isSidebarOpen && (
            <>
              <Panel
                id="explorer-panel"
                order={1}
                defaultSize={18}
                minSize={12}
                maxSize={25}
                className="bg-sidebar"
              >
                {activePanel === 'explorer' && <FileExplorer />}
                {activePanel === 'git' && <GitPanel />}
                {activePanel === 'search' && <SearchPanel />}
                {activePanel === 'theme' && <ThemePanel />}
              </Panel>

              <PanelResizeHandle className="w-[1px] bg-border hover:bg-primary transition-colors" />
            </>
          )}

          {/* Center area: Editor/Agent + Terminal stacked vertically */}
          <Panel
            id="center-panel"
            order={2}
            defaultSize={centerPanelDefaultSize}
            minSize={30}
          >
            <div className="h-full flex flex-col">
              {/* Main content area */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {isAgentMode ? (
                  <AgentModeLayout />
                ) : (
                  <EditorPanel />
                )}
              </div>

              {/* Terminal at bottom - works in both modes */}
              {isTerminalOpen && <TerminalPanel />}
            </div>
          </Panel>

          {/* Chat panel - only in normal mode */}
          {!isAgentMode && showChatPanel && (
            <>
              <PanelResizeHandle className="w-[1px] bg-border hover:bg-primary transition-colors" />

              <Panel
                id="chat-panel"
                order={3}
                defaultSize={25}
                minSize={20}
                maxSize={40}
                className="bg-sidebar"
              >
                <ChatPanel />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      <StatusBar />

      <SettingsPanel />
      <ToolApprovalModal />
      <AuditTimeline />
    </div>
  );
};
