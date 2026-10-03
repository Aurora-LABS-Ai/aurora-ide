/**
 * Agent Window — "Delete this picture?" for the media wall [view].
 *
 * One dialog for both pages that show the wall, driven by the shared
 * `useGalleryActions` state, so Images and Library ask the same question in
 * the same words. Deleting removes the file from disk, its thumbnail and its
 * Canvas card; the conversation that made it stays.
 */

import React from "react";

import { AgentConfirm } from "@/apps/agent/components/modals/AgentConfirm";
import type { GalleryActions } from "@/apps/agent/hooks/gallery/useGalleryActions";

export const GalleryDeleteConfirm: React.FC<{ actions: GalleryActions }> = ({ actions }) => {
  const target = actions.deleteTarget;
  const kind = target?.video ? "video" : "picture";
  return (
    <AgentConfirm
      open={target !== null}
      title={`Delete this ${kind}?`}
      // Never the prompt: prompts run to paragraphs, and a blurred picture's
      // prompt is exactly what its owner chose not to have on screen.
      message={`It's removed from disk and from its chat's Canvas. The chat stays. This can't be undone.`}
      confirmLabel="Delete"
      destructive
      onConfirm={() => void actions.confirmDelete()}
      onCancel={actions.cancelDelete}
    />
  );
};
