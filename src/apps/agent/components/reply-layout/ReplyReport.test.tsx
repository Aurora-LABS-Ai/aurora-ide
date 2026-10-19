import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPLY_LAYOUT_EXAMPLES } from "@/apps/agent/lib/reply-layout/instructions";
import { ReplyLayout } from "./ReplyLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("reply report streaming", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); root = createRoot(host); });
  afterEach(() => act(() => root.unmount()));
  const render = (source: string, closed: boolean) => act(() => root.render(<ReplyLayout language="aurora-report" source={source} closed={closed} fallback={<pre data-fallback>{source}</pre>} />));
  it("holds incomplete data without flashing parser errors or partial totals", () => {
    const source = REPLY_LAYOUT_EXAMPLES.report;
    for (let length = 0; length < source.length; length += 100) {
      render(source.slice(0, length), false);
      expect(host.querySelector(".agw-rl-pending")).not.toBeNull();
      expect(host.querySelector(".ac-metric-value, .agw-rl-problems, [data-fallback]")).toBeNull();
    }
    render(source, true);
    expect(host.querySelector(".ac-metric-value")?.textContent).toBe("$17.9138");
  });
  it("preserves malformed finished reports and gives the failing field", () => {
    render('{"title":"Broken","data":[],"sections":[{"blocks":[{"type":"chart","title":"x","kind":"pie","x":"a","y":["b"]}]}]}', true);
    expect(host.querySelector("[data-fallback]")).not.toBeNull();
    expect(host.querySelector(".agw-rl-problems")?.textContent).toContain("kind");
    expect(host.querySelector(".ac-report")).toBeNull();
  });
});
