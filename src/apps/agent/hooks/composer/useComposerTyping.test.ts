// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { serializeFragment, splitTail } from "./useComposerTyping";

describe("splitTail", () => {
  it("splits the word being typed from the word before it", () => {
    expect(splitTail("fix the bug")).toEqual({ current: "bug", previous: "the" });
  });

  it("keeps in-word apostrophes", () => {
    expect(splitTail("that doesn't")).toEqual({ current: "doesn't", previous: "that" });
  });

  it("handles a single word and empty input", () => {
    expect(splitTail("hello")).toEqual({ current: "hello", previous: "" });
    expect(splitTail("")).toEqual({ current: "", previous: "" });
  });

  it("skips punctuation between the words", () => {
    expect(splitTail("done. next")).toEqual({ current: "next", previous: "done" });
  });
});

describe("serializeFragment", () => {
  const el = (
    tag: string,
    data: Record<string, string>,
    text?: string,
  ): HTMLElement => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(data)) node.dataset[k] = v;
    if (text) node.textContent = text;
    return node;
  };

  it("maps every pill kind to a single space — the engine must never see pill labels", () => {
    const root = document.createElement("div");
    root.append("no MX record for ");
    // A `/` command pill whose label must NOT leak into the engine's text.
    root.append(el("span", { cmd: "mcp:svc", cmdKind: "mcp", cmdTitle: "service" }, "service"));
    root.append("; also see ");
    root.append(el("span", { rel: "src/app.ts", path: "E:/p/src/app.ts" }, "app.ts"));
    root.append(" and ");
    root.append(el("span", { sel: "pick-1" }, "<div> hero section"));
    root.append(" done");
    expect(serializeFragment(root)).toBe("no MX record for  ; also see   and   done");
  });

  it("drops ghost spans entirely", () => {
    const root = document.createElement("div");
    root.append("hel");
    root.append(el("span", { ghost: "1" }, "lo→"));
    expect(serializeFragment(root)).toBe("hel");
  });

  it("renders <br> as a newline and recurses into plain wrappers", () => {
    const root = document.createElement("div");
    root.append("line one");
    root.append(document.createElement("br"));
    const wrapper = document.createElement("div");
    wrapper.append("line two");
    root.append(wrapper);
    expect(serializeFragment(root)).toBe("line one\nline two");
  });
});
