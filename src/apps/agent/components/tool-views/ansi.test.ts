import { describe, expect, it } from "vitest";

import { hasAnsi, parseAnsi, stripAnsi } from "@/apps/agent/components/tool-views/ansi";

const ESC = String.fromCharCode(0x1b);

describe("ansi parser", () => {
  it("passes plain text through as a single unstyled span", () => {
    expect(hasAnsi("plain output")).toBe(false);
    expect(parseAnsi("plain output")).toEqual([{ text: "plain output" }]);
  });

  it("styles 16-color SGR runs and resets", () => {
    const spans = parseAnsi(`${ESC}[31mFAIL${ESC}[0m ok ${ESC}[1;32mPASS${ESC}[0m`);
    expect(spans).toHaveLength(3);
    expect(spans[0].text).toBe("FAIL");
    expect(spans[0].color).toContain("--agw-ansi-red");
    expect(spans[1]).toEqual({ text: " ok " });
    expect(spans[2].text).toBe("PASS");
    expect(spans[2].bold).toBe(true);
    expect(spans[2].color).toContain("--agw-ansi-green");
  });

  it("supports 256-color and truecolor foregrounds", () => {
    const spans = parseAnsi(
      `${ESC}[38;5;196mred256${ESC}[0m${ESC}[38;2;10;20;30mrgb${ESC}[0m`,
    );
    expect(spans[0].text).toBe("red256");
    expect(spans[0].color).toMatch(/^rgb\(/);
    expect(spans[1].text).toBe("rgb");
    expect(spans[1].color).toBe("rgb(10, 20, 30)");
  });

  it("ignores background colors but keeps the following text", () => {
    const spans = parseAnsi(`${ESC}[41mon red bg${ESC}[0m`);
    expect(spans).toEqual([{ text: "on red bg" }]);
  });

  it("consumes extended background arguments without misparsing", () => {
    const spans = parseAnsi(`${ESC}[48;5;21;31mred text${ESC}[0m`);
    expect(spans[0].text).toBe("red text");
    expect(spans[0].color).toContain("--agw-ansi-red");
  });

  it("strips non-SGR CSI and OSC sequences silently", () => {
    const withNoise = `${ESC}[2K${ESC}[1Gline${ESC}]0;window title${String.fromCharCode(7)} done`;
    expect(stripAnsi(withNoise)).toBe("line done");
  });

  it("drops a truncated escape at the end of the buffer", () => {
    expect(stripAnsi(`tail${ESC}[3`)).toBe("tail");
  });
});
