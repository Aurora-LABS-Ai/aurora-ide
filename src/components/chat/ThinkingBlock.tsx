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

import React, { useState, useEffect } from 'react';
import { ChevronRight, Loader2, BrainCircuit } from 'lucide-react';
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
      setIsExpanded(false);
    }
  }, [isGenerating]);

  return (
    <div className="py-2 pl-3 group">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs font-medium w-full outline-none text-left"
      >
        <div className={clsx(
          "flex items-center justify-center w-4 h-4 rounded-full transition-colors",
          isGenerating ? "text-[var(--aurora-common-primary)]" : "text-text-disabled group-hover:text-text-secondary"
        )}>
          {isGenerating ? <Loader2 size={12} className="animate-spin" /> : <BrainCircuit size={12} />}
        </div>

        <span className={clsx(
          "text-[11px] transition-colors",
          isGenerating ? "text-[var(--aurora-common-primary)] animate-pulse" : "text-text-disabled group-hover:text-text-secondary"
        )}>
          {isGenerating ? 'Thinking...' : 'Process Log'}
        </span>

        <ChevronRight size={10} className={clsx(
          "text-text-disabled transition-transform opacity-0 group-hover:opacity-100",
          isExpanded && "rotate-90 opacity-100"
        )} />
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-1 ml-2 pl-3 border-l border-white/10">
              <p className="font-mono text-[10px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words py-1 opacity-80">
                {content || <span className="italic opacity-50">Initializing...</span>}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
