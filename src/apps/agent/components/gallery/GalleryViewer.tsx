/**
 * Agent Window — full-size view of a wall tile [view].
 *
 * One click on a tile opens the app's own image preview (`AgentImageModal`,
 * the same one a chat picture opens), the whole picture fitted to the window.
 * Nothing else on screen: every action lives in the tile's right-click menu.
 * ←/→ step through the wall in its display order. Videos open their player.
 */

import React, { useEffect } from "react";

import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import {
  galleryFileSrc,
  galleryImageId,
  galleryImageTitle,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";
import type { GalleryActions } from "@/apps/agent/hooks/gallery/useGalleryActions";
import { GalleryVideoModal } from "./GalleryVideoModal";

export const GalleryViewer: React.FC<{
  image: GalleryImage;
  /** The wall's pictures in display order, for ←/→. */
  items: readonly GalleryImage[];
  actions: GalleryActions;
  onRefresh: () => void;
}> = ({ image, items, actions, onRefresh }) => {
  const { setPreview, showPreview } = actions;
  const id = galleryImageId(image);
  const index = items.findIndex((entry) => galleryImageId(entry) === id);
  const prev = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 ? items[index + 1] : undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.key === "ArrowLeft" ? prev : event.key === "ArrowRight" ? next : undefined;
      if (!target) return;
      event.preventDefault();
      showPreview(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, showPreview]);

  if (image.video) {
    return <GalleryVideoModal video={image.video} onClose={() => setPreview(false)} onUpdate={onRefresh} />;
  }
  return (
    <AgentImageModal
      open
      mode="preview"
      src={galleryFileSrc(image.path)}
      alt={galleryImageTitle(image)}
      onClose={() => setPreview(false)}
    />
  );
};
