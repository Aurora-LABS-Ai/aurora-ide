import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSubagentMemory,
  forgetParentMemory,
  recallTranscript,
  rememberTranscript,
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

  it("forgets only the deleted parent and rejects a late transcript read", () => {
    const key = subagentMemoryKey("parent", "agent");
    const other = subagentMemoryKey("other", "agent");
    const thread = { id: "agent", title: "Agent", summary: null, messages: [],
      created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z" };
    rememberTranscript(key, thread);
    rememberTranscript(other, thread);
    rememberScroll(key, scroller(300));
    forgetParentMemory("parent");
    expect(recallTranscript(key)).toBeUndefined();
    expect(recallTranscript(other)).toBe(thread);
    expect(recallScrollTop(key)).toBeNull();
    rememberTranscript(key, thread);
    expect(recallTranscript(key)).toBeUndefined();
  });
});
