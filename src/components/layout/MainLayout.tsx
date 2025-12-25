import React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { FileExplorer } from '../explorer/FileExplorer';
import { EditorPanel } from '../editor/EditorPanel';
import { ChatPanel } from '../chat/ChatPanel';
import { SettingsPanel } from '../modals/SettingsPanel';
import { ToolApprovalModal } from '../modals/ToolApprovalModal';
import { AuditTimeline } from '../modals/AuditTimeline';
import { useUiStore } from '../../store/useUiStore';

export const MainLayout: React.FC = () => {
  const { isChatOpen } = useUiStore();

  return (
    <div className="h-screen flex flex-col bg-editor text-text-primary overflow-hidden">
      <TitleBar />
      
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* Sidebar */}
          <Panel defaultSize={18} minSize={12} maxSize={25} className="bg-sidebar">
            <FileExplorer />
          </Panel>
          
          <PanelResizeHandle className="w-[1px] bg-border hover:bg-primary transition-colors" />
          
          {/* Editor */}
          <Panel defaultSize={isChatOpen ? 57 : 82} minSize={30}>
            <EditorPanel />
          </Panel>
          
          {isChatOpen && (
            <>
              <PanelResizeHandle className="w-[1px] bg-border hover:bg-primary transition-colors" />
              
              {/* Chat */}
              <Panel defaultSize={25} minSize={20} maxSize={40} className="bg-sidebar">
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
