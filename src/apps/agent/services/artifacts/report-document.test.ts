import { describe, expect, it } from "vitest";

import {
  CITE_SCHEME,
  parseReportDocument,
} from "@/apps/agent/services/artifacts/report-document";

describe("reading a report", () => {
  it("takes the contents strip from the section headings", () => {
    const report = parseReportDocument(
      ["# Batteries", "", "## Chemistry", "text", "### Cathodes", "more", "## Cost"].join("\n"),
    );

    expect(report.title).toBe("Batteries");
    expect(report.headings).toEqual([
      { index: 0, level: 2, text: "Chemistry" },
      { index: 1, level: 3, text: "Cathodes" },
      { index: 2, level: 2, text: "Cost" },
    ]);
  });

  // The strip scrolls by position among the rendered headings, so the indices
  // have to be the order they appear — two sections may share a name.
  it("numbers the headings by position, even when two share a name", () => {
    const report = parseReportDocument(["## Risks", "a", "## Risks", "b"].join("\n"));
    expect(report.headings.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it("ignores a heading inside a fenced block", () => {
    const report = parseReportDocument(
      ["## Real", "", "```md", "## Not a section", "```", "", "## Also real"].join("\n"),
    );
    expect(report.headings.map((entry) => entry.text)).toEqual(["Real", "Also real"]);
  });

  it("lifts the source definitions out of the body", () => {
    const report = parseReportDocument(
      ["Claim.[^a]", "", "[^a]: Example report — https://example.com/a"].join("\n"),
    );

    expect(report.body).not.toContain("[^a]:");
    expect(report.sources).toEqual([
      { n: 1, key: "a", label: "Example report", href: "https://example.com/a" },
    ]);
  });

  // A source list where [2] appears before [1] reads as a mistake even when
  // every link is right, and the model defines them in whatever order it
  // finished checking them.
  it("numbers sources by the order the reader meets them", () => {
    const report = parseReportDocument(
      [
        "First.[^late] Second.[^early]",
        "",
        "[^early]: Early — https://example.com/early",
        "[^late]: Late — https://example.com/late",
      ].join("\n"),
    );

    expect(report.sources.map((entry) => entry.key)).toEqual(["late", "early"]);
    expect(report.sources.map((entry) => entry.n)).toEqual([1, 2]);
    expect(report.body).toContain(`[1](${CITE_SCHEME}late)`);
    expect(report.body).toContain(`[2](${CITE_SCHEME}early)`);
  });

  it("keeps a source that was defined but never cited", () => {
    const report = parseReportDocument(
      ["Cited.[^a]", "", "[^a]: A — https://example.com/a", "[^b]: B — https://example.com/b"].join(
        "\n",
      ),
    );
    expect(report.sources.map((entry) => entry.n)).toEqual([1, 2]);
    expect(report.sources[1].key).toBe("b");
  });

  it("reads a definition written as a markdown link", () => {
    const report = parseReportDocument(
      ["Claim.[^1]", "", "[^1]: [The paper](https://example.com/paper)"].join("\n"),
    );
    expect(report.sources[0]).toEqual({
      n: 1,
      key: "1",
      label: "The paper",
      href: "https://example.com/paper",
    });
  });

  it("keeps a source with no link, and says so by leaving href null", () => {
    const report = parseReportDocument(
      ["Claim.[^b]", "", "[^b]: Brooks, The Mythical Man-Month, ch. 2"].join("\n"),
    );
    expect(report.sources[0].href).toBeNull();
    expect(report.sources[0].label).toBe("Brooks, The Mythical Man-Month, ch. 2");
  });

  it("does not swallow the full stop after a bare URL", () => {
    const report = parseReportDocument(
      ["Claim.[^1]", "", "[^1]: Example — https://example.com/page."].join("\n"),
    );
    expect(report.sources[0].href).toBe("https://example.com/page");
  });

  // An orphan citation is an error worth seeing. Rewriting it into a link that
  // goes nowhere, or quietly deleting it, both hide a real mistake.
  it("leaves a marker with no definition exactly as written", () => {
    const report = parseReportDocument("Claim.[^missing]");
    expect(report.body).toContain("[^missing]");
    expect(report.sources).toEqual([]);
  });

  it("returns nothing to show for ordinary prose", () => {
    const report = parseReportDocument("Just a paragraph.");
    expect(report.title).toBeNull();
    expect(report.headings).toEqual([]);
    expect(report.sources).toEqual([]);
    expect(report.body).toBe("Just a paragraph.");
  });
});
