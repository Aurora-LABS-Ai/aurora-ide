import { describe, expect, it } from "vitest";

import {
  A6API_IMAGE_PROVIDER_ID,
  MINIMAX_IMAGE_PROVIDER_ID,
  aspectRatioOfSize,
  canEditWith,
  editUrl,
  generationUrl,
  imageModelFromSelection,
  imageModelSelection,
  imageProviderReady,
  isImageModelSelection,
  normalizeImageProviders,
  withSeededImageProviders,
  type ImageModel,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";

const provider = (over: Partial<ImageProvider> = {}): ImageProvider => ({
  id: "p1",
  name: "a6api",
  baseUrl: "https://api.a6api.com/v1",
  apiKey: "k",
  apiFormat: "a6api",
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
  /** Everything the USER added — the shipped row is always there and tested separately. */
  const added = (stored: unknown) => normalizeImageProviders(stored).filter((r) => !r.builtIn);

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
    const [row] = added(stored);
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
    expect(added([{ name: "x" }, { id: "y" }])).toEqual([]);
    const [row] = added([{ id: "p", name: "n", models: [{ label: "no key" }] }]);
    expect(row.models).toEqual([]);
  });

  it("falls back to a known format rather than trusting the stored string", () => {
    const [row] = added([{ id: "p", name: "n", apiFormat: "whatever" }]);
    expect(row.apiFormat).toBe("openai-images");
  });

  // Unset means "not known", and must not render as a measured zero.
  it("drops a price that is not a real number", () => {
    const [row] = added([{ id: "p", name: "n", models: [{ modelKey: "m", pricePerImage: "cheap" }] }]);
    expect(row.models[0].pricePerImage).toBeUndefined();
  });

  it("survives anything that is not a list", () => {
    expect(added(undefined)).toEqual([]);
    expect(added("[]")).toEqual([]);
    expect(added([null, 3, "x"])).toEqual([]);
  });
});

describe("the image provider Aurora ships", () => {
  it("ships native MiniMax without overwriting a saved key or model settings", () => {
    const mini = normalizeImageProviders(undefined).find((row) => row.id === MINIMAX_IMAGE_PROVIDER_ID)!;
    expect(mini.apiFormat).toBe("minimax-native");
    expect(mini.models[0].modelKey).toBe("image-01");
    expect(generationUrl(mini)).toBe("https://api.minimax.io/v1/image_generation");
    expect(editUrl(mini)).toBe(generationUrl(mini));
    expect(imageProviderReady(mini)).toBe(false);
    const custom = { ...mini, apiKey: "subscription-key", enabled: false, models: [{ ...mini.models[0], defaultSize: "1280x720" }] };
    const rows = normalizeImageProviders(normalizeImageProviders([custom]));
    expect(rows.filter((row) => row.id === MINIMAX_IMAGE_PROVIDER_ID)).toEqual([custom]);
  });
  const shipped = (stored: unknown) =>
    normalizeImageProviders(stored).find((r) => r.id === A6API_IMAGE_PROVIDER_ID);

  /** A fresh install has to land on a usable row, not an empty group. */
  it("is there before anything has been stored", () => {
    const row = shipped(undefined);
    expect(row).toBeDefined();
    expect(row?.baseUrl).toBe("https://api.a6api.com/v1");
    expect(row?.apiFormat).toBe("a6api");
    expect(row?.builtIn).toBe(true);
  });

  /**
   * The row is permanent; everything IN it is the user's. A relaunch that reset
   * the key would be indistinguishable from the key being wrong.
   */
  it("keeps the key, models and edits the user put into it", () => {
    const row = shipped([
      {
        id: A6API_IMAGE_PROVIDER_ID,
        name: "my pictures",
        baseUrl: "https://proxy.example.com/v1",
        apiKey: "sk-live",
        apiFormat: "a6api",
        responseShape: "url",
        enabled: false,
        models: [{ modelKey: "nano-banana-pro" }],
      },
    ]);
    expect(row?.apiKey).toBe("sk-live");
    expect(row?.name).toBe("my pictures");
    expect(row?.baseUrl).toBe("https://proxy.example.com/v1");
    expect(row?.enabled).toBe(false);
    expect(row?.models.map((m) => m.modelKey)).toEqual(["nano-banana-pro"]);
  });

  /** One row, however many times the list is read back. */
  it("is never duplicated", () => {
    const rows = normalizeImageProviders(
      normalizeImageProviders(normalizeImageProviders(undefined)),
    );
    expect(rows.filter((r) => r.id === A6API_IMAGE_PROVIDER_ID)).toHaveLength(1);
  });

  /**
   * A row saved before this shipped is the SAME provider, not a lookalike the
   * user could still throw away.
   */
  it("marks a row stored without the flag as built in", () => {
    const row = shipped([
      { id: A6API_IMAGE_PROVIDER_ID, name: "a6api", apiFormat: "a6api", enabled: true },
    ]);
    expect(row?.builtIn).toBe(true);
  });
});

