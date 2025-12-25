import React from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { Circle } from 'lucide-react';

export const StatusBar: React.FC = () => {
  const { tabs, activeTabId } = useEditorStore();
  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div className="h-[22px] bg-statusbar border-t border-border flex items-center justify-between px-2 text-[11px] text-text-secondary select-none">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Circle className="w-2 h-2 fill-success text-success" />
          <span>Ready</span>
        </div>
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
