import { describe, expect, it } from "vitest";
import type { TimelineEvent, ToolCall } from "../../../types";
import { buildTimelineRows, TOOL_GROUP_MIN } from "./grouping";

const tool = (id: string): TimelineEvent => ({
  id,
  timestamp: 1,
  type: "tool",
  tool: {
    args: {},
    id,
    name: "file_read",
    status: "complete",
  } satisfies ToolCall,
});

describe("tool timeline grouping", () => {
  it("groups only long consecutive tool runs", () => {
    const intro: TimelineEvent = {
      content: "intro",
      id: "content-1",
      timestamp: 1,
      type: "content",
    };
    const rows = buildTimelineRows([
      intro,
      ...Array.from({ length: TOOL_GROUP_MIN }, (_, i) => tool(`tool-${i}`)),
      intro,
      tool("short-1"),
      tool("short-2"),
    ]);

    expect(rows.map((row) => row.type)).toEqual([
      "event",
      "tools",
      "event",
      "event",
      "event",
    ]);
    expect(rows[1]).toMatchObject({ type: "tools" });
    if (rows[1]?.type === "tools") {
      expect(rows[1].tools).toHaveLength(TOOL_GROUP_MIN);
    }
  });
});
