import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetSurfaceThread,
  recentSurfaceThread,
  rememberSurfaceThread,
  SURFACE_RESUME_WINDOW_MS,
  SURFACE_THREAD_KEY,
  type ResumableThread,
} from "@/apps/agent/lib/thread/surface-resume";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const thread = (id: string, updatedAt: string | null): ResumableThread => ({
  id,
  updatedAt,
});

beforeEach(() => {
  localStorage.clear();
});

describe("remembering where each side was", () => {
  it("keeps the two sides apart", () => {
    rememberSurfaceThread("chat", "c1");
    rememberSurfaceThread("build", "b1");

    const threads = [thread("c1", ago(MINUTE)), thread("b1", ago(MINUTE))];
    expect(recentSurfaceThread("chat", threads, NOW)).toBe("c1");
    expect(recentSurfaceThread("build", threads, NOW)).toBe("b1");
  });

  it("overwrites the same side rather than accumulating", () => {
    rememberSurfaceThread("chat", "first");
    rememberSurfaceThread("chat", "second");
    const threads = [thread("first", ago(MINUTE)), thread("second", ago(MINUTE))];
    expect(recentSurfaceThread("chat", threads, NOW)).toBe("second");
  });

  it("forgets on request", () => {
    rememberSurfaceThread("chat", "c1");
    forgetSurfaceThread("chat");
    expect(recentSurfaceThread("chat", [thread("c1", ago(MINUTE))], NOW)).toBeNull();
  });

  it("returns nothing when nothing was ever remembered", () => {
    expect(recentSurfaceThread("chat", [thread("c1", ago(MINUTE))], NOW)).toBeNull();
  });
});

describe("the two-hour rule", () => {
  it("resumes a conversation touched inside the window", () => {
    rememberSurfaceThread("chat", "c1");
    for (const age of [0, MINUTE, HOUR, SURFACE_RESUME_WINDOW_MS - 1]) {
      expect(recentSurfaceThread("chat", [thread("c1", ago(age))], NOW)).toBe("c1");
    }
  });

  it("lands on the empty state for anything older", () => {
    rememberSurfaceThread("chat", "c1");
    for (const age of [
      SURFACE_RESUME_WINDOW_MS + 1,
      3 * HOUR,
      24 * HOUR,
      30 * 24 * HOUR,
    ]) {
      expect(recentSurfaceThread("chat", [thread("c1", ago(age))], NOW)).toBeNull();
    }
  });

  it("treats the boundary itself as still recent", () => {
    rememberSurfaceThread("chat", "c1");
    expect(
      recentSurfaceThread("chat", [thread("c1", ago(SURFACE_RESUME_WINDOW_MS))], NOW),
    ).toBe("c1");
  });

  /**
   * Clock skew and a bad sidecar both produce these. A future timestamp is not
   * stale — it is the most recently touched thing there is.
   */
  it("resumes a conversation dated in the future", () => {
    rememberSurfaceThread("chat", "c1");
    expect(recentSurfaceThread("chat", [thread("c1", ago(-HOUR))], NOW)).toBe("c1");
  });
});

describe("a remembered id that is no longer usable", () => {
  it("returns nothing when the conversation was deleted", () => {
    rememberSurfaceThread("chat", "gone");
    expect(recentSurfaceThread("chat", [thread("other", ago(MINUTE))], NOW)).toBeNull();
  });

  /**
   * The important one. The id is looked up in THAT surface's list, so an entry
   * left over from the other store can never open a conversation the window is
   * not showing.
   */
  it("returns nothing when the id belongs to the other store", () => {
    rememberSurfaceThread("chat", "b1");
    const buildOnly = [thread("b1", ago(MINUTE))];
    expect(recentSurfaceThread("chat", [], NOW)).toBeNull();
    // …and it does resume once that id really is on this side.
    expect(recentSurfaceThread("chat", buildOnly, NOW)).toBe("b1");
  });

  it("returns nothing when the conversation has no timestamp", () => {
    rememberSurfaceThread("chat", "c1");
    expect(recentSurfaceThread("chat", [thread("c1", null)], NOW)).toBeNull();
    expect(recentSurfaceThread("chat", [thread("c1", "not a date")], NOW)).toBeNull();
  });
});

describe("a corrupt stored value", () => {
  it("does not throw, and opens fresh", () => {
    localStorage.setItem(SURFACE_THREAD_KEY, "{not json");
    expect(() => recentSurfaceThread("chat", [], NOW)).not.toThrow();
    expect(recentSurfaceThread("chat", [], NOW)).toBeNull();
  });

  it("survives a stored value that is not an object", () => {
    localStorage.setItem(SURFACE_THREAD_KEY, '"a string"');
    expect(recentSurfaceThread("chat", [thread("c1", ago(MINUTE))], NOW)).toBeNull();
  });

  it("can be written over once it is corrupt", () => {
    localStorage.setItem(SURFACE_THREAD_KEY, "{not json");
    rememberSurfaceThread("chat", "c1");
    expect(recentSurfaceThread("chat", [thread("c1", ago(MINUTE))], NOW)).toBe("c1");
  });
});
