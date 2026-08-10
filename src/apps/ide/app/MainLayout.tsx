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
 * See: src/kernel/types/theme.ts for TypeScript interfaces
 * See: src/apps/ide/services/theme-service.ts for theme utilities
 */

import React, { useState, useCallback } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TitleBar } from "./TitleBar";
import { StatusBar } from "./StatusBar";
import { ActivityBar, type SidebarPanel } from "./ActivityBar";
import { MemoizedFileExplorer as FileExplorer } from "@/apps/ide/features/explorer/FileExplorer";
import { GitPanel } from "@/apps/ide/features/git/GitPanel";
import { SearchPanel } from "@/apps/ide/features/search/SearchPanel";
import { EditorPanel } from "@/apps/ide/features/editor/EditorPanel";
import { SettingsPanel } from "@/apps/ide/features/settings/SettingsPanel";
import { TerminalPanel } from "@/apps/ide/features/terminal/Terminal";
import { ThemePanel } from "@/apps/ide/features/theme/ThemePanel";
import { useUiStore } from "@/apps/ide/store/useUiStore";
import { useTerminalStore } from "@/apps/ide/store/useTerminalStore";
import { useGitStore } from "@/kernel/store/useGitStore";
import { useWorkspaceStore } from "@/kernel/store/useWorkspaceStore";

export const MainLayout: React.FC = () => {
  const { setSettingsOpen, isSidebarOpen, toggleSidebar } = useUiStore();
  const { isOpen: isTerminalOpen } = useTerminalStore();
  const status = useGitStore((state) => state.status);
  const initializeGit = useGitStore((state) => state.initialize);
  const resetGit = useGitStore((state) => state.reset);
  const rootPath = useWorkspaceStore((state) => state.rootPath);

  // Sidebar panel state
  const [activePanel, setActivePanel] = useState<SidebarPanel>("explorer");

  // Global Shortcut for Sidebar Toggle
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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

  // Calculate git badge count (staged + unstaged + untracked)
  const gitBadgeCount = status
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : undefined;

  const handleSettingsClick = useCallback(() => {
    setSettingsOpen(true);
  }, [setSettingsOpen]);

  // The agent now lives in its own window, so the editor column always
  // takes the full width left over by the sidebar.
  const centerPanelDefaultSize = 100;

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
                style={{
                  background:
                    "color-mix(in srgb, var(--aurora-sidebar-background) 88%, var(--aurora-editor-background) 12%)",
                }}
              >
                {activePanel === "explorer" && <FileExplorer />}
                {activePanel === "git" && <GitPanel />}
                {activePanel === "search" && <SearchPanel />}
                {activePanel === "theme" && <ThemePanel />}
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
                <EditorPanel />
              </div>

              {/* Terminal at bottom - works in both modes */}
              {isTerminalOpen && <TerminalPanel />}
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <StatusBar />

      <SettingsPanel />
    </div>
  );
};
