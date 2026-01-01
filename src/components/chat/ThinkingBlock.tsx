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
          "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium w-full",
          "transition-all duration-300 group glass-light border",
          isGenerating
            ? "border-transparent bg-[var(--aurora-common-primary)]/[0.05]"
            : "border-transparent hover:border-[var(--aurora-common-border)]/50 hover:glass-medium"
        )}
      >
        <div className={clsx(
          "flex items-center justify-center w-5 h-5 rounded transition-all",
          isGenerating
            ? "bg-[var(--aurora-common-primary)]/15"
            : "bg-[var(--aurora-chat-surface)] group-hover:bg-[var(--aurora-chat-surface)]/80"
        )}>
          {isGenerating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--aurora-common-primary)' }} />
          ) : (
            <Sparkles className="w-3.5 h-3.5 text-[var(--aurora-sidebar-foreground)]" />
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
              <div className="absolute -left-[5px] top-0 w-2 h-2 rounded-full bg-border ring-4 ring-sidebar" />

              <div className="bg-editor rounded-md border border-border p-3 overflow-x-auto">
                <p className="font-mono text-[11px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
                  {content || <span className="text-text-disabled italic">Thinking...</span>}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
