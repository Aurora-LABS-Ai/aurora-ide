import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCursorVariants,
  composeCursorVariant,
  cursorHasFast,
  cursorWireModel,
  primeCursorVariants,
  splitCursorVariant,
  toRunnableModels,
} from "./cursor-variants";
import type { CursorModelView } from "./cursor";

/**
 * A catalogue row. Only the fields the grouping actually reads carry values —
 * the rest are the shape the command returns.
 */
const view = (
  modelId: string,
  extra: Partial<CursorModelView> = {},
): CursorModelView => ({
  modelId,
  displayModelId: null,
  displayName: null,
  displayNameShort: null,
  aliases: [],
  supportsThinking: false,
  maxMode: false,
  enabled: false,
  sortOrder: 0,
  baseModelId: modelId.replace(/-fast$/, ""),
  isFast: modelId.endsWith("-fast"),
  catalogKey: null,
  isLegacy: false,
  ...extra,
});

/** The real shape of one model on a live account (checked against the wire). */
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

describe("splitCursorVariant", () => {
  it("takes an id apart into the model and the way it runs", () => {
    expect(splitCursorVariant("cursor-grok-4.6-high-fast")).toEqual({
      stem: "cursor-grok-4.6",
      thinking: false,
      effort: "high",
      fast: true,
    });
  });

  it("reads thinking and effort together", () => {
    expect(splitCursorVariant("cursor-claude-opus-5-thinking-max-fast")).toEqual({
      stem: "cursor-claude-opus-5",
      thinking: true,
      effort: "max",
      fast: true,
    });
  });

  it("reads the pair written the other way round", () => {
    // Cursor writes both orders. A fixed-order strip leaves half the catalogue
    // partly decorated, which splits one model across two picker rows.
    const a = splitCursorVariant("cursor-claude-4.5-opus-high-thinking");
    expect(a.stem).toBe("cursor-claude-4.5-opus");
    expect(a.thinking).toBe(true);
    expect(a.effort).toBe("high");
  });

  it("leaves an undecorated id alone", () => {
    expect(splitCursorVariant("cursor-composer-2.5")).toEqual({
      stem: "cursor-composer-2.5",
      thinking: false,
      effort: null,
      fast: false,
    });
  });

  it("does not mistake a version number for an effort tier", () => {
    // `-max` is a tier; `4.6` is not. A greedy strip that ran on digits would
    // reduce every model to its family name and merge them all into one row.
    expect(splitCursorVariant("cursor-gpt-5.3-codex").stem).toBe("cursor-gpt-5.3-codex");
  });
});

describe("cursorWireModel", () => {
  beforeEach(() => {
    clearCursorVariants();
    primeCursorVariants(GROK.map((id) => view(id)));
  });

  it("swaps the effort tier for another the account carries", () => {
    expect(cursorWireModel("cursor-grok-4.6-high", { effort: "low" })).toBe(
      "cursor-grok-4.6-low",
    );
  });

  it("adds Fast to the tier that is already selected", () => {
    expect(cursorWireModel("cursor-grok-4.6-high", { fast: true })).toBe(
      "cursor-grok-4.6-high-fast",
    );
  });

  it("takes Fast back off", () => {
    expect(cursorWireModel("cursor-grok-4.6-high-fast", { fast: false })).toBe(
      "cursor-grok-4.6-high",
    );
  });

  it("runs non-fast rather than sending an id the account cannot reach", () => {
    // The whole reason composition is checked against the catalogue: a model
    // with no fast twin sent `-fast` fails the turn with nothing to explain it.
    primeCursorVariants([view("cursor-composer-2.5")]);
    expect(cursorWireModel("cursor-composer-2.5", { fast: true })).toBe(
      "cursor-composer-2.5",
    );
  });

  it("ignores thinking on a model that has no thinking ids", () => {
    expect(cursorWireModel("cursor-grok-4.6-high", { thinking: true })).toBe(
      "cursor-grok-4.6-high",
    );
  });

  it("drops thinking when the switch is off", () => {
    primeCursorVariants(
      [
        "cursor-claude-opus-5-high",
        "cursor-claude-opus-5-thinking-high",
      ].map((id) => view(id)),
    );
    expect(
      cursorWireModel("cursor-claude-opus-5-thinking-high", { thinking: false }),
    ).toBe("cursor-claude-opus-5-high");
  });

  it("falls back to the picked id when nothing has been loaded", () => {
    // The index is empty before the catalogue syncs. The picked id came from
    // that same catalogue, so it is always safe to send as-is — a turn must
    // not fail because a background refresh had not finished.
    clearCursorVariants();
    expect(cursorWireModel("cursor-grok-4.6-high", { fast: true, effort: "low" })).toBe(
      "cursor-grok-4.6-high",
    );
  });

  it("keeps what the id already says when asked for nothing", () => {
    expect(cursorWireModel("cursor-grok-4.6-medium-fast")).toBe(
      "cursor-grok-4.6-medium-fast",
    );
  });
});

