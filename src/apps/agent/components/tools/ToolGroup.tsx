/**
 * Agent Window — grouped tool calls [view].
 *
 * Mirrors the IDE chat's `ToolTimeline` ToolGroup: a run of many consecutive
 * tool calls collapses into one quiet header ("N calls · M done") that expands
 * to the individual `ToolCallCard`s (`TOOL_GROUP_MIN`, currently 3 — the agent
 * window deliberately groups earlier than the IDE's 6).
 *
 * Open-state:
 *   - while the turn is streaming AND this run is the live frontier (the last
 *     row) → expanded, so you watch the tools run;
 *   - as soon as anything lands BELOW it — the model resumes writing, a new
 *     tool row starts — it collapses back to its one-line summary. A finished
 *     run holding the viewport open pushes the live text off-screen, and the
 *     thing you want to read is always the newest thing;
 *   - once streaming ends → collapsed (state resets when the
 *     `isActivelyStreaming` flag flips).
 * An explicit click wins over all of it, in both directions, until the turn
 * ends — auto-collapsing a group the user deliberately opened would fight them.
 * Because the agent window no longer reloads the transcript at stream end, the
 * group stays MOUNTED and framer-motion animates this collapse smoothly instead
 * of the old hard remount that made the view jump.
 *
 * All colour comes from `--agw-*`.
 */

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { ChecklistBeatCard, ToolCallCard } from "@/apps/agent/components/tools/ToolCallCard";
import { McpServerLane } from "@/apps/agent/components/tools/McpServerLane";
import { mcpServerIdForCard } from "@/apps/agent/components/tools/mcp-card";
import {
  formatToolDuration,
  groupToolRuns,
  isChecklistCall,
  toolStatus,
  type ToolCall,
} from "@/apps/agent/components/tools/tool-call";
import { TOOL_GROUP_MIN } from "@/apps/agent/components/conversation/timeline";
import { useFollowBottom } from "@/apps/agent/hooks/conversation/useFollowBottom";
import { useLinger } from "@/apps/agent/hooks/conversation/useLinger";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import {
  createArrivalStagger,
  RUN_LINGER_MS,
  type ArrivalStagger,
} from "@/apps/agent/components/tools/tool-arrival";

/**
 * One step of a run, and the one place its arrival is decided.
 *
 * Whether it fades in, and after what delay, is fixed ONCE, when the step
 * first mounts (a lazy state initializer, so it is free to read the clock).
 * A step that mounts while the turn is streaming arrives; one that mounts from
 * history, or while the setting is off, is simply there. Later re-renders
 * never re-run the entrance, so a card patched by its result does not blink.
 */
