import { describe, expect, it } from "vitest";

import {
  TAIL_APPEARS_AFTER_MS,
  tailDueInMs,
  tailLines,
} from "@/apps/agent/components/tool-views/shell-tail";

describe("tailDueInMs", () => {
  it("waits out the delay from the command's own start", () => {
    expect(tailDueInMs(10_000, 99_999, 10_400)).toBe(TAIL_APPEARS_AFTER_MS - 400);
  });

  it("is due once the command has run long enough", () => {
    expect(tailDueInMs(10_000, 99_999, 10_000 + TAIL_APPEARS_AFTER_MS)).toBe(0);
    expect(tailDueInMs(10_000, 99_999, 60_000)).toBe(0);
  });

  it("counts from when the card saw it running when there is no start time", () => {
    expect(tailDueInMs(undefined, 20_000, 20_500)).toBe(TAIL_APPEARS_AFTER_MS - 500);
  });
});

describe("tailLines", () => {
  it("keeps the newest lines, oldest first", () => {
    const output = Array.from({ length: 47 }, (_, i) => `${i + 1}`).join("\n") + "\n";
    expect(tailLines(output)).toEqual(["43", "44", "45", "46", "47"]);
  });

  it("shows a short output whole, without a phantom empty last line", () => {
    expect(tailLines("1\n2\n")).toEqual(["1", "2"]);
  });

  it("shows a progress bar's latest redraw, as a terminal would", () => {
    expect(tailLines("Downloading\n 10%\r 55%\r100%\n")).toEqual(["Downloading", "100%"]);
  });

  it("drops colour codes and Windows line endings", () => {
    expect(tailLines("\u001b[32mok\u001b[0m\r\ndone\r\n")).toEqual(["ok", "done"]);
  });

  it("reads only the end of a huge buffer", () => {
    const output = "x".repeat(200_000) + "\nlast\n";
    expect(tailLines(output).at(-1)).toBe("last");
  });
});
