import React, { useState, useEffect } from 'react';
import { ChevronRight, Loader2, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';

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
    <div className="my-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={clsx(
          "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 group w-full",
          "border border-transparent hover:bg-white/[0.03]",
          isGenerating
            ? "text-primary bg-primary/[0.05] border-primary/10"
            : "text-zinc-500 hover:text-zinc-300"
        )}
      >
        <div className={clsx(
          "flex items-center justify-center w-5 h-5 rounded-md transition-colors",
          isGenerating ? "bg-primary/10" : "bg-white/5 group-hover:bg-white/10"
        )}>
          {isGenerating ? (
            <Loader2 className="w-3 h-3 animate-spin text-primary" />
          ) : (
            <Sparkles className="w-3 h-3 text-zinc-500 group-hover:text-zinc-300" />
          )}
        </div>

        <div className="flex flex-col items-start flex-1">
          <span className={clsx(
            "leading-none",
            isGenerating && "animate-pulse"
          )}>
            {isGenerating ? 'Analyzing request...' : 'Thought Process'}
          </span>
        </div>

        <ChevronRight className={clsx(
          "w-3.5 h-3.5 transition-transform duration-200 opacity-50 group-hover:opacity-100",
          isExpanded && "rotate-90"
        )} />
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 ml-2 pl-4 border-l-2 border-white/5 relative">
              {/* Decorative timeline dot */}
              <div className="absolute -left-[5px] top-0 w-2 h-2 rounded-full bg-zinc-800 ring-4 ring-[#111111]" />

              <div className="bg-[#0a0a0a] rounded-md border border-white/5 p-3 overflow-x-auto">
                <p className="font-mono text-[11px] text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
                  {content || <span className="text-zinc-600 italic">Thinking...</span>}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