const ToolStep: React.FC<{
  animate: boolean;
  stagger: ArrivalStagger;
  children: React.ReactNode;
}> = ({ animate, stagger, children }) => {
  const [delayMs] = useState<number | null>(() =>
    animate ? stagger.next(performance.now()) : null,
  );
  return (
    <div
      className="agw-tool-step"
      data-enter={delayMs !== null || undefined}
      style={delayMs ? { animationDelay: `${Math.round(delayMs)}ms` } : undefined}
    >
      {children}
    </div>
  );
};

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
  /** This run is the last row of the turn — nothing has landed under it yet.
   *  Defaults to true so a group rendered without turn context (tests, any
   *  future standalone use) keeps the plain streaming behaviour. */
  isLastRow?: boolean;
}> = ({ tools, isActivelyStreaming = false, isLastRow = true }) => {
  // Checklist calls collapse into one step, and so does a run of calls to one
  // MCP server; everything else is a step of one. Computed from `tools` so the
  // header's "N calls" keeps counting calls.
  const runs = useMemo(() => groupToolRuns(tools), [tools]);
  // The threshold is about how many ROWS the reader faces, not how many calls
  // the model made. Three `TaskUpdate` calls — close one, close another, start
  // the next — are one row, and putting a "3 calls · 3 done" header above a
  // single line asks the reader what the other two were when the answer is
  // "this line". A mixed run still groups, because its rows are still rows.
  const grouped = runs.length >= TOOL_GROUP_MIN;

  const stats = useMemo(() => {
    let done = 0;
    let failed = 0;
    let running = 0;
    let totalMs = 0;
    for (const t of tools) {
      const s = toolStatus(t, isActivelyStreaming);
      if (s === "done") done += 1;
      else if (s === "failed") failed += 1;
      else running += 1;
      totalMs += t.durationMs ?? 0;
    }
    return { done, failed, running, totalMs };
  }, [tools, isActivelyStreaming]);

  // The body below is height-capped once grouped, so past about the sixth card
  // every new one lands out of sight. Follow the newest while the run is in
  // flight; a finished run stays where the reader left it, and one reopened
  // from history opens at its first card.
  const { ref: bodyRef, onScroll: onBodyScroll } = useFollowBottom(stats.running > 0);

  // Same trick as the IDE: remember the user's toggle, but key it to the
  // streaming flag so the default flips (open→summary) when the turn ends.
  const [openState, setOpenState] = useState<{
    mode: "hidden" | "shown" | null;
    streaming: boolean;
  }>({ mode: null, streaming: isActivelyStreaming });

  // Transcript → "Keep tool runs open": the run never folds on its own. An
  // explicit click still wins, exactly as it does without the setting.
  const keepOpen = useAgentThemeStore((s) => s.transcriptToolRunsOpen);

  // Transcript → "Smooth tool arrival": steps fade in one after another, and
  // the run stays open for `RUN_LINGER_MS` after it stops being the live edge
  // instead of folding in the same frame the model starts writing below it.
  // Reduce motion drops the fade (it is motion) and keeps the pause (it is not).
  const smooth = useAgentThemeStore((s) => s.transcriptSmoothTools);
  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  const [stagger] = useState(createArrivalStagger);
  const animateArrivals = smooth && !reduceMotion && isActivelyStreaming;
  const liveEdge = useLinger(isActivelyStreaming && isLastRow, smooth ? RUN_LINGER_MS : 0);

  const mode = openState.streaming === isActivelyStreaming ? openState.mode : null;
  // Below the grouping threshold there's no header → the cards are always shown.
  // With no explicit choice on record, the run is open only while it IS the
  // live edge; anything appearing beneath it collapses it to its summary.
  const isOpen =
    !grouped || (mode === null ? keepOpen || liveEdge : mode === "shown");

  const toggle = () =>
    setOpenState({ mode: isOpen ? "hidden" : "shown", streaming: isActivelyStreaming });

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
              /*
               * The same red × the failed row below wears, not a filled badge.
               *
               * It was a bordered, tinted, uppercase "1 FAILED" pill — the
               * loudest object in a collapsed run, louder than the failure it
               * was reporting, and it did not match anything else in the
               * transcript. One call out of three not landing is a fact worth
               * a glyph, not an alarm.
               *
               * The count only appears from two upwards: at one it would
               * restate what the single × already says, and the row underneath
               * carries the reason.
               */
              <span className="agw-tool-group-badge">
                <AgentIcon name="close" size={12} strokeWidth={2.6} />
                {stats.failed > 1 && stats.failed}
                {/* The glyph is the visual signal; this is the same fact for a
                    screen reader, which cannot see a red cross. */}
                <span className="agw-sr-only">{stats.failed} failed</span>
              </span>
            )}
            <span className="agw-timeline-rule" aria-hidden="true" />
          </motion.button>
        )}
      </AnimatePresence>

      <motion.div
        // Named so the spine can widen this box leftwards: `overflow: hidden`
        // is what makes the height animation work, and it also clips the
        // gutter every step marker is drawn in. See `11-transcript-bubbles.css`.
        className="agw-tool-group-anim"
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
          ref={bodyRef}
          onScroll={onBodyScroll}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            paddingTop: grouped ? 6 : 0,
          }}
        >
          {runs.map((run) => (
            // One wrapper per STEP, unstyled by default. `ToolCallCard` renders
            // five different roots depending on the tool (standard card, canvas
            // launch, plan beat, checklist beat), so this is the only element
            // that reliably means "one step" — which is what the transcript
            // spine hangs its marker on, and what a sixth card shape would get
            // for free.
            //
            // A step is one call, except for the checklist: a run of
            // consecutive `TaskCreate` / `TaskUpdate` calls is one step,
            // because laying out a five-task plan is five calls and one
            // decision. The header above still counts the real calls.
            <ToolStep key={run[0].id} animate={animateArrivals} stagger={stagger}>
              {isChecklistCall(run[0]) ? (
                <ChecklistBeatCard calls={run} isActivelyStreaming={isActivelyStreaming} />
              ) : mcpServerIdForCard(run[0]) !== null ? (
                <McpServerLane calls={run} isActivelyStreaming={isActivelyStreaming} />
              ) : (
                <ToolCallCard call={run[0]} isActivelyStreaming={isActivelyStreaming} />
              )}
            </ToolStep>
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
  prev: { tools: ToolCall[]; isActivelyStreaming?: boolean; isLastRow?: boolean },
  next: { tools: ToolCall[]; isActivelyStreaming?: boolean; isLastRow?: boolean },
): boolean {
  if ((prev.isActivelyStreaming ?? false) !== (next.isActivelyStreaming ?? false)) {
    return false;
  }
  // Losing the frontier is exactly what triggers the auto-collapse, so it must
  // never be memoized away.
  if ((prev.isLastRow ?? true) !== (next.isLastRow ?? true)) return false;
  if (prev.tools.length !== next.tools.length) return false;
  for (let i = 0; i < prev.tools.length; i++) {
    if (prev.tools[i] !== next.tools[i]) return false;
  }
  return true;
}

export const ToolGroup = React.memo(ToolGroupImpl, toolGroupPropsEqual);
