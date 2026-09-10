/**
 * Provider categories — the rules that keep the rail honest.
 *
 * The two invariants worth guarding: every provider appears exactly once, and
 * the two system categories can never be edited away. Everything else here is
 * a consequence of one of those.
 */

import { describe, expect, it } from "vitest";

import {
  addCategory,
  assignProviderToCategory,
  BUILT_IN_CATEGORY_ID,
  categoryOf,
  CUSTOM_CATEGORY_ID,
  deleteCategory,
  emptyProviderCategoryState,
  moveCategory,
  normalizeCategoryName,
  normalizeProviderCategories,
  recolorCategory,
  renameCategory,
  sectionsFor,
  type ProviderCategoryState,
} from "./provider-categories";

/** A state with one user category, which is the interesting starting point. */
function withCategory(name = "Coding plans"): { state: ProviderCategoryState; id: string } {
  const made = addCategory(emptyProviderCategoryState(), name);
  if (!made) throw new Error("fixture: the category should have been accepted");
  return made;
}

const providers = [
  { id: "ark", isCustom: false },
  { id: "kenari", isCustom: false },
  { id: "uuid-vectide", isCustom: true },
  { id: "uuid-9inference", isCustom: true },
];

describe("the system categories", () => {
  it("exist from the very first render", () => {
    const state = emptyProviderCategoryState();
    expect(state.categories.map((c) => c.id)).toEqual([
      BUILT_IN_CATEGORY_ID,
      CUSTOM_CATEGORY_ID,
    ]);
  });

  /** Their names describe where rows came from; a rename would make them lie. */
  it("cannot be renamed, recoloured or deleted", () => {
    const state = emptyProviderCategoryState();
    expect(renameCategory(state, BUILT_IN_CATEGORY_ID, "Mine")).toBeNull();
    expect(recolorCategory(state, BUILT_IN_CATEGORY_ID, "accent")).toBe(state);
    expect(deleteCategory(state, CUSTOM_CATEGORY_ID)).toBe(state);
  });

  /** A stored `system: true` must not make a user category undeletable. */
  it("are decided by id, never by what was stored", () => {
    const state = normalizeProviderCategories({
      categories: [{ id: "cat-1", name: "Sneaky", color: "accent", order: 0, system: true }],
      assignments: {},
    });
    expect(state.categories.find((c) => c.id === "cat-1")?.system).toBe(false);
    expect(deleteCategory(state, "cat-1").categories.some((c) => c.id === "cat-1")).toBe(false);
  });

  it("sort below the categories you made", () => {
    const { state } = withCategory();
    const sections = sectionsFor(state, providers);
    expect(sections.map((s) => s.category.name)).toEqual([
      "Coding plans",
      "Built-in",
      "Custom",
    ]);
  });
});

describe("adding a category", () => {
  it("refuses a name that is empty or only whitespace", () => {
    const state = emptyProviderCategoryState();
    expect(addCategory(state, "")).toBeNull();
    expect(addCategory(state, "   ")).toBeNull();
  });

  /** Two identically named sections in one rail cannot be told apart. */
  it("refuses a duplicate name, whatever its case", () => {
    const { state } = withCategory("Coding plans");
    expect(addCategory(state, "Coding plans")).toBeNull();
    expect(addCategory(state, "coding plans")).toBeNull();
    expect(addCategory(state, "Built-in")).toBeNull();
  });

  it("collapses inner whitespace and caps the length", () => {
    expect(normalizeCategoryName("  Coding    plans  ")).toBe("Coding plans");
    expect(normalizeCategoryName("x".repeat(60))?.length).toBe(32);
    expect(normalizeCategoryName("  ")).toBeNull();
  });
});

describe("filing a provider", () => {
  it("puts an unfiled provider in the home its origin implies", () => {
    const state = emptyProviderCategoryState();
    expect(categoryOf(state, { id: "ark", isCustom: false })).toBe(BUILT_IN_CATEGORY_ID);
    expect(categoryOf(state, { id: "x", isCustom: true })).toBe(CUSTOM_CATEGORY_ID);
  });

  it("moves a built-in row into a category you made", () => {
    const { state, id } = withCategory();
    const next = assignProviderToCategory(state, "ark", id, false);
    expect(categoryOf(next, { id: "ark", isCustom: false })).toBe(id);
    const sections = sectionsFor(next, providers);
    expect(sections[0].providers.map((p) => p.id)).toEqual(["ark"]);
    // And it is GONE from Built-in, not drawn twice.
    expect(sections.find((s) => s.category.id === BUILT_IN_CATEGORY_ID)?.providers).toEqual([
      { id: "kenari", isCustom: false },
    ]);
  });

  /**
   * Two stored states that draw identically are a bug waiting to be found, so
   * "filed under my own home" is stored as unfiled.
   */
  it("stores a move to its own home as unfiled rather than as an assignment", () => {
    const state = emptyProviderCategoryState();
    const next = assignProviderToCategory(state, "ark", BUILT_IN_CATEGORY_ID, false);
    expect(next.assignments).toEqual({});
  });

  it("ignores a category that does not exist instead of hiding the row", () => {
    const state = emptyProviderCategoryState();
    const next = assignProviderToCategory(state, "ark", "cat-ghost", false);
    expect(next.assignments).toEqual({});
    expect(categoryOf(next, { id: "ark", isCustom: false })).toBe(BUILT_IN_CATEGORY_ID);
  });

  it("unfiles on null", () => {
    const { state, id } = withCategory();
    const filed = assignProviderToCategory(state, "ark", id, false);
    const unfiled = assignProviderToCategory(filed, "ark", null, false);
    expect(categoryOf(unfiled, { id: "ark", isCustom: false })).toBe(BUILT_IN_CATEGORY_ID);
  });
});

