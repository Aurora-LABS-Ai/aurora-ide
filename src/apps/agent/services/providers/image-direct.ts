/**
 * Path A of Aurora Chat's picture making: the conversation's model IS an
 * image model. One IPC call is the whole turn — Rust appends the user's
 * message, asks the provider, stores the file, lands it in the Canvas, appends
 * the picture as the reply and titles the chat from the prompt. See
 * `src-tauri/src/commands/image_direct.rs`.
 *
 * The provider row is sent as stored; its shape IS the wire shape.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { ImageProvider } from "@/apps/agent/services/providers/image-providers";

export interface ImageDirectRequest {
  threadId: string;
  prompt: string;
  provider: ImageProvider;
  /** The model key inside `provider`. */
  model: string;
  /** `WIDTHxHEIGHT`; the model's default when omitted. */
  size?: string | null;
  /** The conversation's pin, `"<providerId>:<modelKey>"`. */
  modelSelection: string;
}

/** The stored picture, in the shape the transcript renders. */
export interface ImageDirectResult {
  asset: string;
  path: string;
  mediaType: string;
  width: number;
  height: number;
  prompt: string;
  model: string;
  artifactId: string;
  revisedPrompt: string | null;
  elapsedMs: number;
}

/** Rejects with the provider's own words when the picture cannot be made. */
export const generateImageDirect = (request: ImageDirectRequest): Promise<ImageDirectResult> =>
  auroraInvoke<ImageDirectResult>("image_direct_generate", { request });
