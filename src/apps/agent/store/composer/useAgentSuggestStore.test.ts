import { beforeEach, describe, expect, it } from "vitest";

import {
  classifyOutcome,
  looksPasted,
  useAgentSuggestStore,
} from "@/apps/agent/store/composer/useAgentSuggestStore";

beforeEach(() => {
  useAgentSuggestStore.setState({ byThread: {}, pendingByThread: {}, offerByThread: {} });
});

describe("useAgentSuggestStore", () => {
  it("keeps suggestions per thread and clears them independently", () => {
    const store = useAgentSuggestStore.getState();
    store.setSuggestions("t1", ["Yes, apply it", "Show me the diff"]);
    store.setSuggestions("t2", ["Run the tests"]);

    expect(useAgentSuggestStore.getState().byThread.t1).toHaveLength(2);
    expect(useAgentSuggestStore.getState().byThread.t2).toHaveLength(1);

    store.clear("t1");
    expect(useAgentSuggestStore.getState().byThread.t1).toBeUndefined();
    expect(useAgentSuggestStore.getState().byThread.t2).toHaveLength(1);
  });

  it("treats an empty result as a clear", () => {
    const store = useAgentSuggestStore.getState();
    store.setSuggestions("t3", ["One thing"]);
    store.setSuggestions("t3", []);
    expect(useAgentSuggestStore.getState().byThread.t3).toBeUndefined();
  });

  it("shows a run's suggestions only while it is still the pending one", () => {
    const store = useAgentSuggestStore.getState();
    store.startRun("t", "old");
    store.startRun("t", "new");
    store.finishRun("t", "old", ["Stale reply"]);
    expect(useAgentSuggestStore.getState().byThread.t).toBeUndefined();
    expect(useAgentSuggestStore.getState().pendingByThread.t).toBe("new");

    store.finishRun("t", "new", ["Fresh reply"]);
    expect(useAgentSuggestStore.getState().byThread.t).toEqual(["Fresh reply"]);
    expect(useAgentSuggestStore.getState().pendingByThread.t).toBeUndefined();
  });

  /** Tapping a chip clears the chips, but the send that follows still has to
   *  know which one it was. */
  it("remembers the tapped chip after the chips are cleared, until the send", () => {
    const store = useAgentSuggestStore.getState();
    store.startRun("t", "r1");
    store.finishRun("t", "r1", ["Run the tests", "Show the diff"]);
    store.markTapped("t", 1, "Show the diff");
    store.clear("t");

    const outcome = useAgentSuggestStore.getState().takeOutcome("t", "Show the diff");
    expect(outcome).toEqual({
      runId: "r1",
      shown: ["Run the tests", "Show the diff"],
      action: "tapped",
      tappedIndex: 1,
      sentText: "Show the diff",
    });
    // Recorded once.
    expect(useAgentSuggestStore.getState().takeOutcome("t", "again")).toBeNull();
  });

  it("records a send before the suggestions arrived", () => {
    const store = useAgentSuggestStore.getState();
    store.startRun("t", "r1");
    expect(useAgentSuggestStore.getState().takeOutcome("t", "  go  ")).toEqual({
      runId: "r1",
      shown: [],
      action: "sent_before_ready",
      sentText: "go",
    });
    // The late answer is not shown for a conversation that has moved on.
    store.finishRun("t", "r1", ["Late"]);
    expect(useAgentSuggestStore.getState().byThread.t).toBeUndefined();
  });

  it("has nothing to record when nothing was offered", () => {
    expect(useAgentSuggestStore.getState().takeOutcome("t", "hello")).toBeNull();
  });
});

describe("classifyOutcome", () => {
  const offer = { runId: "r", shown: ["Run the tests", "Show the diff"] };

  it("calls a tapped chip sent with changes an edit", () => {
    const outcome = classifyOutcome(
      { ...offer, tapped: { index: 0, text: "Run the tests" } },
      "Run the tests and lint",
    );
    expect(outcome.action).toBe("tapped_edited");
    expect(outcome.tappedIndex).toBe(0);
  });

  it("counts a typed message that matches a chip as that chip", () => {
    const outcome = classifyOutcome(offer, "show the diff");
    expect(outcome.action).toBe("tapped");
    expect(outcome.tappedIndex).toBe(1);
  });

  it("calls anything else typed", () => {
    expect(classifyOutcome(offer, "fix it, don't ask me").action).toBe("typed");
  });

  // Real sends from the first week's log that were recorded as "typed their
  // own" and went back into the brief as examples of the developer's voice.
  it("calls a pasted log, command or path pasted, not typed", () => {
    const log =
      "T /portal/billing 200 in 59ms (next.js: 38ms, application-code: 21ms)\n" +
      "[browser] Detected `scroll-behavior: smooth` on the `<html>` element.\n" +
      "[browser] To disable it add data-scroll-behavior to your <html>.";
    const command =
      'KICK_PROBE_DB="C:/Users/Alvan/AppData/Roaming/quantumgram-app/quantum-kick.db" ' +
      '"E:/QuantumHUB-Infrustructure/node_modules/electron/dist/electron.exe" scripts/probe-kick-mobile-signin';
    const prompt = "PS E:\\QuantumHUB-Infrustructure> pnpm --filter quantumkick-core run login-probe -- --user laylagomez8672";
    for (const sent of [log, command, prompt]) {
      expect(classifyOutcome(offer, sent).action).toBe("pasted");
    }
  });

  it("keeps a short typed message typed even with a line break", () => {
    expect(classifyOutcome(offer, "check new package").action).toBe("typed");
    expect(classifyOutcome(offer, "worked?\nthis plan").action).toBe("typed");
    expect(looksPasted("git status")).toBe(false);
  });
});
