import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSubagentMemory,
  recallScrollTop,
  rememberScroll,
  subagentMemoryKey,
} from "@/apps/agent/components/panels/subagent-memory";

const scroller = (scrollTop: number, scrollHeight = 2_000, clientHeight = 500) =>
  ({ scrollTop, scrollHeight, clientHeight }) as unknown as HTMLElement;

describe("subagent tab memory", () => {
  beforeEach(() => clearSubagentMemory());

  it("puts a reader who had scrolled up back where they were", () => {
    const key = subagentMemoryKey("parent", "agent");
    rememberScroll(key, scroller(300));
    expect(recallScrollTop(key)).toBe(300);
  });

  it("remembers 'at the bottom' as nothing to restore, so the bottom anchor takes over", () => {
    const key = subagentMemoryKey("parent", "agent");
    // 2000 - (1400 + 500) = 100 px from the end: within the bottom band.
    rememberScroll(key, scroller(1_400));
    expect(recallScrollTop(key)).toBeNull();
  });

  it("is per agent, and knows nothing about a tab never shown", () => {
    rememberScroll(subagentMemoryKey("parent", "a"), scroller(300));
    expect(recallScrollTop(subagentMemoryKey("parent", "b"))).toBeNull();
  });
});
