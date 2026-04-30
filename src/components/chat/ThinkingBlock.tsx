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

import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, BrainCircuit } from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';

interface ThinkingBlockProps {
  content: string;
  isGenerating?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isGenerating }) => {
  const [isManuallyExpanded, setIsManuallyExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const isExpanded = Boolean(isGenerating) || isManuallyExpanded;

  useEffect(() => {
    if (!isExpanded || !isGenerating || !contentRef.current) {
      return;
    }

    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [content, isExpanded, isGenerating]);

  // Indent-guide styling mirrors src/components/explorer/tree-node/TreeNodeRow.tsx
  // (1px width, --aurora-editor-indent-guide colour, ~0.42 opacity). Keeping
  // the values in sync makes the dropdown feel like a natural sibling of the
  // file-tree's vertical guide rails — same visual vocabulary.
  const guideStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: "var(--aurora-editor-indent-guide, #404040)",
    opacity: 0.42,
    pointerEvents: "none",
  };

  return (
    // No wrapper background, no border, no rounded shell. The dropdown is
    // structured purely by the two slim vertical guide lines that bracket the
    // expanded body — see the inline comments below.
    <div className="my-1.5 ml-3">
      <button
        onClick={() => setIsManuallyExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="flex items-center gap-2 -mx-1 px-1 py-1 rounded text-xs font-medium outline-none text-left transition-colors hover:bg-sidebar-item-hover/30"
      >
        <div
          className={clsx(
            "flex items-center justify-center w-4 h-4 rounded-full transition-colors",
            isGenerating
              ? "bg-primary/15 text-primary"
              : "bg-input/40 text-text-secondary",
          )}
        >
          {isGenerating ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <BrainCircuit size={12} />
          )}
        </div>

        <span
          className={clsx(
            // Slightly larger so the label reads as a real heading without a
            // wrapper to lean on.
            "text-[12px] transition-colors",
            isGenerating ? "text-primary animate-pulse" : "text-text-secondary",
          )}
        >
          {isGenerating ? "Thinking..." : "Process Log"}
        </span>

        <ChevronRight
          size={12}
          className={clsx(
            "text-text-disabled transition-transform",
            isExpanded && "rotate-90",
          )}
        />
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            {/* Bracketed content area. The two absolute 1px lines are the
                ONLY structural decoration — no fill, no border-top, no
                rounded shell. Padding creates breathing room between the
                guides and the text so the lines read as rails, not as a
                column rule. */}
            <div className="relative">
              {/* Left rail */}
              <div aria-hidden style={{ ...guideStyle, left: 0 }} />
              {/* Right rail */}
              <div aria-hidden style={{ ...guideStyle, right: 0 }} />

              <div
                ref={contentRef}
                className="max-h-[300px] overflow-y-auto overflow-x-hidden px-4 py-2 scrollbar-thin scrollbar-thumb-scrollbar scrollbar-track-transparent"
              >
                {/* Bumped from 10px → 12px so the body text actually reads,
                    and leading widened a touch to compensate for the larger
                    glyphs (otherwise multi-line thoughts feel cramped). */}
                <pre className="font-mono text-[12px] text-text-secondary leading-[1.55] whitespace-pre-wrap break-words">
                  {content || (
                    <span className="italic opacity-50">Initializing...</span>
                  )}
                </pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
