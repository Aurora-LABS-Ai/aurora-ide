/**
 * Agent Window — pictures made from the Images page.
 *
 * The page's prompt box does not go through a language model. Each send is one
 * call to the same `image_direct_generate` command a picture-making chat uses:
 * Rust creates the conversation, journals the prompt as the user's message,
 * asks the provider, stores the file under that conversation's assets, lands
 * it in the Canvas and titles the chat from the prompt. So every picture made
 * here is also a real Aurora Chat conversation — "Open chat" continues it, and
 * the Library lists it — without the page owning any storage of its own.
 *
 * What this store owns is only what disk cannot show yet: the jobs in flight
 * and the ones that failed, so the grid can hold a tile at the right aspect
 * while the provider works and keep a failure on screen with a retry. Jobs
 * live here rather than in the page's state so navigating away and back does
 * not lose a picture that is still being made.
 *
 * `revision` ticks when a picture lands. The page's gallery hook refreshes on
 * it; nothing else needs to know.
 */

import { create } from "zustand";

import { deriveThreadTitle } from "@/apps/agent/lib/thread/thread-title";
import { buildImageMarker } from "@/apps/agent/lib/render/image-markers";
import { generateImageDirect } from "@/apps/agent/services/providers/image-direct";
import type { ImageAttachment } from "@/apps/agent/store/composer/useAgentAttachmentStore";
import {
  aspectRatioOfSize,
  type ImageModel,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";
import { threadService } from "@/apps/agent/services/threads/thread-service";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

export interface GenerateImageInput {
  prompt: string;
  provider: ImageProvider;
  model: ImageModel;
  /** `"<providerId>:<modelKey>"`, written to the new chat as its pin. */
  modelSelection: string;
  /** `WIDTHxHEIGHT`; the model's default when omitted. */
  size?: string | null;
  /**
   * The picture to edit, when one was attached. Sent as an `<aurora_image>`
   * marker after the text — the shape a chat attachment takes — and the Rust
   * command turns that into an edit call.
   */
  source?: ImageAttachment | null;
}

export interface ImageJob {
  id: string;
  prompt: string;
  modelLabel: string;
  /** CSS `aspect-ratio` of the picture that will arrive. */
  aspectRatio: string;
  /**
   * `done`: the picture exists and this job is only holding its slot until
   * the gallery lists it. Dropping the job the moment the command returned
   * emptied the slot, then the refetched picture appeared a beat later —
   * two jumps for one picture.
   */
  status: "pending" | "failed" | "done";
  /** The provider's own words, when `status` is `failed`. */
  error?: string;
  startedAt: number;
  /** Set once the conversation exists; a retry reuses it. */
  threadId?: string;
  /** `threadId/asset` — the gallery id the finished picture will have. */
  resultKey?: string;
  /** The finished picture, drawn in the slot before the gallery has it. */
  result?: { path: string; width: number; height: number };
  /** Everything needed to send the same request again. */
  request: GenerateImageInput;
}

interface AgentImagesState {
  jobs: ImageJob[];
  /** Ticks each time a picture lands on disk. */
  revision: number;
  /**
   * A picture handed to the prompt box from elsewhere ("Edit this image" on
   * any tile, in Images or Library). The prompt box takes it and clears it.
   */
  editSource: ImageAttachment | null;
  generate: (input: GenerateImageInput) => Promise<void>;
  retry: (id: string) => Promise<void>;
  dismiss: (id: string) => void;
  /** Drop finished jobs whose picture the gallery now lists. */
  settle: (galleryKeys: ReadonlySet<string>) => void;
  setEditSource: (source: ImageAttachment | null) => void;
}

const genId = () => Math.random().toString(36).slice(2, 11);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const useAgentImagesStore = create<AgentImagesState>()((set, get) => {
  const patch = (id: string, changes: Partial<ImageJob>) =>
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...changes } : job)),
    }));

  const run = async (id: string): Promise<void> => {
    const job = get().jobs.find((entry) => entry.id === id);
    if (!job) return;
    const { request } = job;
    try {
      // The conversation is made in Aurora Chat's store whatever side of the
      // app the window is showing: pictures are a Chat capability, and the
      // Build store has no place for them.
      const threadId =
        job.threadId ??
        (await threadService.createThread(deriveThreadTitle(request.prompt), null, "chat", false))
          .id;
      patch(id, { threadId });
      const result = await generateImageDirect({
        threadId,
        // Text first, then the picture, the order a chat message takes.
        prompt: request.source
          ? `${request.prompt}\n\n${buildImageMarker(request.source)}`
          : request.prompt,
        provider: request.provider,
        model: request.model.modelKey,
        size: request.size ?? request.model.defaultSize ?? null,
        modelSelection: request.modelSelection,
      });
      // Keep the slot, now showing the picture itself; `settle` drops the job
      // once the refreshed gallery carries the same picture under the same key.
      set((state) => ({
        jobs: state.jobs.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                status: "done" as const,
                resultKey: `${threadId}/${result.asset}`,
                result: { path: result.path, width: result.width, height: result.height },
              }
            : entry,
        ),
        revision: state.revision + 1,
      }));
      // A new chat exists now; if the chat list is showing Aurora Chat it
      // should list it without a reopen.
      void useAgentChatStore.getState().refreshThreads();
    } catch (error) {
      patch(id, { status: "failed", error: describe(error) });
    }
  };

  return {
    jobs: [],
    revision: 0,
    editSource: null,

    settle: (galleryKeys) => {
      const { jobs } = get();
      if (!jobs.some((job) => job.status === "done" && job.resultKey && galleryKeys.has(job.resultKey))) {
        return;
      }
      set({
        jobs: jobs.filter(
          (job) => !(job.status === "done" && job.resultKey && galleryKeys.has(job.resultKey)),
        ),
      });
    },

    setEditSource: (source) => set({ editSource: source }),

    generate: async (input) => {
      const prompt = input.prompt.trim();
      if (!prompt) return;
      const size = input.size ?? input.model.defaultSize ?? null;
      const job: ImageJob = {
        id: genId(),
        prompt,
        modelLabel: input.model.label?.trim() || input.model.modelKey,
        aspectRatio: aspectRatioOfSize(size),
        status: "pending",
        startedAt: Date.now(),
        request: { ...input, prompt, size },
      };
      set((state) => ({ jobs: [job, ...state.jobs] }));
      await run(job.id);
    },

    retry: async (id) => {
      const job = get().jobs.find((entry) => entry.id === id);
      if (!job || job.status !== "failed") return;
      patch(id, { status: "pending", error: undefined, startedAt: Date.now() });
      await run(id);
    },

    dismiss: (id) =>
      set((state) => ({ jobs: state.jobs.filter((entry) => entry.id !== id) })),
  };
});
