import { describe, expect, it } from "vitest";

import { mergeOpenSentence } from "./open-sentence";

const words = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `w${i + from}`).join(" ");

describe("mergeOpenSentence", () => {
  it("takes the new text when the sentence just grew", () => {
    expect(mergeOpenSentence("Open the", "Open the settings file")).toBe("Open the settings file");
  });

  it("lets a short sentence's first word be corrected", () => {
    // Seen live: "Ye Hey, what's up?" became "Hey, what's up? How are you?".
    expect(mergeOpenSentence("Ye Hey, what's up?", "Hey, what's up? How are you?")).toBe(
      "Hey, what's up? How are you?",
    );
  });

  it("keeps the start of a long sentence the window has slid past", () => {
    const shown = words(60);
    const slid = `${words(55, 5)} w60 w61`;
    expect(mergeOpenSentence(shown, slid)).toBe(words(62));
  });

  it("matches across punctuation and capitals the model changed", () => {
    const shown = `${words(50)} Then run the tests`;
    const slid = "then, run the tests again";
    expect(mergeOpenSentence(shown, slid)).toBe(`${words(50)} then, run the tests again`);
  });

  it("takes the new text when it cannot find where it starts", () => {
    expect(mergeOpenSentence(words(60), "something else entirely here")).toBe(
      "something else entirely here",
    );
  });
});
