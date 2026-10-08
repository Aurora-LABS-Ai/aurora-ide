/**
 * Agent Window — an agent's live tail in the Agents tab [view].
 *
 * Probe: Documents/aurora-agent-preview-designs.html, 06 "More history"
 * (picked 2026-10-08). The running command's live tail, for an agent: no box,
 * a rule at the tool body's indent (accent while the agent works), a fixed
 * window with the newest line at the bottom and older lines dissolving into a
 * fade at the top. Tool calls are the transcript's own rows; thoughts and what
 * it said are one quiet line each.
 *
 * "Show more · N earlier steps" grows the window and lets it scroll back
 * through the whole run; it keeps following the newest line unless the reader
 * scrolls up. Read-only: nothing inside takes a click. The agent's own tab is
 * the full view.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { ToolCallCard } from "@/apps/agent/components/tools/ToolCallCard";
import { useAgentAutoScroll } from "@/apps/agent/hooks/conversation/useAgentAutoScroll";
import { useSubagentTranscript } from "@/apps/agent/hooks/subagents/useSubagentTranscript";
import { tailSteps, type TailStep } from "@/apps/agent/lib/subagents/tail-steps";
import { transcriptGrowth } from "@/apps/agent/lib/subagents/transcript-growth";

/** The window's height change lasts this long; follow lands after it. */
const RESIZE_MS = 260;
/**
 * Steps rendered at once. Closed, the window shows about eight lines, so forty
 * covers it with room; open, it scrolls back through this many. Rendering a
 * long run's every step as a tool card when the tail opened was the frame drop
 * on old conversations.
 */
const CLOSED_STEPS = 40;
const OPEN_STEPS = 150;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const Step: React.FC<{ step: TailStep; running: boolean }> = ({ step, running }) => {
  switch (step.kind) {
    case "tool":
      return <ToolCallCard call={step.call} isActivelyStreaming={running} />;
    case "thought":
      return (
        <div className="agw-tail-text" data-kind="thought">
          <span className="agw-tail-tag">Thought</span>
          {step.text}
        </div>
      );
    case "said":
      return (
        <div className="agw-tail-text" data-kind="said">
          {step.text}
        </div>
      );
    case "note":
      return (
        <div className="agw-tail-text" data-kind="note">
          {step.text}
        </div>
      );
    case "parent":
      return (
        <div className="agw-tail-text" data-kind="parent" data-waiting={step.waiting ? "" : undefined}>
          <span className="agw-tail-tag">{step.waiting ? "Waiting" : "From parent"}</span>
          {step.text}
        </div>
      );
    default:
      return null;
  }
};

export const SubagentTail: React.FC<{
  parentThreadId: string;
  agentId: string;
  label: string;
  more: boolean;
  onMoreChange: (more: boolean) => void;
}> = ({ parentThreadId, agentId, label, more, onMoreChange }) => {
  const { running, messages, loading, missing, pending } = useSubagentTranscript(
    parentThreadId,
    agentId,
  );
  const allSteps = useMemo(() => tailSteps(messages, pending), [messages, pending]);
  const steps = useMemo(
    () => allSteps.slice(-(more ? OPEN_STEPS : CLOSED_STEPS)),
    [allSteps, more],
  );
  // Earlier steps not rendered at all, on top of those rendered above the window.
  const unrendered = allSteps.length - steps.length;
  const growth = useMemo(() => transcriptGrowth(messages) + allSteps.length, [messages, allSteps]);
  const { containerRef, contentRef, jumpToBottom } = useAgentAutoScroll({
    isStreaming: running,
    resetKey: agentId,
    growthKey: growth,
  });

  // How many steps sit above the window: what "Show more" would reveal.
  // Measured, not guessed, from the rows' positions after every layout or
  // scroll — the count on the button is a promise.
  const [hiddenAbove, setHiddenAbove] = useState(0);
  // Taller than the window, so something sits above its top edge: only then
  // does the top fade show (`.agw-tail[data-clipped]`).
  const [clipped, setClipped] = useState(false);
  const frame = useRef<number | null>(null);
  const measure = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = containerRef.current;
      const content = contentRef.current;
      if (!el || !content) return;
      const top = el.scrollTop + 4;
      let hidden = 0;
      for (const child of Array.from(content.children) as HTMLElement[]) {
        if (child.offsetTop + child.offsetHeight <= top) hidden += 1;
        else break;
      }
      setHiddenAbove(hidden);
      setClipped(el.scrollHeight > el.clientHeight + 1);
    });
  }, [containerRef, contentRef]);

  useEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [containerRef, contentRef, measure, loading]);

  // Read-only: nothing inside takes clicks or focus; the window still
  // scrolls. Set on the element because React 18's types do not know `inert`.
  useEffect(() => {
    contentRef.current?.setAttribute("inert", "");
  });

  // Opening or closing "more" changes the window's height over RESIZE_MS;
  // land on the newest line once it has settled, gliding.
  const toggleMore = () => {
    onMoreChange(!more);
    window.setTimeout(() => jumpToBottom("smooth"), RESIZE_MS);
  };

  const earlier = unrendered + hiddenAbove;
  const showToggle = more || earlier > 0;

  return (
    <div className="agw-tail-wrap" data-running={running ? "" : undefined}>
      <div
        ref={containerRef}
        className="agw-tail agw-scroll"
        data-more={more ? "" : undefined}
        data-clipped={clipped ? "" : undefined}
        role="region"
        aria-label={`${label}, live`}
      >
        {missing ? (
          <div className="agw-tail-text" data-kind="note">
            This agent&apos;s transcript could not be found.
          </div>
        ) : loading && steps.length === 0 ? (
          <div className="agw-tail-text" data-kind="note">
            Loading…
          </div>
        ) : steps.length === 0 ? (
          <div className="agw-tail-text" data-kind="note">
            Nothing yet.
          </div>
        ) : (
          <div ref={contentRef} className="agw-tail-in">
            {steps.map((step, index) => (
              <div
                // A tool keeps its call id; a line keeps its place. Either way
                // a line does not remount when the live copy is replaced by
                // the file's, so it never flashes in twice.
                key={step.kind === "tool" ? step.id : `${step.kind}-${unrendered + index}`}
                className="agw-tail-step"
                // Only what streams in while the window watches rises in; a
                // history read from the file is just there.
                data-arrive={step.live ? "" : undefined}
              >
                <Step step={step} running={running} />
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Always laid out, hidden when there is nothing more: the count is
          measured after the first layout, and a button appearing then would
          grow the tail just as its opening motion ends. */}
      <button
        type="button"
        className="agw-tail-more"
        aria-expanded={more}
        aria-hidden={showToggle ? undefined : true}
        tabIndex={showToggle ? undefined : -1}
        data-hidden={showToggle ? undefined : ""}
        onClick={toggleMore}
      >
        {more ? (
          "Show less"
        ) : (
          <>
            Show more <span className="agw-tail-more-n">· {plural(earlier, "earlier step")}</span>
          </>
        )}
        <AgentIcon name="chevron-down" size={12} />
      </button>
    </div>
  );
};
