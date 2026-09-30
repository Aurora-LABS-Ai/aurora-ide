// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearFindScript, findScript, type FindResult } from "./find-in-page";

// jsdom has no layout and no highlight registry. Every element "renders" here
// unless it is display:none, and the registry is a plain Map.
class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

// Runs the script text exactly as the page would receive it.
const run = (script: string): FindResult => new Function(`return ${script}`)() as FindResult;

describe("find in page", () => {
  let registry: Map<string, FakeHighlight>;

  beforeEach(() => {
    registry = new Map();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const hidden = (this as HTMLElement).style?.display === "none";
      return (hidden ? [] : [{}]) as unknown as DOMRectList;
    });
    Element.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = `
      <p>Stripe signs every Webhook event.</p>
      <p>A webhook without a signature is rejected. WEBHOOK!</p>
      <p style="display:none">hidden webhook</p>
      <script>var webhook = 1;</script>`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("finds every visible match, ignoring case, script text and hidden text", () => {
    const r = run(findScript("webhook", 0));
    expect(r).toEqual({ count: 3, index: 0, capped: false, supported: true });
    expect(registry.get("aurora-find")?.ranges).toHaveLength(3);
    expect(registry.get("aurora-find-current")?.ranges).toHaveLength(1);
  });

  it("marks the requested match current and wraps past either end", () => {
    const current = () => registry.get("aurora-find-current")!.ranges[0].toString();
    expect(run(findScript("webhook", 2)).index).toBe(2);
    expect(current()).toBe("WEBHOOK");
    expect(run(findScript("webhook", 3)).index).toBe(0);
    expect(run(findScript("webhook", -1)).index).toBe(2);
  });

  it("does not change the page's DOM", () => {
    const before = document.body.innerHTML;
    run(findScript("webhook", 1));
    expect(document.body.innerHTML).toBe(before);
  });

  it("reports nothing found, and an empty query, without highlights", () => {
    expect(run(findScript("stripe api key", 0))).toMatchObject({ count: 0, index: -1 });
    expect(run(findScript("", 0))).toMatchObject({ count: 0, index: -1 });
    expect(registry.size).toBe(0);
  });

  it("clears its highlights", () => {
    run(findScript("webhook", 0));
    run(clearFindScript());
    expect(registry.size).toBe(0);
  });

  it("carries a query with quotes safely into the script", () => {
    document.body.innerHTML = `<p>say "hi" to 'you'</p>`;
    expect(run(findScript(`"hi" to 'you'`, 0)).count).toBe(1);
  });
});
