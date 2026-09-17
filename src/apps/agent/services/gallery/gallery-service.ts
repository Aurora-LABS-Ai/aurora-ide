import { convertFileSrc } from "@tauri-apps/api/core";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { isTauri } from "@/kernel/lib/ipc/tauri";
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
export const galleryThumbnail = (
  image: Pick<GalleryImage, "threadId" | "name">,
): Promise<string> =>
  auroraInvoke<string>("chat_gallery_thumbnail", {
    threadId: image.threadId,
    name: image.name,
  }).then(galleryFileSrc);

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
