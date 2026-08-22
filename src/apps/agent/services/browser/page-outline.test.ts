/**
 * The `browser_page_outline` scanner lives as PAGE_OUTLINE_JS in
 * `src-tauri/src/tools/browser/mod.rs` and executes inside the page, where no
 * Rust test can reach it. This suite runs THE SHIPPED SOURCE — extracted from
 * the Rust file, not a copy — against jsdom.
 *
 * Why it exists: the self-test persona caught the scanner returning
 * `elements: []` on a page whose whole sidebar was href-less `<a>` nav and
 * whose buttons were `cursor: pointer` spans (aurora-tool-findings.md,
 * 2026-08-22). The candidate list required `a[href]` and knew nothing about
 * styled-clickable elements, and the empty answer carried no reason — it read
 * as "this page has no controls".
 *
 * jsdom has no layout, so `getBoundingClientRect` is stubbed to a real box —
 * the visibility gate is not what these tests pin.
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

const OUTLINE_JS = extractConstant("PAGE_OUTLINE_JS");

interface OutlineRow {
  tag: string;
  selector: string | null;
  text?: string;
  state?: string;
}
interface OutlineResult {
  url: string;
  title: string;
  shown: number;
  more: number;
  elements: OutlineRow[];
  note?: string;
}

function runOutline(opts: { limit?: number; scope?: string; query?: string } = {}): OutlineResult {
  const script = OUTLINE_JS.replace("__LIMIT__", String(opts.limit ?? 60))
    .replace("__SCOPE__", JSON.stringify(opts.scope ?? null))
    .replace("__QUERY__", JSON.stringify(opts.query ?? null));
  return (0, eval)(script) as OutlineResult;
}

const realGetRect = Element.prototype.getBoundingClientRect;

describe("page outline scanner", () => {
  beforeEach(() => {
    // jsdom computes no layout; without this every element measures 0x0 and
    // the visibility gate hides the whole fixture.
    Element.prototype.getBoundingClientRect = function () {
      return { width: 40, height: 16, top: 0, left: 0, right: 40, bottom: 16, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realGetRect;
    document.body.innerHTML = "";
  });

  it("lists href-less anchors — the SPA sidebar case the scan used to miss", () => {
    document.body.innerHTML = `
      <nav>
        <a class="active">HUB</a>
        <a>AGENT STUDIO</a>
      </nav>`;
    const result = runOutline();
    const texts = result.elements.map((e) => e.text);
    expect(texts).toContain("HUB");
    expect(texts).toContain("AGENT STUDIO");
    expect(result.note).toBeUndefined();
  });

  it("lists a cursor-pointer element as a control, but only the pointer ROOT", () => {
    // cursor inherits — in a real browser every child of a clickable card
    // computes pointer too. Inline styles stand in for that here.
    document.body.innerHTML = `
      <span id="send" style="cursor: pointer">
        <b style="cursor: pointer">Send</b>
      </span>
      <div id="plain">not clickable</div>`;
    const result = runOutline();
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].selector).toBe("#send");
    expect(result.elements[0].text).toBe("Send");
  });

  it("does not re-list a clickable wrapper around a real control", () => {
    document.body.innerHTML = `
      <div style="cursor: pointer"><button>Save</button></div>`;
    const result = runOutline();
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].tag).toBe("button");
  });

  it("excludes tabindex=-1 but includes tabindex=0", () => {
    document.body.innerHTML = `
      <div tabindex="0">focusable widget</div>
      <div tabindex="-1">script-focus only</div>`;
    const result = runOutline();
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].text).toBe("focusable widget");
  });

  it("a page with nothing to find says WHY instead of a bare empty list", () => {
    document.body.innerHTML = `<p>Just prose.</p>`;
    const result = runOutline();
    expect(result.elements).toHaveLength(0);
    expect(result.note).toMatch(/cursor: pointer/);
    expect(result.note).toMatch(/browser_view/);
  });

  it("an empty result under a query blames the filter, not the page", () => {
    document.body.innerHTML = `<button>Save</button>`;
    const result = runOutline({ query: "delete" });
    expect(result.elements).toHaveLength(0);
    expect(result.note).toMatch(/query/);
  });
});