describe("providers offered once as a starting point", () => {
  it("adds a seed the user has not been offered yet", () => {
    const { providers, seededIds } = withSeededImageProviders([], []);
    const apikl = providers.find((p) => p.id === "img-apikl");
    expect(apikl?.baseUrl).toBe("https://api.apikl.ai/v1");
    // Measured on the live service: multipart edits, and asking for a URL is
    // what stops generation answering in base64.
    expect(apikl?.apiFormat).toBe("openai-images");
    expect(apikl?.requestFormat).toBe("url");
    expect(apikl?.models.map((m) => m.modelKey)).toEqual(["gpt-image-2-pro"]);
    expect(apikl?.models[0].canEdit).toBe(true);
    // Deletable, unlike the shipped a6api row.
    expect(apikl?.builtIn).toBeUndefined();
    expect(seededIds).toContain("img-apikl");
  });

  /** The whole point of the record: a seed thrown away stays thrown away. */
  it("does not put back a seed the user deleted", () => {
    const { providers } = withSeededImageProviders([], ["img-apikl"]);
    expect(providers.find((p) => p.id === "img-apikl")).toBeUndefined();
  });

  it("never duplicates a row that already carries the id", () => {
    const mine = provider({ id: "img-apikl", name: "mine" });
    const { providers } = withSeededImageProviders([mine], []);
    expect(providers.filter((p) => p.id === "img-apikl")).toHaveLength(1);
    expect(providers[0].name).toBe("mine");
  });

  /** Seeding twice in a row must be the same as seeding once. */
  it("is stable across repeated loads", () => {
    const first = withSeededImageProviders([], []);
    const second = withSeededImageProviders(first.providers, first.seededIds);
    expect(second.providers).toHaveLength(first.providers.length);
    expect(second.seededIds).toEqual(first.seededIds);
  });
});

describe("a conversation pinned to an image model", () => {
  const imgProvider = provider({
    id: "img-abc",
    models: [model({ id: "img-abc:gpt-image-1", providerId: "img-abc", modelKey: "gpt-image-1" })],
  });

  it("is told apart from a language pin by the provider id alone", () => {
    expect(isImageModelSelection("img-abc:gpt-image-1")).toBe(true);
    expect(isImageModelSelection("openai:gpt-5")).toBe(false);
    expect(isImageModelSelection(null)).toBe(false);
  });

  it("resolves to the provider and model the pin names", () => {
    const hit = imageModelFromSelection("img-abc:gpt-image-1", [imgProvider]);
    expect(hit?.provider.id).toBe("img-abc");
    expect(hit?.model.modelKey).toBe("gpt-image-1");
    expect(imageModelSelection(hit!.model)).toBe("img-abc:gpt-image-1");
  });

  it("is null when the provider or the model is gone", () => {
    expect(imageModelFromSelection("img-abc:other", [imgProvider])).toBeNull();
    expect(imageModelFromSelection("img-zzz:gpt-image-1", [imgProvider])).toBeNull();
    expect(imageModelFromSelection("openai:gpt-image-1", [imgProvider])).toBeNull();
  });

  it("reserves the picture's shape from its size, square when unsaid", () => {
    expect(aspectRatioOfSize("1536x1024")).toBe("1536 / 1024");
    expect(aspectRatioOfSize("1024×1536")).toBe("1024 / 1536");
    expect(aspectRatioOfSize("832x1248")).toBe("832 / 1248");
    expect(aspectRatioOfSize(" 1280 X 720 ")).toBe("1280 / 720");
    expect(aspectRatioOfSize(undefined)).toBe("1 / 1");
    expect(aspectRatioOfSize("auto")).toBe("1 / 1");
    expect(aspectRatioOfSize("0x1024")).toBe("1 / 1");
    expect(aspectRatioOfSize("1024x-1")).toBe("1 / 1");
    expect(aspectRatioOfSize(`${"9".repeat(400)}x1024`)).toBe("1 / 1");
  });
});
