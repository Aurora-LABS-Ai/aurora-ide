/**
 * The web result panels — behaviour, not appearance.
 *
 * What is pinned here is what a reader relies on: every result is reachable
 * from the keyboard, the domain is visible without hovering, and a page that
 * did not fit says so rather than ending mid-sentence in silence.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WebResultsView } from "@/apps/agent/components/tool-views/WebResultsView";
import type { WebData } from "@/apps/agent/components/tool-views/tool-result";

// Streamdown pulls in Shiki, which is far more than a unit test needs. The
// panel's job is to hand the markdown over; that it arrives is the assertion.
vi.mock("@/apps/agent/components/conversation/AgentMarkdown", () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div data-md>{content}</div>,
}));

const render = (data: WebData) => renderToStaticMarkup(<WebResultsView data={data} />);

const searchData: WebData = {
  kind: "search",
  heading: "rust async trait",
  source: "duckduckgo-lite",
  hits: [
    {
      rank: 1,
      title: "async_trait - Rust - Docs.rs",
      url: "https://docs.rs/async-trait/latest/async_trait/",
      displayUrl: "docs.rs/async-trait/latest/async_trait/",
      snippet: "Type erasure for async trait methods.",
    },
    {
      rank: 2,
      title: "Traits - The Rust Reference",
      url: "https://doc.rust-lang.org/reference/items/traits.html",
    },
  ],
};

describe("web search results", () => {
  it("shows every result with its domain and summary", () => {
    const html = render(searchData);
    expect(html).toContain("async_trait - Rust - Docs.rs");
    expect(html).toContain("docs.rs/async-trait/latest/async_trait/");
    expect(html).toContain("Type erasure for async trait methods.");
    // No displayUrl on the second result — the host is derived so the source
    // is never blank.
    expect(html).toContain("doc.rust-lang.org");
    expect(html).toContain("2 results");
  });

  /** A list of sources you cannot follow is a screenshot of a search. */
  it("makes every result a real button, so it is reachable by keyboard", () => {
    const html = render(searchData);
    expect(html.match(/<button/g) ?? []).toHaveLength(2);
    // The full URL stays available on hover; the row shows only the domain.
    expect(html).toContain('title="https://docs.rs/async-trait/latest/async_trait/"');
  });

  it("states an empty search instead of rendering a blank panel", () => {
    const html = render({ ...searchData, hits: [] });
    expect(html).toContain("No results came back");
    expect(html).toContain("0 results");
  });

  it("shows the note when another source had to be tried first", () => {
    const html = render({ ...searchData, note: "One other source returned nothing first." });
    expect(html).toContain("One other source returned nothing first.");
  });
});

describe("fetched page", () => {
  const doc: WebData = {
    kind: "document",
    heading: "Quick start",
    source: "https://www.example.com/docs",
    content: "# Quick start\n\nInstall it, then sign in.",
    documentKind: "article",
    totalChars: 40,
    offset: 0,
    hasMore: false,
  };

  it("shows the title, the domain, and the page as markdown", () => {
    const html = render(doc);
    expect(html).toContain("Quick start");
    // `www.` is noise in a column of domains.
    expect(html).toContain(">example.com<");
    expect(html).toContain("Article");
    expect(html).toContain("40 characters");
    expect(html).toContain("Install it, then sign in.");
  });

  /** Otherwise a reader assumes the document broke. */
  it("says the page continues when only part of it was read", () => {
    const html = render({ ...doc, content: "part one", totalChars: 90000, hasMore: true });
    expect(html).toContain("More of this page is available");
    expect(html).toContain("Characters 1-8 of 90,000");
  });

  it("reports the final window and counts Unicode characters like Rust", () => {
    const html = render({ ...doc, offset: 90, totalChars: 93, content: "A\u{1F600}B", hasMore: false });
    expect(html).toContain("Characters 91-93 of 93");
    expect(html).not.toContain("first part");
    expect(html).not.toContain("More of this page");
  });

  it("keeps the source author and publication date", () => {
    const html = render({ ...doc, byline: "Research team", published: "2026-09-14" });
    expect(html).toContain("Research team / 2026-09-14");
  });

  it("names a page whose body could not be read", () => {
    const html = render({
      kind: "document",
      heading: "spec.pdf",
      source: "https://example.com/spec.pdf",
      content: "",
      documentKind: "unsupported",
      note: "a PDF cannot be read as text.",
    });
    expect(html).toContain("Not readable");
    expect(html).toContain("could be read as text");
    expect(html).toContain("a PDF cannot be read as text.");
  });

  /** A page with no article body carries navigation the reader must discount. */
  it("passes the extraction note through verbatim", () => {
    const html = render({
      ...doc,
      documentKind: "page",
      note: "no article body was found on this page",
    });
    expect(html).toContain("Full page");
    expect(html).toContain("no article body was found on this page");
  });
});
