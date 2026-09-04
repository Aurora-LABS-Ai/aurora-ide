import { describe, expect, it } from "vitest";

import {
  applyBuildRoster,
  applyChatShortlist,
  normalizeThreadModelSelection,
  pinnedThreadModel,
} from "@/apps/agent/lib/thread/thread-model";

const row = (id: string, model?: string | null) => ({ id, model });

const source = (rows: Array<{ id: string; model?: string | null }>) => ({
  threads: rows,
  allThreads: rows,
});

describe("pinnedThreadModel", () => {
  it("returns the model the conversation is pinned to", () => {
    const state = source([row("a", "prov:alpha"), row("b", "other:beta")]);
    expect(pinnedThreadModel(state, "a")).toBe("prov:alpha");
    expect(pinnedThreadModel(state, "b")).toBe("other:beta");
  });

  /** The whole point: chat B's pick must not surface in chat A. */
  it("keeps two conversations on different models", () => {
    const state = source([row("a", "prov:alpha"), row("b", "other:beta")]);
    expect(pinnedThreadModel(state, "a")).not.toBe(pinnedThreadModel(state, "b"));
  });

  /** A draft has no thread — the caller falls back to the user's default. */
  it("reports nothing for a draft", () => {
    expect(pinnedThreadModel(source([row("a", "prov:alpha")]), null)).toBeNull();
    expect(pinnedThreadModel(source([]), undefined)).toBeNull();
  });

  /** Chats that predate per-conversation models carry no model at all. */
  it("reports nothing for a chat that has never run a turn", () => {
    const state = source([row("a"), row("b", null), row("c", "")]);
    expect(pinnedThreadModel(state, "a")).toBeNull();
    expect(pinnedThreadModel(state, "b")).toBeNull();
    // An empty string is an absent model, not a model named "".
    expect(pinnedThreadModel(state, "c")).toBeNull();
  });

  it("reports nothing for a thread it has never heard of", () => {
    expect(pinnedThreadModel(source([row("a", "prov:alpha")]), "ghost")).toBeNull();
  });

  /** `allThreads` covers every project; `threads` is only the active one. A
   *  chat docked from another project must still resolve. */
  it("falls back to the scoped list when the global one hasn't caught up", () => {
    const state = {
      threads: [row("a", "prov:alpha")],
      allThreads: [],
    };
    expect(pinnedThreadModel(state, "a")).toBe("prov:alpha");
  });
});

describe("normalizeThreadModelSelection", () => {
  const models = [
    { providerId: "cursor", modelKey: "cursor-grok-4.6" },
    { providerId: "other", modelKey: "alpha" },
  ];

  it("migrates a decorated Cursor pin when its stable row exists", () => {
    expect(
      normalizeThreadModelSelection("cursor:cursor-grok-4.6-high-fast", models),
    ).toBe("cursor:cursor-grok-4.6");
  });

  it("keeps an exact row even when its name ends in a modifier word", () => {
    const exact = [...models, { providerId: "cursor", modelKey: "company-high" }];
    expect(normalizeThreadModelSelection("cursor:company-high", exact)).toBe(
      "cursor:company-high",
    );
  });

  it("does not strip a suffix unless the resulting stable row is real", () => {
    expect(normalizeThreadModelSelection("cursor:unknown-high-fast", models)).toBe(
      "cursor:unknown-high-fast",
    );
    expect(normalizeThreadModelSelection("other:alpha-high", models)).toBe(
      "other:alpha-high",
    );
  });

  describe("a Modal endpoint that moved gateway", () => {
    const US = "maya--ep-kimi-k3-server.us-west.modal.direct";
    const EU = "maya--ep-kimi-k3-server.eu-west.modal.direct";
    const modal = [{ providerId: "modal", modelKey: EU }];

    /** Changing region renames every model on the row. The endpoint is the
     *  same deployment, so the conversation follows it rather than dying on
     *  `unknown inference model`. */
    it("follows the endpoint to its new hostname", () => {
      expect(normalizeThreadModelSelection(`modal:${US}`, modal)).toBe(`modal:${EU}`);
    });

    it("prefers the exact row when both regions are configured", () => {
      const both = [...modal, { providerId: "modal", modelKey: US }];
      expect(normalizeThreadModelSelection(`modal:${US}`, both)).toBe(`modal:${US}`);
    });

    it("leaves a pin alone when that endpoint is genuinely gone", () => {
      const gone = [{ providerId: "modal", modelKey: "maya--ep-glm-5-3-server.eu-west.modal.direct" }];
      expect(normalizeThreadModelSelection(`modal:${US}`, gone)).toBe(`modal:${US}`);
    });

    /** Another workspace's endpoint of the same name is a different machine
     *  behind a different token, so it is never a substitute. */
    it("never crosses workspaces", () => {
      const other = [{ providerId: "modal", modelKey: "canyaman6879--ep-kimi-k3-server.eu-west.modal.direct" }];
      expect(normalizeThreadModelSelection(`modal:${US}`, other)).toBe(`modal:${US}`);
    });

    /** The rule keys on a Modal hostname, so a `--` in another provider's
     *  model id cannot trigger it. */
    it("does not fire on a non-Modal model id containing a double dash", () => {
      const odd = [{ providerId: "other", modelKey: "vendor--model-b" }];
      expect(normalizeThreadModelSelection("other:vendor--model-a", odd)).toBe(
        "other:vendor--model-a",
      );
    });
  });
});

