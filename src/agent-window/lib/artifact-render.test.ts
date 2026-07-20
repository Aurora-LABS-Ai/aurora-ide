import { describe, expect, it } from "vitest";

import { buildArtifactDocument } from "./artifact-render";

describe("buildArtifactDocument", () => {
  it("preserves complete HTML documents byte for byte", () => {
    const document = "<!doctype html><html><body><button>Run</button></body></html>";
    expect(buildArtifactDocument("html", document)).toBe(document);
  });

  it("wraps HTML fragments in a complete viewport document", () => {
    const document = buildArtifactDocument("html", "<main>Report</main>");
    expect(document).toContain("<!doctype html>");
    expect(document).toContain("<body><main>Report</main></body>");
  });

  it("wraps SVG source with responsive sizing", () => {
    const document = buildArtifactDocument("svg", '<svg viewBox="0 0 10 10"></svg>');
    expect(document).toContain("svg{display:block;max-width:100%");
    expect(document).toContain('<svg viewBox="0 0 10 10"></svg>');
  });
});
