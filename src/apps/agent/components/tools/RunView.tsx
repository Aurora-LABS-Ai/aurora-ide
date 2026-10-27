/**
 * Agent Window — one step's card [view].
 *
 * A step is one tool call, or one run of calls that draw as a single row (a
 * checklist update, calls to one MCP server). Shared by `ToolGroup` (the
 * transcript's runs) and the work card's step list, so a step looks and opens
 * the same wherever it is drawn.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { ErrorBoundary } from "@/kernel/ui/ErrorBoundary";
import { ChecklistBeatCard, ToolCallCard } from "@/apps/agent/components/tools/ToolCallCard";
import { McpServerLane } from "@/apps/agent/components/tools/McpServerLane";
import { mcpServerIdForCard } from "@/apps/agent/components/tools/mcp-card";
import { isChecklistCall, type ToolCall } from "@/apps/agent/components/tools/tool-call";

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
export const RunView = React.memo(
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
