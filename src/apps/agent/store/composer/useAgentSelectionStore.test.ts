import { describe, expect, it } from "vitest";

import type { PickedElement } from "@/apps/agent/services/browser/browser-service";
import {
  buildSelectionContext,
  buildSelectionPills,
  SELECTION_HTML_MAX_CHARS,
  selectionTooltip,
  type SelectedEntry,
} from "./useAgentSelectionStore";

/** The quantumhub hero heading, as the page script describes it. */
function heading(overrides: Partial<PickedElement> = {}): SelectedEntry {
  return {
    id: "pick-1",
    index: 1,
    element: {
      label: "browser-agentwin",
      selector: "html > body > div:nth-of-type(2) > main > section > div:nth-of-type(3) > h1",
      path: "div.relative > main.flex-1 > section.relative > div.relative",
      tagName: "h1",
      id: null,
      className: "type-display text-[#000000]",
      text: "Run every account from one hub",
      outerHtml:
        '<h1 class="type-display text-[#000000]">Run every account from <span style="color:#007AFF">one hub</span></h1>',
      url: "https://getquantumhub.com/",
      boundingRect: { x: 216, y: 190.4, width: 768, height: 151.2 },
      attributes: [
        { name: "class", value: "type-display text-[#000000]" },
        { name: "data-hero", value: "title" },
      ],
      styles: [
        { name: "display", value: "block" },
        { name: "font-size", value: "72px" },
        { name: "font-weight", value: "700" },
      ],
      parent: '<div class="relative" />',
      siblings: [
        '<div class="mb-6 inline-flex items-center" />',
        '<!-- SELECTED --> <h1 class="type-display text-[#000000]" />',
        '<p class="mt-5 max-w-2xl text-lg" />',
      ],
      framework: "react",
      component: "Hero",
      props: [
        { name: "selectedUrl", value: "modal-dialogs" },
        { name: "onItemSelect", value: "[function]" },
      ],
      source: "inspector",
      note: null,
      ...overrides,
    },
  };
}

describe("buildSelectionContext", () => {
  it("is null with nothing picked", () => {
    expect(buildSelectionContext([])).toBeNull();
  });

  it("carries what a picture would have said: size, styles, siblings, component", () => {
    const block = buildSelectionContext([heading()]) ?? "";
    expect(block).toContain("<selected_elements>");
    expect(block).toContain('<element index="1">');
    expect(block).toContain("tag: <h1>");
    expect(block).toContain("text: Run every account from one hub");
    expect(block).toContain("path: div.relative > main.flex-1 > section.relative > div.relative");
    expect(block).toContain("size: 768×151 at x=216, y=190");
    expect(block).toContain("component: Hero (react)");
    expect(block).toContain("props: selectedUrl=modal-dialogs; onItemSelect=[function]");
    expect(block).toContain("styles: display=block; font-size=72px; font-weight=700");
    expect(block).toContain('parent: <div class="relative" />');
    expect(block).toContain('    <!-- SELECTED --> <h1 class="type-display text-[#000000]" />');
    expect(block).toContain('    <p class="mt-5 max-w-2xl text-lg" />');
    expect(block).toContain('html: <h1 class="type-display');
  });

  it("lists attributes besides id and class, which have their own lines", () => {
    const block = buildSelectionContext([heading()]) ?? "";
    expect(block).toContain("attributes: data-hero=title");
    expect(block).not.toContain("attributes: class=");
  });

  it("names the framework when no component was found", () => {
    const block = buildSelectionContext([heading({ component: null })]) ?? "";
    expect(block).toContain("component: none named (react page)");
  });

  it("leaves out what the page did not give", () => {
    const block =
      buildSelectionContext([
        heading({
          path: undefined,
          styles: null,
          siblings: null,
          parent: null,
          framework: null,
          component: null,
          props: null,
          boundingRect: null,
          attributes: null,
        }),
      ]) ?? "";
    expect(block).not.toContain("path:");
    expect(block).not.toContain("styles:");
    expect(block).not.toContain("siblings:");
    expect(block).not.toContain("parent:");
    expect(block).not.toContain("component:");
    expect(block).not.toContain("props:");
    expect(block).not.toContain("size:");
    expect(block).not.toContain("attributes:");
    expect(block).toContain("selector: html > body");
  });

  it("cuts the HTML at the cap and says so", () => {
    const long = `<div>${"x".repeat(SELECTION_HTML_MAX_CHARS + 500)}</div>`;
    const block = buildSelectionContext([heading({ outerHtml: long })]) ?? "";
    expect(block).toContain("… [cut]");
    const htmlLine = block.split("\n").find((line) => line.startsWith("  html: ")) ?? "";
    expect(htmlLine.length).toBeLessThan(SELECTION_HTML_MAX_CHARS + 20);
  });

  it("numbers several picks in order", () => {
    const second = { ...heading({ text: "Second" }), id: "pick-2", index: 2 };
    const block = buildSelectionContext([heading(), second]) ?? "";
    expect(block.indexOf('<element index="1">')).toBeLessThan(block.indexOf('<element index="2">'));
  });
});

describe("buildSelectionPills", () => {
  it("keeps the chip light but names the component and the path", () => {
    const [pill] = buildSelectionPills([heading()]);
    expect(pill).toEqual({
      index: 1,
      selector: "html > body > div:nth-of-type(2) > main > section > div:nth-of-type(3) > h1",
      tagName: "h1",
      url: "https://getquantumhub.com/",
      text: "Run every account from one hub",
      source: "inspector",
      component: "Hero",
      path: "div.relative > main.flex-1 > section.relative > div.relative",
    });
    expect(pill).not.toHaveProperty("outerHtml");
  });
});

describe("selectionTooltip", () => {
  it("reads as what it is, who owns it, where it sits, how big it is", () => {
    const tip = selectionTooltip(heading().element);
    expect(tip.split("\n")).toEqual([
      "<h1>",
      "component: Hero",
      "in: div.relative > main.flex-1 > section.relative > div.relative",
      "class: type-display text-[#000000]",
      "size: 768×151",
      "url: https://getquantumhub.com/",
    ]);
  });
});
