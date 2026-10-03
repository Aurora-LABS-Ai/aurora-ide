import { convertFileSrc } from "@tauri-apps/api/core";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { isTauri } from "@/kernel/lib/ipc/tauri";
import type { ImageAttachment } from "@/apps/agent/store/composer/useAgentAttachmentStore";
import type { VideoData } from "./video-service";

export interface GalleryImage {
  threadId: string;
  threadTitle: string;
  name: string;
  path: string;
  source: "generated" | "edited" | "attached";
  mediaType: string;
  width: number;
  height: number;
  prompt?: string;
  model?: string;
  createdAt: string;
  /** Kept out of sight: drawn blurred until shown again. Pictures only. */
  hidden?: boolean;
  video?: VideoData;
}

export interface GalleryResult {
  images: GalleryImage[];
  videos?: GalleryImage[];
  warnings: string[];
}

export const galleryImageId = (image: GalleryImage): string =>
  `${image.threadId}/${image.name}`;
export const galleryImageTitle = (image: GalleryImage): string =>
  image.prompt || image.name;
export const galleryFileSrc = (path: string): string =>
  isTauri() ? convertFileSrc(path) : path;

export const listGallery = async (): Promise<GalleryResult> => {
  const result = await auroraInvoke<GalleryResult>("chat_gallery_list");
  return {
    warnings: result.warnings,
    images: [...result.images, ...(result.videos ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  };
};
/** Blur a picture everywhere it is shown, or bring it back. Remembered on the picture. */
export const setGalleryHidden = (
  image: Pick<GalleryImage, "threadId" | "name">,
  hidden: boolean,
): Promise<void> =>
  auroraInvoke<void>("chat_gallery_set_hidden", {
    threadId: image.threadId,
    name: image.name,
    hidden,
  });

/** Delete a picture (file, thumbnail, Canvas card) or a finished video, for good. */
export const deleteGalleryMedia = (image: Pick<GalleryImage, "threadId" | "name">): Promise<void> =>
  auroraInvoke<void>("chat_gallery_delete", { threadId: image.threadId, name: image.name });

/**
 * Thumbnail URLs already resolved this session, by gallery id. A thumbnail
 * file never changes for a given picture, so a page that remounts (Images ↔
 * Library) draws every tile straight from here instead of asking Rust again
 * and fading each one in a second time.
 */
const thumbnails = new Map<string, string>();
/** URLs the webview has finished decoding at least once. */
const decoded = new Set<string>();

export const cachedGalleryThumbnail = (
  image: Pick<GalleryImage, "threadId" | "name">,
): string | undefined => thumbnails.get(`${image.threadId}/${image.name}`);

export const isDecodedSrc = (src: string | undefined): boolean => !!src && decoded.has(src);
export const markDecodedSrc = (src: string): void => {
  decoded.add(src);
};

export const galleryThumbnail = (
  image: Pick<GalleryImage, "threadId" | "name">,
): Promise<string> => {
  const key = `${image.threadId}/${image.name}`;
  const known = thumbnails.get(key);
  if (known) return Promise.resolve(known);
  return auroraInvoke<string>("chat_gallery_thumbnail", {
    threadId: image.threadId,
    name: image.name,
  })
    .then(galleryFileSrc)
    .then((url) => {
      thumbnails.set(key, url);
      return url;
    });
};

/**
 * A gallery picture at full quality, as the attachment "Edit this image" hands
 * the prompt box. Read by Rust (`chat_gallery_read_image`): the webview's fs
 * scope does not cover conversation assets, so `readFile` refused them.
 */
export const galleryImageForEdit = async (image: GalleryImage): Promise<ImageAttachment> => ({
  id: Math.random().toString(36).slice(2, 11),
  name: image.name,
  mediaType: image.mediaType || "image/png",
  base64: await auroraInvoke<string>("chat_gallery_read_image", {
    threadId: image.threadId,
    name: image.name,
  }),
});

/** Forget a deleted picture's thumbnail. */
export const forgetGalleryThumbnail = (image: Pick<GalleryImage, "threadId" | "name">): void => {
  thumbnails.delete(`${image.threadId}/${image.name}`);
};

/** The last list read from disk, so a remounted page paints at once and revalidates. */
let lastList: GalleryResult | null = null;
export const cachedGalleryList = (): GalleryResult | null => lastList;
export const rememberGalleryList = (result: GalleryResult): void => {
  lastList = result;
};

export function filterGallery(
  images: GalleryImage[],
  query: string,
): GalleryImage[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return images.filter((image) => {
    const text = [image.prompt, image.name, image.threadTitle, image.model]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
