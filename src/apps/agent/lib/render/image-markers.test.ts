import { describe, expect, it } from "vitest";

import {
  buildImageMarker,
  findImageMarker,
  findImageMarkers,
  hasImageMarker,
  parseUserContent,
} from "./image-markers";

const SHOT =
  '<aurora_image media_type="image/png" width="1400" height="812" src="C:\\shots\\a.png">aGVsbG8=</aurora_image>';

/**
 * Prose that documents the marker syntax. `.knowledge/knowledge.md` and this
 * project's own source both read like this, which is what made a plain file read
 * render as a "Captured screenshot" card and ship markdown to the provider as
 * base64.
 */
const PROSE = [
  'FIX: `truncate_tool_content` returns early when `s.contains("<aurora_image ")`.',
  "The MODEL copy keeps the full `<aurora_image>` block (vision), the UI copy is lean.",
  "On reload, parse the raw `<aurora_image ... src=.. w.. h..>BASE64</aurora_image>` block.",
].join("\n");

describe("findImageMarker", () => {
  it("parses a screenshot marker with every attribute", () => {
    const marker = findImageMarker(SHOT);
    expect(marker).not.toBeNull();
    expect(marker?.attrs.media_type).toBe("image/png");
    expect(marker?.attrs.src).toBe("C:\\shots\\a.png");
    expect(marker?.attrs.width).toBe("1400");
    expect(marker?.body).toBe("aGVsbG8=");
    expect(marker?.end).toBe(SHOT.length);
  });

  it("parses a composer marker carrying only media_type", () => {
    const raw = '<aurora_image media_type="image/jpeg">aGVsbG8=</aurora_image>';
    expect(findImageMarker(raw)?.attrs.media_type).toBe("image/jpeg");
  });

  it("parses a lean marker whose body was stripped for persistence", () => {
    const raw = '<aurora_image media_type="image/png" src="/tmp/a.png"></aurora_image>';
    const marker = findImageMarker(raw);
    expect(marker?.body).toBe("");
    expect(marker?.attrs.src).toBe("/tmp/a.png");
  });

  it("does not treat prose that quotes the syntax as an image", () => {
    expect(findImageMarker(PROSE)).toBeNull();
    expect(hasImageMarker(PROSE)).toBe(false);
  });

  it("still finds a real marker that follows quoted prose", () => {
    const marker = findImageMarker(`${PROSE}\n\n${SHOT}`);
    expect(marker?.body).toBe("aGVsbG8=");
  });

  it("rejects malformed headers and non-base64 bodies", () => {
    const bad = [
      '<aurora_image width="10">aGVsbG8=</aurora_image>', // no media_type
      '<aurora_image media_type="text/plain">aGVsbG8=</aurora_image>', // not an image
      "<aurora_image media_type=image/png>aGVsbG8=</aurora_image>", // unquoted value
      '<aurora_image media_type="image/png" oops>aGVsbG8=</aurora_image>', // stray word
      '<aurora_image media_type="image/png">not base64!</aurora_image>', // bad body
      '<aurora_image media_type="image/png">aGVsbG8=', // no close tag
    ];
    for (const raw of bad) expect(hasImageMarker(raw)).toBe(false);
  });

  it("finds every marker in order", () => {
    const raw = `${SHOT}\ntext between\n${SHOT}`;
    expect(findImageMarkers(raw)).toHaveLength(2);
  });
});

describe("parseUserContent", () => {
  it("splits typed text from attached images", () => {
    const content = `look at this\n\n${buildImageMarker({
      mediaType: "image/png",
      base64: "aGVsbG8=",
    })}`;
    const parsed = parseUserContent(content);
    expect(parsed.text).toBe("look at this");
    expect(parsed.images).toEqual([{ mediaType: "image/png", base64: "aGVsbG8=" }]);
  });

  it("leaves a message that merely discusses markers intact", () => {
    const parsed = parseUserContent(PROSE);
    expect(parsed.images).toHaveLength(0);
    expect(parsed.text).toBe(PROSE);
  });

  it("extracts screenshot-shaped markers too, not just media_type-only ones", () => {
    const parsed = parseUserContent(`before ${SHOT} after`);
    expect(parsed.images).toEqual([{ mediaType: "image/png", base64: "aGVsbG8=" }]);
    expect(parsed.text).toBe("before  after");
  });
});
