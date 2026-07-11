import type { TimelineEvent, ToolCall } from "../../../types";

export const TOOL_GROUP_MIN = 6;

export type TimelineRenderRow =
  | { type: "event"; event: TimelineEvent }
  | { type: "tools"; id: string; tools: ToolCall[] };

export const buildTimelineRows = (
  timeline: TimelineEvent[],
): TimelineRenderRow[] => {
  const rows: TimelineRenderRow[] = [];
  let toolRun: TimelineEvent[] = [];

  const flushTools = () => {
    if (toolRun.length >= TOOL_GROUP_MIN) {
      const first = toolRun[0]!;
      const last = toolRun[toolRun.length - 1]!;
      rows.push({
        type: "tools",
        id: `tools-${first.id}-${last.id}`,
        tools: toolRun.map((event) => event.tool!),
      });
    } else {
      for (const event of toolRun) rows.push({ type: "event", event });
    }
    toolRun = [];
  };

  for (const event of timeline) {
    if (event.type === "tool" && event.tool) {
      toolRun.push(event);
      continue;
    }
    flushTools();
    rows.push({ type: "event", event });
  }

  flushTools();
  return rows;
};
