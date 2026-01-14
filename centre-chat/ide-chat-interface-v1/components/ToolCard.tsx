import React, { useState } from 'react';
import { ToolAction } from '../types';

interface ToolCardProps {
  action: ToolAction;
}

const ToolCard: React.FC<ToolCardProps> = ({ action }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div 
      className={`tool-card group relative flex flex-col rounded-2xl border transition-all duration-300 overflow-hidden
        ${isOpen 
          ? 'bg-white/10 border-white/20 dark:bg-white/10 dark:border-white/20' 
          : 'bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-white/80 dark:hover:bg-white/10'
        } backdrop-blur-md cursor-pointer`}
      onClick={() => setIsOpen(!isOpen)}
    >
      {/* Header Row */}
      <div className="flex items-center justify-between pl-3 pr-2 py-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-2 shrink-0">
            <span className="material-symbols-rounded text-base text-blue-500 dark:text-cyan-400">
              {action.icon}
            </span>
            <span className="font-mono text-[13px] font-medium text-gray-800 dark:text-gray-200">
              {action.toolName}
            </span>
          </div>
          <div className="w-px h-3 bg-gray-300 dark:bg-white/20 shrink-0"></div>
          <span className="font-mono text-xs text-gray-500 dark:text-gray-400 truncate flex-1">
            {action.args}
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          {action.status === 'pending' ? (
            <span className="material-icons-round text-base text-yellow-500 animate-spin">
              sync
            </span>
          ) : (
             <span className="material-icons-round text-base text-primary dark:text-cyan-400 neon-glow">
              check_circle
            </span>
          )}
          <span className={`material-icons-round text-gray-400 text-sm transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </div>
      </div>

      {/* Dropdown Content */}
      <div 
        className={`grid transition-all duration-300 ease-in-out ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pt-0">
            <div className="bg-gray-100 dark:bg-black/30 rounded-lg p-2.5 font-mono text-[11px] leading-relaxed text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-white/5">
              <div className="flex justify-between items-center mb-1 pb-1 border-b border-gray-200 dark:border-white/10 opacity-70">
                <span>INPUT</span>
                <span className="uppercase text-[9px]">{action.status}</span>
              </div>
              <div className="mb-2">
                <span className="text-blue-500 dark:text-cyan-500">{action.toolName}</span>
                <span className="text-gray-400">({action.args})</span>
              </div>
              
              <div className="flex justify-between items-center mb-1 pb-1 border-b border-gray-200 dark:border-white/10 opacity-70 mt-3">
                <span>OUTPUT</span>
              </div>
              <div className="whitespace-pre-wrap">
                {action.result || "No output available."}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ToolCard;