describe("cursorHasFast", () => {
  it("is true only where the account carries a twin", () => {
    primeCursorVariants([
      ...GROK.map((id) => view(id)),
      view("cursor-composer-2.5"),
    ]);
    expect(cursorHasFast("cursor-grok-4.6-high")).toBe(true);
    expect(cursorHasFast("cursor-composer-2.5")).toBe(false);
  });
});

describe("composeCursorVariant", () => {
  it("writes the tokens in the order Cursor writes them", () => {
    expect(
      composeCursorVariant("cursor-claude-opus-5", {
        thinking: true,
        effort: "high",
        fast: true,
      }),
    ).toBe("cursor-claude-opus-5-thinking-high-fast");
  });
});

describe("toRunnableModels", () => {
  it("collapses eight ids into one pickable model", () => {
    const [model] = toRunnableModels(GROK.map((id) => view(id)));
    expect(model.stem).toBe("cursor-grok-4.6");
    expect(model.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(model.hasFast).toBe(true);
    expect(model.hasThinking).toBe(false);
    expect(model.variantIds).toHaveLength(8);
  });

  it("gives the row an id that can actually be sent", () => {
    // There is no plain `cursor-grok-4.6` on the account. A row identified by
    // one would print a model that does not exist and fail on first use.
    const [model] = toRunnableModels(GROK.map((id) => view(id)));
    expect(GROK).toContain(model.representativeId);
    expect(model.representativeId).not.toMatch(/-fast$/);
  });

  it("prefers high over the most expensive tier as the default", () => {
    // Picking `xhigh` for someone spends real time on every turn — that is a
    // decision, not a default. The tier is one click away in the picker.
    const [model] = toRunnableModels(GROK.map((id) => view(id)));
    expect(model.representativeId).toBe("cursor-grok-4.6-high");
  });

  it("marks a model whose ids are all thinking as not switchable", () => {
    const models = toRunnableModels(
      ["cursor-claude-fable-5-thinking-high", "cursor-claude-fable-5-thinking-xhigh"].map(
        (id) => view(id),
      ),
    );
    expect(models[0].hasThinking).toBe(true);
    expect(models[0].thinkingOnly).toBe(true);
  });

  it("marks a model that has both as switchable", () => {
    const models = toRunnableModels(
      ["cursor-claude-opus-5-high", "cursor-claude-opus-5-thinking-high"].map((id) =>
        view(id),
      ),
    );
    expect(models[0].thinkingOnly).toBe(false);
  });

  it("is old only when every id under it is", () => {
    const models = toRunnableModels([
      view("cursor-x-low", { isLegacy: true }),
      view("cursor-x-high", { isLegacy: false }),
    ]);
    expect(models[0].isLegacy).toBe(false);
  });

  it("is on when any id under it is on", () => {
    const models = toRunnableModels([
      view("cursor-x-low", { enabled: false }),
      view("cursor-x-high", { enabled: true }),
    ]);
    expect(models[0].enabled).toBe(true);
  });

  it("names Grok as Cursor's own", () => {
    // Sitting beside Claude and GPT rows from other providers, a bare "Grok"
    // would read as a third party's model that happens to be reachable here.
    const [model] = toRunnableModels(GROK.map((id) => view(id)));
    expect(model.label).toBe("Cursor Grok 4.6");
  });

  it("strips the variant words out of Cursor's own display name", () => {
    // `displayName` describes ONE id. Used verbatim the row would be named
    // after whichever variant happened to be representative, and would rename
    // itself when the user changed the effort.
    const models = toRunnableModels([
      view("cursor-claude-opus-5-high", { displayName: "Claude Opus 5 High" }),
      view("cursor-claude-opus-5-high-fast", { displayName: "Claude Opus 5 High Fast" }),
    ]);
    expect(models[0].label).toBe("Claude Opus 5");
  });

  it("calls the account's router Auto", () => {
    const models = toRunnableModels([view("cursor-default")]);
    expect(models[0].label).toBe("Auto");
  });
});
