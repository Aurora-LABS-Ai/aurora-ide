import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REPLY_LAYOUT_EXAMPLES } from "@/apps/agent/lib/reply-layout/instructions";
import type { LayoutLanguage } from "@/apps/agent/lib/reply-layout/parse";
import { ReplyLayout } from "./ReplyLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("structured reply layouts", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = (language: LayoutLanguage, source: string, closed = true) => {
    act(() => root.render(<ReplyLayout language={language} source={source} closed={closed} fallback={<pre data-fallback>{source}</pre>} />));
    return host;
  };

  it("renders a comparison with associated row and option headers", () => {
    const el = render("aurora-compare", REPLY_LAYOUT_EXAMPLES.compare);
    expect(el.querySelector("table caption")?.textContent).toBe("Rendering choices");
    expect([...el.querySelectorAll("thead th")].map((node) => node.textContent)).toEqual(["Aspect", "Server rendering", "Client rendering"]);
    expect(el.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
    expect(el.querySelectorAll("tbody td")).toHaveLength(6);
    expect(el.querySelector("tbody td .agw-rl-compare-option")?.textContent).toBe("Server rendering");
  });

  it("renders every status as text without pretending to be editable", () => {
    const el = render("aurora-checklist", REPLY_LAYOUT_EXAMPLES.checklist);
    expect([...el.querySelectorAll(".agw-rl-status")].map((node) => node.textContent)).toEqual(["Done", "In progress", "Blocked", "Pending"]);
    expect(el.querySelector('section[aria-labelledby]')?.getAttribute("aria-labelledby")).toBe(el.querySelector(".agw-rl-block-title")?.id);
    expect(el.querySelector('input, button, [role="checkbox"]')).toBeNull();
  });

  it("keeps timeline dates beside their events in the supplied order", () => {
    const el = render("aurora-timeline", REPLY_LAYOUT_EXAMPLES.timeline);
    expect(el.querySelectorAll("ol > li")).toHaveLength(3);
    expect([...el.querySelectorAll(".agw-rl-date")].map((node) => node.textContent)).toEqual(["09:10 UTC", "09:18 UTC", "09:30 UTC"]);
    expect(el.querySelector(".agw-rl-dated-row .agw-rl-node-title")?.textContent).toBe("First failed request");
  });

  it("renders nested ownership as nested lists", () => {
    const el = render("aurora-tree", REPLY_LAYOUT_EXAMPLES.tree);
    const roots = el.querySelectorAll("section > ul > li");
    expect(roots).toHaveLength(2);
    expect(roots[0].querySelectorAll(":scope > ul > li")).toHaveLength(2);
    expect(roots[0].querySelector(":scope > ul > li > ul > li > .agw-rl-tree-node .agw-rl-node-title")?.textContent).toBe("Reply layout");
    expect(roots[1].textContent).toContain("Kernel");
  });

  it("escapes HTML and preserves inline code in structured fields", () => {
    const el = render("aurora-timeline", "Now | `<script>` | <img src=x onerror=alert(1)>");
    expect(el.querySelector("code")?.textContent).toBe("<script>");
    expect(el.querySelector("script, img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("reveals only complete rows, reports errors at closure, and accepts an ended partial row", () => {
    const source = "Checks\ndone | Build\nunknown | Lost\ntodo | Pub";
    render("aurora-checklist", source, false);
    expect(host.querySelectorAll(".agw-rl-status-row")).toHaveLength(1);
    expect(host.querySelector(".agw-rl-problems")).toBeNull();
    render("aurora-checklist", `${source}lish`, true);
    expect(host.querySelectorAll(".agw-rl-status-row")).toHaveLength(2);
    expect(host.querySelector(".agw-rl-problems")?.textContent).toContain("unknown | Lost");
  });

  it.each(["aurora-compare", "aurora-checklist", "aurora-timeline", "aurora-tree"] as const)(
    "%s holds incomplete content and falls back for invalid completed content", (language) => {
      render(language, "", false);
      expect(host.querySelector(".agw-rl-pending")).not.toBeNull();
      expect(host.querySelector("[data-fallback]")).toBeNull();
      render(language, "Bad | | | | | extra", true);
      expect(host.querySelector("[data-fallback]")?.textContent).toBe("Bad | | | | | extra");
    },
  );
});
