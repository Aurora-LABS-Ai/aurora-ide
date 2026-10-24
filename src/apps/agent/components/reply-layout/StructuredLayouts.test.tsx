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

  const click = (node: Element | null | undefined) => {
    expect(node).toBeTruthy();
    act(() => (node as HTMLElement).click());
  };
  const byText = (selector: string, text: string) =>
    [...host.querySelectorAll(selector)].find((node) => node.textContent?.startsWith(text));

  it("draws a short comparison as a table with associated row and option headers", () => {
    const source = "Rendering\nAspect | Server | Client\nExecution | Server | Browser\nBest fit | Data loading | Controls";
    const el = render("aurora-compare", source);
    expect(el.querySelector('[role="tablist"]')).toBeNull();
    expect(el.querySelector("table caption")?.textContent).toBe("Rendering");
    expect([...el.querySelectorAll("thead th")].map((node) => node.textContent)).toEqual(["Aspect", "Server", "Client"]);
    expect(el.querySelectorAll('tbody th[scope="row"]')).toHaveLength(2);
    expect(el.querySelector("tbody td .agw-rl-compare-option")?.textContent).toBe("Server");
  });

  it("opens a longer comparison one aspect at a time, with the full table under All", () => {
    const el = render("aurora-compare", REPLY_LAYOUT_EXAMPLES.compare);
    const tabs = [...el.querySelectorAll('[role="tab"]')];
    expect(tabs.map((node) => node.textContent)).toEqual(["Execution", "Interactivity", "Best fit", "All"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect([...el.querySelectorAll(".agw-rl-compare-name")].map((node) => node.textContent)).toEqual(["Server rendering", "Client rendering"]);
    expect([...el.querySelectorAll(".agw-rl-compare-value")].map((node) => node.textContent)).toEqual(["Server", "Browser"]);
    expect(el.querySelector("table")).toBeNull();

    click(tabs[2]);
    expect([...el.querySelectorAll(".agw-rl-compare-value")].map((node) => node.textContent)).toEqual(["Data loading", "Interactive controls"]);

    click(byText('[role="tab"]', "All"));
    expect(el.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
    expect(el.querySelectorAll("tbody td")).toHaveLength(6);
    expect(el.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(tabs[3].id);
  });

  it("moves between aspects with the arrow keys and keeps one tab in the Tab order", () => {
    const el = render("aurora-compare", REPLY_LAYOUT_EXAMPLES.compare);
    const list = el.querySelector('[role="tablist"]') as HTMLElement;
    act(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const tabs = [...el.querySelectorAll('[role="tab"]')];
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs.filter((node) => node.getAttribute("tabindex") === "0")).toEqual([tabs[1]]);
    act(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    act(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(tabs[3].getAttribute("aria-selected")).toBe("true");
  });

  it("shows every status as a mark and its word, filters by status, and never offers a checkbox", () => {
    const el = render("aurora-checklist", REPLY_LAYOUT_EXAMPLES.checklist);
    expect([...el.querySelectorAll(".agw-rl-status")].map((node) => node.textContent)).toEqual(["Done", "In progress", "Blocked", "Pending"]);
    expect(el.querySelectorAll(".agw-rl-status .agw-rl-mark")).toHaveLength(4);
    expect(el.querySelector('section[aria-labelledby]')?.getAttribute("aria-labelledby")).toBe(el.querySelector(".agw-rl-block-title")?.id);
    expect(el.querySelector('input, [role="checkbox"]')).toBeNull();

    const filters = [...el.querySelectorAll("button[aria-pressed]")];
    expect(filters.map((node) => node.textContent)).toEqual(["All4", "Done1", "In progress1", "Blocked1", "Pending1"]);
    click(byText("button[aria-pressed]", "Pending"));
    expect([...el.querySelectorAll(".agw-rl-status-row .agw-rl-node-title")].map((node) => node.textContent)).toEqual(["Publish"]);
    expect(byText("button[aria-pressed]", "Pending")?.getAttribute("aria-pressed")).toBe("true");
    click(byText("button[aria-pressed]", "All"));
    expect(el.querySelectorAll(".agw-rl-status-row")).toHaveLength(4);
  });

  it("offers no filter when there is nothing to narrow", () => {
    render("aurora-checklist", "Checks\ndone | Build\ndone | Tests\ndone | Lint\ndone | Types");
    expect(host.querySelector("button")).toBeNull();
    render("aurora-checklist", "Checks\ndone | Build\ntodo | Publish");
    expect(host.querySelector("button")).toBeNull();
  });

  it("walks three or more timeline events one at a time, in the supplied order", () => {
    const el = render("aurora-timeline", REPLY_LAYOUT_EXAMPLES.timeline);
    expect([...el.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual(["09:10 UTC", "09:18 UTC", "09:30 UTC"]);
    const pane = () => el.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(pane().querySelector(".agw-rl-node-title")?.textContent).toBe("First failed request");
    expect(pane().querySelector(".agw-rl-count")?.textContent).toBe("1 of 3");

    const previous = byText(".agw-rl-pager-btn", "←");
    expect(previous?.getAttribute("aria-disabled")).toBe("true");
    click(previous);
    expect(pane().querySelector(".agw-rl-count")?.textContent).toBe("1 of 3");

    click(byText(".agw-rl-pager-btn", "Next"));
    click(byText(".agw-rl-pager-btn", "Next"));
    expect(pane().querySelector(".agw-rl-node-title")?.textContent).toBe("Verification complete");
    expect(byText(".agw-rl-pager-btn", "Next")?.getAttribute("aria-disabled")).toBe("true");
    expect(el.querySelectorAll('[role="tab"]')[2].getAttribute("aria-selected")).toBe("true");
  });

  it("keeps one or two timeline events as a dated list", () => {
    const el = render("aurora-timeline", "Incident\n09:10 UTC | First failed request\n09:18 UTC | Service restored");
    expect(el.querySelector('[role="tablist"]')).toBeNull();
    expect([...el.querySelectorAll("ol > li .agw-rl-date")].map((node) => node.textContent)).toEqual(["09:10 UTC", "09:18 UTC"]);
  });

  it("renders nested ownership as nested lists", () => {
    const el = render("aurora-tree", REPLY_LAYOUT_EXAMPLES.tree);
    const roots = el.querySelectorAll("section > ul > li");
    expect(roots).toHaveLength(2);
    expect(roots[0].querySelectorAll(":scope > ul > li")).toHaveLength(2);
    expect(roots[0].querySelector(":scope > ul > li > ul > li > .agw-rl-tree-node .agw-rl-node-title")?.textContent).toBe("Reply layout");
    expect(roots[1].textContent).toContain("Kernel");
  });

  it("folds a branch and says how much it holds", () => {
    const el = render("aurora-tree", REPLY_LAYOUT_EXAMPLES.tree);
    const toggle = byText(".agw-rl-tree-toggle", "Agent window") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("3 inside");
    expect((toggle.closest("li")?.querySelector(":scope > ul") as HTMLElement).hidden).toBe(true);
    expect(el.querySelector(".agw-rl-tree-leaf")?.textContent).toBe("Reply layout");
  });

  it("opens only the first level of a large tree", () => {
    const rows = ["Repo", "0 | src | Source"];
    for (let i = 0; i < 12; i += 1) rows.push(`1 | module-${i}`, `2 | file-${i}.ts`);
    render("aurora-tree", rows.join("\n"));
    expect(byText(".agw-rl-tree-toggle", "src")?.getAttribute("aria-expanded")).toBe("true");
    expect(byText(".agw-rl-tree-toggle", "module-0")?.getAttribute("aria-expanded")).toBe("false");
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
