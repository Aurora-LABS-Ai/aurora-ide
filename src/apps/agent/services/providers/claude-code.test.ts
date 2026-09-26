/**
 * The Claude Code card's two pure helpers and the shape of its seeded row.
 *
 * The preset is worth pinning because three things about it are load-bearing
 * and silent when wrong: no API key must be demanded, the provider type must
 * be the one Rust routes to its own adapter, and every seeded model must be
 * billed at zero so the enrichment pass never backfills platform prices onto
 * a plan that does not charge per token.
 */

import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_PRESET,
  CLAUDE_CODE_PROVIDER_ID,
  claudeCodeHighestUsedPercent,
  claudeCodePlanLabel,
  claudeCodeResetLabel,
  claudeCodeWindowMeta,
  isClaudeCodeProvider,
} from "./claude-code";

describe("claudeCodePlanLabel", () => {
  it("capitalises the plan Claude Code reports", () => {
    expect(claudeCodePlanLabel("max")).toBe("Max");
    expect(claudeCodePlanLabel("pro")).toBe("Pro");
    expect(claudeCodePlanLabel("enterprise")).toBe("Enterprise");
  });

  it("says nothing for an unknown plan", () => {
    expect(claudeCodePlanLabel(null)).toBeNull();
    expect(claudeCodePlanLabel(undefined)).toBeNull();
    expect(claudeCodePlanLabel("  ")).toBeNull();
  });
});

describe("claudeCodeResetLabel", () => {
  it("words the countdown the way every other plan row does", () => {
    expect(
      claudeCodeResetLabel({ usedPercent: 0, resetsAtMs: 1, resetsInSeconds: 3_900 }),
    ).toBe("resets in 1h 5m");
  });

  it("says nothing when the plan gave no reset time", () => {
    // Not "resets in 0s": unknown and imminent are different facts.
    expect(
      claudeCodeResetLabel({ usedPercent: 0, resetsAtMs: null, resetsInSeconds: null }),
    ).toBeNull();
  });

  it("reads a window that is turning over now as turning over now", () => {
    expect(
      claudeCodeResetLabel({ usedPercent: 0, resetsAtMs: 1, resetsInSeconds: 0 }),
    ).toBe("resets now");
  });
});

describe("claudeCodeWindowMeta", () => {
  it("names the reset when the backend gave one", () => {
    expect(
      claudeCodeWindowMeta({ usedPercent: 42.4, resetsAtMs: 1, resetsInSeconds: 3_900 }),
    ).toBe("42% used · resets in 1h 5m");
  });

  it("does not invent a reset time when there is none", () => {
    expect(claudeCodeWindowMeta({ usedPercent: 7, resetsAtMs: null, resetsInSeconds: null })).toBe(
      "7% used",
    );
  });

  it("clamps a figure past the meter's range", () => {
    expect(claudeCodeWindowMeta({ usedPercent: 130, resetsAtMs: null, resetsInSeconds: 0 })).toBe(
      "100% used · resets now",
    );
  });
});

describe("CLAUDE_CODE_PRESET", () => {
  it("is keyed so Rust routes it to the subscription adapter", () => {
    expect(CLAUDE_CODE_PRESET.id).toBe(CLAUDE_CODE_PROVIDER_ID);
    expect(CLAUDE_CODE_PRESET.providerType).toBe("claude-code");
    expect(isClaudeCodeProvider({ id: CLAUDE_CODE_PRESET.id })).toBe(true);
    expect(isClaudeCodeProvider({ id: "anthropic" })).toBe(false);
  });

  it("never asks for an API key", () => {
    expect(CLAUDE_CODE_PRESET.requiresApiKey).toBe(false);
  });

  it("bills every seeded model at zero", () => {
    const models = CLAUDE_CODE_PRESET.customModels ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const id of models) {
      expect(CLAUDE_CODE_PRESET.modelPricing?.[id]).toEqual({
        cacheHitPerMtok: 0,
        cacheMissPerMtok: 0,
        outputPerMtok: 0,
      });
      expect(CLAUDE_CODE_PRESET.modelAliases?.[id]).toBeTruthy();
    }
  });

  it("seeds an effort picker for the Claude 5 family", () => {
    const reasoning = CLAUDE_CODE_PRESET.modelReasoning?.["claude-sonnet-5"];
    expect(reasoning?.type).toBe("effort");
    expect(reasoning?.levels).toContain("high");
  });
});

describe("claudeCodeHighestUsedPercent", () => {
  const win = (usedPercent: number) => ({ usedPercent, resetsAtMs: null, resetsInSeconds: null });
  const snap = {
    plan: "max",
    fiveHour: win(12),
    sevenDay: win(64),
    sevenDayOpus: null,
    sevenDaySonnet: win(30),
    sevenDayModels: [{ model: "Fable", window: win(71) }],
    extraUsage: null,
    fetchedAtMs: 0,
  };

  it("reports the fullest window, the one that stops the account first", () => {
    expect(claudeCodeHighestUsedPercent({ ...snap, sevenDayModels: [] })).toBe(64);
  });

  it("counts a per-model window such as Fable", () => {
    expect(claudeCodeHighestUsedPercent(snap)).toBe(71);
  });

  it("is null when the account reported no windows or no usage loaded", () => {
    expect(
      claudeCodeHighestUsedPercent({
        ...snap,
        fiveHour: null,
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayModels: [],
      }),
    ).toBeNull();
    expect(claudeCodeHighestUsedPercent(null)).toBeNull();
  });
});
