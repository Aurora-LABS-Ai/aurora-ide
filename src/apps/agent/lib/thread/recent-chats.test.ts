import { describe, expect, it } from "vitest";

import { recentChats, RECENT_LIMIT } from "./recent-chats";
import type { ThreadSummary } from "@/apps/agent/services/threads/thread-service";

const chat = (id: string, pinned = false): ThreadSummary =>
  ({ id, title: id, pinned, messageCount: 1, preview: "", updatedAt: "" }) as ThreadSummary;

describe("recentChats", () => {
  it("takes the head of the list without re-sorting it", () => {
    const threads = ["a", "b", "c"].map((id) => chat(id));
    expect(recentChats(threads).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("stops at the limit", () => {
    const threads = Array.from({ length: 20 }, (_, i) => chat(`c${i}`));
    expect(recentChats(threads)).toHaveLength(RECENT_LIMIT);
  });

  it("skips pinned chats, which the section above already lists", () => {
    const threads = [chat("pinned", true), chat("a"), chat("b")];
    expect(recentChats(threads).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("still fills the limit when pinned chats sit at the top", () => {
    const threads = [
      ...Array.from({ length: 3 }, (_, i) => chat(`p${i}`, true)),
      ...Array.from({ length: 8 }, (_, i) => chat(`c${i}`)),
    ];
    const got = recentChats(threads);
    expect(got).toHaveLength(RECENT_LIMIT);
    expect(got.every((t) => !t.pinned)).toBe(true);
  });

  it("returns nothing for an empty list or a zero limit", () => {
    expect(recentChats([])).toEqual([]);
    expect(recentChats([chat("a")], 0)).toEqual([]);
  });
});
