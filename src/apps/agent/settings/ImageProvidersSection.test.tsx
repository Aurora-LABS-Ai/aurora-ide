import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageProviderCard } from "./ImageProvidersSection";
import {
  A6API_IMAGE_PRESET,
  MINIMAX_IMAGE_PRESET,
} from "@/apps/agent/services/providers/image-providers";
import type { VideoCatalog } from "@/apps/agent/services/providers/video-catalog";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), addImageModel: vi.fn() }));
vi.mock("@/kernel/lib/ipc/runtime", () => ({ auroraInvoke: mocks.invoke }));
vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      addImageModel: mocks.addImageModel,
      updateImageProvider: vi.fn(),
      deleteImageProvider: vi.fn(),
      updateImageModel: vi.fn(),
      deleteImageModel: vi.fn(),
    }),
}));

const catalog: VideoCatalog = {
  defaultModel: "MiniMax-Hailuo-2.3",
  models: [
    {
      model: "MiniMax-Hailuo-2.3",
      label: "Hailuo 2.3",
      vendor: "MiniMax",
      api: "v1",
      access: "Subscription Key or pay-as-you-go API key",
      input: "Text or first frame",
      duration: [6, 10],
      resolutions: ["768P", "1080P"],
      note: "1080P: 6s only",
    },
    {
      model: "MiniMax-Hailuo-2.3-Fast",
      label: "Hailuo 2.3 Fast",
      vendor: "MiniMax",
      api: "v1",
      access: "Account eligibility required",
      input: "First frame required",
      duration: [6, 10],
      resolutions: ["768P", "1080P"],
      note: "1080P: 6s only",
    },
    {
      model: "MiniMax-H3",
      label: "H3",
      vendor: "MiniMax",
      api: "v2",
      access: "Pay-as-you-go",
      input: "Text, frames or references",
      duration: Array.from({ length: 12 }, (_, i) => i + 4),
      resolutions: ["768P", "2K"],
      note: "Frames and references cannot be combined",
    },
    {
      model: "MiniMax-H3-Max",
      label: "H3 Max",
      vendor: "MiniMax",
      api: "v2",
      access: "Pay-as-you-go",
      input: "Text, frames or references",
      duration: Array.from({ length: 11 }, (_, i) => i + 5),
      resolutions: ["480P", "768P"],
      note: "Frames and references cannot be combined",
    },
  ],
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockReset().mockResolvedValue(catalog);
  mocks.addImageModel.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows built-in video models without a key, separately from editable image models", async () => {
  await act(async () =>
    root.render(
      <ImageProviderCard
        provider={MINIMAX_IMAGE_PRESET}
        initiallyOpen
        standalone
      />,
    ),
  );
  expect(host.textContent).toContain("Image models");
  expect(host.textContent).toContain("Video models");
  const video = host.querySelector('[aria-label="Built-in video models"]')!;
  expect(video.querySelectorAll('[role="listitem"]')).toHaveLength(4);
  for (const model of catalog.models)
    expect(video.textContent).toContain(model.model);
  expect(video.querySelector("button, input")).toBeNull();
  expect(host.querySelectorAll('[title="Remove model"]')).toHaveLength(1);
  expect(
    host.querySelectorAll('[placeholder="/v1/image_generation"]'),
  ).toHaveLength(2);
  expect(video.textContent).toContain("6 / 10s");
  expect(video.textContent).toContain("4-15s");
  expect(video.textContent).toContain("5-15s");
  expect(video.textContent).toContain("Pay-as-you-go");
  expect(video.textContent).toContain("First frame required");
  expect(
    video.querySelector(".agw-prov-chip")?.closest('[role="listitem"]')
      ?.textContent,
  ).toContain(catalog.defaultModel);
  expect(host.textContent).toContain("Quota not checked");
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("video_model_catalog");
  expect(mocks.addImageModel).not.toHaveBeenCalled();
  expect(MINIMAX_IMAGE_PRESET.models.map((model) => model.modelKey)).toEqual([
    "image-01",
  ]);
});

it("does not expose native video models under another image format", async () => {
  await act(async () =>
    root.render(
      <ImageProviderCard provider={A6API_IMAGE_PRESET} initiallyOpen />,
    ),
  );
  expect(host.textContent).toContain("Discover image models");
  expect(host.textContent).not.toContain("Video models");
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("loads only when the provider opens and removes the list when its format changes", async () => {
  await act(async () =>
    root.render(
      <ImageProviderCard
        provider={MINIMAX_IMAGE_PRESET}
        initiallyOpen={false}
      />,
    ),
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () =>
    (
      host.querySelector("button.agw-img-card-main") as HTMLButtonElement
    ).click(),
  );
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(
      <ImageProviderCard
        provider={{ ...MINIMAX_IMAGE_PRESET, apiFormat: "openai-images" }}
        initiallyOpen={false}
      />,
    ),
  );
  expect(host.textContent).not.toContain("Video models");
});

it("shows loading and a retryable error without requesting a paid generation", async () => {
  let reject!: (error: Error) => void;
  mocks.invoke.mockReturnValueOnce(
    new Promise((_, failure) => {
      reject = failure;
    }),
  );
  await act(async () =>
    root.render(
      <ImageProviderCard provider={MINIMAX_IMAGE_PRESET} initiallyOpen />,
    ),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Loading video models",
  );
  await act(async () => reject(new Error("Native catalog unavailable")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Native catalog unavailable",
  );
  const retry = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(
    host.querySelector('[aria-label="Built-in video models"]'),
  ).not.toBeNull();
  expect(mocks.invoke.mock.calls).toEqual([
    ["video_model_catalog"],
    ["video_model_catalog"],
  ]);
});
