import { describe, expect, it } from "vitest";

import { mediaRequestFacts, providerFromResult } from "./media-request";

describe("media request facts", () => {
  it("reads the provider that answered from a success or a failure", () => {
    expect(providerFromResult("Generated a.png (8×8 px) with m via APIKEY-FAN in 7s. Saved.")).toBe("APIKEY-FAN");
    expect(
      providerFromResult("[error] execution failed: gpt-image-2.5 via APIKEY-FAN: the image provider answered HTTP 401"),
    ).toBe("APIKEY-FAN");
    // A success whose rewritten prompt has a colon still reads the success.
    expect(
      providerFromResult("… with m via A6 in 3s. The provider rewrote the prompt as: a cat"),
    ).toBe("A6");
    expect(providerFromResult("the image provider refused the request")).toBe("");
  });

  it("prefers the provider the call named", () => {
    expect(
      mediaRequestFacts("generate_image", { model: "m", provider: "Named" }, "with m via Other in 1s."),
    ).toEqual(["m", "Named"]);
  });

  it("states an edit's source and a video's shape", () => {
    expect(mediaRequestFacts("generate_image", { op: "edit", model: "m", source: "1" })).toEqual(["m", "from 1"]);
    expect(
      mediaRequestFacts("generate_video", { model: "MiniMax-Hailuo-2.3", duration: 6, resolution: "768P" }),
    ).toEqual(["MiniMax-Hailuo-2.3", "6s", "768P"]);
  });

  it("says nothing for a lookup", () => {
    expect(mediaRequestFacts("generate_image", { op: "list" }, "… via X: y")).toEqual([]);
    expect(mediaRequestFacts("generate_video", { op: "query", jobId: "j" })).toEqual([]);
  });
});
