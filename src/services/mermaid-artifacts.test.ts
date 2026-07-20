import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

import {
  describeMermaidError,
  renderMermaidSource,
  validateMermaidSource,
} from "./mermaid-artifacts";

const palette = {
  canvas: "#101010",
  surface: "#181818",
  surfaceElevated: "#202020",
  text: "#eeeeee",
  textMuted: "#999999",
  border: "#454545",
  accent: "#7788ff",
  fontFamily: "Inter",
};

describe("Mermaid artifact rendering", () => {
  beforeEach(() => {
    mermaidMocks.initialize.mockReset();
    mermaidMocks.parse.mockReset().mockResolvedValue({ diagramType: "flowchart-v2" });
    mermaidMocks.render.mockReset().mockResolvedValue({ svg: '<svg viewBox="0 0 100 50" />' });
  });

  it("parses source without rendering during validation", async () => {
    await validateMermaidSource("flowchart LR\nA --> B");

    expect(mermaidMocks.parse).toHaveBeenCalledWith("flowchart LR\nA --> B", {
      suppressErrors: false,
    });
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });

  it("renders with strict security and Aurora theme tokens", async () => {
    const svg = await renderMermaidSource("sequenceDiagram\nA->>B: Ping", "diagram-1", palette);

    expect(svg).toContain("viewBox");
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        suppressErrorRendering: true,
        startOnLoad: false,
        theme: "base",
        themeVariables: expect.objectContaining({
          background: palette.canvas,
          primaryColor: palette.surface,
          primaryTextColor: palette.text,
          lineColor: palette.textMuted,
        }),
      }),
    );
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      "diagram-1",
      "sequenceDiagram\nA->>B: Ping",
    );
  });

  it("keeps parser errors concise and useful", () => {
    expect(
      describeMermaidError(
        new Error("Error: line one\nline two\nline three\nline four\nline five\nline six"),
      ),
    ).toBe("line one\nline two\nline three\nline four\nline five");
  });
});
