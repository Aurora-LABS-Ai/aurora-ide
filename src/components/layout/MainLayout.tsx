import React from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TitleBar } from "./TitleBar";
import { StatusBar } from "./StatusBar";
import { FileExplorer } from "../explorer/FileExplorer";
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

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <PanelGroup direction="horizontal" id="main-panel-group">
            {/* Sidebar */}
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

            {/* Editor */}
            <Panel
              id="editor-panel"
              order={2}
              defaultSize={showChatPanel ? 57 : 82}
              minSize={30}
            >
              <EditorPanel />
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

        {/* Terminal Panel */}
        {isTerminalOpen && <TerminalPanel />}
      </div>

      <StatusBar />

      <SettingsPanel />
      <ToolApprovalModal />
      <AuditTimeline />
    </div>
  );
};
