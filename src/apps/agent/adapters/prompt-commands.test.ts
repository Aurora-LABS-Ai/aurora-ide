import { describe, expect, it } from "vitest";

import { isChatPromptCommand, type PromptCommand } from "@/apps/agent/adapters/prompt-commands";

const command = (kind: PromptCommand["kind"], skillSource?: PromptCommand["skillSource"]): PromptCommand => ({
  key: `${kind}:${skillSource ?? "none"}`,
  kind,
  title: kind,
  subtitle: "",
  description: "",
  sourceLabel: "",
  haystack: "",
  skillSource,
});

describe("Chat slash commands", () => {
  it("rejects project rules and project skills, including legacy skills without a source tag", () => {
    expect(isChatPromptCommand(command("rule"))).toBe(false);
    expect(isChatPromptCommand(command("skill", "workspace"))).toBe(false);
    expect(isChatPromptCommand(command("skill"))).toBe(false);
  });

  it("keeps explicit global and built-in skills and shared directives", () => {
    expect(isChatPromptCommand(command("skill", "global"))).toBe(true);
    expect(isChatPromptCommand(command("skill", "builtin"))).toBe(true);
    expect(isChatPromptCommand(command("mcp"))).toBe(true);
    expect(isChatPromptCommand(command("image"))).toBe(true);
  });
});
