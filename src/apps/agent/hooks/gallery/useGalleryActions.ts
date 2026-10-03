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
 *
 * Hide and delete are optimistic: the wall changes the moment you click, and
 * a failure puts it back with the reason. Hide is a flag on the picture
 * (`chat_gallery_set_hidden`), so it is remembered and both pages agree;
 * delete asks first, through the window's own confirm dialog.
 */

import React, { useCallback, useState } from "react";

import type { RailMenuItem, RailMenuState } from "@/apps/agent/components/shell/RailMenu";
import {
  copyGalleryImage,
  copyGalleryPath,
  copyGalleryPrompt,
  revealGalleryMedia,
  saveGalleryMedia,
} from "@/apps/agent/services/gallery/gallery-actions";
import {
  deleteGalleryMedia,
  forgetGalleryThumbnail,
  galleryImageForEdit,
  galleryImageId,
  setGalleryHidden,
  type GalleryImage,
} from "@/apps/agent/services/gallery/gallery-service";
import { openDestination } from "@/apps/agent/lib/navigation/destinations";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentImagesStore } from "@/apps/agent/store/images/useAgentImagesStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { toast } from "@/apps/agent/store/ui/useAgentToastStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";

export type GalleryMenuEvent =
  | React.MouseEvent<HTMLElement>
  | React.KeyboardEvent<HTMLElement>;

export function useGalleryActions(images: readonly GalleryImage[], refresh?: () => Promise<void> | void) {
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface === "chat");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [openError, setOpenError] = useState("");
  const [menu, setMenu] = useState<RailMenuState | null>(null);
  /** Hide state set here and not yet confirmed by a refresh, by gallery id. */
  const [hiddenOverride, setHiddenOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** Deleted here and not yet gone from the gallery list, by gallery id. */
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<GalleryImage | null>(null);

  const selected = images.find((image) => galleryImageId(image) === selectedId);

  /** Whether a picture draws blurred, with a just-clicked toggle winning. */
  const isHidden = useCallback(
    (image: GalleryImage) => hiddenOverride.get(galleryImageId(image)) ?? image.hidden === true,
    [hiddenOverride],
  );
  /** The list minus anything deleted from here but not yet refetched. */
  const visible = useCallback(
    <T extends GalleryImage>(list: readonly T[]) =>
      deleted.size ? list.filter((image) => !deleted.has(galleryImageId(image))) : list,
    [deleted],
  );

  const toggleHidden = async (image: GalleryImage) => {
    if (image.video) return;
    const id = galleryImageId(image);
    const next = !isHidden(image);
    setHiddenOverride((map) => new Map(map).set(id, next));
    setOpenError("");
    try {
      await setGalleryHidden(image, next);
      // The override stays: it now says what disk says. Clearing it after the
      // refresh flickered the blur when that refresh was skipped because a
      // poll begun before the write was still in flight.
      await refresh?.();
    } catch (cause) {
      setOpenError(`Could not ${next ? "hide" : "show"} the picture: ${String(cause)}`);
      // Back to what disk says.
      setHiddenOverride((map) => {
        const copy = new Map(map);
        copy.delete(id);
        return copy;
      });
    }
  };

  const requestDelete = (image: GalleryImage) => {
    setMenu(null);
    setDeleteTarget(image);
  };

  const confirmDelete = async () => {
    const image = deleteTarget;
    setDeleteTarget(null);
    if (!image) return;
    const id = galleryImageId(image);
    setDeleted((set) => new Set(set).add(id));
    if (selectedId === id) setSelectedId(null);
    setOpenError("");
    try {
      await deleteGalleryMedia(image);
      forgetGalleryThumbnail(image);
      // Stays in `deleted` (it is gone from disk), so a poll that started
      // before the delete cannot bring it back for a moment.
      await refresh?.();
    } catch (cause) {
      setOpenError(`Could not delete it: ${String(cause)}`);
      // Back on the wall.
      setDeleted((set) => {
        const copy = new Set(set);
        copy.delete(id);
        return copy;
      });
    }
  };

  /** Hand the picture to the Images prompt box as the one to edit, and go there. */
  const editInImages = async (image: GalleryImage) => {
    if (image.video || !image.path) return;
    setOpenError("");
    try {
      const source = await galleryImageForEdit(image);
      useAgentImagesStore.getState().setEditSource(source);
      openDestination("images");
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    }
  };

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
    setOpenError("");
    try {
      // A confirmation, not page content: a window toast (empty = none).
      if ((await run()) !== false) toast(message);
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
        icon: "zoom-in",
        label: image.video ? "Open video" : "Open image",
        onSelect: () => showPreview(image),
      },
      ...(!image.video
        ? [
            {
              icon: "pencil" as const,
              label: "Edit this image",
              onSelect: () => void editInImages(image),
            },
            {
              icon: "copy" as const,
              label: "Copy image",
              separatorBefore: true,
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
      ...(!image.video
        ? [
            {
              icon: (isHidden(image) ? "eye" : "eye-off") as "eye" | "eye-off",
              label: isHidden(image) ? "Unblur image" : "Blur image",
              separatorBefore: true,
              onSelect: () => void toggleHidden(image),
            },
          ]
        : []),
      {
        icon: "trash",
        label: image.video ? "Delete video…" : "Delete image…",
        danger: true,
        separatorBefore: !!image.video,
        onSelect: () => requestDelete(image),
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
    menu,
    closeMenu: () => setMenu(null),
    selectImage,
    showPreview,
    clearSelection,
    openConversation,
    openMenu,
    isHidden,
    visible,
    toggleHidden,
    requestDelete,
    deleteTarget,
    confirmDelete,
    cancelDelete: () => setDeleteTarget(null),
    editInImages,
  };
}

export type GalleryActions = ReturnType<typeof useGalleryActions>;
