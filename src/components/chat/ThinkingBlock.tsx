import React, { useState, useEffect } from 'react';
import { ChevronRight, Loader2, Brain } from 'lucide-react';
import clsx from 'clsx';

interface ThinkingBlockProps {
  content: string;
  isGenerating?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isGenerating }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // Auto-expand when generating starts, auto-collapse when done
  useEffect(() => {
    if (isGenerating) {
      setIsExpanded(true);
    } else {
      // Auto-collapse when thinking is done
      setIsExpanded(false);
    }
  }, [isGenerating]);

  return (
    <div className="my-1">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={clsx(
          "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors",
          "border border-border hover:bg-input/50",
          isGenerating ? "text-primary" : "text-text-secondary"
        )}
      >
        {isGenerating ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Brain className="w-3 h-3 text-text-disabled" />
        )}
        <span>{isGenerating ? 'Thinking...' : 'Thought Process'}</span>
        <ChevronRight className={clsx(
          "w-3 h-3 transition-transform",
          isExpanded && "rotate-90"
        )} />
      </button>

      {isExpanded && (
        <div className="mt-1 pl-3 border-l-2 border-primary/20 ml-1 max-h-40 overflow-y-auto scrollbar-thin">
          <p className="text-[11px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </p>
        </div>
      )}
    </div>
  );
};
