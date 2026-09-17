import { beforeEach, expect, it, vi } from "vitest";
import {
  copyGalleryImage,
  copyGalleryPath,
  saveGalleryMedia,
} from "./gallery-actions";
import type { GalleryImage } from "./gallery-service";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  copy: vi.fn(),
  clipboard: vi.fn(),
}));
vi.mock("@/kernel/lib/ipc/runtime", () => ({ auroraInvoke: mocks.invoke }));
vi.mock("@/kernel/lib/ipc/tauri", () => ({
  isTauri: () => true,
  revealInExplorer: vi.fn(),
}));
vi.mock("@/kernel/lib/clipboard", () => ({
  writeClipboardText: mocks.clipboard,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ copyFile: mocks.copy }));
const image: GalleryImage = {
  threadId: "chat",
  threadTitle: "Research",
  name: "001.png",
  path: "E:/chat/001.png",
  source: "generated",
  mediaType: "image/png",
  width: 800,
  height: 600,
  createdAt: "2026-09-14",
};
beforeEach(() => vi.clearAllMocks());
it("copies image pixels through the native bounded decoder, not a URL", async () => {
  await copyGalleryImage(image);
  expect(mocks.invoke).toHaveBeenCalledWith("chat_gallery_copy_image", {
    threadId: "chat",
    name: "001.png",
  });
});
it("saves the original with the native file dialog and respects cancellation", async () => {
  mocks.save.mockResolvedValueOnce(null);
  expect(await saveGalleryMedia(image)).toBe(false);
  expect(mocks.copy).not.toHaveBeenCalled();
  mocks.save.mockResolvedValueOnce("E:/exports/001.png");
  expect(await saveGalleryMedia(image)).toBe(true);
  expect(mocks.copy).toHaveBeenCalledWith(image.path, "E:/exports/001.png");
});
it("does not overwrite a source with itself and reports clipboard failures", async () => {
  mocks.save.mockResolvedValueOnce(image.path);
  await saveGalleryMedia(image);
  expect(mocks.copy).not.toHaveBeenCalled();
  mocks.clipboard.mockResolvedValueOnce(false);
  await expect(copyGalleryPath(image)).rejects.toThrow(
    "Clipboard could not be updated",
  );
});
