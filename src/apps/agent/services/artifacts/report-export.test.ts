import { describe, expect, it } from "vitest";

import {
  buildPrintableDocument,
  reportFileName,
} from "@/apps/agent/services/artifacts/report-export";

describe("naming the saved file", () => {
  it("keeps the title readable", () => {
    expect(reportFileName("Battery chemistry in 2026", "md")).toBe(
      "Battery chemistry in 2026.md",
    );
  });

  // Windows refuses these outright, and a trailing dot or space produces a file
  // that exists and cannot be opened.
  it("removes the characters Windows will not accept", () => {
    expect(reportFileName('LFP vs. NMC: what/why?', "md")).toBe("LFP vs. NMC what why.md");
    expect(reportFileName("Draft .", "pdf")).toBe("Draft.pdf");
  });

  it("still produces a name when the title is only punctuation", () => {
    expect(reportFileName("///", "md")).toBe("report.md");
  });
});

describe("the printed copy", () => {
  const report = {
    title: "Batteries",
    bodyHtml: "<h2>Chemistry</h2><p>Text.</p>",
    headings: [
      { level: 2 as const, text: "Chemistry" },
      { level: 3 as const, text: "Cathodes" },
    ],
    sources: [{ n: 1, label: "Example", href: "https://example.com/a" }],
  };

  it("carries the body, the contents and the sources", () => {
    const html = buildPrintableDocument(report);
    expect(html).toContain("<h2>Chemistry</h2><p>Text.</p>");
    expect(html).toContain("Contents");
    expect(html).toContain('data-level="3"');
    expect(html).toContain("https://example.com/a");
  });

  // Syntax highlighting and theme tokens are colours chosen for a dark panel.
  // Carried onto paper they range from low-contrast to invisible.
  it("prints light, whatever the panel was themed", () => {
    const html = buildPrintableDocument(report);
    expect(html).toContain("background: #ffffff");
    expect(html).toContain("pre span, code span { color: inherit !important; }");
  });

  it("escapes text that came from the model", () => {
    const html = buildPrintableDocument({
      ...report,
      title: "<script>alert(1)</script>",
      sources: [{ n: 1, label: "<img onerror=x>", href: null }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });

  it("leaves out a one-heading contents strip, which says nothing", () => {
    const html = buildPrintableDocument({ ...report, headings: [report.headings[0]] });
    expect(html).not.toContain('<nav class="rp-contents">');
    expect(buildPrintableDocument(report)).toContain('<nav class="rp-contents">');
  });
});
