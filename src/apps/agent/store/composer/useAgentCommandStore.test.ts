import { describe, expect, it } from "vitest";

import { IMAGE_COMMAND, type PromptCommand } from "@/apps/agent/adapters/prompt-commands";
import {
  buildCommandSelection,
  composerCommands,
  useAgentCommandStore,
} from "@/apps/agent/store/composer/useAgentCommandStore";

const skill: PromptCommand = {
  key: "skill:s1",
  kind: "skill",
  title: "Brand kit",
  subtitle: "brand-kit",
  description: "",
  sourceLabel: "Built-in Skill",
  haystack: "brand kit",
  skillStorageKey: "s1",
};

const mcp: PromptCommand = {
  key: "mcp:m1",
  kind: "mcp",
  title: "Linear",
  subtitle: "3 tools",
  description: "",
  sourceLabel: "MCP Server",
  haystack: "linear",
  mcpServerId: "m1",
};

describe("buildCommandSelection", () => {
  it("derives each directive kind into its own channel", () => {
    const selection = buildCommandSelection([skill, mcp, IMAGE_COMMAND]);
    expect(selection).toEqual({
      explicitSkillKeys: ["s1"],
      ruleFilenames: [],
      mcpServerNames: ["Linear"],
      imageRequested: true,
    });
  });

  it("reports no image request when /image was not attached", () => {
    expect(buildCommandSelection([skill]).imageRequested).toBe(false);
    expect(buildCommandSelection([]).imageRequested).toBe(false);
  });
});

describe("useAgentCommandStore", () => {
  it("stages per composer and dedupes by key", () => {
    const store = useAgentCommandStore.getState();
    store.add("c1", IMAGE_COMMAND);
    store.add("c1", IMAGE_COMMAND);
    store.add("c2", skill);

    expect(composerCommands(useAgentCommandStore.getState(), "c1")).toHaveLength(1);
    expect(composerCommands(useAgentCommandStore.getState(), "c2")).toEqual([skill]);

    store.clear("c1");
    expect(composerCommands(useAgentCommandStore.getState(), "c1")).toEqual([]);
    expect(composerCommands(useAgentCommandStore.getState(), "c2")).toHaveLength(1);
    store.clear("c2");
  });
});
