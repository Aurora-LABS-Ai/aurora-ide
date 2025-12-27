import React from 'react';
import { X } from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import clsx from 'clsx';
import { FileIcon } from '../explorer/FileIcons';

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
          <FileIcon name={tab.filename} className="w-3 h-3" />
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
