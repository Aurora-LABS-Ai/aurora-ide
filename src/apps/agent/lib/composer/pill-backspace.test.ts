import { afterEach, describe, expect, it } from "vitest";

import { deletePillBeforeCaret } from "@/apps/agent/lib/composer/pill-backspace";

const pill = (rel = "src/app.js"): HTMLSpanElement => {
  const el = document.createElement("span");
  el.contentEditable = "false";
  el.dataset.rel = rel;
  el.textContent = "app.js";
  return el;
};

const editor = (...children: Node[]): HTMLDivElement => {
  const root = document.createElement("div");
  root.contentEditable = "true";
  root.append(...children);
  document.body.append(root);
  return root;
};

const caret = (node: Node, offset: number): void => {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("deletePillBeforeCaret", () => {
  it("removes a pill right before the caret", () => {
    const after = document.createTextNode("");
    const root = editor(pill(), after);
    caret(after, 0);

    expect(deletePillBeforeCaret(root)).toBe(true);
    expect(root.querySelector("[data-rel]")).toBeNull();
  });

  // The reported bug: inserting a pill splits the text node, and deleting the
  // space after it leaves that node empty, so an empty text node sits between
  // the caret and the pill. Backspace used to see that node and do nothing.
  it("reaches the pill across empty text nodes left by a split", () => {
    const leftover = document.createTextNode("");
    const after = document.createTextNode("");
    const root = editor(document.createTextNode(""), pill(), leftover, after);
    caret(after, 0);

    expect(deletePillBeforeCaret(root)).toBe(true);
    expect(root.querySelector("[data-rel]")).toBeNull();
  });

  it("reaches the pill across empty text when the caret sits between children", () => {
    const root = editor(pill(), document.createTextNode(""), document.createTextNode(""));
    caret(root, 3);

    expect(deletePillBeforeCaret(root)).toBe(true);
    expect(root.querySelector("[data-rel]")).toBeNull();
  });

  it("leaves ordinary text to the browser", () => {
    const text = document.createTextNode("hello");
    const root = editor(pill(), text);
    caret(text, 3);

    expect(deletePillBeforeCaret(root)).toBe(false);
    expect(root.querySelector("[data-rel]")).not.toBeNull();
  });

  it("does not skip past a real character to reach a pill", () => {
    const space = document.createTextNode(" ");
    const after = document.createTextNode("");
    const root = editor(pill(), space, after);
    caret(after, 0);

    expect(deletePillBeforeCaret(root)).toBe(false);
    expect(root.querySelector("[data-rel]")).not.toBeNull();
  });

  it("ignores a caret outside the editor", () => {
    const root = editor(pill(), document.createTextNode(""));
    const outside = document.createTextNode("x");
    document.body.append(outside);
    caret(outside, 0);

    expect(deletePillBeforeCaret(root)).toBe(false);
  });
});
