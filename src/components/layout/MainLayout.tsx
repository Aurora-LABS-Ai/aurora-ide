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

import React from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TitleBar } from "./TitleBar";
import { StatusBar } from "./StatusBar";
import { MemoizedFileExplorer as FileExplorer } from "../explorer/FileExplorer";
import { EditorPanel } from "../editor/EditorPanel";
import { ChatPanel } from "../chat/ChatPanel";
import { SettingsPanel } from "../modals/SettingsPanel";
import { ToolApprovalModal } from "../modals/ToolApprovalModal";
import { AuditTimeline } from "../modals/AuditTimeline";
import { TerminalPanel } from "../terminal/Terminal";
import { useUiStore } from "../../store/useUiStore";
import { useRustChatSync } from "../../hooks/useRustChatSync";
import { useTerminalStore } from "../../store/useTerminalStore";

export const MainLayout: React.FC = () => {
  const { isChatOpen, detachedChat } = useUiStore();
  const { isOpen: isTerminalOpen } = useTerminalStore();

  // Initialize Rust-based cross-window state sync (bulletproof)
  useRustChatSync();

  // Show chat panel only if it's open AND not detached
  const showChatPanel = isChatOpen && !detachedChat.isDetached;

  return (
    <div className="h-screen flex flex-col bg-editor text-text-primary overflow-hidden">
      <TitleBar />

      {/* Main horizontal layout */}
      <div className="flex-1 flex min-h-0">
        <PanelGroup direction="horizontal" id="main-panel-group">
          {/* Sidebar / Explorer */}
          <Panel
            id="explorer-panel"
            order={1}
            defaultSize={18}
            minSize={12}
            maxSize={25}
            className="bg-sidebar"
          >
            <FileExplorer />
          </Panel>

          <PanelResizeHandle className="w-[1px] bg-border hover:bg-primary transition-colors" />

          {/* Center area: Editor + Terminal stacked vertically */}
          <Panel
            id="center-panel"
            order={2}
            defaultSize={showChatPanel ? 57 : 82}
            minSize={30}
          >
            <div className="h-full flex flex-col">
              {/* Editor takes remaining space */}
              <div className="flex-1 min-h-0 overflow-hidden">
                <EditorPanel />
              </div>
              
              {/* Terminal at bottom of center area */}
              {isTerminalOpen && <TerminalPanel />}
            </div>
          </Panel>

          {showChatPanel && (
            <>
              <PanelResizeHandle className="w-[1px] bg-border hover:bg-primary transition-colors" />

              {/* Chat */}
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
