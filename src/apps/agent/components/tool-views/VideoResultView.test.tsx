import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoResultView } from "./VideoResultView";
import { parseToolResult } from "./tool-result";
import type { VideoData } from "@/apps/agent/services/gallery/video-service";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  provider: { id: "mini", enabled: true, apiKey: "test-key" },
}));
vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: mocks.invoke,
  isDesktopRuntime: () => false,
}));
vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ imageProviders: [mocks.provider] }),
}));
let root: Root;
let host: HTMLDivElement;
const job: VideoData = {
  jobId: "job",
  threadId: "chat",
  providerId: "mini",
  taskId: "42",
  model: "MiniMax-Hailuo-2.3",
  prompt: "Sunrise",
  duration: 6,
  resolution: "768P",
  status: "queued",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockReset();
  mocks.provider.apiKey = "test-key";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("routes durable video results to the player, not raw JSON", () => {
  expect(
    parseToolResult("generate_video", {}, JSON.stringify({ video: job })).video,
  ).toEqual(job);
  expect(
    parseToolResult(
      "generate_video",
      {},
      JSON.stringify({ video: { ...job, path: {} } }),
    ).video,
  ).toBeFalsy();
});
it("checks an existing job and displays its saved video without a generation request", async () => {
  mocks.invoke.mockResolvedValueOnce({
    video: { ...job, status: "succeeded", path: "/video.mp4" },
  });
  await act(async () => root.render(<VideoResultView video={job} />));
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.invoke).toHaveBeenCalledWith("chat_video_refresh", {
    threadId: "chat",
    jobId: "job",
    provider: mocks.provider,
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(host.querySelector("video")?.getAttribute("src")).toBe("/video.mp4");
  expect(host.textContent).toContain("Ready");
  expect(host.querySelector("button")).toBeNull();
});
it("keeps failed status checks retryable without creating another task", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("Network unavailable"));
  await act(async () => root.render(<VideoResultView video={job} />));
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Network unavailable",
  );
  expect(host.querySelector("button")?.disabled).toBe(false);
  expect(host.textContent).toContain("Queued");
});
it("uses newer gallery state instead of a stale locally checked status", async () => {
  mocks.invoke.mockResolvedValueOnce({ video: { ...job, status: "running" } });
  await act(async () => root.render(<VideoResultView video={job} />));
  await act(async () => host.querySelector("button")!.click());
  await act(async () =>
    root.render(
      <VideoResultView
        video={{ ...job, status: "succeeded", path: "/new.mp4" }}
      />,
    ),
  );
  expect(host.querySelector("video")?.getAttribute("src")).toBe("/new.mp4");
});
it("does not contact MiniMax when the saved provider has no key", async () => {
  mocks.provider.apiKey = "";
  await act(async () => root.render(<VideoResultView video={job} />));
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("key");
});

it("reserves the video's shape with the placeholder while the task is queued", async () => {
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  try {
    await act(async () =>
      root.render(<VideoResultView video={{ ...job, aspectRatio: 9 / 16 }} />),
    );
    const hole = host.querySelector<HTMLElement>(".agw-video-hole")!;
    expect(hole.style.aspectRatio).toBe(`${9 / 16} / 1`);
    expect(host.querySelector(".agw-video-silk")).not.toBeNull();
    // The facts live on one line inside the box, not as stacked rows.
    expect(host.querySelector(".agw-video-overlay")?.textContent).toContain("768P");
    expect(host.querySelector(".agw-video-check")).not.toBeNull();
    // No player is mounted for a clip that does not exist yet.
    expect(host.querySelector("video")).toBeNull();
  } finally {
    context.mockRestore();
  }
});

it("falls back to a landscape box when the record predates the aspect field", async () => {
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  try {
    await act(async () => root.render(<VideoResultView video={job} />));
    expect(host.querySelector<HTMLElement>(".agw-video-hole")!.style.aspectRatio).toBe("16 / 9");
  } finally {
    context.mockRestore();
  }
});

it("removes the refresh on a failed task rather than disabling it", async () => {
  await act(async () =>
    root.render(
      <VideoResultView video={{ ...job, status: "failed", error: "Rejected" }} />,
    ),
  );
  expect(host.querySelector(".agw-video-check")).toBeNull();
  // A failed task gets no "working" animation over it either.
  expect(host.querySelector(".agw-video-silk")).toBeNull();
  expect(host.querySelector('.agw-video-badge[data-tone="bad"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Rejected");
});

it("marks an expired task as expiry rather than failure, with no control", async () => {
  await act(async () =>
    root.render(<VideoResultView video={{ ...job, status: "unknown" }} />),
  );
  expect(host.querySelector('.agw-video-badge[data-tone="warn"]')?.textContent).toContain("Expired");
  expect(host.querySelector(".agw-video-check")).toBeNull();
});

it("swaps the overlay for a caption once the clip has arrived", async () => {
  await act(async () =>
    root.render(
      <VideoResultView
        video={{ ...job, status: "succeeded", path: "C:/chats/clip.mp4", aspectRatio: 16 / 9 }}
      />,
    ),
  );
  expect(host.querySelector(".agw-video-overlay")).toBeNull();
  expect(host.querySelector(".agw-video-hole")).toBeNull();
  expect(host.querySelector<HTMLElement>("video")!.style.aspectRatio).toBe(`${16 / 9} / 1`);
  expect(host.querySelector(".agw-video-meta")?.textContent).toContain("768P");
});
