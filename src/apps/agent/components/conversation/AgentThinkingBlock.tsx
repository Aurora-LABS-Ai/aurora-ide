/**
 * Agent Window — thinking / reasoning block [view].
 *
 * A collapsible reasoning log bracketed by a slim left rail. While the model
 * is reasoning it auto-expands, reads "Thinking…" and runs a clock; once done
 * it collapses to "Thought" followed by how long that took. Isolated — all
 * colour comes from `--agw-*`.
 *
 * That auto-expand is a DEFAULT, never a lock: clicking the header always wins,
 * so a live reasoning dump can be folded away mid-stream and stays folded. The
 * header keeps shimmering "Thinking…" and running its clock while collapsed, so
 * hiding the text never hides the fact that the model is still working.
 *
 * The duration sits ON the rule at a FIXED offset from the label (a short
 * `lead` stub, the number, then the rule resuming to the edge) rather than at
 * the rule's midpoint. A centred number moves with the available width, so it
 * lands somewhere different in the dock than in the full window and never
 * forms a column; anchored, every reasoning block in a turn puts its duration
 * at the same x and an expensive stretch is visible by scanning down.
 *
 * The live clock uses the SAME formatter as the settled value, so when
 * reasoning ends the number does not re-format or change width — it stops.
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { formatWorkedDuration } from "@/apps/agent/components/conversation/timeline";

const AgentThinkingBlockImpl: React.FC<{
  content: string;
  isGenerating?: boolean;
  /** Epoch ms of the first reasoning token — live segments only. */
  startedAt?: number;
  /** Settled wall-clock for the segment. Undefined = never measured. */
  durationMs?: number;
}> = ({ content, isGenerating = false, startedAt, durationMs }) => {
  // Three states, not two. `null` follows the automatic behaviour (open while
  // reasoning, shut once it settles); `true`/`false` is the user's own choice
  // and OUTRANKS it. A plain boolean OR'd with `isGenerating` made the toggle
  // dead for the whole time the model was thinking — exactly when a long
  // reasoning dump is most in the way and most worth folding out of sight.
  const [override, setOverride] = useState<boolean | null>(null);
  // Transcript → Reasoning "Folded" drops the auto-open; the header still
  // shimmers and ticks, and a click still opens it.
  const autoOpen = useAgentThemeStore((s) => s.transcriptReasoning === "live");
  const expanded = override ?? (autoOpen && isGenerating);
  const bodyRef = useRef<HTMLDivElement>(null);

  // A clock, not derived state: the interval only advances `now` and the
  // elapsed time is computed during render. Seeded at mount so the first paint
  // is already correct instead of blank for a second. Mirrors the turn chip.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isGenerating || startedAt === undefined) return;
    // One second is the smallest unit the label shows, so a faster tick would
    // re-render for nothing.
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isGenerating, startedAt]);

  // Follow the latest reasoning while it streams.
  useEffect(() => {
    if (expanded && isGenerating && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, expanded, isGenerating]);

  const elapsed =
    isGenerating && startedAt !== undefined ? Math.max(0, now - startedAt) : durationMs;
  // A span of exactly 0 is "measured as instant", not "unmeasured" — but it
  // renders as `<1s`, never `0s`. Only an ABSENT measurement drops the number,
  // which is what a legacy thread with no persisted duration produces.
  const showTime = elapsed !== undefined;

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        className="agw-think-toggle"
        aria-expanded={expanded}
        onClick={() => setOverride(!expanded)}
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
          {isGenerating ? "Thinking…" : "Thought"}
        </span>
        {showTime ? (
          <>
            <span className="agw-timeline-rule agw-rule-lead" aria-hidden="true" />
            <span className="agw-think-time">{formatWorkedDuration(elapsed)}</span>
            <span className="agw-timeline-rule agw-rule-tail" aria-hidden="true" />
          </>
        ) : (
          <span className="agw-timeline-rule" aria-hidden="true" />
        )}
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
 * turn streams, so skip their re-render per streamed frame (strings, numbers
 * and a bool → default shallow compare is exact).
 */
export const AgentThinkingBlock = React.memo(AgentThinkingBlockImpl);
