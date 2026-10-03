import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createThread: vi.fn(),
  generateImageDirect: vi.fn(),
  refreshThreads: vi.fn(),
}));
vi.mock("@/apps/agent/services/threads/thread-service", () => ({
  threadService: { createThread: mocks.createThread },
}));
vi.mock("@/apps/agent/services/providers/image-direct", () => ({
  generateImageDirect: mocks.generateImageDirect,
}));
vi.mock("@/apps/agent/store/conversation/useAgentChatStore", () => ({
  useAgentChatStore: { getState: () => ({ refreshThreads: mocks.refreshThreads }) },
}));

import { useAgentImagesStore, type GenerateImageInput } from "./useAgentImagesStore";
import type { ImageModel, ImageProvider } from "@/apps/agent/services/providers/image-providers";

const model: ImageModel = {
  id: "img-a/banana",
  providerId: "img-a",
  modelKey: "banana",
  label: "Nano Banana Pro",
  sizes: ["1024x1024", "1536x1024"],
  defaultSize: "1536x1024",
};
const provider: ImageProvider = {
  id: "img-a",
  name: "A",
  baseUrl: "https://img.example/v1",
  apiKey: "k",
  apiFormat: "openai-images",
  enabled: true,
  models: [model],
};
const input: GenerateImageInput = {
  prompt: "  an aurora over mountains  ",
  provider,
  model,
  modelSelection: "img-a:banana",
};

beforeEach(() => {
  vi.clearAllMocks();
  useAgentImagesStore.setState({ jobs: [], revision: 0 });
  mocks.createThread.mockResolvedValue({ id: "chat-9" });
  mocks.generateImageDirect.mockResolvedValue({ asset: "001.png" });
  mocks.refreshThreads.mockResolvedValue(undefined);
});

describe("useAgentImagesStore.generate", () => {
  it("keeps a finished picture in its slot until the gallery lists it, then lets it go", async () => {
    mocks.generateImageDirect.mockResolvedValue({ asset: "001.png", path: "C:/a/001.png", width: 1024, height: 768 });
    await useAgentImagesStore.getState().generate(input);
    const [job] = useAgentImagesStore.getState().jobs;
    expect(job).toMatchObject({
      status: "done",
      resultKey: "chat-9/001.png",
      result: { path: "C:/a/001.png", width: 1024, height: 768 },
    });
    useAgentImagesStore.getState().settle(new Set(["chat-9/other.png"]));
    expect(useAgentImagesStore.getState().jobs).toHaveLength(1);
    useAgentImagesStore.getState().settle(new Set(["chat-9/001.png"]));
    expect(useAgentImagesStore.getState().jobs).toEqual([]);
  });

  it("makes an Aurora Chat conversation, sends the picture request into it, then marks the job done and ticks the revision", async () => {
    await useAgentImagesStore.getState().generate(input);

    // Always the Chat store, no project: pictures are a Chat capability
    // whichever side of the app is showing.
    expect(mocks.createThread).toHaveBeenCalledWith("an aurora over mountains", null, "chat", false);
    expect(mocks.generateImageDirect).toHaveBeenCalledWith({
      threadId: "chat-9",
      prompt: "an aurora over mountains",
      provider,
      model: "banana",
      size: "1536x1024",
      modelSelection: "img-a:banana",
    });
    expect(useAgentImagesStore.getState().jobs.map((job) => job.status)).toEqual(["done"]);
    expect(useAgentImagesStore.getState().revision).toBe(1);
    expect(mocks.refreshThreads).toHaveBeenCalledTimes(1);
  });

  it("holds a pending tile at the picture's aspect while the provider works", async () => {
    let finish!: (value: unknown) => void;
    mocks.generateImageDirect.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const running = useAgentImagesStore.getState().generate({ ...input, size: "1024x1024" });
    await Promise.resolve();
    const [job] = useAgentImagesStore.getState().jobs;
    expect(job.status).toBe("pending");
    expect(job.aspectRatio).toBe("1024 / 1024");
    expect(job.modelLabel).toBe("Nano Banana Pro");
    finish({ asset: "001.png", path: "C:/a/001.png", width: 1024, height: 1024 });
    await running;
    expect(useAgentImagesStore.getState().jobs.map((entry) => entry.status)).toEqual(["done"]);
  });

  it("keeps a failed job on screen with the provider's own words", async () => {
    mocks.generateImageDirect.mockRejectedValue(new Error("1536x1024 is not a size banana offers."));
    await useAgentImagesStore.getState().generate(input);
    const [job] = useAgentImagesStore.getState().jobs;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("1536x1024 is not a size banana offers.");
    expect(job.threadId).toBe("chat-9");
    expect(useAgentImagesStore.getState().revision).toBe(0);
  });

  it("fails the job, not the page, when the conversation cannot be created", async () => {
    mocks.createThread.mockRejectedValue(new Error("disk full"));
    await useAgentImagesStore.getState().generate(input);
    const [job] = useAgentImagesStore.getState().jobs;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("disk full");
    expect(job.threadId).toBeUndefined();
    expect(mocks.generateImageDirect).not.toHaveBeenCalled();
  });

  it("ignores an empty prompt", async () => {
    await useAgentImagesStore.getState().generate({ ...input, prompt: "   " });
    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(useAgentImagesStore.getState().jobs).toEqual([]);
  });

  it("sends an attached picture as a marker after the text, the shape a chat attachment takes", async () => {
    const source = { id: "s1", name: "fox.png", mediaType: "image/png", base64: "iVBORw0KGgo=" };
    await useAgentImagesStore.getState().generate({ ...input, prompt: "make the sky purple", source });
    expect(mocks.generateImageDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'make the sky purple\n\n<aurora_image media_type="image/png">iVBORw0KGgo=</aurora_image>',
      }),
    );
    // The chat is titled from what was asked, never from the picture's bytes.
    expect(mocks.createThread.mock.calls[0][0]).not.toContain("aurora_image");
  });
});

describe("useAgentImagesStore.retry / dismiss", () => {
  it("retries into the same conversation rather than making a second one", async () => {
    mocks.generateImageDirect.mockRejectedValueOnce(new Error("timed out"));
    await useAgentImagesStore.getState().generate(input);
    const [failed] = useAgentImagesStore.getState().jobs;

    await useAgentImagesStore.getState().retry(failed.id);

    expect(mocks.createThread).toHaveBeenCalledTimes(1);
    expect(mocks.generateImageDirect).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "chat-9" }),
    );
    expect(useAgentImagesStore.getState().jobs.map((job) => job.status)).toEqual(["done"]);
    expect(useAgentImagesStore.getState().revision).toBe(1);
  });

  it("only retries jobs that failed", async () => {
    let finish!: (value: unknown) => void;
    mocks.generateImageDirect.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const running = useAgentImagesStore.getState().generate(input);
    await Promise.resolve();
    const [pending] = useAgentImagesStore.getState().jobs;
    await useAgentImagesStore.getState().retry(pending.id);
    expect(mocks.generateImageDirect).toHaveBeenCalledTimes(1);
    finish({ asset: "001.png", path: "C:/a/001.png", width: 1, height: 1 });
    await running;
  });

  it("dismiss removes a failed job", async () => {
    mocks.generateImageDirect.mockRejectedValue(new Error("no"));
    await useAgentImagesStore.getState().generate(input);
    const [failed] = useAgentImagesStore.getState().jobs;
    useAgentImagesStore.getState().dismiss(failed.id);
    expect(useAgentImagesStore.getState().jobs).toEqual([]);
  });
});
