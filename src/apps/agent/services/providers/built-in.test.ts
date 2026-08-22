import { describe, expect, it } from "vitest";

import { BUILT_IN_PROVIDER_ORDER, groupProviders, isBuiltInProvider } from "./built-in";

const p = (id: string, isCustom?: boolean) => ({ id, isCustom });

describe("groupProviders", () => {
  it("puts the providers Aurora ships with ahead of the ones the user added", () => {
    const { builtIn, custom } = groupProviders([
      p("my-proxy", true),
      p("anthropic"),
      p("another-proxy", true),
      p("deepseek"),
    ]);
    expect(builtIn.map((x) => x.id)).toEqual(["anthropic", "deepseek"]);
    expect(custom.map((x) => x.id)).toEqual(["my-proxy", "another-proxy"]);
  });

  it("orders the shipped group the way the page names them, not the way the store holds them", () => {
    const ids = ["deepseek", "codex", "anthropic", "openai-responses"];
    const { builtIn } = groupProviders(ids.map((id) => p(id)));

    // Derived from the order list rather than a fixed slice of it: the
    // assertion is about *relative* position, so adding a provider in the
    // middle of BUILT_IN_PROVIDER_ORDER must not fail a test about sorting.
    const expected = BUILT_IN_PROVIDER_ORDER.filter((id) => ids.includes(id));
    expect(builtIn.map((x) => x.id)).toEqual(expected);
    expect(expected).toHaveLength(ids.length);
  });

  it("keeps a shipped provider that is not named in the order, after the ones that are", () => {
    // The list is a DISPLAY order, not a membership list. A preset added to the
    // catalog and not named here must still appear — dropping it would make a
    // provider vanish from the page with nothing to explain it.
    const { builtIn, custom } = groupProviders([
      p("ollama"),
      p("anthropic"),
      p("glm"),
    ]);
    expect(builtIn.map((x) => x.id)).toEqual(["anthropic", "ollama", "glm"]);
    expect(custom).toEqual([]);
  });

  it("keeps user-added providers in the order they were added", () => {
    // Stable sort, and no sort at all on this group: re-ordering someone's own
    // list on every render would move the row out from under their cursor.
    const { custom } = groupProviders([p("z", true), p("a", true), p("m", true)]);
    expect(custom.map((x) => x.id)).toEqual(["z", "a", "m"]);
  });

  it("treats a provider with no flag at all as one Aurora ships with", () => {
    // Rows seeded before the flag existed read back as undefined. Defaulting
    // those to "the user added this" would offer a Delete button on a preset
    // that re-seeds on the next launch.
    expect(isBuiltInProvider({})).toBe(true);
    expect(isBuiltInProvider({ isCustom: false })).toBe(true);
    expect(isBuiltInProvider({ isCustom: true })).toBe(false);
  });

  it("survives an empty list", () => {
    expect(groupProviders([])).toEqual({ builtIn: [], custom: [] });
  });
});

describe("kenari", () => {
  it("sits in the shipped group on every one of its three wires", async () => {
    const { isKenariProvider, kenariWire } = await import("./kenari");
    for (const providerType of ["kenari", "kenari-messages", "kenari-responses"] as const) {
      // `isCustom: false` is what the store writes for a seeded row.
      const provider = { id: "kenari", providerType, isCustom: false };
      expect(isKenariProvider(provider)).toBe(true);
      expect(isBuiltInProvider(provider)).toBe(true);
      expect(kenariWire(provider)).toBe(providerType);
    }
  });

  it("falls back to the chat wire when none was ever chosen", async () => {
    // A row stored before the picker existed has no wire on it. Chat is both
    // the default and the only wire every model kenari offers will answer on,
    // so an unset value must not strand the provider on a narrower one.
    const { kenariWire } = await import("./kenari");
    expect(kenariWire({ id: "kenari", providerType: undefined })).toBe("kenari");
    expect(kenariWire({ id: "kenari", providerType: "openai" })).toBe("kenari");
  });

  it("does not mistake another provider for kenari", async () => {
    const { isKenariProvider } = await import("./kenari");
    expect(isKenariProvider({ id: "openai", providerType: "openai" })).toBe(false);
    expect(isKenariProvider({ id: "anthropic", providerType: "anthropic" })).toBe(false);
  });

  it("is offered in the shipped order alongside the rest", async () => {
    const { builtInRank } = await import("./built-in");
    expect(builtInRank("kenari")).toBeLessThan(BUILT_IN_PROVIDER_ORDER.length);
  });
});
