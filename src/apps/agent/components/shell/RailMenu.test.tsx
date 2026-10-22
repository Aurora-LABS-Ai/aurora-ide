import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RailMenu, type RailMenuItem } from "./RailMenu";

/** The chat row's menu as the rail builds it: one row carries a flyout. */
function items(onPick: (label: string) => void): RailMenuItem[] {
  return [
    { icon: "panel-right", label: "Open in side panel", onSelect: () => onPick("open") },
    {
      icon: "folder",
      label: "Move to",
      children: [
        { icon: "folder", label: "qwen-asr", onSelect: () => onPick("qwen-asr") },
        { icon: "folder", label: "QuantumHUB", onSelect: () => onPick("QuantumHUB") },
      ],
    },
    { icon: "trash", label: "Delete…", danger: true, onSelect: () => onPick("delete") },
  ];
}

let root: Root;
let host: HTMLDivElement;
let agwRoot: HTMLDivElement;

const row = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (el) => el.querySelector("span")?.textContent === label,
  ) ?? null;
const open = (onPick: (label: string) => void, onClose: () => void) =>
  act(async () =>
    root.render(<RailMenu menu={{ x: 100, y: 100, items: items(onPick) }} onClose={onClose} />),
  );
const press = (target: EventTarget) =>
  act(async () => {
    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
const key = (target: Element, keyName: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true }));
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  agwRoot = document.createElement("div");
  agwRoot.className = "agw-root";
  document.body.append(agwRoot);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  agwRoot.remove();
  vi.unstubAllGlobals();
});

describe("RailMenu flyouts", () => {
  /**
   * 2026-10-19: the flyout was laid out inside the menu, whose box scrolls
   * when too tall, so opening Move to › clipped the list and grew scrollbars
   * on the menu. A flyout must be its own layer beside the menu, never a
   * descendant of it.
   */
  it("opens a flyout as its own layer beside the menu, not inside it", async () => {
    await open(vi.fn(), vi.fn());
    const parent = row("Move to")!;
    expect(parent.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => {
      parent.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const child = row("qwen-asr");
    expect(child).not.toBeNull();
    const flyout = child!.closest('[data-agw-rail-menu="flyout"]')!;
    const top = parent.closest('[data-agw-rail-menu="root"]')!;
    expect(top.contains(flyout)).toBe(false);
    expect(flyout.parentElement).toBe(agwRoot);
    expect(top.parentElement).toBe(agwRoot);
    expect((flyout as HTMLElement).style.position).toBe("fixed");
    expect(parent.getAttribute("aria-expanded")).toBe("true");
  });

  it("treats a press inside the flyout as inside the menu, and picks the child", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    await open(onPick, onClose);
    await act(async () => {
      row("Move to")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const child = row("QuantumHUB")!;

    // The outside-press handler listens on the document; a press on the
    // flyout is not a DOM descendant of the top level and must not close it.
    await press(child);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      child.click();
    });
    expect(onPick).toHaveBeenCalledWith("QuantumHUB");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a press anywhere else", async () => {
    const onClose = vi.fn();
    await open(vi.fn(), onClose);
    await press(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the flyout on ArrowRight and back on ArrowLeft", async () => {
    await open(vi.fn(), vi.fn());
    const parent = row("Move to")!;
    await act(async () => {
      parent.focus();
    });
    await key(parent, "ArrowRight");
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    const first = row("qwen-asr")!;
    expect(document.activeElement).toBe(first);

    await key(first, "ArrowLeft");
    expect(document.activeElement).toBe(parent);
    expect(row("qwen-asr")).toBeNull();
  });

  it("a plain row has no chevron and picks on click", async () => {
    const onPick = vi.fn();
    await open(onPick, vi.fn());
    const plain = row("Delete…")!;
    expect(plain.hasAttribute("aria-haspopup")).toBe(false);
    await act(async () => {
      plain.click();
    });
    expect(onPick).toHaveBeenCalledWith("delete");
  });
});
