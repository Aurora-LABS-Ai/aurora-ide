/**
 * Agent Window — image attachment helpers.
 *
 * Turns dropped file paths and pasted/clipboard blobs into `ImageAttachment`s
 * (raw base64 + media type), and provides the small classifiers the composer
 * uses to decide image-vs-file and to gate on vision support.
 */

import { readFile } from "@tauri-apps/plugin-fs";

import type { ImageAttachment } from "@/apps/agent/store/composer/useAgentAttachmentStore";

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const genId = (): string => Math.random().toString(36).slice(2, 11);

const extOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
};

export const basenameOf = (path: string): string => {
  const norm = path.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return slash >= 0 ? norm.slice(slash + 1) : norm;
};

/** True when the path's extension is a supported raster/vector image. */
export const isImagePath = (path: string): boolean => extOf(path) in IMAGE_EXT_TO_MIME;

/** Encode bytes to base64 in chunks (avoids call-stack blowups on big images). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Longest edge, and quality, for anything handed to the model.
 *
 * Deliberately the same numbers as the Rust capture path
 * (`SCREENSHOT_MAX_EDGE` / `SCREENSHOT_JPEG_QUALITY` in `browser_runtime.rs`):
 * a screenshot the agent took and a screenshot you pasted should arrive as the
 * same kind of object, and providers charge by tile, so pixels past this bound
 * cost upload bandwidth on every later turn and buy nothing.
 */
const MODEL_IMAGE_MAX_EDGE = 1024;
const MODEL_IMAGE_QUALITY = 0.85;

/**
 * Fit an image inside {@link MODEL_IMAGE_MAX_EDGE} and re-encode it as JPEG.
 *
 * Falls back to the original bytes when the blob can't be decoded (an SVG with
 * no intrinsic size, a corrupt paste) — sending the image we were handed beats
 * sending nothing, and the model still gets a valid attachment.
 */
async function toModelImage(blob: Blob): Promise<{ base64: string; mediaType: string }> {
  const original = async () => ({
    base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    mediaType: blob.type || "image/png",
  });
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MODEL_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return await original();
    // JPEG carries no alpha: without a painted ground, every transparent pixel
    // encodes as black and a UI screenshot with rounded corners gets a bruise.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const parts = dataUrlToParts(canvas.toDataURL("image/jpeg", MODEL_IMAGE_QUALITY));
    return parts.base64 ? parts : await original();
  } catch {
    return await original();
  }
}

/** Re-point a display name at the format we actually encoded. */
const asJpegName = (name: string, mediaType: string): string =>
  mediaType === "image/jpeg" ? name.replace(/\.[^./\\]+$/, "") + ".jpg" : name;

/** Read an image file from disk (absolute path) into an attachment. */
export async function imageFileToAttachment(path: string): Promise<ImageAttachment> {
  const bytes = await readFile(path);
  const type = IMAGE_EXT_TO_MIME[extOf(path)] ?? "image/png";
  // `slice()` gives a plain ArrayBuffer view, which `Blob` accepts regardless of
  // whether the read returned a shared buffer.
  const { base64, mediaType } = await toModelImage(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type }),
  );
  return {
    id: genId(),
    name: asJpegName(basenameOf(path), mediaType),
    mediaType,
    base64,
  };
}

/**
 * Formats an image provider's edit endpoint takes, and the size Aurora will
 * store as a conversation asset (`assets::MAX_ASSET_BYTES` in Rust).
 */
const EDIT_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
export const EDIT_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Read an image file AS IT IS, for an image model to edit.
 *
 * `imageFileToAttachment` shrinks to 1024px JPEG, which is right for a vision
 * model reading a screenshot and wrong for a picture someone wants changed: it
 * throws away resolution and paints transparency white before the edit model
 * ever sees it. This keeps the original bytes. Throws, in words for the user,
 * when the file is a format or size the edit path cannot take.
 */
export async function imageFileForEdit(path: string): Promise<ImageAttachment> {
  const ext = extOf(path);
  if (!EDIT_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error("Edits take PNG, JPEG, WebP or GIF pictures.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > EDIT_IMAGE_MAX_BYTES) {
    throw new Error(
      `That picture is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; edits take up to ${EDIT_IMAGE_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  return {
    id: genId(),
    name: basenameOf(path),
    mediaType: IMAGE_EXT_TO_MIME[ext] ?? "image/png",
    base64: bytesToBase64(bytes),
  };
}

/** Convert a clipboard/file blob (pasted image) into an attachment. */
export async function blobToAttachment(
  blob: Blob,
  name = "pasted-image.png",
): Promise<ImageAttachment> {
  const { base64, mediaType } = await toModelImage(blob);
  return { id: genId(), name: asJpegName(name, mediaType), mediaType, base64 };
}

/** Normalize an annotator's `data:` URL the same way a paste or drop is. */
export async function dataUrlToAttachmentParts(
  dataUrl: string,
): Promise<{ base64: string; mediaType: string }> {
  const res = await fetch(dataUrl);
  return toModelImage(await res.blob());
}

/** Convert a `data:` URL (annotator output) into base64 + media type. */
export function dataUrlToParts(dataUrl: string): { base64: string; mediaType: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return { base64: "", mediaType: "image/png" };
  return { mediaType: match[1], base64: match[2] };
}
