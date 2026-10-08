/**
 * A long code or diff box builds its first screenful at once and the rest once
 * the card's opening motion has run — including when its lines arrive a moment
 * after mount (colours landing).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProgressiveCount } from "@/apps/agent/components/tool-views/useProgressiveCount";

const Probe: React.FC<{ total: number }> = ({ total }) => (
  <span>{useProgressiveCount(total, 80)}</span>
);

describe("useProgressiveCount", () => {
  let root: Root;
  let host: HTMLDivElement;
  const shown = () => Number(host.textContent);
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("holds a long list to its first screenful, then shows it all", () => {
    act(() => root.render(<Probe total={2_000} />));
    expect(shown()).toBe(80);
    act(() => vi.advanceTimersByTime(400));
    expect(shown()).toBe(2_000);
  });

  it("still holds back when the lines arrive after mount", () => {
    act(() => root.render(<Probe total={0} />));
    expect(shown()).toBe(0);
    act(() => root.render(<Probe total={2_000} />));
    expect(shown()).toBe(80);
  });

  it("shows a short list whole at once", () => {
    act(() => root.render(<Probe total={12} />));
    expect(shown()).toBe(12);
  });
});
