/**
 * Agent Window — work card: one tool run as plain steps [view].
 *
 * Inside the card a run has no header, no height cap, no fold and no live
 * line: the card already bounds the work, and each of those moved rows while
 * a fast model worked (2026-10-19, "Group tool calls while working" — gone
 * with the old card). Each step is the transcript's own card (`RunView`), so
 * it opens and closes exactly as it does outside.
 *
 * A step fades in only when it is new (`arrival.ts`).
 */

import React, { useMemo, useState } from "react";

import { isArriving } from "@/apps/agent/components/conversation/work-log/arrival";
import { RunView } from "@/apps/agent/components/tools/RunView";
import { groupToolRuns, type ToolCall } from "@/apps/agent/components/tools/tool-call";

/** Whether the fade actually plays (Smooth tool arrival, Reduce motion) is the
 *  card's stylesheet's call (`.agw-wc[data-arrivals]`); this only says "new". */
const Step: React.FC<{
  run: ToolCall[];
  streaming: boolean;
}> = ({ run, streaming }) => {
  const [arriving] = useState(() => isArriving(run[0], streaming, Date.now()));
  return (
    <div className="agw-tool-step agw-wc-step" data-arrive={arriving || undefined}>
      <RunView run={run} isActivelyStreaming={streaming} />
    </div>
  );
};

export const WorkSteps: React.FC<{
  tools: ToolCall[];
  /** The turn is still running. */
  streaming: boolean;
}> = ({ tools, streaming }) => {
  const runs = useMemo(() => groupToolRuns(tools), [tools]);
  return (
    <div className="agw-wc-steps">
      {runs.map((run) => (
        <Step key={run[0].id} run={run} streaming={streaming} />
      ))}
    </div>
  );
};