describe("applyChatShortlist", () => {
  const models = [
    { providerId: "prov", modelKey: "alpha" },
    { providerId: "prov", modelKey: "beta" },
    { providerId: "other", modelKey: "gamma" },
  ];

  it("leaves a model that is on the shortlist alone", () => {
    expect(applyChatShortlist("prov:beta", ["prov:alpha", "prov:beta"], models)).toBe(
      "prov:beta",
    );
  });

  /** The rule Alvan asked for: it is not thrown away and it does not break. */
  it("falls to the next available model when this one leaves the shortlist", () => {
    expect(applyChatShortlist("other:gamma", ["prov:alpha", "prov:beta"], models)).toBe(
      "prov:alpha",
    );
  });

  /** Nothing ticked means "not curated yet", never "no models". */
  it("changes nothing when the shortlist is empty", () => {
    expect(applyChatShortlist("other:gamma", [], models)).toBe("other:gamma");
  });

  /** Image models are picked from their own list; the shortlist cannot hold one. */
  it("leaves a picture-making chat on its image model", () => {
    expect(
      applyChatShortlist("img-abc:gpt-image-1.5", ["prov:alpha", "prov:beta"], models),
    ).toBe("img-abc:gpt-image-1.5");
  });

  /** A pinned model that still exists beats falling back to nothing. */
  it("changes nothing when every shortlisted model is gone", () => {
    expect(applyChatShortlist("other:gamma", ["prov:vanished"], models)).toBe("other:gamma");
  });

  it("skips shortlist entries whose model no longer exists", () => {
    expect(
      applyChatShortlist("other:gamma", ["prov:vanished", "prov:beta"], models),
    ).toBe("prov:beta");
  });

  it("ignores a malformed entry rather than resolving it", () => {
    expect(applyChatShortlist("other:gamma", ["alpha", "prov:alpha"], models)).toBe(
      "prov:alpha",
    );
  });
});

describe("applyBuildRoster", () => {
  const models = [
    { providerId: "prov", modelKey: "alpha" },
    { providerId: "prov", modelKey: "beta" },
  ];

  /** The overwhelming case: Build's default is already a language model. */
  it("leaves an ordinary model alone", () => {
    expect(applyBuildRoster("prov:beta", models)).toBe("prov:beta");
  });

  /**
   * The defect this closes. Picking an image model in Chat writes the shared
   * default, and Build's picker never offers one — so a new Build chat used to
   * inherit it and fail the turn with "model no longer available".
   */
  it("does not let Build inherit a picture-making model", () => {
    expect(applyBuildRoster("img-abc:gpt-image-1.5", models)).toBe("prov:alpha");
  });

  /** Same rule as the chat shortlist: no model at all is the worse answer. */
  it("changes nothing when there is no model to fall back to", () => {
    expect(applyBuildRoster("img-abc:gpt-image-1.5", [])).toBe("img-abc:gpt-image-1.5");
  });

  /**
   * The two surfaces disagree ON PURPOSE about the same string: Chat keeps the
   * image model, Build substitutes. Pinned here so a later "simplification"
   * that shares one path between them fails instead of quietly picking a side.
   */
  it("disagrees with the chat shortlist about the same selection", () => {
    const selection = "img-abc:gpt-image-1.5";
    expect(applyChatShortlist(selection, ["prov:alpha"], models)).toBe(selection);
    expect(applyBuildRoster(selection, models)).not.toBe(selection);
  });
});
