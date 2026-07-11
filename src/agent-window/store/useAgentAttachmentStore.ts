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
 * Not per-thread: attachments belong to the single live composer draft and are
 * cleared the moment a turn is sent.
 */

import { create } from "zustand";

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

interface AgentAttachmentState {
  images: ImageAttachment[];
  add: (image: ImageAttachment) => void;
  remove: (id: string) => void;
  /** Replace one attachment's bitmap (used after annotation). */
  update: (id: string, patch: Pick<ImageAttachment, "base64" | "mediaType">) => void;
  clear: () => void;
}

export const useAgentAttachmentStore = create<AgentAttachmentState>((set) => ({
  images: [],
  add: (image) => set((s) => ({ images: [...s.images, image] })),
  remove: (id) => set((s) => ({ images: s.images.filter((i) => i.id !== id) })),
  update: (id, patch) =>
    set((s) => ({
      images: s.images.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    })),
  clear: () => set((s) => (s.images.length === 0 ? s : { images: [] })),
}));
