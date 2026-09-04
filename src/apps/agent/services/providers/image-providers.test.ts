import { describe, expect, it } from "vitest";

import {
  canEditWith,
  editUrl,
  generationUrl,
  imageProviderReady,
  normalizeImageProviders,
  type ImageModel,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";

const provider = (over: Partial<ImageProvider> = {}): ImageProvider => ({
  id: "p1",
  name: "a6api",
  baseUrl: "https://api.a6api.com/v1",
  apiKey: "k",
  apiFormat: "a6api",
  responseShape: "url",
  enabled: true,
  models: [],
  ...over,
});

const model = (over: Partial<ImageModel> = {}): ImageModel => ({
  id: "p1:gpt-image-1",
  providerId: "p1",
  modelKey: "gpt-image-1",
  ...over,
});

describe("building the request URL", () => {
  it("falls back to the format's own path", () => {
    expect(generationUrl(provider())).toBe("https://api.a6api.com/v1/images/generations");
  });

  it("does not double or drop the separator", () => {
    expect(generationUrl(provider({ baseUrl: "https://x.test/v1/" }))).toBe(
      "https://x.test/v1/images/generations",
    );
    expect(generationUrl(provider({ generationPath: "images/generations" }))).toBe(
      "https://api.a6api.com/v1/images/generations",
    );
  });
});

describe("whether a provider can edit at all", () => {
  it("uses the format's edit path when the field was never filled in", () => {
    expect(editUrl(provider())).toBe("https://api.a6api.com/v1/images/edits");
  });

  // The distinction the UI depends on: a blank field is a STATEMENT that this
  // provider only generates, not an omission to be filled from the default.
  // Without it, an edit posts to the provider's root and comes back as a
  // confusing 404 instead of "this one cannot edit".
  it("treats an explicitly empty edit path as cannot-edit", () => {
    expect(editUrl(provider({ editPath: "" }))).toBeNull();
    expect(editUrl(provider({ editPath: "   " }))).toBeNull();
  });

  it("needs the provider AND the model to be willing", () => {
    const generatesOnly = provider({ editPath: "" });
    expect(canEditWith(generatesOnly, model({ canEdit: true }))).toBe(false);
    expect(canEditWith(provider(), model({ canEdit: true }))).toBe(true);
    // Not every image model can edit; a generator asked to edit returns 400.
    expect(canEditWith(provider(), model({ canEdit: false }))).toBe(false);
    expect(canEditWith(provider(), model())).toBe(false);
  });
});

describe("whether a provider is usable", () => {
  it("needs to be switched on, addressed and keyed", () => {
    expect(imageProviderReady(provider())).toBe(true);
    expect(imageProviderReady(provider({ enabled: false }))).toBe(false);
    expect(imageProviderReady(provider({ baseUrl: "  " }))).toBe(false);
    expect(imageProviderReady(provider({ apiKey: "" }))).toBe(false);
    expect(imageProviderReady(provider({ apiKey: undefined }))).toBe(false);
  });
});

describe("reading the stored list back", () => {
  it("keeps a complete row", () => {
    const stored = [
      {
        id: "p1",
        name: "a6api",
        baseUrl: "https://api.a6api.com/v1",
        apiFormat: "a6api",
        responseShape: "url",
        enabled: true,
        models: [{ modelKey: "gpt-image-1", canEdit: true, pricePerImage: 0.04 }],
      },
    ];
    const [row] = normalizeImageProviders(stored);
    expect(row.apiFormat).toBe("a6api");
    expect(row.models[0]).toMatchObject({
      id: "p1:gpt-image-1",
      providerId: "p1",
      canEdit: true,
      pricePerImage: 0.04,
    });
  });

  // A row that cannot work is worse than no row: it renders as a provider the
  // user thinks they configured.
  it("drops rows with no id, no name, or no model key", () => {
    expect(normalizeImageProviders([{ name: "x" }, { id: "y" }])).toEqual([]);
    const [row] = normalizeImageProviders([
      { id: "p", name: "n", models: [{ label: "no key" }] },
    ]);
    expect(row.models).toEqual([]);
  });

  it("falls back to a known format rather than trusting the stored string", () => {
    const [row] = normalizeImageProviders([{ id: "p", name: "n", apiFormat: "whatever" }]);
    expect(row.apiFormat).toBe("openai-images");
  });

  // Unset means "not known", and must not render as a measured zero.
  it("drops a price that is not a real number", () => {
    const [row] = normalizeImageProviders([
      { id: "p", name: "n", models: [{ modelKey: "m", pricePerImage: "cheap" }] },
    ]);
    expect(row.models[0].pricePerImage).toBeUndefined();
  });

  it("survives anything that is not a list", () => {
    expect(normalizeImageProviders(undefined)).toEqual([]);
    expect(normalizeImageProviders("[]")).toEqual([]);
    expect(normalizeImageProviders([null, 3, "x"])).toEqual([]);
  });
});
