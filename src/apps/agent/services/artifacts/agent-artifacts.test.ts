import { describe, expect, it } from "vitest";

import { parseImageArtifactContent } from "@/apps/agent/services/artifacts/agent-artifacts";

/**
 * An `image` artifact's content is the record Rust's `generate_image` wrote
 * (`ImageArtifactContent`, camelCase on the wire). The Canvas decodes it here,
 * and what it does with a record it cannot read is decided here too.
 */
describe("reading an image artifact", () => {
  it("decodes the record Rust writes, field for field", () => {
    const record = parseImageArtifactContent(
      JSON.stringify({
        asset: "001-generated-an-aurora.png",
        path: "C:/Users/a/AppData/Local/AuroraIDE/Chats/t1/assets/001-generated-an-aurora.png",
        mediaType: "image/png",
        width: 1024,
        height: 1024,
        source: "generated",
        prompt: "An aurora over mountains",
        model: "gpt-image-1.5",
        provider: "a6api",
        createdAt: "2026-09-04T12:00:00Z",
      }),
    );

    expect(record).not.toBeNull();
    expect(record?.asset).toBe("001-generated-an-aurora.png");
    expect(record?.path).toContain("/assets/001-generated-an-aurora.png");
    expect(record?.source).toBe("generated");
    expect(record?.prompt).toBe("An aurora over mountains");
    expect(record?.model).toBe("gpt-image-1.5");
    expect(record?.provider).toBe("a6api");
    // Rust omits absent optionals rather than writing null.
    expect(record?.parent).toBeUndefined();
  });

  it("keeps the edit lineage", () => {
    const record = parseImageArtifactContent(
      JSON.stringify({
        asset: "002-edited-add-the-word-aurora.png",
        path: "C:/Chats/t1/assets/002-edited-add-the-word-aurora.png",
        mediaType: "image/png",
        width: 1024,
        height: 1024,
        source: "edited",
        parent: "001-generated-an-aurora.png",
        createdAt: "2026-09-04T12:01:00Z",
      }),
    );
    expect(record?.source).toBe("edited");
    expect(record?.parent).toBe("001-generated-an-aurora.png");
  });

  // The panel says the entry is unreadable instead of drawing a broken picture
  // from a path it does not have.
  it("refuses a record that is not JSON or does not name its file", () => {
    expect(parseImageArtifactContent("<svg/>")).toBeNull();
    expect(parseImageArtifactContent(JSON.stringify({ path: "C:/x.png" }))).toBeNull();
    expect(parseImageArtifactContent(JSON.stringify({ asset: "x.png" }))).toBeNull();
    expect(parseImageArtifactContent(JSON.stringify({ asset: "  ", path: "C:/x.png" }))).toBeNull();
  });

  it("falls back to sane values for fields a future record might drop", () => {
    const record = parseImageArtifactContent(
      JSON.stringify({ asset: "x.png", path: "C:/x.png", source: "something-new" }),
    );
    expect(record?.mediaType).toBe("image/png");
    expect(record?.width).toBe(0);
    expect(record?.source).toBe("generated");
    expect(record?.createdAt).toBe("");
  });
});
