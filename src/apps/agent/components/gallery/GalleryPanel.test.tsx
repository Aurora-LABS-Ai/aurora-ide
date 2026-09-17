import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryPanel } from "./GalleryPanel";
import type { GalleryImage } from "@/apps/agent/services/gallery/gallery-service";

const state = vi.hoisted(() => ({
  surface: "chat",
  images: [] as GalleryImage[],
  loading: false,
  error: "",
  warnings: [] as string[],
  refresh: vi.fn(),
  selectThread: vi.fn(),
  copyImage: vi.fn(),
  save: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: (select: (value: unknown) => unknown) =>
    select({ auroraSurface: state.surface }),
}));
vi.mock("@/apps/agent/hooks/gallery/useGallery", () => ({
  useGallery: () => state,
}));
vi.mock("@/apps/agent/store/conversation/useAgentChatStore", () => ({
  useAgentChatStore: { getState: () => ({ selectThread: state.selectThread }) },
}));
vi.mock("@/apps/agent/services/gallery/gallery-actions", () => ({
  copyGalleryImage: state.copyImage,
  saveGalleryMedia: state.save,
  revealGalleryMedia: state.reveal,
  copyGalleryPath: vi.fn(),
  copyGalleryPrompt: vi.fn(),
}));
vi.mock("./GalleryVideoModal", () => ({
  GalleryVideoModal: () => <div role="dialog" aria-label="Video preview" />,
}));
vi.mock("@/apps/agent/components/tool-views/VideoResultView", () => ({
  VideoResultView: () => <div>Video status</div>,
}));
vi.mock("@/apps/agent/components/modals/AgentImageModal", () => ({
  AgentImageModal: () => <div role="dialog" aria-label="Image preview" />,
}));
vi.mock("@/apps/agent/services/gallery/gallery-service", async (original) => ({
  ...(await original<object>()),
  galleryThumbnail: vi.fn().mockResolvedValue("/test.png"),
}));

let root: Root;
let host: HTMLDivElement;
const asset = (name: string, source: GalleryImage["source"]): GalleryImage => ({
  name,
  source,
  prompt: name,
  threadId: "chat-1",
  threadTitle: "Research",
  path: `/images/${name}.png`,
  width: 800,
  height: 600,
  mediaType: "image/png",
  createdAt: "2026-09-14T12:00:00Z",
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.surface = "chat";
  state.error = "";
  state.loading = false;
  vi.clearAllMocks();
  state.copyImage.mockResolvedValue(undefined);
  state.save.mockResolvedValue(true);
  state.images = [
    asset("Generated scene", "generated"),
    asset("Edited scene", "edited"),
    asset("Pasted screenshot", "attached"),
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<GalleryPanel />));

describe("Chat gallery", () => {
  it("keeps edits with generated images and pasted images in their own section", async () => {
    await render();
    expect(
      host.querySelector('[aria-label="Generated"]')?.textContent,
    ).toContain("Edited scene");
    expect(
      host.querySelector('[aria-label="Generated"]')?.textContent,
    ).not.toContain("Pasted screenshot");
    expect(
      [...host.querySelectorAll("section")].map((item) =>
        item.getAttribute("aria-label"),
      ),
    ).toEqual(["Generated", "Pasted & uploaded", "Videos"]);
    expect(host.querySelectorAll("section")[1]?.textContent).toContain(
      "Pasted screenshot",
    );
    const filter = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Generated",
    )!;
    await act(async () => filter.click());
    expect(host.querySelector('[aria-label="Pasted & uploaded"]')).toBeNull();
  });
  it("opens the chat that owns a selected picture", async () => {
    await render();
    await act(async () =>
      (
        host.querySelector(
          '[aria-label="Open Generated scene"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Open chat")!
        .click(),
    );
    expect(state.selectThread).toHaveBeenCalledWith("chat-1", null);
  });
  it("does not render the gallery in Build", async () => {
    state.surface = "build";
    await render();
    expect(host.innerHTML).toBe("");
  });
  it("keeps loaded images visible when a refresh fails", async () => {
    state.error = "Could not read image manifest";
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      state.error,
    );
    expect(host.textContent).toContain("Generated scene");
  });
  it("opens the existing image preview on double-click or Enter", async () => {
    await render();
    const tile = host.querySelector('[aria-label="Open Generated scene"]')!;
    await act(async () =>
      tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    expect(host.querySelector('[aria-label="Image preview"]')).not.toBeNull();
    await act(async () =>
      tile.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(host.querySelectorAll('[aria-label="Image preview"]')).toHaveLength(
      1,
    );
  });
  it("copies the original image from the context menu and reports failures", async () => {
    await render();
    const tile = host.querySelector('[aria-label="Open Generated scene"]')!;
    await act(async () =>
      tile.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 30,
          clientY: 40,
        }),
      ),
    );
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      "Open image",
      "Copy image",
      "Save as...",
      "Show in folder",
      "Copy file path",
      "Copy prompt",
      "Open chat",
    ]);
    expect(document.activeElement).toBe(items[0]);
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(items[1]);
    state.copyImage.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await act(async () => items[1].click());
    expect(state.copyImage).toHaveBeenCalledWith(state.images[0]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Clipboard unavailable",
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("supports keyboard context menus, save, and focus restoration", async () => {
    await render();
    const tile = host.querySelector(
      '[aria-label="Open Generated scene"]',
    ) as HTMLButtonElement;
    tile.focus();
    await act(async () =>
      tile.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Save as...")!
        .click(),
    );
    expect(state.save).toHaveBeenCalledWith(state.images[0]);
    expect(document.activeElement).toBe(tile);
    expect(host.textContent).toContain("Saved");
  });
  it("shows only videos in the Videos tab and opens video playback", async () => {
    const clip: GalleryImage = {
      ...asset("Sunrise clip", "generated"),
      mediaType: "video/mp4",
      video: {
        jobId: "job",
        threadId: "chat-1",
        providerId: "mini",
        model: "MiniMax-Hailuo-2.3",
        prompt: "Sunrise clip",
        duration: 6,
        resolution: "768P",
        status: "queued",
        taskId: "42",
      },
    };
    state.images.push(clip);
    await render();
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Videos")!
        .click(),
    );
    expect(host.querySelectorAll("section")).toHaveLength(1);
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(
      "Videos",
    );
    expect(
      host.querySelector('[aria-label="Open Generated scene"]'),
    ).toBeNull();
    await act(async () =>
      host
        .querySelector('[aria-label="Open Sunrise clip"]')!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    expect(host.querySelector('[aria-label="Video preview"]')).not.toBeNull();
  });
});
