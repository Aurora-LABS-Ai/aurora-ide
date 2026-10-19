import { describe, expect, it } from "vitest";

import { reasoningChoices, reasoningSummary } from "./model-settings";

const labels = (r: Parameters<typeof reasoningChoices>[0], max?: number) =>
  reasoningChoices(r, max).map((c) => (c.current ? `[${c.label}]` : c.label));

describe("reasoning choices", () => {
  it("offers Off and the levels, without a duplicate 'none', and names X-High", () => {
    expect(labels({ type: "effort", levels: ["none", "low", "medium", "high"], default: "high", enabled: true })).toEqual([
      "Off",
      "Low",
      "Medium",
      "[High]",
    ]);
    expect(labels({ type: "effort", levels: ["low", "xhigh"], default: "xhigh", enabled: true })).toEqual(["Off", "Low", "[X-High]"]);
  });

  it("writes the chosen level, and Off as reasoning disabled", () => {
    const r = { type: "effort" as const, levels: ["low", "high"], default: "high", enabled: true };
    const [off, low] = reasoningChoices(r);
    expect(low.next).toEqual({ ...r, enabled: true, default: "low" });
    expect(off.next).toEqual({ ...r, enabled: false });
  });

  it("has no Off for a model that always reasons (Antigravity's folded tiers)", () => {
    expect(labels({ type: "effort", levels: ["low", "medium", "high"], default: "high", toggleable: false })).toEqual([
      "Low",
      "Medium",
      "[High]",
    ]);
  });

  it("offers thinking on or off for a switch-only model", () => {
    expect(labels({ type: "toggle", default: true })).toEqual(["Off", "[Thinking]"]);
    expect(labels({ type: "toggle", default: true, enabled: false })).toEqual(["[Off]", "Thinking"]);
  });

  it("lists budget presets, and keeps a stored size that is none of them", () => {
    const r = { type: "budget" as const, min: 1024, default: 16_000, enabled: true };
    expect(labels(r, 64_000)).toEqual(["Off", "1k", "4k", "8k", "[16k]", "Max"]);
    expect(labels({ ...r, default: 12_000 }, 64_000)).toEqual(["Off", "1k", "4k", "8k", "[12k]", "16k", "Max"]);
    expect(reasoningChoices(r, 64_000)[2].next).toEqual({ ...r, enabled: true, default: 4000 });
  });

  it("gives nothing to choose for a model without reasoning", () => {
    expect(reasoningChoices(undefined)).toEqual([]);
    expect(reasoningSummary(undefined)).toBeNull();
  });

  it("summarises the current choice as the row's grey word", () => {
    expect(reasoningSummary({ type: "effort", levels: ["low", "high"], default: "low", enabled: true })).toBe("Low");
    expect(reasoningSummary({ type: "effort", levels: ["low", "high"], default: "low", enabled: false })).toBe("Off");
    expect(reasoningSummary({ type: "toggle", default: true })).toBe("Thinking");
  });
});
