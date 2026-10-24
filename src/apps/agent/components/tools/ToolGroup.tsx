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

import React, { useContext, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { ToolGlyph } from "@/apps/agent/components/tools/tool-icons/ToolGlyph";
import { ErrorBoundary } from "@/kernel/ui/ErrorBoundary";
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
import { ArrivalHoldContext } from "@/apps/agent/components/tools/arrival-hold";
import { useInLiveWorkCard } from "@/apps/agent/components/conversation/work-card-context";
import { GLIDE } from "@/apps/agent/lib/motion/glide";

/**
 * One step of a run, and the one place its arrival is decided.
 *
 * Whether it enters, and after what delay, is fixed ONCE, when the step first
 * mounts (a lazy state initializer, so it is free to read the clock). A step
 * that mounts while the turn is streaming arrives; one that mounts from
 * history, or while the setting is off, is simply there. Later re-renders
 * never re-run the entrance, so a card patched by its result does not blink.
 *
 * The entrance opens the step's height from 0 (see `09-tool-cards.css`), which
 * needs its content clipped while it opens. `data-enter` is dropped when the
 * entrance's LAST part — the content sliding in — ends, so the clip never
 * outlives it and a card that later grows (expanded output, a popover) is
 * never cut off.
 *
 * Inside a running work card the entrance is `fade` instead: the step takes
 * its full height at once and only its paint fades in, together with any
 * step landing in the same moment. Growing from 0 there moved every row above
 * it once per call, which a fast model turns into constant motion.
 */
const ToolStep: React.FC<{
  animate: boolean;
  entrance: "grow" | "fade";
  stagger: ArrivalStagger;
  children: React.ReactNode;
}> = ({ animate, entrance, stagger, children }) => {
  // A step redrawn somewhere new (a work card opening) is not arriving.
  const hold = useContext(ArrivalHoldContext);
  const [arrival] = useState<{ kind: "grow"; delayMs: number } | { kind: "fade" } | null>(() => {
    if (!animate || hold.current) return null;
    return entrance === "fade" ? { kind: "fade" } : { kind: "grow", delayMs: stagger.next(performance.now()) };
  });
  const [entering, setEntering] = useState(arrival !== null);
  const growing = entering && arrival?.kind === "grow";
  const fading = entering && arrival?.kind === "fade";
  return (
    <div
      className="agw-tool-step"
      data-enter={growing || undefined}
      data-fade={fading || undefined}
      style={
        growing && arrival?.kind === "grow"
          ? ({ "--agw-enter-delay": `${Math.round(arrival.delayMs)}ms` } as React.CSSProperties)
          : undefined
      }
      onAnimationEnd={(e) => {
        if (
          (e.animationName === "agw-tool-slide-in" &&
            (e.target as Element).parentElement === e.currentTarget) ||
          (e.animationName === "agw-tool-fade-in" && e.target === e.currentTarget)
        ) {
          setEntering(false);
        }
      }}
    >
      {children}
    </div>
  );
};

/**
 * Transcript → "One live line for tool calls": while a run is the live edge,
 * this is the whole run — one row whose content rolls over in place.
 *
 * The newest step is drawn exactly as the run would draw it (`renderRun`), so
 * its card, chip, result and expand work unchanged; only the frame around it
 * is new. The roll is the suggestion drum's (`.agw-suggest-drum`): 0.18s,
 * tipped 48° in a 340px perspective.
 *
 * Between calls the line keeps the call that just finished and shimmers
 * (`data-waiting`) until the next call lands or anything else — the model's
 * own reasoning, its reply — appears below it. It never says "Thinking" itself:
 * when the model really thinks, its reasoning row says so, and a second label
 * here only duplicated it. With parallel calls the newest can finish before an
 * older one, so the shimmer waits for the whole run (`allDone`).
 *
 * The count on the right opens the whole run as ordinary rows. What the line
 * becomes once the run is no longer live is decided by `ToolGroupImpl`.
 */
const LiveLine: React.FC<{
  runs: ToolCall[][];
  callCount: number;
  /** Every call in the run has finished. */
  allDone: boolean;
  /** Nothing has landed below the run yet. */
  isLastRow: boolean;
  reduceMotion: boolean;
  renderRun: (run: ToolCall[]) => React.ReactNode;
  onShowAll: () => void;
}> = ({ runs, callCount, allDone, isLastRow, reduceMotion, renderRun, onShowAll }) => {
  const newest = runs[runs.length - 1];
  const newestId = newest[0].id;
  const waiting = allDone && isLastRow;

  const roll = reduceMotion
    ? { initial: false as const, transition: { duration: 0 } }
    : {
        initial: { opacity: 0, y: "60%", rotateX: -48 },
        transition: { duration: 0.18, ease: "easeInOut" as const },
      };

  return (
    <div className="agw-tool-step agw-tool-liveline" data-waiting={waiting || undefined}>
      <div className="agw-tool-liveline-reel">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={newestId}
            className="agw-tool-liveline-slide"
            initial={roll.initial}
            animate={{ opacity: 1, y: 0, rotateX: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: "-60%", rotateX: 48 }}
            transition={roll.transition}
          >
            {renderRun(newest)}
          </motion.div>
        </AnimatePresence>
      </div>
      {/* Rows, not calls: three checklist updates are one row, and a count
          that opens onto the same single row would promise more than it has. */}
      {runs.length > 1 && (
        <button
          type="button"
          className="agw-tool-liveline-count"
          onClick={onShowAll}
          title="Show every call in this run"
        >
          {callCount} calls
        </button>
      )}
    </div>
  );
};

/**
 * One step's content: its card, behind its own error boundary.
 *
 * Memoised on the step's CALLS, compared one by one. `groupToolRuns` rebuilds
 * every run array whenever the group's `tools` change, which happens each time
 * a call arrives or a result lands anywhere in the run. Without this every card
 * in the run drew again for each of those events, so a 40-call run did 40 card
 * renders per event. With two chats streaming tool-heavy turns that was the
 * dropped frames. A call object keeps its identity until that call itself is
 * patched (see `upsertToolEvent`), so identity is the right comparison.
 */
const RunView = React.memo(
  function RunView({
    run,
    isActivelyStreaming,
  }: {
    run: ToolCall[];
    isActivelyStreaming: boolean;
  }) {
    return (
      // One step's card can fail to draw (a model sends an argument in a shape
      // no card expects). That is this step's problem, not the transcript's: the
      // row says so and the rest of the window stays up. Retried once the call's
      // result arrives, in case the failure was a half-streamed argument.
      <ErrorBoundary
        where={`tool step ${run[0].name}`}
        resetKey={run[0].result ?? run[0].arguments}
        fallback={() => <StepRenderFailed name={run[0].name} />}
      >
        {isChecklistCall(run[0]) ? (
          <ChecklistBeatCard calls={run} isActivelyStreaming={isActivelyStreaming} />
        ) : mcpServerIdForCard(run[0]) !== null ? (
          <McpServerLane calls={run} isActivelyStreaming={isActivelyStreaming} />
        ) : (
          <ToolCallCard call={run[0]} isActivelyStreaming={isActivelyStreaming} />
        )}
      </ErrorBoundary>
    );
  },
  (prev, next) =>
    prev.isActivelyStreaming === next.isActivelyStreaming &&
    prev.run.length === next.run.length &&
    prev.run.every((call, i) => call === next.run[i]),
);

/**
 * What a step shows when its card threw while drawing. The call itself ran
 * and its result is in the conversation; only the picture of it is missing.
 */
const StepRenderFailed: React.FC<{ name: string }> = ({ name }) => (
  <div className="agw-tool-render-failed" role="status">
    <AgentIcon name="alert" size={13} />
    <span>
      Aurora could not draw this step (<code>{name}</code>). The call itself ran; the
      error is in the log.
    </span>
  </div>
);

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
  // Transcript → "One live line for tool calls" (see `LiveLine`).
  const liveLineOn = useAgentThemeStore((s) => s.transcriptLiveLine);
  // The threshold is about how many ROWS the reader faces, not how many calls
  // the model made. Three `TaskUpdate` calls — close one, close another, start
  // the next — are one row, and putting a "3 calls · 3 done" header above a
  // single line asks the reader what the other two were when the answer is
  // "this line". A mixed run still groups, because its rows are still rows.
  //
  // With the live line on, a run of TWO rows groups as well. The line showed
  // the run as one row the whole time it was live; handing it back as two
  // separate rows split that one line in two the moment the model moved on,
  // and moved the reply. It folds to the same one-line header a longer run
  // does — live, and when the conversation is reopened later.
  //
  // Inside a running work card (`LiveWorkCardContext`) none of this applies
  // unless the reader asked for it: the run is plain rows, no header, no cap,
  // no fold, no live line. The card already bounds the work.
  const inLiveCard = useInLiveWorkCard();
  const groupInCard = useAgentThemeStore((s) => s.transcriptWorkCardGroupRuns);
  const flat = inLiveCard && !groupInCard;
  const grouped = !flat && (runs.length >= TOOL_GROUP_MIN || (liveLineOn && runs.length >= 2));

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

  // Transcript → "Smooth tool arrival" (on by default): each step opens its own
  // space and grows off the spine instead of landing at full height, and the
  // run stays open for `RUN_LINGER_MS` after it stops being the live edge
  // instead of folding in the same frame the model starts writing below it.
  // Reduce motion drops the entrance (it is motion) and keeps the pause (it is not).
  const smooth = useAgentThemeStore((s) => s.transcriptSmoothTools);
  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  const [stagger] = useState(createArrivalStagger);
  const liveEdge = useLinger(isActivelyStreaming && isLastRow, smooth ? RUN_LINGER_MS : 0);

  const mode = openState.streaming === isActivelyStreaming ? openState.mode : null;

  // While this run is the live edge it is one line that changes in place. An
  // explicit open or fold wins, as it does everywhere else in this component.
  // Once it stops being the live edge it is drawn by the ordinary path below:
  // a single row stays that row, two or more fold to their header (`grouped`)
  // in the same place the line was, so the reply does not move.
  const lineMode = !flat && liveLineOn && isActivelyStreaming && liveEdge && mode === null;
  // How many steps the line has already shown. Those steps are not new when the
  // run is handed back to ordinary rows (or opened by its count), so they must
  // not play their entrance as if they had just arrived; a call that lands
  // after that point still does. State adjusted during render (React's pattern
  // for derived state), so it takes effect in this same render.
  const [shownOnLine, setShownOnLine] = useState(0);
  if (lineMode && shownOnLine !== runs.length) setShownOnLine(runs.length);
  const animateArrivals = smooth && !reduceMotion && isActivelyStreaming;
  // Below the grouping threshold there's no header → the cards are always shown.
  // With no explicit choice on record, the run is open only while it IS the
  // live edge; anything appearing beneath it collapses it to its summary.
  //
  // With the live line on, a run never opens on its own: while it is live the
  // line IS the run, and afterwards opening it would burst every row out at
  // once — exactly the movement the line exists to prevent. That covers "Keep
  // tool runs open", and the moment the turn ends, when `liveEdge` is still
  // lingering but the line has already handed over. It opens on a click.
  const isOpen =
    !grouped ||
    (mode === null ? !liveLineOn && (keepOpen || liveEdge) : mode === "shown");

  const toggle = () =>
    setOpenState({ mode: isOpen ? "hidden" : "shown", streaming: isActivelyStreaming });

  // One step's content, shared by the rows below and the live line.
  const renderRun = (run: ToolCall[]) => (
    <RunView run={run} isActivelyStreaming={isActivelyStreaming} />
  );

  if (lineMode) {
    return (
      <div className="agw-tool-group">
        <LiveLine
          runs={runs}
          callCount={tools.length}
          allDone={stats.running === 0}
          isLastRow={isLastRow}
          reduceMotion={reduceMotion}
          renderRun={renderRun}
          onShowAll={() => setOpenState({ mode: "shown", streaming: isActivelyStreaming })}
        />
      </div>
    );
  }

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
            transition={GLIDE}
            style={{ overflow: "hidden" }}
          >
            <AgentIcon
              name="chevron-down"
              size={13}
              style={{
                transform: isOpen ? "none" : "rotate(-90deg)",
                transition: "transform var(--agw-glide-dur) var(--agw-glide-ease)",
                color: "var(--agw-text-subtle)",
              }}
            />
            <ToolGlyph
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
        transition={GLIDE}
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
          {runs.map((run, index) => (
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
            <ToolStep
              key={run[0].id}
              animate={animateArrivals && index >= shownOnLine}
              entrance={flat ? "fade" : "grow"}
              stagger={stagger}
            >
              {renderRun(run)}
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
