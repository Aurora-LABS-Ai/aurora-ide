import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_SELECTION_KEY,
  loadProviderSelection,
  saveProviderSelection,
} from "./provider-pins";

afterEach(() => localStorage.clear());

describe("provider selection memory", () => {
  it("survives a round trip so the pane reopens on the row it was left on", () => {
    saveProviderSelection({ providerId: "anthropic", imageProviderId: null });
    expect(loadProviderSelection()).toEqual({
      providerId: "anthropic",
      imageProviderId: null,
    });
    // The two kinds of row are remembered apart: an image selection wins the
    // pane, so losing it would silently reopen on a language provider.
    saveProviderSelection({ providerId: "anthropic", imageProviderId: "img-qwen" });
    expect(loadProviderSelection().imageProviderId).toBe("img-qwen");
  });

  it("reads nothing at all as no selection rather than throwing", () => {
    expect(loadProviderSelection()).toEqual({
      providerId: null,
      imageProviderId: null,
    });
  });

  it("ignores a stored value that is not the shape it expects", () => {
    // Hand-edited storage, an older build, or another product on the origin.
    for (const raw of ['"anthropic"', "[]", "null", "{", '{"providerId":7}']) {
      localStorage.setItem(PROVIDER_SELECTION_KEY, raw);
      expect(loadProviderSelection()).toEqual({
        providerId: null,
        imageProviderId: null,
      });
    }
  });
});
