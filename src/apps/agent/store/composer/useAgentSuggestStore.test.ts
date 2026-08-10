import { describe, expect, it } from "vitest";

import { useAgentSuggestStore } from "@/apps/agent/store/composer/useAgentSuggestStore";

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
});
