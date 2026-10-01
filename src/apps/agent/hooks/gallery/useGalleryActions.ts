/**
 * Agent Window — what you can do with a picture in a media grid.
 *
 * Selection, preview, the context menu and "Open chat" for gallery media, in
 * one hook. The Library page and the Images page both show grids of the same
 * `GalleryImage` records, and a picture must behave identically in both: same
 * menu rows, same copy/save/reveal actions, same route back to the chat that
 * made it. Before this the actions lived inside one panel and a second grid
 * would have meant a second copy of every row.
 *
 * "Open chat" crosses products when it has to. Pictures are Aurora Chat
 * conversations; if the window is showing Build, the chat side is entered
 * first, then the conversation is selected, then the window goes Home so the
 * transcript is actually on screen.
 */

import React, { useState } from "react";

import type { RailMenuItem, RailMenuState } from "@/apps/agent/components/shell/RailMenu";
import {
  copyGalleryImage,
  copyGalleryPath,
  copyGalleryPrompt,
  revealGalleryMedia,
  saveGalleryMedia,
} from "@/apps/agent/services/gallery/gallery-actions";
import { galleryImageId, type GalleryImage } from "@/apps/agent/services/gallery/gallery-service";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";

export type GalleryMenuEvent =
  | React.MouseEvent<HTMLElement>
  | React.KeyboardEvent<HTMLElement>;

export function useGalleryActions(images: readonly GalleryImage[]) {
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface === "chat");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [openError, setOpenError] = useState("");
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<RailMenuState | null>(null);

  const selected = images.find((image) => galleryImageId(image) === selectedId);

  const selectImage = (image: GalleryImage) => {
    setSelectedId(galleryImageId(image));
    setPreview(false);
    setOpenError("");
  };

  const showPreview = (image: GalleryImage) => {
    selectImage(image);
    setPreview(true);
  };

  const clearSelection = () => setSelectedId(null);

  const openConversation = async (image = selected) => {
    if (!image) return;
    setOpenError("");
    try {
      if (!chatSurface) await useAgentChatStore.getState().enterSurface("chat");
      await useAgentChatStore.getState().selectThread(image.threadId, null);
      const failure = useAgentChatStore.getState().error;
      if (failure) {
        setOpenError(failure);
        return;
      }
      useAgentUiStore.getState().goHome();
    } catch (cause) {
      setOpenError(String(cause));
    }
  };

  const action = async (run: () => Promise<unknown>, message: string) => {
    setNotice("");
    setOpenError("");
    try {
      if ((await run()) !== false) setNotice(message);
    } catch (cause) {
      setOpenError(String(cause));
    }
  };

  const openMenu = (event: GalleryMenuEvent, image: GalleryImage) => {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget;
    anchor.focus();
    selectImage(image);
    const items: RailMenuItem[] = [
      {
        icon: "eye",
        label: image.video ? "Open video" : "Open image",
        onSelect: () => showPreview(image),
      },
      ...(!image.video
        ? [
            {
              icon: "copy" as const,
              label: "Copy image",
              onSelect: () => void action(() => copyGalleryImage(image), "Image copied"),
            },
          ]
        : []),
      ...(image.path
        ? [
            {
              icon: "download" as const,
              label: "Save as...",
              onSelect: () => void action(() => saveGalleryMedia(image), "Saved"),
            },
            {
              icon: "folder" as const,
              label: "Show in folder",
              onSelect: () => void action(() => revealGalleryMedia(image), ""),
            },
            {
              icon: "copy" as const,
              label: "Copy file path",
              onSelect: () => void action(() => copyGalleryPath(image), "Path copied"),
            },
          ]
        : []),
      ...(image.prompt
        ? [
            {
              icon: "copy" as const,
              label: "Copy prompt",
              separatorBefore: true,
              onSelect: () => void action(() => copyGalleryPrompt(image), "Prompt copied"),
            },
          ]
        : []),
      {
        icon: "chat",
        label: "Open chat",
        separatorBefore: true,
        onSelect: () => void openConversation(image),
      },
    ];
    const rect = anchor.getBoundingClientRect();
    setMenu({
      anchor,
      items,
      x: "clientX" in event && event.clientX ? event.clientX : rect.left + 12,
      y: "clientY" in event && event.clientY ? event.clientY : rect.top + 12,
    });
  };

  return {
    selected,
    preview,
    setPreview,
    openError,
    notice,
    menu,
    closeMenu: () => setMenu(null),
    selectImage,
    showPreview,
    clearSelection,
    openConversation,
    openMenu,
  };
}

export type GalleryActions = ReturnType<typeof useGalleryActions>;
