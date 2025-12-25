import React from 'react';
import { X } from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import clsx from 'clsx';
import { FileCode, FileJson, FileText, File } from 'lucide-react';

const getFileIcon = (name: string) => {
  if (name.endsWith('.tsx') || name.endsWith('.ts')) return <FileCode className="w-3 h-3 text-[#519aba]" />;
  if (name.endsWith('.css')) return <FileCode className="w-3 h-3 text-[#563d7c]" />;
  if (name.endsWith('.json')) return <FileJson className="w-3 h-3 text-warning" />;
  if (name.endsWith('.md')) return <FileText className="w-3 h-3 text-[#519aba]" />;
  return <File className="w-3 h-3 text-text-secondary" />;
};

export const TabBar: React.FC = () => {
  const { tabs, activeTabId, setActiveTab, closeTab } = useEditorStore();

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
          {getFileIcon(tab.filename)}
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
    </div>
  );
};
