/**
 * The target locator behind `browser_click` / `browser_fill` / `browser_hover`
 * lives as LOCATE_TARGET_JS in `src-tauri/src/tools/browser/mod.rs` and runs
 * inside the page. This suite runs THE SHIPPED SOURCE against jsdom.
 *
 * What it pins: resolving by visible text (exact beats prefix beats
 * substring; a container that merely contains the text loses to the control
 * that IS the text; two equal matches are reported, never picked), and the
 * hit-test verdict (self / descendant / ancestor / covered) that decides
 * whether a press goes ahead.
 *
 * jsdom has no layout and no `elementFromPoint`, so both are stubbed — the
 * geometry is not what these tests pin, the decisions made from it are.
 *
 * NOTE: reads the Rust source with readFileSync — if `tools/browser/mod.rs`
 * moves, fix the path here by hand (see .knowledge/lesson.md 2026-08-06).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync } from "node:fs";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const RUST_SOURCE = `${cwd}/src-tauri/src/tools/browser/mod.rs`;

function extractConstant(name: string): string {
  const source = readFileSync(RUST_SOURCE, "utf8");
  const match = source.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`));
  if (!match) throw new Error(`${name} not found in ${RUST_SOURCE}`);
  return match[1];
}

const LOCATE_JS = extractConstant("LOCATE_TARGET_JS");

interface Located {
  found: boolean;
  by?: string;
  visible?: boolean;
  ambiguous?: string[];
  x?: number;
  y?: number;
  tag?: string;
  description?: string;
  disabled?: boolean;
  hit?: string;
  covered_by?: string;
}

function locate(opts: { selector?: string; text?: string }): Located {
  const script = LOCATE_JS.replace("__SEL__", JSON.stringify(opts.selector ?? null)).replace(
    "__TEXT__",
    JSON.stringify(opts.text ?? null),
  );
  return (0, eval)(script) as Located;
}

const realGetRect = Element.prototype.getBoundingClientRect;
type Doc = Document & { elementFromPoint: (x: number, y: number) => Element | null };

beforeEach(() => {
  // Every element gets a real box, so visibility passes and a centre exists.
  Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30, toJSON() {} } as DOMRect;
  };
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  // Default hit-test: the element under the point is whatever we resolved.
  (document as Doc).elementFromPoint = () => null;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realGetRect;
  document.body.innerHTML = "";
});

describe("resolving by visible text", () => {
  it("prefers an exact label over a prefix over a substring", () => {
    document.body.innerHTML = `
      <button id="a">Save</button>
      <button id="b">Save as template</button>
      <button id="c">Do not save</button>`;
    expect(locate({ text: "save" }).description).toContain("button#a");
    expect(locate({ text: "save as" }).description).toContain("button#b");
    expect(locate({ text: "not save" }).description).toContain("button#c");
  });

  it("lets the control that IS the text beat the container that contains it", () => {
    // Without the tighten pass a click on "Save" lands on the form.
    document.body.innerHTML = `
      <form role="button"><p>Fill in the form, then</p><button id="save">Save</button></form>`;
    const got = locate({ text: "Save" });
    expect(got.found).toBe(true);
    expect(got.description).toContain("button#save");
  });

  it("reports two equally good matches instead of picking one", () => {
    document.body.innerHTML = `
      <button id="one">Delete</button>
      <button id="two">Delete</button>`;
    const got = locate({ text: "delete" });
    expect(got.found).toBe(true);
    expect(got.ambiguous).toHaveLength(2);
    expect(got.ambiguous?.[0]).toContain("button#one");
    expect(got.x).toBeUndefined();
  });

  it("reads aria-label, submit values and placeholders as labels", () => {
    document.body.innerHTML = `
      <button id="x" aria-label="Close dialog">×</button>
      <input id="go" type="submit" value="Sign in">
      <input id="q" placeholder="Search products">`;
    expect(locate({ text: "close dialog" }).description).toContain("button#x");
    expect(locate({ text: "sign in" }).description).toContain("input#go");
    expect(locate({ text: "search products" }).description).toContain("input#q");
  });

  it("says when nothing matches, and by which route", () => {
    document.body.innerHTML = `<button>Save</button>`;
    expect(locate({ text: "publish" })).toEqual({ found: false, by: "text" });
    expect(locate({ selector: "#nope" })).toEqual({ found: false, by: "selector" });
  });
});

describe("the hit-test verdict", () => {
  it("is self when the element is what is painted at its centre", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const button = document.getElementById("b")!;
    (document as Doc).elementFromPoint = () => button;
    const got = locate({ selector: "#b" });
    expect(got.hit).toBe("self");
    expect(got.covered_by).toBeUndefined();
    expect(got.x).toBe(60);
    expect(got.y).toBe(25);
  });

  it("is descendant when a child (an icon, a span) is on top — still fine", () => {
    document.body.innerHTML = `<button id="b"><span id="icon">✓</span> Go</button>`;
    (document as Doc).elementFromPoint = () => document.getElementById("icon");
    expect(locate({ selector: "#b" }).hit).toBe("descendant");
  });

  it("is ancestor when the element has no painted box of its own", () => {
    document.body.innerHTML = `<label id="wrap"><input id="cb" type="checkbox"></label>`;
    (document as Doc).elementFromPoint = () => document.getElementById("wrap");
    expect(locate({ selector: "#cb" }).hit).toBe("ancestor");
  });

  it("is covered when something unrelated is on top, and names it", () => {
    // The silent failure this exists to stop: a click that "registered" on
    // the modal backdrop while reporting success on the button beneath.
    document.body.innerHTML = `
      <button id="b">Go</button>
      <div id="backdrop" class="modal-overlay dim" role="presentation">Cookie notice</div>`;
    (document as Doc).elementFromPoint = () => document.getElementById("backdrop");
    const got = locate({ selector: "#b" });
    expect(got.hit).toBe("covered");
    expect(got.covered_by).toContain("div#backdrop");
    expect(got.covered_by).toContain("Cookie notice");
  });

  it("reports a disabled control rather than a live one", () => {
    document.body.innerHTML = `<button id="b" disabled>Go</button><a id="l" aria-disabled="true">Link</a>`;
    expect(locate({ selector: "#b" }).disabled).toBe(true);
    expect(locate({ selector: "#l" }).disabled).toBe(true);
  });

  it("treats an element with no box as not visible", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRect;
    };
    const got = locate({ selector: "#b" });
    expect(got.found).toBe(true);
    expect(got.visible).toBe(false);
  });
});
