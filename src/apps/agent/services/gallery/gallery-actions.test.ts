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
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.save.mockResolvedValueOnce("E:/exports/001.png");
  expect(await saveGalleryMedia(image)).toBe(true);
  expect(mocks.invoke).toHaveBeenCalledWith("chat_gallery_save_as", {
    threadId: "chat",
    source: image.path,
    destination: "E:/exports/001.png",
  });
});
/**
 * The copy must NOT go through `plugin-fs`. Its scope holds only paths the user
 * picked, and a conversation's own asset is never one of them, so `copyFile`
 * refused every save with "forbidden path … `allow-copy-file`". Naming the
 * command here is what stops someone reaching for `copyFile` again because it
 * reads as the obvious call.
 */
it("never asks the fs plugin to read a path the user did not pick", async () => {
  mocks.save.mockResolvedValueOnce("E:/exports/001.png");
  await saveGalleryMedia(image);
  expect(mocks.invoke).toHaveBeenCalledOnce();
  expect(mocks.invoke.mock.calls[0][0]).toBe("chat_gallery_save_as");
});
it("reports clipboard failures", async () => {
  mocks.clipboard.mockResolvedValueOnce(false);
  await expect(copyGalleryPath(image)).rejects.toThrow(
    "Clipboard could not be updated",
  );
});
