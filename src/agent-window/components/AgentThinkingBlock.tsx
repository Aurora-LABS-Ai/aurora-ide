/**
 * Agent Window — thinking / reasoning block [view].
 *
 * Mirrors the IDE chat's `ThinkingBlock`: a collapsible reasoning log bracketed
 * by a slim left rail. While the model is reasoning it auto-expands and reads
 * "Thinking…"; once done it collapses to a quiet "Reasoning" toggle. Isolated —
 * all colour comes from `--agw-*`.
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";

const AgentThinkingBlockImpl: React.FC<{
  content: string;
  isGenerating?: boolean;
}> = ({ content, isGenerating = false }) => {
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const expanded = isGenerating || manuallyExpanded;
  const bodyRef = useRef<HTMLDivElement>(null);

  // Follow the latest reasoning while it streams.
  useEffect(() => {
    if (expanded && isGenerating && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, expanded, isGenerating]);

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        className="agw-think-toggle"
        aria-expanded={expanded}
        onClick={() => setManuallyExpanded((v) => !v)}
      >
        <AgentIcon
          name="chevron-down"
          size={12}
          style={{
            transform: expanded ? "none" : "rotate(-90deg)",
            transition: "transform 0.15s ease",
            color: "var(--agw-text-subtle)",
          }}
        />
        <span
          className={isGenerating ? "agw-think-label agw-shimmer" : "agw-think-label"}
          style={isGenerating ? undefined : { color: "var(--agw-text-subtle)" }}
        >
          {isGenerating ? "Thinking…" : "Reasoning"}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="rail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div className="agw-think-rail">
              <div ref={bodyRef} className="agw-think-body agw-scroll">
                <pre className="agw-code agw-think-pre">
                  {content || "…"}
                </pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/**
 * Memoized: completed reasoning segments never change while the rest of the
 * turn streams, so skip their re-render per streamed frame (string + bool
 * props → default shallow compare is exact).
 */
export const AgentThinkingBlock = React.memo(AgentThinkingBlockImpl);
