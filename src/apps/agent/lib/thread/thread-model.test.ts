import { describe, expect, it } from "vitest";

import {
  normalizeThreadModelSelection,
  pinnedThreadModel,
} from "@/apps/agent/lib/thread/thread-model";

const row = (id: string, model?: string | null) => ({ id, model });

const source = (rows: Array<{ id: string; model?: string | null }>) => ({
  threads: rows,
  allThreads: rows,
});

describe("pinnedThreadModel", () => {
  it("returns the model the conversation is pinned to", () => {
    const state = source([row("a", "prov:alpha"), row("b", "other:beta")]);
    expect(pinnedThreadModel(state, "a")).toBe("prov:alpha");
    expect(pinnedThreadModel(state, "b")).toBe("other:beta");
  });

  /** The whole point: chat B's pick must not surface in chat A. */
  it("keeps two conversations on different models", () => {
    const state = source([row("a", "prov:alpha"), row("b", "other:beta")]);
    expect(pinnedThreadModel(state, "a")).not.toBe(pinnedThreadModel(state, "b"));
  });

  /** A draft has no thread — the caller falls back to the user's default. */
  it("reports nothing for a draft", () => {
    expect(pinnedThreadModel(source([row("a", "prov:alpha")]), null)).toBeNull();
    expect(pinnedThreadModel(source([]), undefined)).toBeNull();
  });

  /** Chats that predate per-conversation models carry no model at all. */
  it("reports nothing for a chat that has never run a turn", () => {
    const state = source([row("a"), row("b", null), row("c", "")]);
    expect(pinnedThreadModel(state, "a")).toBeNull();
    expect(pinnedThreadModel(state, "b")).toBeNull();
    // An empty string is an absent model, not a model named "".
    expect(pinnedThreadModel(state, "c")).toBeNull();
  });

  it("reports nothing for a thread it has never heard of", () => {
    expect(pinnedThreadModel(source([row("a", "prov:alpha")]), "ghost")).toBeNull();
  });

  /** `allThreads` covers every project; `threads` is only the active one. A
   *  chat docked from another project must still resolve. */
  it("falls back to the scoped list when the global one hasn't caught up", () => {
    const state = {
      threads: [row("a", "prov:alpha")],
      allThreads: [],
    };
    expect(pinnedThreadModel(state, "a")).toBe("prov:alpha");
  });
});

describe("normalizeThreadModelSelection", () => {
  const models = [
    { providerId: "cursor", modelKey: "cursor-grok-4.6" },
    { providerId: "other", modelKey: "alpha" },
  ];

  it("migrates a decorated Cursor pin when its stable row exists", () => {
    expect(
      normalizeThreadModelSelection("cursor:cursor-grok-4.6-high-fast", models),
    ).toBe("cursor:cursor-grok-4.6");
  });

  it("keeps an exact row even when its name ends in a modifier word", () => {
    const exact = [...models, { providerId: "cursor", modelKey: "company-high" }];
    expect(normalizeThreadModelSelection("cursor:company-high", exact)).toBe(
      "cursor:company-high",
    );
  });

  it("does not strip a suffix unless the resulting stable row is real", () => {
    expect(normalizeThreadModelSelection("cursor:unknown-high-fast", models)).toBe(
      "cursor:unknown-high-fast",
    );
    expect(normalizeThreadModelSelection("other:alpha-high", models)).toBe(
      "other:alpha-high",
    );
  });
});
