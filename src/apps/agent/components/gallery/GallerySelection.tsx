/**
 * Agent Window — the details strip for a selected picture or video.
 *
 * Title, dimensions and model, the chat it came from, and the three actions
 * (view, more, open chat), plus the preview modal when asked for. Shared by
 * the Library and Images pages through `useGalleryActions`, so a selected
 * picture reads the same wherever it was selected.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentImageModal } from "@/apps/agent/components/modals/AgentImageModal";
import { VideoResultView } from "@/apps/agent/components/tool-views/VideoResultView";
import { GalleryVideoModal } from "./GalleryVideoModal";
import {
  galleryFileSrc,
  galleryImageTitle,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";
import type { GalleryActions } from "@/apps/agent/hooks/gallery/useGalleryActions";

export const GallerySelection: React.FC<{
  selected: GalleryImage;
  actions: GalleryActions;
  onRefresh: () => void;
}> = ({ selected, actions, onRefresh }) => {
  const { preview, setPreview, clearSelection, openMenu, openConversation } = actions;
  return (
    <aside className="agw-gallery-selection" aria-label="Selected media">
      <button
        type="button"
        className="agw-gallery-icon"
        aria-label="Close image details"
        title="Close image details"
        onClick={clearSelection}
      >
        <AgentIcon name="close" size={14} />
      </button>
      <p className="agw-gallery-selected-title">{galleryImageTitle(selected)}</p>
      {!selected.video && (
        <p>
          {selected.width} x {selected.height}
          {selected.model ? ` / ${selected.model}` : ""}
        </p>
      )}
      {selected.video && !preview && (
        <VideoResultView key={selected.video.jobId} video={selected.video} onUpdate={onRefresh} />
      )}
      <p>{selected.threadTitle}</p>
      <div className="agw-gallery-actions">
        <button type="button" onClick={() => setPreview(true)}>
          <AgentIcon name="zoom-in" size={14} />
          {selected.video ? "View video" : "View image"}
        </button>
        <button
          type="button"
          aria-label="More media actions"
          title="More actions"
          onClick={(event) => openMenu(event, selected)}
        >
          <AgentIcon name="more" size={14} />
        </button>
        <button type="button" onClick={() => void openConversation()}>
          <AgentIcon name="chat" size={14} />
          Open chat
        </button>
      </div>
      {preview &&
        (selected.video ? (
          <GalleryVideoModal
            video={selected.video}
            onClose={() => setPreview(false)}
            onUpdate={onRefresh}
          />
        ) : (
          <AgentImageModal
            open
            src={galleryFileSrc(selected.path)}
            alt={galleryImageTitle(selected)}
            mode="preview"
            onClose={() => setPreview(false)}
          />
        ))}
    </aside>
  );
};
