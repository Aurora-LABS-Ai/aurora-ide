import { describe, expect, it } from "vitest";

import { formatTokens, prettyModel } from "@/apps/agent/lib/thread/model-label";

const CATALOG = [
  { modelKey: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { modelKey: "claude-opus-4-8", label: "Claude Opus 4.8" },
];

describe("prettyModel", () => {
  it("prefers the catalog label", () => {
    expect(prettyModel("deepseek:deepseek-v4-pro", CATALOG)).toBe("DeepSeek V4 Pro");
    expect(prettyModel("agentrouter:claude-opus-4-8", CATALOG)).toBe("Claude Opus 4.8");
  });

  it("drops a provider-instance UUID rather than showing an internal key", () => {
    // This is what the panel was rendering verbatim before.
    expect(
      prettyModel("dd6cdd64-6368-4a53-9ff7-e178aa9a6bac:claude-opus-4-8-r", CATALOG),
    ).toBe("Claude Opus 4 8 R");
  });

  it("title-cases an unknown key and upper-cases short segments", () => {
    expect(prettyModel("agentrouter:glm-5.2", [])).toBe("GLM 5.2");
    // A version segment must keep its case: the old rule made this "GPT 4O Mini".
    expect(prettyModel("openai:gpt-4o-mini", [])).toBe("GPT 4o Mini");
    expect(prettyModel("deepseek:deepseek-v4-pro", [])).toBe("Deepseek V4 PRO");
  });

  it("never renders an empty label", () => {
    expect(prettyModel("", CATALOG)).toBe("Unknown model");
    expect(prettyModel("   ", CATALOG)).toBe("Unknown model");
    expect(prettyModel("openai:", CATALOG)).toBe("openai:");
  });
});

describe("formatTokens", () => {
  it("scales without false precision", () => {
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(322_000)).toBe("322K");
    expect(formatTokens(1_700_000)).toBe("1.7M");
    expect(formatTokens(12_400_000)).toBe("12.4M");
    expect(formatTokens(2_000_000_000)).toBe("2B");
  });
});
