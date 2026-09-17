import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseToolResult } from "./tool-result";
import { WebResultsView } from "./WebResultsView";

vi.mock("@/apps/agent/components/conversation/AgentMarkdown", () => ({ AgentMarkdown: () => null }));

describe("image search results", () => {
  const result = (url = "https://commons.wikimedia.org/wiki/File:Webb.jpg") => JSON.stringify({
    success: true, search: { engine: "wikimedia-commons", query: "Webb", results: [{
      rank: 1, title: "Webb mirror", url,
      image: { url: "https://upload.wikimedia.org/webb.jpg", thumbnailUrl: "https://thumb.wikimedia.org/webb.jpg", creator: "NASA", license: "Public domain", width: 4000, height: 2000 },
    }] },
  });
  it("renders a real preview, source link and attribution from the saved result", () => {
    const parsed = parseToolResult("auroro_websearch", {}, result());
    expect(parsed.web?.hits?.[0].image?.width).toBe(4000);
    const html = renderToStaticMarkup(<WebResultsView data={parsed.web!} />);
    expect(html).toContain("Image Search");
    expect(html).toContain('src="https://thumb.wikimedia.org/webb.jpg"');
    expect(html).toContain("NASA / Public domain");
    expect(html).toContain('title="https://commons.wikimedia.org/wiki/File:Webb.jpg"');
  });
  it("does not turn an unsafe result URL into an external action", () => {
    expect(parseToolResult("auroro_websearch", {}, result("file:///private.txt")).web?.hits).toHaveLength(0);
    expect(parseToolResult("auroro_websearch", {}, result("javascript:alert(1)")).web?.hits).toHaveLength(0);
  });
});
