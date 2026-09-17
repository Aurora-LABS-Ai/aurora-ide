import { describe, expect, it } from "vitest";
import {
  filterGallery,
  galleryImageId,
  type GalleryImage,
} from "./gallery-service";

describe("gallery search", () => {
  const image: GalleryImage = {
    threadId: "chat-one",
    threadTitle: "Space research",
    name: "001.png",
    path: "/a.png",
    source: "generated",
    prompt: "Webb mirror",
    model: "Image model",
    width: 100,
    height: 50,
    mediaType: "image/png",
    createdAt: "2026-09-14",
  };
  it("searches prompt, model and conversation title together", () => {
    expect(filterGallery([image], " WEBB research ")).toEqual([image]);
    expect(filterGallery([image], "image model")).toEqual([image]);
    expect(filterGallery([image], "missing")).toEqual([]);
  });
  it("does not collide when two chats own the same file name", () => {
    expect(galleryImageId(image)).not.toBe(
      galleryImageId({ ...image, threadId: "chat-two" }),
    );
  });
});
