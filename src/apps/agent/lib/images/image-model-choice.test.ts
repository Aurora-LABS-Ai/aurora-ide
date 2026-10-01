import { beforeEach, describe, expect, it } from "vitest";

import {
  loadImageModelChoice,
  pickImageModel,
  readyImageModels,
  saveImageModelChoice,
} from "./image-model-choice";
import type { ImageModel, ImageProvider } from "@/apps/agent/services/providers/image-providers";

const model = (providerId: string, modelKey: string, label?: string): ImageModel => ({
  id: `${providerId}/${modelKey}`,
  providerId,
  modelKey,
  label,
});

const provider = (
  id: string,
  models: ImageModel[],
  overrides: Partial<ImageProvider> = {},
): ImageProvider => ({
  id,
  name: id,
  baseUrl: "https://img.example/v1",
  apiKey: "k",
  apiFormat: "openai-images",
  enabled: true,
  models,
  ...overrides,
});

beforeEach(() => localStorage.clear());

describe("readyImageModels", () => {
  it("flattens only providers that can be called now, keeping row order", () => {
    const ready = readyImageModels([
      provider("img-a", [model("img-a", "one", " One "), model("img-a", "two")]),
      provider("img-off", [model("img-off", "x")], { enabled: false }),
      provider("img-nokey", [model("img-nokey", "y")], { apiKey: "" }),
      provider("img-b", [model("img-b", "three")]),
    ]);
    expect(ready.map((entry) => entry.selection)).toEqual([
      "img-a:one",
      "img-a:two",
      "img-b:three",
    ]);
    // The label is trimmed and falls back to the key when empty.
    expect(ready.map((entry) => entry.label)).toEqual(["One", "two", "three"]);
  });
});

describe("pickImageModel", () => {
  const models = readyImageModels([
    provider("img-a", [model("img-a", "one"), model("img-a", "two")]),
  ]);

  it("returns the remembered pick while it is still ready", () => {
    expect(pickImageModel(models, "img-a:two")?.selection).toBe("img-a:two");
  });

  it("falls back to the first ready model when the pick is gone, and to none when nothing is ready", () => {
    // A provider switched off or a key removed must not leave a dead picker.
    expect(pickImageModel(models, "img-a:deleted")?.selection).toBe("img-a:one");
    expect(pickImageModel(models, null)?.selection).toBe("img-a:one");
    expect(pickImageModel([], "img-a:one")).toBeNull();
  });
});

describe("the remembered pick", () => {
  it("round-trips through localStorage and is null before any pick", () => {
    expect(loadImageModelChoice()).toBeNull();
    saveImageModelChoice("img-a:two");
    expect(loadImageModelChoice()).toBe("img-a:two");
  });
});
