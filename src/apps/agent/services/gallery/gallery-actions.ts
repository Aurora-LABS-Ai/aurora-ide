import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { isTauri, revealInExplorer } from "@/kernel/lib/ipc/tauri";
import { writeClipboardText } from "@/kernel/lib/clipboard";
import { galleryFileSrc, type GalleryImage } from "./gallery-service";

export async function copyGalleryImage(image: GalleryImage): Promise<void> {
  if (image.video) throw new Error("Copy image is not available for videos");
  if (isTauri())
    return auroraInvoke("chat_gallery_copy_image", {
      threadId: image.threadId,
      name: image.name,
    });
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error("Image clipboard is unavailable in this browser");
  // Browsers accept PNG clipboard items even when the original is JPEG/WebP.
  const png = (async () => {
    const response = await fetch(galleryFileSrc(image.path));
    if (!response.ok) throw new Error("Could not read the original image");
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image conversion is unavailable");
      context.drawImage(bitmap, 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("Could not copy image")),
          "image/png",
        ),
      );
    } finally {
      bitmap.close();
    }
  })();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export async function saveGalleryMedia(image: GalleryImage): Promise<boolean> {
  if (!image.path) throw new Error("This video has not been saved yet");
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const extension =
      image.name.split(".").pop() || (image.video ? "mp4" : "png");
    const destination = await save({
      defaultPath: image.name,
      filters: [
        { name: image.video ? "Video" : "Image", extensions: [extension] },
      ],
    });
    if (!destination) return false;
    // Rust does the copy. `plugin-fs` cannot: its scope holds only paths the
    // user picked, and a conversation's own asset is never one of them, so
    // `copyFile` refused every save as a forbidden path. Rust also checks the
    // file is really this conversation's before reading it.
    await auroraInvoke("chat_gallery_save_as", {
      threadId: image.threadId,
      source: image.path,
      destination,
    });
  } else {
    const link = document.createElement("a");
    link.href = galleryFileSrc(image.path);
    link.download = image.name;
    document.body.append(link);
    link.click();
    link.remove();
  }
  return true;
}

export async function revealGalleryMedia(image: GalleryImage): Promise<void> {
  if (!isTauri())
    throw new Error("Show in folder is available in the Aurora desktop app");
  await revealInExplorer(image.path);
}
async function copyText(text: string): Promise<void> {
  if (!(await writeClipboardText(text)))
    throw new Error("Clipboard could not be updated");
}
export const copyGalleryPath = (image: GalleryImage): Promise<void> =>
  copyText(image.path);
export const copyGalleryPrompt = (image: GalleryImage): Promise<void> =>
  copyText(image.prompt || "");
