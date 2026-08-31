import { beforeEach, describe, expect, it } from "vitest";

import { resetFastPreferenceCache, setFastOn } from "@/apps/agent/lib/model/cursor-fast";
import {
  cursorFastAvailable,
  cursorRunOptions,
  resolveCursorModelRun,
} from "@/apps/agent/services/providers/cursor-run";
import {
  clearCursorVariants,
  primeCursorVariants,
} from "@/apps/agent/services/providers/cursor-variants";
import type { CursorModelView } from "@/apps/agent/services/providers/cursor";

const view = (modelId: string): CursorModelView => ({
  modelId,
  displayModelId: null,
  displayName: null,
  displayNameShort: null,
  aliases: [],
  supportsThinking: false,
  maxMode: false,
  enabled: true,
  sortOrder: 0,
  baseModelId: modelId.replace(/-fast$/, ""),
  isFast: modelId.endsWith("-fast"),
  catalogKey: null,
  isLegacy: false,
});

beforeEach(() => {
  localStorage.clear();
  resetFastPreferenceCache();
  clearCursorVariants();
});

describe("Cursor's model-row controls", () => {
  it("does not turn effort-only Grok into a thinking variant", () => {
    primeCursorVariants(
      ["cursor-grok-4.6-high", "cursor-grok-4.6-high-fast"].map(view),
    );
    const model = {
      id: "cursor::cursor-grok-4.6",
      modelKey: "cursor-grok-4.6",
      reasoning: {
        type: "effort" as const,
        levels: ["high"],
        default: "high",
        toggleable: false,
      },
    };
    setFastOn(model.id, true);

    expect(cursorRunOptions(model)).toEqual({
      thinking: false,
      effort: "high",
      fast: true,
    });
    expect(resolveCursorModelRun(model)).toMatchObject({
      ok: true,
      wireModel: "cursor-grok-4.6-high-fast",
    });
  });

  it("keeps a thinking-only family on its real thinking id", () => {
    primeCursorVariants([view("cursor-claude-opus-5-thinking-high")]);
    const model = {
      id: "cursor::cursor-claude-opus-5",
      modelKey: "cursor-claude-opus-5",
      reasoning: {
        type: "effort" as const,
        levels: ["high"],
        default: "high",
        toggleable: false,
      },
    };

    expect(resolveCursorModelRun(model)).toMatchObject({
      ok: true,
      wireModel: "cursor-claude-opus-5-thinking-high",
    });
  });

  it("reports Fast unavailable for only the unsupported effort tier", () => {
    primeCursorVariants(
      ["gpt-5.4-low", "gpt-5.4-medium", "gpt-5.4-medium-fast"].map(view),
    );
    const low = {
      modelKey: "gpt-5.4",
      reasoning: {
        type: "effort" as const,
        levels: ["low", "medium"],
        default: "low",
        toggleable: false,
      },
    };
    const medium = {
      ...low,
      reasoning: { ...low.reasoning, default: "medium" },
    };

    expect(cursorFastAvailable(low)).toBe(false);
    expect(cursorFastAvailable(medium)).toBe(true);
    expect(resolveCursorModelRun(low, true)).toMatchObject({
      ok: false,
      reason: "unsupported_combination",
    });
  });
});
