/**
 * Agent Window — a reply layout fence, drawn inline in a reply [view].
 *
 * Transcript → Reply layout (opt-in). Since 2026-10-16 the model is taught one
 * fence, `aurora-ui` (`lib/reply-layout/ui.ts`, drawn by `UiReply`), which
 * lays out a whole answer. The single-block fences it replaced
 * (`aurora-facts`, `aurora-flow`, …) and `aurora-report` still draw here, so
 * every chat written before keeps its blocks.
 *
 * Nothing here is saved: these are page parts, not tools. The answer box
 * (`components/answer-box`) is the tool. A line the block could not read is
 * named under it, the same way a box names its skipped lines; a block with
 * nothing drawable falls back to its source as code, so the reader always
 * sees what the model wrote.
 */

import React, { useMemo } from "react";

import { layoutIsEmpty, parseLayout, type LayoutLanguage } from "@/apps/agent/lib/reply-layout/parse";
import { UI_FENCE_LANGUAGE } from "@/apps/agent/lib/reply-layout/ui";
import type { ReplyFenceLanguage } from "@/apps/agent/lib/answer-box/split";
import { LayoutBody, LayoutProblems } from "./LayoutBody";
import { UiReply } from "./UiReply";
import "@/canvas-sdk/canvas.css";

interface FenceProps {
  source: string;
  /** The closing fence has arrived (or the turn is over). */
  closed: boolean;
  /** Drawn instead when the block holds nothing to draw: the source as code. */
  fallback: React.ReactNode;
}

const BlockFence: React.FC<FenceProps & { language: LayoutLanguage }> = ({ language, source, closed, fallback }) => {
  const layout = useMemo(() => parseLayout(language, source, closed), [language, source, closed]);

  if (layoutIsEmpty(layout)) {
    // Streaming and nothing complete yet: hold the space quietly rather than
    // flashing the raw fence for a frame.
    if (!closed) return layout.kind === "report" ? <div className="agw-rl agw-rl-pending" data-kind="report" role="status" aria-busy="true">Preparing report…</div> : <div className="agw-rl agw-rl-pending" aria-hidden="true" />;
    return <>{fallback}{layout.kind === "report" && layout.problems.length > 0 && <ul className="agw-rl-problems" aria-label="Report errors">{layout.problems.slice(0, 8).map((problem, i) => <li key={i}>{problem}</li>)}</ul>}</>;
  }

  return (
    <div className="agw-rl-wrap" data-kind={layout.kind}>
      <LayoutBody layout={layout} />
      {/* Problems only once the block is finished: a half-written line is not a fault. */}
      {closed && <LayoutProblems problems={layout.problems} />}
    </div>
  );
};

export const ReplyLayout: React.FC<FenceProps & { language: ReplyFenceLanguage }> = ({ language, ...fence }) =>
  language === UI_FENCE_LANGUAGE ? <UiReply {...fence} /> : <BlockFence language={language} {...fence} />;