describe("deleting a category", () => {
  /**
   * Refusing to delete a non-empty category would make someone move six rows
   * by hand before they are allowed to undo a naming decision.
   */
  it("returns its providers to their home rather than deleting them", () => {
    const { state, id } = withCategory();
    let next = assignProviderToCategory(state, "ark", id, false);
    next = assignProviderToCategory(next, "uuid-vectide", id, true);
    next = deleteCategory(next, id);

    expect(next.assignments).toEqual({});
    const sections = sectionsFor(next, providers);
    expect(sections.map((s) => s.category.name)).toEqual(["Built-in", "Custom"]);
    // Each row went to the home its own origin implies, not all to one bucket.
    expect(sections[0].providers.map((p) => p.id)).toEqual(["ark", "kenari"]);
    expect(sections[1].providers.map((p) => p.id)).toEqual([
      "uuid-vectide",
      "uuid-9inference",
    ]);
  });

  /** An assignment pointing at a deleted category must not hide the row. */
  it("drops a dangling assignment on load", () => {
    const state = normalizeProviderCategories({
      categories: [],
      assignments: { ark: "cat-that-was-deleted" },
    });
    expect(state.assignments).toEqual({});
    expect(sectionsFor(state, providers).map((s) => s.category.name)).toEqual([
      "Built-in",
      "Custom",
    ]);
  });
});

describe("the rail's sections", () => {
  /**
   * A category you just made has to appear before it has anything in it, or
   * there is nowhere to put the first provider.
   */
  it("keeps an empty category you made", () => {
    const { state } = withCategory("Tokens");
    const sections = sectionsFor(state, providers);
    expect(sections[0]).toMatchObject({ providers: [] });
    expect(sections[0].category.name).toBe("Tokens");
  });

  /** The seeds are leftovers, not destinations, so an empty one draws nothing. */
  it("omits a system category once it is empty", () => {
    const { state, id } = withCategory();
    let next = assignProviderToCategory(state, "ark", id, false);
    next = assignProviderToCategory(next, "kenari", id, false);
    const names = sectionsFor(next, providers).map((s) => s.category.name);
    expect(names).toEqual(["Coding plans", "Custom"]);
  });

  it("draws every provider exactly once", () => {
    const { state, id } = withCategory();
    const next = assignProviderToCategory(state, "uuid-vectide", id, true);
    const drawn = sectionsFor(next, providers).flatMap((s) => s.providers.map((p) => p.id));
    expect(drawn.slice().sort()).toEqual(providers.map((p) => p.id).slice().sort());
    expect(new Set(drawn).size).toBe(providers.length);
  });
});

describe("ordering", () => {
  it("moves a category past its neighbour and keeps the numbering contiguous", () => {
    let state = emptyProviderCategoryState();
    for (const name of ["Subs", "Plans", "Tokens"]) {
      const made = addCategory(state, name);
      if (!made) throw new Error("fixture");
      state = made.state;
    }
    const userNames = (s: ProviderCategoryState) =>
      s.categories.filter((c) => !c.system).sort((a, b) => a.order - b.order).map((c) => c.name);
    expect(userNames(state)).toEqual(["Subs", "Plans", "Tokens"]);

    const plans = state.categories.find((c) => c.name === "Plans");
    const moved = moveCategory(state, plans?.id ?? "", -1);
    expect(userNames(moved)).toEqual(["Plans", "Subs", "Tokens"]);
    expect(moved.categories.filter((c) => !c.system).map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it("does nothing at the ends rather than wrapping around", () => {
    const { state, id } = withCategory();
    expect(moveCategory(state, id, -1)).toBe(state);
    expect(moveCategory(state, id, 1)).toBe(state);
  });
});

describe("reading a broken stored value", () => {
  /**
   * This is a JSON blob in `app_settings`. A hand-edited database or an older
   * build must degrade to a working rail, never throw on the settings load and
   * take the page down with it.
   */
  it("survives anything", () => {
    for (const junk of [null, undefined, 42, "nope", [], {}, { categories: "x" }]) {
      const state = normalizeProviderCategories(junk);
      expect(state.categories.map((c) => c.id)).toEqual([
        BUILT_IN_CATEGORY_ID,
        CUSTOM_CATEGORY_ID,
      ]);
    }
  });

  it("drops a nameless or id-less category instead of drawing a blank header", () => {
    const state = normalizeProviderCategories({
      categories: [
        { id: "cat-1", name: "  ", color: "accent", order: 0 },
        { id: "", name: "No id", color: "accent", order: 1 },
        { id: "cat-2", name: "Real", color: "accent", order: 2 },
      ],
      assignments: {},
    });
    expect(state.categories.filter((c) => !c.system).map((c) => c.name)).toEqual(["Real"]);
  });

  it("falls back to the neutral colour rather than painting an unknown one", () => {
    const state = normalizeProviderCategories({
      categories: [{ id: "cat-1", name: "Odd", color: "#ff00ff", order: 0 }],
      assignments: {},
    });
    expect(state.categories.find((c) => c.id === "cat-1")?.color).toBe("neutral");
  });

  it("de-duplicates repeated ids", () => {
    const state = normalizeProviderCategories({
      categories: [
        { id: "cat-1", name: "First", color: "accent", order: 0 },
        { id: "cat-1", name: "Second", color: "added", order: 1 },
      ],
      assignments: {},
    });
    expect(state.categories.filter((c) => c.id === "cat-1")).toHaveLength(1);
  });
});
