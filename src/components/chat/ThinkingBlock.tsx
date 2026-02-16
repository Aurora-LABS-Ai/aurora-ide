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
    <div
      className="my-1 ml-3 rounded-xl border border-border bg-surface/60 overflow-hidden"
      style={{
        background: 'color-mix(in srgb, var(--aurora-chat-surface) 92%, transparent)',
      }}
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium w-full outline-none text-left transition-colors hover:bg-sidebar-item-hover/30"
      >
        <div className={clsx(
          "flex items-center justify-center w-4 h-4 rounded-full transition-colors",
          isGenerating ? "bg-primary/15 text-primary" : "bg-input/40 text-text-secondary"
        )}>
          {isGenerating ? <Loader2 size={12} className="animate-spin" /> : <BrainCircuit size={12} />}
        </div>

        <span className={clsx(
          "text-[11px] transition-colors",
          isGenerating ? "text-primary animate-pulse" : "text-text-secondary"
        )}>
          {isGenerating ? 'Thinking...' : 'Process Log'}
        </span>

        <ChevronRight size={10} className={clsx(
          "text-text-disabled transition-transform ml-auto",
          isExpanded && "rotate-90"
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
            <div className="border-t border-border/60 bg-input/25 px-3 py-2">
              <p className="font-mono text-[10px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
                {content || <span className="italic opacity-50">Initializing...</span>}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
