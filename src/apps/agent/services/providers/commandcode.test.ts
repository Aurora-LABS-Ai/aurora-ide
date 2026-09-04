/**
 * Which Command Code models Aurora advertises as thinking.
 *
 * The rule is about the GATEWAY, not the models, so it is worth pinning: every
 * MiniMax id goes out over the Anthropic Messages wire with no `thinking`
 * block, and returns zero reasoning deltas no matter what is asked of it.
 * Verified live on 2026-09-03 against `/alpha/generate`.
 */

import { describe, expect, it } from "vitest";

import { __test } from "@/apps/agent/services/providers/commandcode";

const { reasonsOnCommandCode } = __test;

describe("reasonsOnCommandCode", () => {
  it("turns thinking off for every MiniMax id, whatever models.dev says", () => {
    // models.dev is right that these models reason. They just cannot do it
    // through this gateway, and a toggle that does nothing is worse than none.
    expect(reasonsOnCommandCode("MiniMaxAI/MiniMax-M3", true)).toBe(false);
    expect(reasonsOnCommandCode("MiniMaxAI/MiniMax-M2.7", true)).toBe(false);
    expect(reasonsOnCommandCode("minimaxai/minimax-m2.5", undefined)).toBe(false);
  });

  it("keeps what models.dev knows for everyone else", () => {
    expect(reasonsOnCommandCode("zai-org/GLM-5.2", true)).toBe(true);
    expect(reasonsOnCommandCode("Qwen/Qwen3.8-Flash", false)).toBe(false);
  });

  it("defaults unknown models to thinking, because the endpoint usually does", () => {
    // LongCat is not in models.dev and streams reasoning anyway, which is why
    // the default leans on rather than off.
    expect(reasonsOnCommandCode("meituan/LongCat-2.0:free", undefined)).toBe(true);
  });

  it("does not match a model that merely mentions minimax later in its id", () => {
    // The rule is about who serves the model, and that is the leading segment.
    expect(reasonsOnCommandCode("somevendor/not-minimax-clone", true)).toBe(true);
  });
});
