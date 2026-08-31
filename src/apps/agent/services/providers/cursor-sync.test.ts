import { beforeEach, describe, expect, it } from "vitest";

import { __test } from "./cursor-sync";
import type { LLMModel } from "@/kernel/store/useSettingsStore";
import type { ModelsDevEntry } from "./models-dev";
import type { CursorModelView } from "./cursor";
import {
  clearCursorVariants,
  cursorHasFast,
  cursorWireModel,
  primeCursorVariants,
  resolveCursorVariant,
  toRunnableModels,
} from "./cursor-variants";

const { toModelRow } = __test;

/** One catalogue id, with only the fields the grouping reads set. */
const view = (modelId: string, extra: Partial<CursorModelView> = {}): CursorModelView => ({
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
  catalogKey: "grok-4.6",
  isLegacy: false,
  ...extra,
});

/** The shape of a real account: every tier, each with a fast twin. */
const GROK = [
  "cursor-grok-4.6-low",
  "cursor-grok-4.6-low-fast",
  "cursor-grok-4.6-medium",
  "cursor-grok-4.6-medium-fast",
  "cursor-grok-4.6-high",
  "cursor-grok-4.6-high-fast",
  "cursor-grok-4.6-xhigh",
  "cursor-grok-4.6-xhigh-fast",
];

const catalog = (extra: Partial<ModelsDevEntry> = {}): ModelsDevEntry =>
  ({
    modelKey: "grok-4.6",
    providerId: "xai",
    name: "Grok 4.6",
    contextWindow: 500_000,
    maxOutputTokens: 64_000,
    supportsVision: true,
    supportsThinking: true,
    ...extra,
  }) as ModelsDevEntry;

const stored = (extra: Partial<LLMModel> = {}): LLMModel =>
  ({
    id: "cursor::cursor-grok-4.6",
    providerId: "cursor",
    modelKey: "cursor-grok-4.6",
    enabled: true,
    sortOrder: 0,
    ...extra,
  }) as LLMModel;

const grok = () => toRunnableModels(GROK.map((id) => view(id)))[0];

beforeEach(() => {
  clearCursorVariants();
  primeCursorVariants(GROK.map((id) => view(id)));
});

describe("what a model row stores", () => {
  it("is the model's own id, with no tier or Fast in it", () => {
    // Effort and Fast are things the user chooses, not part of what the model
    // is. A decorated id here would make `cursor-grok-4.6-high` the model's
    // name in the database and on the provider page — and once that string is
    // what a conversation pins, it stops matching this row, so the model's
    // context window can no longer be found.
    const row = toModelRow(grok(), undefined, catalog());

    expect(row.modelKey).toBe("cursor-grok-4.6");
    expect(row.contextWindow).toBe(500_000);
  });

  it("offers the account's tiers as the row's effort levels", () => {
    const row = toModelRow(grok(), undefined, catalog());

    expect(row.reasoning?.type).toBe("effort");
    expect(row.reasoning?.levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("keeps a context window the user set", () => {
    // The catalogue is replaced wholesale on every refresh, so reading
    // models.dev first would undo an edit on a schedule nobody sees.
    const row = toModelRow(
      grok(),
      stored({ contextWindow: 250_000 }),
      catalog({ contextWindow: 500_000 }),
    );

    expect(row.contextWindow).toBe(250_000);
  });

  it("seeds from models.dev when the row has no number yet", () => {
    const row = toModelRow(grok(), stored({}), catalog());

    expect(row.contextWindow).toBe(500_000);
  });
});

describe("turning the row plus its choices into an id to send", () => {
  it("folds the chosen tier and Fast into the id", () => {
    expect(cursorWireModel("cursor-grok-4.6", { effort: "high", fast: true })).toBe(
      "cursor-grok-4.6-high-fast",
    );
    expect(cursorWireModel("cursor-grok-4.6", { effort: "low", fast: false })).toBe(
      "cursor-grok-4.6-low",
    );
  });

  it("requires an exact effort for a family that has no undecorated id", () => {
    expect(resolveCursorVariant("cursor-grok-4.6", {})).toMatchObject({
      ok: false,
      reason: "unsupported_combination",
    });
  });

  it("rejects Fast rather than silently dropping it when a twin is missing", () => {
    clearCursorVariants();
    primeCursorVariants([view("cursor-grok-4.6-high")].map((v) => v));

    expect(resolveCursorVariant("cursor-grok-4.6", { effort: "high", fast: true })).toMatchObject({
      ok: false,
      reason: "unsupported_combination",
    });
  });

  it("answers whether the model can run fast at all", () => {
    // Asked of the group, not of one spelling: `cursor-grok-4.6-fast` exists
    // nowhere, so composing the bare id with Fast would hide a control the
    // account plainly supports.
    expect(cursorHasFast("cursor-grok-4.6", { effort: "high", thinking: false })).toBe(true);

    clearCursorVariants();
    primeCursorVariants([view("composer-2.5")]);
    expect(cursorHasFast("composer-2.5")).toBe(false);
  });
});

describe("when the catalogue has not loaded yet", () => {
  beforeEach(() => clearCursorVariants());

  it("does not invent the tier and Fast id", () => {
    expect(resolveCursorVariant("cursor-grok-4.6", { effort: "xhigh", fast: true })).toMatchObject({
      ok: false,
      reason: "catalogue_unavailable",
    });
  });

  it("reports a recoverable error instead of returning any model id", () => {
    expect(() => cursorWireModel("cursor-grok-4.6", { effort: "high" })).toThrow(
      /catalogue is not ready/i,
    );
  });
});
