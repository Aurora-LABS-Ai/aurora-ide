/**
 * Agent Window — composer image attachments.
 *
 * Transient, draft-scoped image attachments staged in the composer before send.
 * The composer is the SOLE gate: images only land here when the active model is
 * vision-capable (see `AgentComposer`). On send, `useAgentWindowSend` drains
 * these into `<aurora_image>` markers appended to the user message (the same
 * marker convention `browser_screenshot` uses, which the Rust provider adapter
 * splits into real multimodal `image`/`image_url` blocks).
 *
 * Keyed by COMPOSER (see `composerKey`), not global. The window can show more
 * than one composer at a time — the main pane plus any chat docked in the side
 * panel — and a single shared tray meant staging an image in one and sending
 * from the other silently attached it to the wrong conversation.
 */

import { create } from "zustand";

/**
 * The key a composer stages under: its thread, or `"draft"` for a new chat that
 * has no thread yet. Shared by every per-composer staging store so they always
 * partition the same way.
 */
export const composerKey = (threadId: string | null | undefined): string =>
  threadId || "draft";

export interface ImageAttachment {
  id: string;
  /** Display name (filename, or "pasted-image.png"). */
  name: string;
  /** MIME type, e.g. "image/png". */
  mediaType: string;
  /** Raw base64 (NO `data:` prefix) — what rides in the marker. */
  base64: string;
}

/** Convenience: a renderable `data:` URL for an attachment. */
export const attachmentDataUrl = (a: { mediaType: string; base64: string }): string =>
  `data:${a.mediaType};base64,${a.base64}`;

/** Stable empty array so a selector for an unstaged composer never re-renders. */
const NO_IMAGES: ImageAttachment[] = [];

interface AgentAttachmentState {
  /** Staged images per composer key. */
  byComposer: Record<string, ImageAttachment[]>;
  add: (key: string, image: ImageAttachment) => void;
  remove: (key: string, id: string) => void;
  /** Replace one attachment's bitmap (used after annotation). */
  update: (
    key: string,
    id: string,
    patch: Pick<ImageAttachment, "base64" | "mediaType">,
  ) => void;
  clear: (key: string) => void;
}

/** One composer's staged images. Safe to call inside a zustand selector. */
export const composerImages = (
  state: { byComposer: Record<string, ImageAttachment[]> },
  key: string,
): ImageAttachment[] => state.byComposer[key] ?? NO_IMAGES;

export const useAgentAttachmentStore = create<AgentAttachmentState>((set) => ({
  byComposer: {},
  add: (key, image) =>
    set((s) => ({
      byComposer: { ...s.byComposer, [key]: [...(s.byComposer[key] ?? []), image] },
    })),
  remove: (key, id) =>
    set((s) => ({
      byComposer: {
        ...s.byComposer,
        [key]: (s.byComposer[key] ?? []).filter((i) => i.id !== id),
      },
    })),
  update: (key, id, patch) =>
    set((s) => ({
      byComposer: {
        ...s.byComposer,
        [key]: (s.byComposer[key] ?? []).map((i) =>
          i.id === id ? { ...i, ...patch } : i,
        ),
      },
    })),
  clear: (key) =>
    set((s) => {
      if (!s.byComposer[key]?.length) return s;
      const byComposer = { ...s.byComposer };
      delete byComposer[key];
      return { byComposer };
    }),
}));
