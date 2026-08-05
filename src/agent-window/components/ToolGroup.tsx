/**
 * Agent Window — grouped tool calls [view].
 *
 * Mirrors the IDE chat's `ToolTimeline` ToolGroup: a run of many consecutive
 * tool calls collapses into one quiet header ("N calls · M done") that expands
 * to the individual `ToolCallCard`s. Threshold matches the IDE
 * (`TOOL_GROUP_MIN = 6`).
 *
 * Open-state follows the IDE EXACTLY:
 *   - while the turn is actively streaming → expanded by default (you watch the
 *     tools run), user may collapse it;
 *   - once streaming ends → collapses back to the summary (state resets when the
 *     `isActivelyStreaming` flag flips), user may expand it again.
 * Because the agent window no longer reloads the transcript at stream end, the
 * group stays MOUNTED and framer-motion animates this collapse smoothly instead
 * of the old hard remount that made the view jump.
 *
 * All colour comes from `--agw-*`.
 */

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import { ToolCallCard } from "./ToolCallCard";
import { formatToolDuration, toolStatus, type ToolCall } from "./tool-call";
import { TOOL_GROUP_MIN } from "./timeline";

/**
 * Renders a run of consecutive tool calls. ALWAYS used for a tools row (even a
 * single call) so the cards never remount: once the run reaches
 * `TOOL_GROUP_MIN`, the collapsible header simply animates IN above the same,
 * still-mounted cards instead of swapping a plain card list for a different
 * component (which made the view jump at the 6th call). Below the threshold it
 * is a transparent passthrough — just the cards, no header, always open.
 */
const ToolGroupImpl: React.FC<{
  tools: ToolCall[];
  /** The turn this group belongs to is still streaming. */
  isActivelyStreaming?: boolean;
}> = ({ tools, isActivelyStreaming = false }) => {
  const grouped = tools.length >= TOOL_GROUP_MIN;

  const stats = useMemo(() => {
    let done = 0;
    let failed = 0;
    let totalMs = 0;
    for (const t of tools) {
      const s = toolStatus(t, isActivelyStreaming);
      if (s === "done") done += 1;
      else if (s === "failed") failed += 1;
      totalMs += t.durationMs ?? 0;
    }
    return { done, failed, totalMs };
  }, [tools, isActivelyStreaming]);

  // Same trick as the IDE: remember the user's toggle, but key it to the
  // streaming flag so the default flips (open→summary) when the turn ends.
  const [openState, setOpenState] = useState<{
    mode: "hidden" | "shown" | null;
    streaming: boolean;
  }>({ mode: null, streaming: isActivelyStreaming });

  const mode = openState.streaming === isActivelyStreaming ? openState.mode : null;
  // Below the grouping threshold there's no header → the cards are always shown.
  const isOpen = !grouped || (isActivelyStreaming ? mode !== "hidden" : mode === "shown");

  const toggle = () =>
    setOpenState({
      mode: isOpen ? (isActivelyStreaming ? "hidden" : null) : "shown",
      streaming: isActivelyStreaming,
    });

  return (
    <div className="agw-tool-group">
      {/* The header grows in once the run crosses the threshold — the cards
          below stay mounted, so there's no jump. */}
      <AnimatePresence initial={false}>
        {grouped && (
          <motion.button
            key="head"
            type="button"
            className="agw-tool-group-head"
            aria-expanded={isOpen}
            onClick={toggle}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <AgentIcon
              name="chevron-down"
              size={13}
              style={{
                transform: isOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
                color: "var(--agw-text-subtle)",
              }}
            />
            <AgentIcon
              name="layers"
              size={13}
              style={{ color: "var(--agw-text-subtle)" }}
            />
            <span style={{ color: "var(--agw-text-muted)" }}>
              {tools.length} {tools.length === 1 ? "call" : "calls"} · {stats.done} done
              {stats.totalMs >= 1000 && ` · ${formatToolDuration(stats.totalMs)}`}
            </span>
            {stats.failed > 0 && (
              <span className="agw-tool-group-badge">{stats.failed} failed</span>
            )}
            <span className="agw-timeline-rule" aria-hidden="true" />
          </motion.button>
        )}
      </AnimatePresence>

      <motion.div
        initial={false}
        animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        style={{ overflow: "hidden" }}
      >
        <div
          // When grouped (≥6 calls, e.g. a 10-file edit run), the cards live in a
          // BOUNDED lock area that scrolls internally — so the expansion never
          // balloons the message. Below the threshold it's a plain passthrough.
          className={grouped ? "agw-tool-group-body" : undefined}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            paddingTop: grouped ? 6 : 0,
          }}
        >
          {tools.map((call) => (
            // One wrapper per call, unstyled by default. `ToolCallCard` renders
            // five different roots depending on the tool (standard card, canvas
            // launch, plan beat, checklist beat), so this is the only element
            // that reliably means "one call" — which is what the transcript
            // spine hangs its marker on, and what a sixth card shape would get
            // for free.
            <div className="agw-tool-step" key={call.id}>
              <ToolCallCard call={call} isActivelyStreaming={isActivelyStreaming} />
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

/**
 * Memoized by ELEMENT identity: `buildRows` recreates the `tools` array every
 * render of the streaming turn, but the ToolCall objects inside keep their
 * identity unless that specific call was actually patched (args delta /
 * result landing). Comparing element-wise means a frame of pure text tokens
 * no longer re-renders every tool card in the turn — in a long agentic run
 * that's dozens of cards skipped per frame.
 */
function toolGroupPropsEqual(
  prev: { tools: ToolCall[]; isActivelyStreaming?: boolean },
  next: { tools: ToolCall[]; isActivelyStreaming?: boolean },
): boolean {
  if ((prev.isActivelyStreaming ?? false) !== (next.isActivelyStreaming ?? false)) {
    return false;
  }
  if (prev.tools.length !== next.tools.length) return false;
  for (let i = 0; i < prev.tools.length; i++) {
    if (prev.tools[i] !== next.tools[i]) return false;
  }
  return true;
}

export const ToolGroup = React.memo(ToolGroupImpl, toolGroupPropsEqual);
