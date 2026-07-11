/**
 * Agent Window — image attachment helpers.
 *
 * Turns dropped file paths and pasted/clipboard blobs into `ImageAttachment`s
 * (raw base64 + media type), and provides the small classifiers the composer
 * uses to decide image-vs-file and to gate on vision support.
 */

import { readFile } from "@tauri-apps/plugin-fs";

import type { ImageAttachment } from "../store/useAgentAttachmentStore";

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

/** Read an image file from disk (absolute path) into an attachment. */
export async function imageFileToAttachment(path: string): Promise<ImageAttachment> {
  const bytes = await readFile(path);
  return {
    id: genId(),
    name: basenameOf(path),
    mediaType: IMAGE_EXT_TO_MIME[extOf(path)] ?? "image/png",
    base64: bytesToBase64(bytes),
  };
}

/** Convert a clipboard/file blob (pasted image) into an attachment. */
export async function blobToAttachment(
  blob: Blob,
  name = "pasted-image.png",
): Promise<ImageAttachment> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return {
    id: genId(),
    name,
    mediaType: blob.type || "image/png",
    base64: bytesToBase64(buf),
  };
}

/** Convert a `data:` URL (annotator output) into base64 + media type. */
export function dataUrlToParts(dataUrl: string): { base64: string; mediaType: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return { base64: "", mediaType: "image/png" };
  return { mediaType: match[1], base64: match[2] };
}
